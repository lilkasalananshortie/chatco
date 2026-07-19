<?php

namespace App\Services;

use App\Enums\UserRole;
use App\Models\Remittance;
use App\Models\ShiftLog;
use App\Models\Setting;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Validation\ValidationException;

class AdminService
{
    /** Account statuses an admin may toggle a commuter between. */
    private const ADMIN_TOGGLEABLE_STATUSES = ['ACTIVE', 'SUSPENDED'];
    /**
     * List vehicles with optional filters + pagination.
     *
     * Supported filters:
     *   - status   (exact match, e.g. ACTIVE / MAINTENANCE / INACTIVE)
     *   - route_id (exact match, UUID)
     *   - search   (LIKE on plate_number OR unit_number)
     *
     * Always eager-loads driver + route (+ conductor) to avoid N+1 in lists.
     *
     * @param  array{status?: string, route_id?: string, search?: string}  $filters
     * @param  int  $perPage  Page size (defaults to 15, matching other list endpoints).
     */
    public function listVehicles(array $filters = [], int $perPage = 15): LengthAwarePaginator
    {
        return Vehicle::query()
            ->with(['route', 'driver', 'conductor'])
            ->when($filters['status'] ?? null, function (Builder $q, string $status) {
                $q->where('status', $status);
            })
            ->when($filters['route_id'] ?? null, function (Builder $q, string $routeId) {
                $q->where('route_id', $routeId);
            })
            ->when($filters['search'] ?? null, function (Builder $q, string $search) {
                $term = "%{$search}%";
                $q->where(function (Builder $sub) use ($term) {
                    $sub->where('plate_number', 'like', $term)
                        ->orWhere('unit_number', 'like', $term);
                });
            })
            ->orderBy('unit_number', 'asc')
            ->paginate($perPage);
    }

    /**
     * Create a new vehicle.
     *
     * plate_number + unit_number uniqueness is enforced by the database
     * (unique indexes) and by the Form Request validation.
     *
     * @param  array  $data  Validated payload from StoreVehicleRequest.
     */
    public function createVehicle(array $data): Vehicle
    {
        return DB::transaction(function () use ($data) {
            return Vehicle::create([
                'unit_number'     => $data['unit_number'],
                'plate_number'    => $data['plate_number'],
                'vehicle_type'    => $data['vehicle_type'] ?? null,
                'route_id'        => $data['route_id'] ?? null,
                'driver_id'       => $data['driver_id'] ?? null,
                'conductor_id'    => $data['conductor_id'] ?? null,
                'status'          => $data['status'] ?? 'ACTIVE',
                'capacity_status' => $data['capacity_status'] ?? 'AVAILABLE',
            ])->fresh(['route', 'driver', 'conductor']);
        });
    }

    /**
     * Update an existing vehicle's mutable fields.
     *
     * @param  array  $data  Validated payload from UpdateVehicleRequest.
     * @throws \Illuminate\Database\Eloquent\ModelNotFoundException  If the vehicle doesn't exist.
     */
    public function updateVehicle(string $id, array $data): Vehicle
    {
        $vehicle = Vehicle::findOrFail($id);

        DB::transaction(function () use ($vehicle, $data) {
            $vehicle->update(array_filter([
                'unit_number'     => $data['unit_number'] ?? null,
                'plate_number'    => $data['plate_number'] ?? null,
                'vehicle_type'    => array_key_exists('vehicle_type', $data) ? $data['vehicle_type'] : null,
                'route_id'        => array_key_exists('route_id', $data) ? $data['route_id'] : null,
                'driver_id'       => array_key_exists('driver_id', $data) ? $data['driver_id'] : null,
                'conductor_id'    => array_key_exists('conductor_id', $data) ? $data['conductor_id'] : null,
                'status'          => $data['status'] ?? null,
                'capacity_status' => $data['capacity_status'] ?? null,
            ], fn ($value) => $value !== null));
        });

        return $vehicle->fresh(['route', 'driver', 'conductor']);
    }

    /**
     * Delete a vehicle — UNLESS it has an active_shift_id, in which case
     * reject with a 409 Conflict so the conductor's active shift is never
     * orphaned.
     *
     * @throws ValidationException  When the vehicle has an active shift.
     * @throws \Illuminate\Database\Eloquent\ModelNotFoundException  If the vehicle doesn't exist.
     */
    public function deleteVehicle(string $id): void
    {
        $vehicle = Vehicle::findOrFail($id);

        if ($vehicle->active_shift_id) {
            throw ValidationException::withMessages([
                'vehicle' => [
                    'Cannot delete a vehicle that is currently on an active shift. ' .
                    'End the shift (via conductor remittance) before deleting.',
                ],
            ]);
        }

        $vehicle->delete();
    }

    /**
     * Aggregate business metrics for the admin dashboard.
     *
     * Computes from real DB tables (transactions + remittances + vehicles +
     * shift_logs). All aggregation is server-side via Query Builder — no
     * static data, no wallet/balance metrics (none exist in the schema).
     *
     * Default window: last 30 days (date_from = today - 30, date_to = today).
     * Override via ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD.
     *
     * Only PAID transactions count toward revenue totals; pending counts
     * are exposed separately.
     *
     * @param  array{date_from?: string, date_to?: string}  $filters
     * @return array{
     *     date_range: array{from: string, to: string, days: int},
     *     totals: array{
     *         total_fares: float,
     *         cash_total: float,
     *         gcash_total: float,
     *         paid_count: int,
     *         pending_count: int,
     *         total_passengers: int
     *     },
     *     payment_split: array{cash: array{count: int, total: float}, gcash: array{count: int, total: float}},
     *     daily_series: array<int, array{date: string, cash: float, gcash: float, total: float, count: int}>,
     *     remittances: array{total_remitted: float, total_collected: float, total_shortage: float, count: int},
     *     fleet: array{active_vehicles: int, total_vehicles: int, active_conductors: int, total_conductors: int}
     * }
     */
    public function analytics(array $filters = []): array
    {
        // Default window: last 30 days.
        $dateTo = isset($filters['date_to'])
            ? Carbon::parse($filters['date_to'])->endOfDay()
            : Carbon::today()->endOfDay();
        $dateFrom = isset($filters['date_from'])
            ? Carbon::parse($filters['date_from'])->startOfDay()
            : Carbon::today()->subDays(29)->startOfDay();

        // ── Totals (PAID transactions only) ────────────────────────────────
        $paidBase = DB::table('transactions')
            ->where('status', 'PAID')
            ->whereBetween('created_at', [$dateFrom, $dateTo]);

        $cashTotal = (float) (clone $paidBase)->where('payment_method', 'CASH')->sum('final_amount');
        $gcashTotal = (float) (clone $paidBase)->where('payment_method', 'GCASH')->sum('final_amount');
        $paidCount = (int) (clone $paidBase)->count();
        $totalPassengers = $paidCount; // 1 transaction = 1 passenger in the current schema

        // ── Pending transactions (PENDING + PROCESSING) ────────────────────
        $pendingCount = (int) DB::table('transactions')
            ->whereIn('status', ['PENDING', 'PROCESSING'])
            ->whereBetween('created_at', [$dateFrom, $dateTo])
            ->count();

        // ── Payment split (counts + sums) ──────────────────────────────────
        $paymentSplit = [
            'cash' => [
                'count' => (int) (clone $paidBase)->where('payment_method', 'CASH')->count(),
                'total' => $cashTotal,
            ],
            'gcash' => [
                'count' => (int) (clone $paidBase)->where('payment_method', 'GCASH')->count(),
                'total' => $gcashTotal,
            ],
        ];

        // ── Per-day series (PAID transactions, grouped by date) ────────────
        // Uses DATE(created_at) so it groups by calendar day regardless of DB driver.
        $dailyRows = DB::table('transactions')
            ->select(
                DB::raw('DATE(created_at) as date'),
                DB::raw("SUM(CASE WHEN payment_method = 'CASH' THEN final_amount ELSE 0 END) as cash"),
                DB::raw("SUM(CASE WHEN payment_method = 'GCASH' THEN final_amount ELSE 0 END) as gcash"),
                DB::raw('SUM(final_amount) as total'),
                DB::raw('COUNT(*) as count')
            )
            ->where('status', 'PAID')
            ->whereBetween('created_at', [$dateFrom, $dateTo])
            ->groupBy(DB::raw('DATE(created_at)'))
            ->orderBy('date', 'asc')
            ->get();

        $dailySeries = $dailyRows->map(function ($row) {
            return [
                'date'  => $row->date,
                'cash'  => (float) $row->cash,
                'gcash' => (float) $row->gcash,
                'total' => (float) $row->total,
                'count' => (int) $row->count,
            ];
        })->values()->toArray();

        // ── Remittance summary ─────────────────────────────────────────────
        // Remittances use a 'date' column (not created_at) — that's the
        // business date the shift was remitted on.
        $remittanceBase = Remittance::query()
            ->whereBetween('date', [$dateFrom->toDateString(), $dateTo->toDateString()]);

        $remittanceCount = (int) (clone $remittanceBase)->count();
        $totalRemitted = (float) (clone $remittanceBase)->sum('remitted_amount');
        $totalCollected = (float) (clone $remittanceBase)->sum('total_collected');
        $totalShortage = (float) (clone $remittanceBase)->sum('shortage');

        // ── Fleet counts ───────────────────────────────────────────────────
        // Active = currently on an active shift (active_shift_id IS NOT NULL).
        // Total = all non-deleted vehicles (soft-deletes excluded by Eloquent).
        $totalVehicles = (int) Vehicle::count();
        $activeVehicles = (int) Vehicle::whereNotNull('active_shift_id')->count();

        // Active conductors = conductors with an ACTIVE shift right now.
        // Total conductors = all conductor profiles (non-deleted).
        $totalConductors = (int) DB::table('conductor_profiles')->count();
        $activeConductors = (int) ShiftLog::where('status', 'ACTIVE')->distinct('conductor_id')->count('conductor_id');

        // ── Top Pickup Points (aggregate PAID transactions by pickup_name) ──
        // Each PAID transaction has a `pickup_name` (the fare point name the
        // conductor selected). We count how many passengers boarded at each
        // pickup point in the date window, sorted descending. Limited to top 10.
        $pickupPoints = DB::table('transactions')
            ->select('pickup_name', DB::raw('COUNT(*) as pickup_count'))
            ->where('status', 'PAID')
            ->whereNotNull('pickup_name')
            ->where('pickup_name', '!=', '')
            ->whereBetween('created_at', [$dateFrom, $dateTo])
            ->groupBy('pickup_name')
            ->orderByDesc('pickup_count')
            ->limit(10)
            ->get()
            ->map(fn ($row) => [
                'name'  => $row->pickup_name,
                'count' => (int) $row->pickup_count,
            ])
            ->toArray();

        // ── Demand Heatmap Zones (aggregate PAID transactions with coordinates) ──
        // Join transactions with fare_points to get the GPS coordinates of each
        // pickup location. Group by fare_point to cluster demand by location.
        // The intensity is computed from the pickup_count:
        //   - >= 50 pickups  → Critical (red)
        //   - >= 20 pickups  → High (orange)
        //   - >= 5 pickups   → Moderate (yellow)
        //   - < 5 pickups    → Low (green)
        $heatmapZones = DB::table('transactions')
            ->join('fare_points', 'transactions.pickup_stop_id', '=', 'fare_points.id')
            ->select(
                'fare_points.name as zone_name',
                'fare_points.latitude',
                'fare_points.longitude',
                DB::raw('COUNT(*) as commuter_count')
            )
            ->where('transactions.status', 'PAID')
            ->whereNotNull('fare_points.latitude')
            ->whereNotNull('fare_points.longitude')
            ->whereBetween('transactions.created_at', [$dateFrom, $dateTo])
            ->groupBy('fare_points.id', 'fare_points.name', 'fare_points.latitude', 'fare_points.longitude')
            ->orderByDesc('commuter_count')
            ->limit(15)
            ->get()
            ->map(function ($row) {
                $count = (int) $row->commuter_count;
                $intensity = $count >= 50 ? 'Critical' : ($count >= 20 ? 'High' : ($count >= 5 ? 'Moderate' : 'Low'));
                $color = $count >= 50 ? 'bg-red-500' : ($count >= 20 ? 'bg-orange-500' : ($count >= 5 ? 'bg-yellow-500' : 'bg-green-500'));
                return [
                    'zone'      => $row->zone_name,
                    'commuters' => $count,
                    'intensity' => $intensity,
                    'color'     => $color,
                    'lat'       => (float) $row->latitude,
                    'lng'       => (float) $row->longitude,
                ];
            })
            ->toArray();

        return [
            'date_range' => [
                'from' => $dateFrom->toDateString(),
                'to'   => $dateTo->toDateString(),
                'days' => (int) $dateFrom->diffInDays($dateTo) + 1,
            ],
            'totals' => [
                'total_fares'      => $cashTotal + $gcashTotal,
                'cash_total'       => $cashTotal,
                'gcash_total'      => $gcashTotal,
                'paid_count'       => $paidCount,
                'pending_count'    => $pendingCount,
                'total_passengers' => $totalPassengers,
            ],
            'payment_split' => $paymentSplit,
            'daily_series'  => $dailySeries,
            'remittances' => [
                'total_remitted'   => $totalRemitted,
                'total_collected'  => $totalCollected,
                'total_shortage'   => $totalShortage,
                'count'            => $remittanceCount,
            ],
            'fleet' => [
                'active_vehicles'   => $activeVehicles,
                'total_vehicles'    => $totalVehicles,
                'active_conductors' => $activeConductors,
                'total_conductors'  => $totalConductors,
            ],
            'pickup_points' => $pickupPoints,
            'heatmap_zones' => $heatmapZones,
        ];
    }

    // ═══════════════════════════════════════════════════════════════════
    // USER MANAGEMENT (S5-T3)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * GET /admin/users — paginated, role-filterable, searchable list.
     */
    public function listUsers(array $filters): LengthAwarePaginator
    {
        $perPage = (int) ($filters['per_page'] ?? 15);
        $perPage = max(1, min($perPage, 100));

        $query = User::query()
            ->with($this->profileEagerLoads())
            ->orderBy('created_at', 'desc');

        if (! empty($filters['role'])) {
            $query->where('role', $filters['role']);
        }

        if (! empty($filters['search'])) {
            $this->applySearch($query, trim($filters['search']));
        }

        return $query->paginate($perPage)
            ->withQueryString()
            ->through(fn (User $user) => $this->present($user));
    }

    /**
     * GET /admin/users/{id} — a single user with its profile.
     */
    public function getUser(string $id): ?array
    {
        $user = User::with($this->profileEagerLoads())->find($id);
        return $user ? $this->present($user) : null;
    }

    /**
     * PUT /admin/users/{id} — update the editable profile fields.
     */
    public function updateUser(string $id, array $data, User $actingAdmin): ?array
    {
        $user = User::with($this->profileEagerLoads())->find($id);

        if (! $user) {
            return null;
        }

        $profile = $this->profileOf($user);

        if (! $profile) {
            throw ValidationException::withMessages([
                'user' => ['This user has no profile and cannot be edited.'],
            ]);
        }

        if (array_key_exists('first_name', $data)) {
            $profile->first_name = $data['first_name'];
        }
        if (array_key_exists('middle_name', $data)) {
            $profile->middle_name = $data['middle_name'];
        }
        if (array_key_exists('last_name', $data)) {
            $lastNameColumn = $user->isCommuter() ? 'surname' : 'last_name';
            $profile->{$lastNameColumn} = $data['last_name'];
        }

        $commuterOnly = array_intersect_key($data, array_flip(['account_status', 'contact_number']));

        if (! empty($commuterOnly) && ! $user->isCommuter()) {
            throw ValidationException::withMessages([
                'account_status' => ['Account status and contact number can only be set on commuter accounts.'],
            ]);
        }

        if (array_key_exists('account_status', $data)) {
            if ($user->id === $actingAdmin->id && $data['account_status'] === 'SUSPENDED') {
                throw ValidationException::withMessages([
                    'account_status' => ['You cannot suspend your own account.'],
                ]);
            }
            $profile->account_status = $data['account_status'];
        }

        if (array_key_exists('contact_number', $data)) {
            $profile->contact_number = $data['contact_number'];
        }

        if ($profile->isDirty()) {
            $profile->save();
        }

        return $this->present($user->setRelation($this->relationName($user), $profile));
    }

    /**
     * DELETE /admin/users/{id} — soft-delete a user account.
     */
    public function deleteUser(string $id, User $actingAdmin): bool
    {
        $user = User::find($id);

        if (! $user) {
            return false;
        }

        if ($user->id === $actingAdmin->id) {
            throw ValidationException::withMessages([
                'user' => ['You cannot delete your own account.'],
            ]);
        }

        if ($user->isAdmin() && $this->activeAdminCount() <= 1) {
            throw ValidationException::withMessages([
                'user' => ['Cannot delete the last administrator account.'],
            ]);
        }

        $user->delete();

        return true;
    }

    // ── Internals ────────────────────────────────────────────────

    private function profileEagerLoads(): array
    {
        return [
            'adminProfile:id,first_name,middle_name,last_name',
            'conductorProfile:id,first_name,middle_name,last_name,generated_username',
            'commuterProfile:id,first_name,middle_name,surname,contact_number,commuter_type,account_status,verified_at,username',
        ];
    }

    private function applySearch($query, string $term): void
    {
        $like = '%' . $term . '%';

        $query->where(function ($q) use ($like) {
            $q->where('email', 'like', $like)
                ->orWhereHas('adminProfile', fn ($p) => $p
                    ->where('first_name', 'like', $like)
                    ->orWhere('last_name', 'like', $like))
                ->orWhereHas('conductorProfile', fn ($p) => $p
                    ->where('first_name', 'like', $like)
                    ->orWhere('last_name', 'like', $like)
                    ->orWhere('generated_username', 'like', $like))
                ->orWhereHas('commuterProfile', fn ($p) => $p
                    ->where('first_name', 'like', $like)
                    ->orWhere('surname', 'like', $like)
                    ->orWhere('username', 'like', $like));
        });
    }

    private function relationName(User $user): string
    {
        return match ($user->role) {
            UserRole::ADMIN => 'adminProfile',
            UserRole::CONDUCTOR => 'conductorProfile',
            UserRole::COMMUTER => 'commuterProfile',
        };
    }

    private function profileOf(User $user)
    {
        return $user->{$this->relationName($user)};
    }

    private function activeAdminCount(): int
    {
        return User::where('role', UserRole::ADMIN->value)->count();
    }

    private function present(User $user): array
    {
        $commuter = $user->commuterProfile;

        return [
            'id'             => $user->id,
            'email'          => $user->email,
            'role'           => $user->role->value,
            'name'           => $user->getDisplayName(),
            'account_status' => $commuter?->account_status,
            'commuter_type'  => $commuter?->commuter_type,
            'contact_number' => $commuter?->contact_number,
            'verified_at'    => optional($commuter?->verified_at)->toIso8601String(),
            'created_at'     => optional($user->created_at)->toIso8601String(),
        ];
    }

    public static function isToggleableStatus(string $status): bool
    {
        return in_array($status, self::ADMIN_TOGGLEABLE_STATUSES, true);
    }

    // ═══════════════════════════════════════════════════════════════════
    // REGISTRATION REVIEW (S5-T15)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * GET /admin/registrations — list PENDING commuter accounts awaiting review.
     *
     * Returns commuters with account_status=PENDING, including their uploaded
     * valid ID (id_image_url), applied_type (the discount tier they requested),
     * and identifying fields so the admin can verify the ID matches the tier.
     */
    public function listPendingRegistrations(int $perPage = 15): LengthAwarePaginator
    {
        return User::where('role', UserRole::COMMUTER)
            ->whereHas('commuterProfile', function ($q) {
                $q->where('account_status', 'PENDING');
            })
            ->with(['commuterProfile:id,first_name,middle_name,surname,birthdate,gender,email,contact_number,commuter_type,applied_type,account_status,id_image_url,verified_at,rejection_reason,username,language_preference'])
            ->orderBy('created_at', 'asc') // oldest first — FIFO review queue
            ->paginate($perPage)
            ->through(function (User $user) {
                $c = $user->commuterProfile;
                return [
                    'id'              => $user->id,
                    'email'           => $user->email,
                    'first_name'      => $c?->first_name,
                    'middle_name'     => $c?->middle_name,
                    'surname'         => $c?->surname,
                    'birthdate'       => $c?->birthdate?->toDateString(),
                    'gender'          => $c?->gender,
                    'contact_number'  => $c?->contact_number,
                    'username'        => $c?->username,
                    'applied_type'    => $c?->applied_type,
                    'id_image_url'    => $c?->id_image_url,
                    'account_status'  => $c?->account_status,
                    'language_preference' => $c?->language_preference,
                    'verified_at'     => $c?->verified_at?->toIso8601String(),
                    'rejection_reason'=> $c?->rejection_reason,
                    'created_at'      => optional($user->created_at)->toIso8601String(),
                ];
            });
    }

    /**
     * GET /admin/registrations/rejected — list REJECTED commuter accounts.
     *
     * Rejected accounts are soft-deleted (their email is rewritten to
     * 'rejected+{timestamp}@chatco.local' so the canonical email frees up
     * for re-registration). We use withTrashed() to include them.
     *
     * Returns the same shape as listPendingRegistrations so the frontend
     * can reuse the RejectedUser table component.
     */
    public function listRejectedRegistrations(int $perPage = 15): LengthAwarePaginator
    {
        return User::withTrashed()
            ->where('role', UserRole::COMMUTER)
            ->whereHas('commuterProfile', function ($q) {
                $q->where('account_status', 'REJECTED');
            })
            ->with(['commuterProfile:id,first_name,middle_name,surname,birthdate,gender,email,contact_number,commuter_type,applied_type,account_status,id_image_url,verified_at,rejection_reason,username,language_preference'])
            ->orderBy('updated_at', 'desc') // most recently rejected first
            ->paginate($perPage)
            ->through(function (User $user) {
                $c = $user->commuterProfile;
                return [
                    'id'              => $user->id,
                    'email'           => $user->email,
                    'first_name'      => $c?->first_name,
                    'middle_name'     => $c?->middle_name,
                    'surname'         => $c?->surname,
                    'birthdate'       => $c?->birthdate?->toDateString(),
                    'gender'          => $c?->gender,
                    'contact_number'  => $c?->contact_number,
                    'username'        => $c?->username,
                    'applied_type'    => $c?->applied_type,
                    'id_image_url'    => $c?->id_image_url,
                    'account_status'  => $c?->account_status,
                    'language_preference' => $c?->language_preference,
                    'verified_at'     => $c?->verified_at?->toIso8601String(),
                    'rejection_reason'=> $c?->rejection_reason,
                    'created_at'      => optional($user->created_at)->toIso8601String(),
                    'rejected_at'     => optional($user->deleted_at)->toIso8601String(),
                ];
            });
    }

    /**
     * GET /admin/users/{id}/activity — build a user activity timeline.
     *
     * Instead of a separate audit_logs table, this reuses existing data
     * sources to build a chronological timeline of the user's activity:
     *   - Account creation + verification (for commuters)
     *   - Recent transactions (for commuters with passenger_id bound)
     *   - Recent shift logs (for conductors)
     *   - Recent feedback received (for conductors/drivers)
     *
     * Each entry has: id, timestamp, action, details.
     */
    public function getUserActivity(string $id): array
    {
        $user = User::with(['commuterProfile', 'conductorProfile', 'adminProfile'])->find($id);

        if (! $user) {
            abort(404, 'User not found');
        }

        $events = [];

        // Account creation
        $events[] = [
            'id'        => 'created',
            'timestamp' => optional($user->created_at)->toIso8601String(),
            'action'    => 'Account Created',
            'details'   => "Role: {$user->role->value}",
        ];

        // Commuter-specific events
        if ($user->commuterProfile) {
            $c = $user->commuterProfile;

            if ($c->verified_at) {
                $events[] = [
                    'id'        => 'verified',
                    'timestamp' => $c->verified_at->toIso8601String(),
                    'action'    => 'Account Verified',
                    'details'   => "Commuter type: {$c->commuter_type}",
                ];
            }

            if ($c->account_status === 'REJECTED' && $c->rejection_reason) {
                $events[] = [
                    'id'        => 'rejected',
                    'timestamp' => optional($user->deleted_at)->toIso8601String(),
                    'action'    => 'Registration Rejected',
                    'details'   => "Reason: {$c->rejection_reason}",
                ];
            }

            // Recent transactions (payment history)
            $transactions = Transaction::where('passenger_id', $c->id)
                ->orderBy('created_at', 'desc')
                ->limit(10)
                ->get();

            foreach ($transactions as $txn) {
                $events[] = [
                    'id'        => "txn-{$txn->transaction_id}",
                    'timestamp' => optional($txn->created_at)->toIso8601String(),
                    'action'    => 'Payment',
                    'details'   => "{$txn->payment_method} ₱{$txn->final_amount} — {$txn->pickup_name} → {$txn->dropoff_name} ({$txn->status})",
                ];
            }
        }

        // Conductor-specific events
        if ($user->conductorProfile) {
            $shiftLogs = ShiftLog::where('conductor_id', $user->conductorProfile->id)
                ->orderBy('time_in', 'desc')
                ->limit(10)
                ->get();

            foreach ($shiftLogs as $log) {
                $events[] = [
                    'id'        => "shift-{$log->shift_id}",
                    'timestamp' => optional($log->time_in)->toIso8601String(),
                    'action'    => $log->status === 'ACTIVE' ? 'Shift Started' : 'Shift Ended',
                    'details'   => "Unit: {$log->unit_number} — {$log->driver_name}",
                ];
            }
        }

        // Sort all events by timestamp, newest first
        usort($events, function ($a, $b) {
            $ta = $a['timestamp'] ? strtotime($a['timestamp']) : 0;
            $tb = $b['timestamp'] ? strtotime($b['timestamp']) : 0;
            return $tb - $ta;
        });

        return $events;
    }

    /**
     * POST /admin/registrations/{id}/approve — approve a pending registration.
     *
     * - Copies applied_type → commuter_type (the validated discount tier)
     * - Sets verified_at = now
     * - Sets account_status = APPROVED
     * - Clears rejection_reason
     *
     * The commuter can now log in and receives that tier's fare discount.
     *
     * @throws ValidationException if the user is not a PENDING commuter
     */
    public function approveRegistration(string $id): array
    {
        $user = User::with('commuterProfile')->find($id);

        if (! $user || ! $user->commuterProfile) {
            abort(404, 'Registration not found.');
        }

        $profile = $user->commuterProfile;

        if ($profile->account_status !== 'PENDING') {
            throw ValidationException::withMessages([
                'account_status' => ['This registration has already been processed (status: ' . $profile->account_status . ').'],
            ]);
        }

        $profile->update([
            'commuter_type'     => $profile->applied_type ?? 'REGULAR',
            'account_status'    => 'APPROVED',
            'verified_at'       => now(),
            'rejection_reason'  => null,
        ]);

        $fresh = $profile->fresh();

        // Send approval email to the commuter (best-effort — don't fail
        // the approval if the email can't be sent).
        $this->sendApprovalEmail($user, $fresh);

        return [
            'id'              => $user->id,
            'email'           => $user->email,
            'name'            => $user->getDisplayName(),
            'commuter_type'   => $fresh->commuter_type,
            'applied_type'    => $fresh->applied_type,
            'account_status'  => 'APPROVED',
            'verified_at'     => $fresh->verified_at?->toIso8601String(),
            'rejection_reason'=> null,
        ];
    }

    /**
     * POST /admin/registrations/{id}/reject — reject a pending registration.
     *
     * - Sets account_status = REJECTED + rejection_reason
     * - SOFT-DELETES the user + profile so the email frees up for re-registration
     *   (per S5-T14: a previously rejected email can register again)
     *
     * @throws ValidationException if the user is not a PENDING commuter
     */
    public function rejectRegistration(string $id, string $reason): array
    {
        $user = User::with('commuterProfile')->find($id);

        if (! $user || ! $user->commuterProfile) {
            abort(404, 'Registration not found.');
        }

        $profile = $user->commuterProfile;

        if ($profile->account_status !== 'PENDING') {
            throw ValidationException::withMessages([
                'account_status' => ['This registration has already been processed (status: ' . $profile->account_status . ').'],
            ]);
        }

        // Send rejection email to the commuter BEFORE rewriting the email
        // (best-effort — don't fail the rejection if the email can't be sent).
        $this->sendRejectionEmail($user, $profile, $reason);

        // Rewrite the email to a unique placeholder BEFORE soft-deleting.
        // This frees the canonical email for re-registration (the users.email
        // column has a DB-level unique index that includes soft-deleted rows).
        $placeholderEmail = 'rejected+' . time() . '@chatco.local';
        $user->update(['email' => $placeholderEmail]);

        // Free the username too. commuter_profiles.username has a DB-level
        // unique index, and the profile row is NOT soft-deleted (only the
        // User is), so the rejected applicant's username would otherwise stay
        // locked forever — blocking them (or anyone) from reusing it on a
        // fresh registration. Rewrite it to a unique placeholder keyed on the
        // user id (guaranteed unique, fits the 50-char column). The original
        // username isn't needed on a dead account — admins identify rejected
        // applicants by name/contact in the Rejected tab.
        $placeholderUsername = 'rejected_' . $user->id;

        $profile->update([
            'account_status'   => 'REJECTED',
            'rejection_reason' => $reason,
            'username'         => $placeholderUsername,
        ]);

        // Soft-delete the user (cascades to commuter_profile via shared PK).
        $user->delete();

        return [
            'id'               => $user->id,
            'email'            => $user->email, // placeholder
            'account_status'   => 'REJECTED',
            'rejection_reason' => $reason,
        ];
    }

    // ── Email helpers ──────────────────────────────────────────────

    /**
     * Send an approval notification email to the commuter.
     * Reads the `account_approved_template` from the settings table.
     * Best-effort: errors are logged but never thrown.
     */
    private function sendApprovalEmail(User $user, $profile): void
    {
        try {
            $template = Setting::where('key', 'account_approved_template')->value('value')
                ?? "Congratulations {name}!\n\nYour CHATCO commuter account has been approved.\n\nCommuter Type: {commuter_type}\n\nYou can now log in to the CHATCO app and start riding.";

            $body = strtr($template, [
                '{name}'          => trim($profile->first_name . ' ' . $profile->surname),
                '{commuter_type}' => $profile->commuter_type ?? 'REGULAR',
            ]);

            Mail::raw($body, function ($message) use ($user) {
                $message->to($user->email)
                    ->subject('CHATCO — Account Approved');
            });
        } catch (\Exception $e) {
            Log::error('Failed to send approval email', [
                'error' => $e->getMessage(),
                'user_id' => $user->id,
            ]);
        }
    }

    /**
     * Send a rejection notification email to the commuter.
     * Reads the `account_rejected_template` from the settings table.
     * Best-effort: errors are logged but never thrown.
     */
    private function sendRejectionEmail(User $user, $profile, string $reason): void
    {
        try {
            $template = Setting::where('key', 'account_rejected_template')->value('value')
                ?? "Hello {name},\n\nWe regret to inform you that your CHATCO commuter registration has been rejected.\n\nReason: {reason}\n\nIf you believe this is an error, please contact support.";

            $body = strtr($template, [
                '{name}'   => trim($profile->first_name . ' ' . $profile->surname),
                '{reason}' => $reason,
            ]);

            Mail::raw($body, function ($message) use ($user) {
                $message->to($user->email)
                    ->subject('CHATCO — Registration Update');
            });
        } catch (\Exception $e) {
            Log::error('Failed to send rejection email', [
                'error' => $e->getMessage(),
                'user_id' => $user->id,
            ]);
        }
    }
}
