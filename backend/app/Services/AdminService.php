<?php

namespace App\Services;

use App\Enums\UserRole;
use App\Mail\AccountApprovedMail;
use App\Mail\AccountRejectedMail;
use App\Models\DiscountApplication;
use App\Models\Driver;
use App\Models\RegistrationRejection;
use App\Models\Remittance;
use App\Models\Setting;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\UserSuspension;
use App\Models\Vehicle;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Pagination\LengthAwarePaginator as Paginator;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\ValidationException;

class AdminService
{
    /** Account statuses an admin may toggle a commuter between. */
    private const ADMIN_TOGGLEABLE_STATUSES = ['ACTIVE', 'SUSPENDED'];

    public function __construct(
        private RegistrationGuard $registrationGuard
    ) {}

    /**
     * List vehicles with optional filters + pagination.
     *
     * Supported filters:
     *   - status   (exact match, e.g. ACTIVE / MAINTENANCE / INACTIVE)
     *   - route_id (exact match, UUID)
     *   - search   (each word LIKE plate_number, unit_number, or driver/conductor name)
     *
     * Always eager-loads driver + route (+ conductor) to avoid N+1 in lists.
     *
     * @param  array{status?: string, route_id?: string, search?: string}  $filters
     * @param  int  $perPage  Page size (defaults to 15, matching other list endpoints).
     */
    public function listVehicles(array $filters = [], int $perPage = 15): LengthAwarePaginator
    {
        return $this->vehicleListQuery($filters)
            ->with(['route', 'driver', 'conductor'])
            ->orderBy('unit_number', 'asc')
            ->paginate($perPage);
    }

    /**
     * Count vehicles using the same filters as listVehicles(), without eager
     * loading relations or fetching a page row.
     *
     * @param  array{status?: string, route_id?: string, search?: string}  $filters
     */
    public function countVehicles(array $filters = []): int
    {
        return (int) $this->vehicleListQuery($filters)->count();
    }

    /**
     * Fetch one vehicle with the same relations used by the Fleet list.
     *
     * @throws ModelNotFoundException If the vehicle doesn't exist.
     */
    public function getVehicle(string $id): Vehicle
    {
        return Vehicle::with(['route', 'driver', 'conductor'])->findOrFail($id);
    }

    /**
     * @param  array{status?: string, route_id?: string, search?: string}  $filters
     */
    private function vehicleListQuery(array $filters = []): Builder
    {
        return Vehicle::query()
            ->when($filters['status'] ?? null, function (Builder $q, string $status) {
                $q->where('status', $status);
            })
            ->when($filters['route_id'] ?? null, function (Builder $q, string $routeId) {
                $q->where('route_id', $routeId);
            })
            ->when($filters['search'] ?? null, function (Builder $q, string $search) {
                // Every word must match the unit, plate, or a crew name, so a
                // full name ("mark arone") finds the unit it is assigned to.
                foreach ($this->searchWords($search) as $word) {
                    $term = '%'.str_replace(['%', '_'], ['\\%', '\\_'], $word).'%';
                    $crewName = fn (Builder $person) => $person->where('first_name', 'like', $term)
                        ->orWhere('middle_name', 'like', $term)
                        ->orWhere('last_name', 'like', $term);
                    $q->where(function (Builder $sub) use ($term, $crewName) {
                        $sub->where('plate_number', 'like', $term)
                            ->orWhere('unit_number', 'like', $term)
                            ->orWhereHas('driver', $crewName)
                            ->orWhereHas('conductor', $crewName);
                    });
                }
            });
    }

    /**
     * Create a new vehicle.
     *
     * Allocate the unit number and insert the vehicle in one transaction so
     * simultaneous requests cannot reserve the same number, and failed inserts
     * do not consume a number. Existing unique indexes remain the final guard.
     *
     * @param  array  $data  Validated payload from StoreVehicleRequest.
     */
    public function createVehicle(array $data): Vehicle
    {
        try {
            return DB::transaction(function () use ($data) {
                $number = $this->lockVehicleUnitSequence() + 1;
                DB::table('vehicle_unit_sequences')->where('id', 1)->update(['last_number' => $number]);

                $approved = ! empty($data['driver_id']) && ! empty($data['conductor_id']);

                return Vehicle::create([
                    'unit_number' => 'UNIT-'.$number,
                    'plate_number' => $data['plate_number'],
                    'brand' => $data['brand'],
                    'model' => $data['model'],
                    'route_id' => $data['route_id'] ?? null,
                    'driver_id' => $data['driver_id'] ?? null,
                    'conductor_id' => $data['conductor_id'] ?? null,
                    'status' => $data['status'] ?? 'ACTIVE',
                    'capacity_status' => $data['capacity_status'] ?? 'AVAILABLE',
                    'assignment_date' => $approved ? now('Asia/Manila')->toDateString() : null,
                    'assignment_approved_at' => $approved ? now() : null,
                ])->fresh(['route', 'driver', 'conductor']);
            }, 3);
        } catch (UniqueConstraintViolationException $exception) {
            // A second request may have registered this plate after validation.
            if (Vehicle::withTrashed()->where('plate_number', $data['plate_number'])->exists()) {
                throw ValidationException::withMessages([
                    'plate_number' => ['The plate number has already been taken.'],
                ]);
            }

            throw $exception;
        }
    }

    /** Preview only: opening the form must not reserve or consume a number. */
    public function previewVehicleUnitNumber(): string
    {
        $lastNumber = DB::table('vehicle_unit_sequences')->where('id', 1)->value('last_number');

        return 'UNIT-'.(($lastNumber === null ? $this->highestVehicleUnitSuffix() : (int) $lastNumber) + 1);
    }

    /**
     * Must be called inside the transaction that saves the vehicle. The first
     * insert is safe even for an empty fleet; later callers lock the same row.
     * Bootstrap once from all unit names, including soft-deleted vehicles.
     */
    private function lockVehicleUnitSequence(): int
    {
        // Updating only the primary key preserves the counter and acquires a
        // write lock immediately, avoiding shared-lock upgrades on MySQL.
        DB::table('vehicle_unit_sequences')->upsert(
            [['id' => 1, 'last_number' => null]],
            ['id'],
            ['id'],
        );
        $lastNumber = DB::table('vehicle_unit_sequences')->where('id', 1)->lockForUpdate()->value('last_number');

        if ($lastNumber !== null) {
            return (int) $lastNumber;
        }

        return $this->highestVehicleUnitSuffix();
    }

    private function highestVehicleUnitSuffix(): int
    {
        $lastNumber = 0;
        foreach (DB::table('vehicles')->select('unit_number')->orderBy('unit_number')->cursor() as $vehicle) {
            $lastNumber = max($lastNumber, $this->vehicleUnitSuffix($vehicle->unit_number));
        }

        return $lastNumber;
    }

    /** Accept existing padded names and the spacing/dashes used in older units. */
    private function vehicleUnitSuffix(string $unitNumber): int
    {
        return preg_match('/^UNIT\s*[-–—]\s*(\d+)$/iu', trim($unitNumber), $matches)
            ? (int) $matches[1]
            : 0;
    }

    /**
     * Update an existing vehicle's mutable fields.
     *
     * @param  array  $data  Validated payload from UpdateVehicleRequest.
     *
     * @throws ModelNotFoundException If the vehicle doesn't exist.
     */
    public function updateVehicle(string $id, array $data): Vehicle
    {
        return DB::transaction(function () use ($id, $data) {
            // Use the same lock order as creation when a unit is renamed.
            $lastUnitNumber = array_key_exists('unit_number', $data) ? $this->lockVehicleUnitSequence() : null;
            $vehicle = Vehicle::query()->whereKey($id)->lockForUpdate()->firstOrFail();
            $previousStatus = $vehicle->status;
            $assignmentIsChanging = array_key_exists('driver_id', $data)
                || array_key_exists('conductor_id', $data);

            if ($assignmentIsChanging && $vehicle->active_shift_id) {
                throw ValidationException::withMessages([
                    'assignment' => ['End the active shift before changing its approved crew assignment.'],
                ]);
            }

            $allowed = [
                'unit_number',
                'plate_number',
                'route_id',
                'driver_id',
                'conductor_id',
                'status',
                'capacity_status',
            ];
            $changes = array_intersect_key($data, array_flip($allowed));

            if ($lastUnitNumber !== null) {
                DB::table('vehicle_unit_sequences')->where('id', 1)->update([
                    'last_number' => max($lastUnitNumber, $this->vehicleUnitSuffix($data['unit_number'])),
                ]);
            }

            if ($assignmentIsChanging) {
                $driverId = array_key_exists('driver_id', $changes) ? $changes['driver_id'] : $vehicle->driver_id;
                $conductorId = array_key_exists('conductor_id', $changes) ? $changes['conductor_id'] : $vehicle->conductor_id;
                $approved = $driverId !== null && $conductorId !== null;
                $changes['assignment_date'] = $approved ? now('Asia/Manila')->toDateString() : null;
                $changes['assignment_approved_at'] = $approved ? now() : null;
            }

            $vehicle->update($changes);

            if ($vehicle->wasChanged('status')) {
                $labels = ['ACTIVE' => 'Operating', 'MAINTENANCE' => 'Under Maintenance', 'INACTIVE' => 'Out of Service / Damaged'];
                $before = $labels[$previousStatus] ?? $previousStatus;
                $after = $labels[$vehicle->status] ?? $vehicle->status;
                app(AnnouncementService::class)->notifyAdmins(
                    'VEHICLE_STATUS_CHANGED',
                    "Vehicle status changed: unit {$vehicle->unit_number}",
                    "Unit {$vehicle->unit_number} ({$vehicle->plate_number}) changed from {$before} to {$after}.",
                    $vehicle->id,
                );
            }

            return $vehicle->fresh(['route', 'driver', 'conductor']);
        }, 3);
    }

    /**
     * Delete a vehicle — UNLESS it has an active_shift_id, in which case
     * reject with a 409 Conflict so the conductor's active shift is never
     * orphaned.
     *
     * @throws ValidationException When the vehicle has an active shift.
     * @throws ModelNotFoundException If the vehicle doesn't exist.
     */
    public function deleteVehicle(string $id): void
    {
        $vehicle = Vehicle::findOrFail($id);

        if ($vehicle->active_shift_id) {
            throw ValidationException::withMessages([
                'vehicle' => [
                    'Cannot delete a vehicle that is currently on an active shift. '.
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
     * @param  array{date_from?: string, date_to?: string, pickup_period?: string}  $filters
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

        // Immediately-preceding window of the same length, used for the
        // period-over-period deltas on the metric cards. A window of N days
        // is compared against the N days directly before it.
        $windowDays = (int) $dateFrom->diffInDays($dateTo) + 1;
        $prevTo = (clone $dateFrom)->subSecond();
        $prevFrom = (clone $dateFrom)->subDays($windowDays);

        $current = $this->aggregateTransactionWindow($dateFrom, $dateTo);
        $previous = $this->aggregateTransactionWindow($prevFrom, $prevTo);

        $cashTotal = $current['cash_total'];
        $gcashTotal = $current['gcash_total'];
        $voucherCount = $current['voucher_count'];
        // Revenue excludes VOUCHER by construction: reward rides are recorded
        // with final_amount = 0. They still count as *rides*, which is why
        // ride counts and revenue are reported separately below.
        $totalFares = $cashTotal + $gcashTotal;
        $paidCount = $current['paid_count'];

        // ── Full status breakdown ──────────────────────────────────────────
        // Drives the GCash settlement-success metric. Previously only
        // PENDING was surfaced, so FAILED/EXPIRED/CANCELLED payments — the
        // ones that actually need chasing — were invisible.
        //
        // One grouped query feeds both the per-row status breakdown and the
        // per-payment GCash figures: a group payment is one row per seat, so
        // GCash attempts are counted once per payment (group_id, or the row
        // itself when ungrouped) instead of once per seat.
        $statusMethodRows = DB::table('transactions')
            ->select(
                'status',
                'payment_method',
                DB::raw('COUNT(*) as row_count'),
                DB::raw('COUNT(DISTINCT COALESCE(group_id, transaction_id)) as payment_count')
            )
            ->whereBetween('created_at', [$dateFrom, $dateTo])
            ->groupBy('status', 'payment_method')
            ->get();
        $statusRows = $statusMethodRows->groupBy('status')->map(fn ($rows) => $rows->sum('row_count'));
        $gcashPayments = $statusMethodRows
            ->where('payment_method', 'GCASH')
            ->mapWithKeys(fn ($row) => [$row->status => (int) $row->payment_count]);

        // Statuses the app can actually produce. REFUNDED is deliberately not
        // here: nothing in the product initiates a refund, so it would be a
        // permanently-zero tile. It is still reachable in theory via a
        // provider-side refund webhook, so it (or any other unexpected
        // status) is appended below when a row genuinely has one — hidden
        // when zero, never hidden when it exists.
        $expectedStatuses = ['PAID', 'PENDING', 'PROCESSING', 'FAILED', 'CANCELLED', 'EXPIRED'];

        $statusBreakdown = [];
        foreach ($expectedStatuses as $s) {
            $statusBreakdown[$s] = (int) ($statusRows[$s] ?? 0);
        }
        foreach ($statusRows as $status => $count) {
            if (! in_array($status, $expectedStatuses, true) && (int) $count > 0) {
                $statusBreakdown[$status] = (int) $count;
            }
        }
        $pendingCount = $statusBreakdown['PENDING'] + $statusBreakdown['PROCESSING'];

        // Gateway-settled attempts only — cash never goes through this
        // lifecycle, so including it would flatter the success rate.
        $gcashOutcome = fn (string $status): int => (int) ($gcashPayments[$status] ?? 0);
        $gcashSettled = $gcashOutcome('PAID');
        $gcashAttempts = $gcashSettled + $gcashOutcome('FAILED') + $gcashOutcome('CANCELLED') + $gcashOutcome('EXPIRED');

        // ── Payment split (counts + sums), now including VOUCHER ───────────
        $paymentSplit = [
            'cash' => ['count' => $current['cash_count'], 'total' => $cashTotal],
            'gcash' => ['count' => $current['gcash_count'], 'total' => $gcashTotal],
            'voucher' => ['count' => $voucherCount, 'total' => $current['voucher_total']],
        ];

        // ── Per-day series (PAID transactions, grouped by date) ────────────
        // Uses DATE(created_at) so it groups by calendar day regardless of DB driver.
        $dailyRows = DB::table('transactions')
            ->select(
                DB::raw('DATE(created_at) as date'),
                DB::raw("SUM(CASE WHEN payment_method = 'CASH' THEN final_amount ELSE 0 END) as cash"),
                DB::raw("SUM(CASE WHEN payment_method = 'GCASH' THEN final_amount ELSE 0 END) as gcash"),
                DB::raw('SUM(final_amount) as total'),
                DB::raw("SUM(CASE WHEN payment_method IN ('CASH', 'GCASH') THEN 1 ELSE 0 END) as paid_count"),
                DB::raw('COUNT(*) as count')
            )
            ->where('status', 'PAID')
            ->whereBetween('created_at', [$dateFrom, $dateTo])
            ->groupBy(DB::raw('DATE(created_at)'))
            ->orderBy('date', 'asc')
            ->get()
            ->keyBy('date');

        // Zero-fill every calendar day in the window. The grouped query only
        // returns days that had transactions, so a chart built straight from
        // it silently closed the gaps — 12 active days out of 30 rendered as
        // 12 adjacent bars implying continuous trade. Days with no trade are
        // the most operationally interesting ones, so they must be present.
        $dailySeries = [];
        for ($d = (clone $dateFrom)->startOfDay(); $d->lte($dateTo); $d->addDay()) {
            $key = $d->toDateString();
            $row = $dailyRows->get($key);
            $dailySeries[] = [
                'date' => $key,
                'cash' => $row ? (float) $row->cash : 0.0,
                'gcash' => $row ? (float) $row->gcash : 0.0,
                'total' => $row ? (float) $row->total : 0.0,
                'paid_count' => $row ? (int) $row->paid_count : 0,
                'count' => $row ? (int) $row->count : 0,
            ];
        }

        // ── Hour-of-day demand profile ─────────────────────────────────────
        // Aggregated across the whole window; drives the peak-hours chart.
        // Every hour 0-23 is present so the chart has a stable x-axis.
        //
        // Hour extraction is driver-specific: MySQL has HOUR(), SQLite (used
        // by the test suite) does not and needs strftime.
        $driver = DB::connection()->getDriverName();
        $hourExpr = match ($driver) {
            'sqlite' => "CAST(strftime('%H', created_at) AS INTEGER)",
            'pgsql' => 'EXTRACT(HOUR FROM created_at)',
            default => 'HOUR(created_at)',
        };

        $hourRows = DB::table('transactions')
            ->select(DB::raw("{$hourExpr} as hour"), DB::raw('COUNT(*) as ride_count'), DB::raw('SUM(final_amount) as revenue'))
            ->where('status', 'PAID')
            ->whereBetween('created_at', [$dateFrom, $dateTo])
            ->groupBy(DB::raw($hourExpr))
            ->get()
            ->keyBy(fn ($row) => (int) $row->hour);

        $hourlySeries = [];
        for ($h = 0; $h < 24; $h++) {
            $row = $hourRows->get($h);
            $hourlySeries[] = [
                'hour' => $h,
                'count' => $row ? (int) $row->ride_count : 0,
                'revenue' => $row ? (float) $row->revenue : 0.0,
            ];
        }

        // ── Remittance summary ─────────────────────────────────────────────
        // Remittances use a 'date' column (not created_at) — that's the
        // business date the shift was remitted on. NOTE: transaction totals
        // above are windowed on created_at, so a shift running past midnight
        // can land in a different bucket than its fares. The two are related
        // but do not reconcile exactly; the UI labels them accordingly.
        //
        // A shift that ended before its cash was handed in is PENDING with
        // shortage = the whole expected cash (nothing physically remitted yet).
        // That is cash in transit, not missing cash, so it is reported as
        // "awaiting" and kept out of the shortage figure and its rate.
        $remittanceBase = Remittance::query()
            ->whereBetween('date', [$dateFrom->toDateString(), $dateTo->toDateString()]);
        $pending = Remittance::STATUS_PENDING;

        $remittanceTotals = $remittanceBase
            ->selectRaw('COUNT(*) as remittance_count')
            ->selectRaw('COALESCE(SUM(remitted_amount), 0) as total_remitted')
            ->selectRaw('COALESCE(SUM(total_collected), 0) as total_collected')
            ->selectRaw('COALESCE(SUM(CASE WHEN remittance_status <> ? THEN total_collected ELSE 0 END), 0) as settled_collected', [$pending])
            ->selectRaw('COALESCE(SUM(CASE WHEN remittance_status <> ? THEN shortage ELSE 0 END), 0) as total_shortage', [$pending])
            ->selectRaw('COALESCE(SUM(CASE WHEN remittance_status = ? THEN 1 ELSE 0 END), 0) as awaiting_count', [$pending])
            ->selectRaw('COALESCE(SUM(CASE WHEN remittance_status = ? THEN total_collected ELSE 0 END), 0) as awaiting_amount', [$pending])
            ->first();

        $remittanceCount = (int) ($remittanceTotals->remittance_count ?? 0);
        $totalRemitted = (float) ($remittanceTotals->total_remitted ?? 0);
        $totalCollected = (float) ($remittanceTotals->total_collected ?? 0);
        $settledCollected = (float) ($remittanceTotals->settled_collected ?? 0);
        $totalShortage = (float) ($remittanceTotals->total_shortage ?? 0);

        // ── Fleet counts ───────────────────────────────────────────────────
        // Active = currently on an active shift (active_shift_id IS NOT NULL).
        // Total = all non-deleted vehicles (soft-deletes excluded by Eloquent).
        $totalVehicles = (int) Vehicle::count();
        $activeVehicles = (int) Vehicle::whereNotNull('active_shift_id')->count();

        // Active conductors = conductors with an ACTIVE shift right now.
        // Total conductors = conductors still on the roster. Removing a
        // conductor soft-deletes the user only (soft deletes don't cascade),
        // so the profile row survives and the user's deleted_at decides.
        $totalConductors = (int) DB::table('conductor_profiles')
            ->join('users', 'users.id', '=', 'conductor_profiles.id')
            ->whereNull('users.deleted_at')
            ->whereNull('conductor_profiles.deleted_at')
            ->count();
        $activeConductors = (int) ShiftLog::where('status', 'ACTIVE')->distinct('conductor_id')->count('conductor_id');

        // Dashboard pickups card (pickup_period=week only): the current
        // calendar week, grouped by the major fare point so different landmark
        // labels belong to one location. Analytics reads its Pickup Points
        // report from heatmap_zones below, so a plain analytics call skips
        // this query and returns an empty list.
        $pickupPoints = [];
        if (($filters['pickup_period'] ?? null) === 'week') {
            $now = Carbon::now();
            $pickupPoints = DB::table('transactions')
                ->join('fare_points', 'transactions.pickup_stop_id', '=', 'fare_points.id')
                ->select('fare_points.name as pickup_name', DB::raw('COUNT(*) as pickup_count'))
                ->where('transactions.status', 'PAID')
                ->whereIn('transactions.payment_method', ['CASH', 'GCASH'])
                ->whereBetween('transactions.created_at', [$now->copy()->startOfWeek(Carbon::MONDAY), $now])
                ->groupBy('fare_points.name')
                ->orderByDesc('pickup_count')
                ->orderBy('fare_points.name')
                ->limit(10)
                ->get()
                ->map(fn ($row) => [
                    'name' => $row->pickup_name,
                    'count' => (int) $row->pickup_count,
                ])
                ->toArray();
        }

        // ── Demand Heatmap Zones (Analytics > Pickup Points report) ──
        // Paid CASH/GCASH boardings per fare point over the selected range,
        // counted the same way as the dashboard's weekly pickups card. Fare
        // points without coordinates are NOT excluded: the cooperative fare
        // matrix seeds every point with null lat/lng, and filtering on them
        // left this report empty. Not capped, so every boarding fare point is
        // listed and the report's Share column adds up to 100%.
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
            ->whereIn('transactions.payment_method', ['CASH', 'GCASH'])
            ->whereBetween('transactions.created_at', [$dateFrom, $dateTo])
            ->groupBy('fare_points.id', 'fare_points.name', 'fare_points.latitude', 'fare_points.longitude')
            ->orderByDesc('commuter_count')
            ->orderBy('fare_points.name')
            ->get()
            ->map(function ($row) {
                $count = (int) $row->commuter_count;
                $intensity = $count >= 50 ? 'Critical' : ($count >= 20 ? 'High' : ($count >= 5 ? 'Moderate' : 'Low'));
                $color = $count >= 50 ? 'bg-red-500' : ($count >= 20 ? 'bg-orange-500' : ($count >= 5 ? 'bg-yellow-500' : 'bg-green-500'));

                return [
                    'zone' => $row->zone_name,
                    'commuters' => $count,
                    'intensity' => $intensity,
                    'color' => $color,
                    'lat' => $row->latitude !== null ? (float) $row->latitude : null,
                    'lng' => $row->longitude !== null ? (float) $row->longitude : null,
                ];
            })
            ->toArray();

        $prevTotalFares = $previous['cash_total'] + $previous['gcash_total'];
        $shiftSummary = $this->shiftSummary($dateFrom, $dateTo);

        return [
            'date_range' => [
                'from' => $dateFrom->toDateString(),
                'to' => $dateTo->toDateString(),
                'days' => $windowDays,
            ],
            // The window immediately before this one, so the UI can label
            // what the deltas are actually being compared against.
            'previous_range' => [
                'from' => $prevFrom->toDateString(),
                'to' => $prevTo->toDateString(),
            ],
            'totals' => [
                'total_fares' => $totalFares,
                'cash_total' => $cashTotal,
                'gcash_total' => $gcashTotal,
                // Rides settled for money (excludes free voucher rides), so
                // this is directly comparable to cash_count + gcash_count.
                'paid_count' => $current['cash_count'] + $current['gcash_count'],
                // Every PAID row including voucher rides = bodies carried.
                'total_passengers' => $current['passenger_count'],
                'paying_passengers' => $current['paying_passenger_count'],
                'pending_count' => $pendingCount,
                'voucher_count' => $voucherCount,
                // Fare given away in the window (discounts, vouchers, free rides).
                'discount_total' => $current['discount_total'],
                // Mean revenue per paying passenger. Normalises the headline
                // total so a busy-but-cheap window is distinguishable from a
                // quiet one.
                'avg_fare' => $this->averageFare($current),
            ],
            // Same shape as `totals`, for the preceding window. The frontend
            // derives percentage deltas from these rather than the backend
            // pre-computing them, so it can format "no prior data" itself.
            'previous_totals' => [
                'total_fares' => $prevTotalFares,
                'cash_total' => $previous['cash_total'],
                'gcash_total' => $previous['gcash_total'],
                'paid_count' => $previous['cash_count'] + $previous['gcash_count'],
                // Same basis as totals.total_passengers (sum across CASH+GCASH+
                // VOUCHER, not a row count) — the Passengers card's delta was
                // comparing that sum against paid_count (a voucher-excluded row
                // count) before this field existed, which compared two
                // different kinds of numbers.
                'total_passengers' => $previous['passenger_count'],
                'avg_fare' => $this->averageFare($previous),
            ],
            'payment_split' => $paymentSplit,
            'daily_series' => $dailySeries,
            'hourly_series' => $hourlySeries,
            'status_breakdown' => $statusBreakdown,
            'gcash_health' => [
                'attempts' => $gcashAttempts,
                'settled' => $gcashSettled,
                'failed' => $gcashOutcome('FAILED'),
                'expired' => $gcashOutcome('EXPIRED'),
                'cancelled' => $gcashOutcome('CANCELLED'),
                'success_rate' => $gcashAttempts > 0
                    ? round(($gcashSettled / $gcashAttempts) * 100, 1)
                    : null,
            ],
            'remittances' => [
                'total_remitted' => $totalRemitted,
                'total_collected' => $totalCollected,
                'total_shortage' => $totalShortage,
                'count' => $remittanceCount,
                // Shortage as a share of the cash expected from remitted
                // shifts. An absolute peso figure alone can't distinguish ₱500
                // short on ₱600 from ₱500 short on ₱600,000.
                'shortage_rate' => $settledCollected > 0
                    ? round(($totalShortage / $settledCollected) * 100, 2)
                    : 0.0,
                // Ended shifts whose cash hasn't been handed in yet.
                'awaiting_count' => (int) ($remittanceTotals->awaiting_count ?? 0),
                'awaiting_amount' => (float) ($remittanceTotals->awaiting_amount ?? 0),
            ],
            'fleet' => [
                'active_vehicles' => $activeVehicles,
                'total_vehicles' => $totalVehicles,
                'active_conductors' => $activeConductors,
                'total_conductors' => $totalConductors,
            ],
            'pickup_points' => $pickupPoints,
            'heatmap_zones' => $heatmapZones,
            'service' => [
                'shifts_run' => $shiftSummary['shifts_run'],
                'avg_shift_minutes' => $shiftSummary['avg_shift_minutes'],
                ...$this->ratingSummary($dateFrom, $dateTo),
            ],
            'safety' => $this->safetySummary($dateFrom, $dateTo),
            'performance' => [
                'units' => $shiftSummary['units'],
                'conductors' => $shiftSummary['conductors'],
            ],
        ];
    }

    /**
     * Shifts run in the window, and revenue/passengers per unit and per
     * conductor.
     *
     * Shifts are those that started in the window or took fares in it (one
     * that began just before the window but earned inside it counts), and the
     * shifts_run card uses that same set, so it equals the tables' shift
     * totals. Revenue and passengers use the same PAID-by-created_at window as
     * the headline totals, attributed to the shift's unit and conductor
     * snapshot, so per-unit revenue sums exactly to total_fares.
     *
     * @return array{shifts_run: int, avg_shift_minutes: int|null, units: list<array<string, mixed>>, conductors: list<array<string, mixed>>}
     */
    private function shiftSummary(Carbon $from, Carbon $to): array
    {
        $shiftColumns = ['shift_logs.shift_id', 'shift_logs.vehicle_id', 'shift_logs.unit_number', 'shift_logs.plate_number', 'shift_logs.conductor_id', 'shift_logs.conductor_name', 'shift_logs.time_in', 'shift_logs.time_out'];

        $started = DB::table('shift_logs')
            ->select($shiftColumns)
            ->whereBetween('time_in', [$from, $to])
            ->orderByDesc('time_in')
            ->get();

        // Same passenger rule as the totals: a group seat row counts once.
        $earned = DB::table('transactions')
            ->join('shift_logs', 'shift_logs.shift_id', '=', 'transactions.shift_id')
            ->select($shiftColumns)
            ->selectRaw("COALESCE(SUM(CASE WHEN transactions.payment_method IN ('CASH', 'GCASH') THEN transactions.final_amount ELSE 0 END), 0) as revenue")
            ->selectRaw('SUM(CASE
                WHEN transactions.group_id IS NOT NULL THEN 1
                WHEN transactions.total_passengers IS NULL OR transactions.total_passengers < 1 THEN 1
                ELSE transactions.total_passengers
            END) as passengers')
            ->where('transactions.status', 'PAID')
            ->whereBetween('transactions.created_at', [$from, $to])
            ->groupBy($shiftColumns)
            ->get()
            ->keyBy('shift_id');

        // Every shift that started or earned in the window, newest first so
        // each unit/conductor takes its latest label.
        $shifts = $started->keyBy('shift_id');
        foreach ($earned as $shiftId => $row) {
            if (! $shifts->has($shiftId)) {
                $shifts->put($shiftId, $row);
            }
        }
        $shifts = $shifts->sortByDesc('time_in');

        // Only ended shifts have a length; a time_out before time_in (a bad
        // clock) is left out rather than averaged in as a negative length.
        $lengths = $shifts
            ->filter(fn ($shift) => $shift->time_out !== null)
            ->map(fn ($shift) => Carbon::parse($shift->time_in)->diffInMinutes(Carbon::parse($shift->time_out), false))
            ->filter(fn ($minutes) => $minutes >= 0);
        $avgShiftMinutes = $lengths->isEmpty() ? null : (int) round($lengths->avg());

        $units = [];
        $conductors = [];
        foreach ($shifts as $shiftId => $shift) {
            $revenue = (float) ($earned->get($shiftId)->revenue ?? 0);
            $passengers = (int) ($earned->get($shiftId)->passengers ?? 0);

            $units[$shift->vehicle_id] ??= ['vehicle_id' => $shift->vehicle_id, 'unit_number' => $shift->unit_number, 'plate_number' => $shift->plate_number, 'shifts' => 0, 'passengers' => 0, 'revenue' => 0.0];
            $units[$shift->vehicle_id]['shifts']++;
            $units[$shift->vehicle_id]['passengers'] += $passengers;
            $units[$shift->vehicle_id]['revenue'] += $revenue;

            $conductors[$shift->conductor_id] ??= ['conductor_id' => $shift->conductor_id, 'name' => $shift->conductor_name, 'shifts' => 0, 'passengers' => 0, 'revenue' => 0.0];
            $conductors[$shift->conductor_id]['shifts']++;
            $conductors[$shift->conductor_id]['passengers'] += $passengers;
            $conductors[$shift->conductor_id]['revenue'] += $revenue;
        }

        $rank = fn (array $rows, string $label) => collect($rows)
            ->map(fn (array $row) => [...$row, 'revenue' => round($row['revenue'], 2)])
            ->sortBy([['revenue', 'desc'], [$label, 'asc']])
            ->values()
            ->all();

        return [
            'shifts_run' => $shifts->count(),
            'avg_shift_minutes' => $avgShiftMinutes,
            'units' => $rank($units, 'unit_number'),
            'conductors' => $rank($conductors, 'name'),
        ];
    }

    /**
     * Commuter ride ratings submitted in the window. `rating` is the ride /
     * driver rating every review has; the conductor rating is optional.
     *
     * @return array{review_count: int, driver_rating: float|null, conductor_rating: float|null}
     */
    private function ratingSummary(Carbon $from, Carbon $to): array
    {
        $row = DB::table('feedback')
            ->whereBetween('created_at', [$from, $to])
            ->selectRaw('COUNT(*) as review_count, AVG(rating) as driver_rating, AVG(conductor_rating) as conductor_rating')
            ->first();

        return [
            'review_count' => (int) ($row->review_count ?? 0),
            'driver_rating' => $row?->driver_rating !== null ? round((float) $row->driver_rating, 1) : null,
            'conductor_rating' => $row?->conductor_rating !== null ? round((float) $row->conductor_rating, 1) : null,
        ];
    }

    /**
     * SOS alerts raised and overspeeding episodes recorded in the window.
     *
     * @return array{sos_alerts: int, sos_open: int, overspeed_episodes: int, overspeed_top_speed: int|null}
     */
    private function safetySummary(Carbon $from, Carbon $to): array
    {
        $sos = DB::table('sos_alerts')
            ->whereBetween('created_at', [$from, $to])
            ->selectRaw("COUNT(*) as total, COALESCE(SUM(CASE WHEN status <> 'RESOLVED' THEN 1 ELSE 0 END), 0) as still_open")
            ->first();

        $overspeed = DB::table('overspeed_events')
            ->whereBetween('date', [$from->toDateString(), $to->toDateString()])
            ->selectRaw('COUNT(*) as episodes, MAX(top_speed) as top_speed')
            ->first();

        return [
            'sos_alerts' => (int) ($sos->total ?? 0),
            'sos_open' => (int) ($sos->still_open ?? 0),
            'overspeed_episodes' => (int) ($overspeed->episodes ?? 0),
            'overspeed_top_speed' => $overspeed?->top_speed !== null ? (int) $overspeed->top_speed : null,
        ];
    }

    /** Revenue per paying passenger in one aggregated window; 0 when nobody paid. */
    private function averageFare(array $window): float
    {
        return $window['paying_passenger_count'] > 0
            ? round(($window['cash_total'] + $window['gcash_total']) / $window['paying_passenger_count'], 2)
            : 0.0;
    }

    /**
     * Revenue + ride counts for PAID transactions inside one window.
     *
     * Extracted so the current and immediately-preceding windows can be
     * aggregated identically for period-over-period deltas.
     *
     * @return array{cash_total: float, gcash_total: float, voucher_total: float, cash_count: int, gcash_count: int, voucher_count: int, paid_count: int, passenger_count: int, paying_passenger_count: int, discount_total: float}
     */
    private function aggregateTransactionWindow(Carbon $from, Carbon $to): array
    {
        // One grouped query rather than six independent aggregates — the old
        // code cloned the base builder and hit the table once per figure.
        //
        // Passengers: a group payment stores one row per seat, and each of
        // those rows repeats the whole group size in total_passengers, so a
        // grouped row counts as one passenger (same rule as
        // ShiftCloseoutService). An ungrouped row may carry several.
        $rows = DB::table('transactions')
            ->select(
                'payment_method',
                DB::raw('COUNT(*) as method_count'),
                DB::raw('SUM(final_amount) as method_total'),
                DB::raw('SUM(CASE
                    WHEN group_id IS NOT NULL THEN 1
                    WHEN total_passengers IS NULL OR total_passengers < 1 THEN 1
                    ELSE total_passengers
                END) as passenger_count'),
                DB::raw('SUM(COALESCE(discount_amount, 0)) as discount_total')
            )
            ->where('status', 'PAID')
            ->whereBetween('created_at', [$from, $to])
            ->groupBy('payment_method')
            ->get()
            ->keyBy('payment_method');

        $countFor = fn (string $m) => (int) ($rows->get($m)->method_count ?? 0);
        $totalFor = fn (string $m) => (float) ($rows->get($m)->method_total ?? 0);
        $passengersFor = fn (string $m) => (int) ($rows->get($m)->passenger_count ?? 0);

        return [
            'cash_total' => $totalFor('CASH'),
            'gcash_total' => $totalFor('GCASH'),
            // Sourced from the same aggregate as cash/gcash rather than
            // hardcoded — voucher fares are ₱0 by construction today (every
            // insert path forces final_amount = 0), so this reads as 0.0
            // now, but it will reflect reality automatically if that
            // business rule ever changes.
            'voucher_total' => $totalFor('VOUCHER'),
            'cash_count' => $countFor('CASH'),
            'gcash_count' => $countFor('GCASH'),
            'voucher_count' => $countFor('VOUCHER'),
            'paid_count' => $countFor('CASH') + $countFor('GCASH') + $countFor('VOUCHER'),
            'passenger_count' => $passengersFor('CASH') + $passengersFor('GCASH') + $passengersFor('VOUCHER'),
            // Passengers who paid money (cash or GCash), the base for avg fare.
            'paying_passenger_count' => $passengersFor('CASH') + $passengersFor('GCASH'),
            // Fare given away: student/senior/PWD discounts, discount vouchers
            // and free reward rides (whose discount is the whole fare).
            'discount_total' => round((float) $rows->sum(fn ($row) => (float) $row->discount_total), 2),
        ];
    }

    /**
     * Paginated Fleet Management personnel view.
     *
     * Combines drivers and conductors as the UI has always shown them, but
     * performs the merge in SQL so large personnel tables are never fully
     * loaded into PHP or the browser.
     */
    public function listFleetPersonnel(int $perPage = 25, int $page = 1, ?string $search = null, ?string $role = null, ?string $status = null): Paginator
    {
        $base = $this->fleetPersonnelBaseQuery($search, $role, $status);
        $total = (clone $base)->count();
        $items = (clone $base)
            ->orderBy('role_order')
            ->orderBy('sort_last_name')
            ->orderBy('sort_first_name')
            ->orderBy('id')
            ->forPage($page, $perPage)
            ->get()
            ->map(fn ($row) => [
                'id' => (string) $row->id,
                'name' => trim((string) $row->name),
                'role' => (string) $row->role,
                'contact' => (string) $row->contact,
                'birthday' => $row->birthday !== null ? (string) $row->birthday : null,
                'profile_picture_url' => $row->profile_picture_url,
                'status' => (string) $row->status,
            ]);

        return new Paginator(
            $items,
            $total,
            $perPage,
            $page,
            ['path' => request()->url(), 'query' => request()->query()],
        );
    }

    public function countFleetPersonnel(?string $search = null, ?string $role = null, ?string $status = null): int
    {
        return (int) $this->fleetPersonnelBaseQuery($search, $role, $status)->count();
    }

    private function fleetPersonnelBaseQuery(?string $search = null, ?string $role = null, ?string $status = null): \Illuminate\Database\Query\Builder
    {
        $normalizedRole = match (strtoupper(trim((string) $role))) {
            'DRIVER' => 'Driver',
            'CONDUCTOR' => 'Conductor',
            default => null,
        };

        $driverNameExpr = DB::connection()->getDriverName() === 'sqlite'
            ? "first_name || ' ' || last_name"
            : "CONCAT(first_name, ' ', last_name)";

        // Both drivers.status and conductor_profiles.status use their own
        // role-specific vocab (driver: ACTIVE/SUSPENDED, conductor:
        // ACTIVE/DISABLED — see AdminController::disableConductor). This
        // normalizes both into one ACTIVE/DEACTIVATED pair for the shared
        // Personnel tab's Status column; NULL reads as ACTIVE either way.
        $driverStatusExpr = "CASE WHEN status IS NULL OR status = 'ACTIVE' THEN 'ACTIVE' ELSE 'DEACTIVATED' END";
        $conductorStatusExpr = "CASE WHEN status = 'DISABLED' THEN 'DEACTIVATED' ELSE 'ACTIVE' END";

        $drivers = DB::table('drivers')
            ->select([
                'id',
                DB::raw("{$driverNameExpr} as name"),
                DB::raw("'Driver' as role"),
                'contact',
                'birthday',
                'profile_picture_url',
                DB::raw("{$driverStatusExpr} as status"),
                DB::raw('0 as role_order'),
                'last_name as sort_last_name',
                'first_name as sort_first_name',
            ])
            ->whereNull('deleted_at');

        $conductors = DB::table('conductor_profiles')
            ->select([
                'id',
                DB::raw("{$driverNameExpr} as name"),
                DB::raw("'Conductor' as role"),
                DB::raw("COALESCE(contact, '-') as contact"),
                'birthday',
                'profile_picture_url',
                DB::raw("{$conductorStatusExpr} as status"),
                DB::raw('1 as role_order'),
                'last_name as sort_last_name',
                'first_name as sort_first_name',
            ])
            ->whereNull('deleted_at');

        if ($search !== null && trim($search) !== '') {
            // Names span separate columns, so each word must match one of them
            // ("mark a" → "Mark" in first_name AND "A" in last_name).
            foreach ($this->searchWords($search) as $word) {
                $term = '%'.str_replace(['%', '_'], ['\\%', '\\_'], $word).'%';
                foreach ([[$drivers, 'Driver'], [$conductors, 'Conductor']] as [$table, $roleLabel]) {
                    $table->where(function ($query) use ($term, $roleLabel): void {
                        $query->where('first_name', 'like', $term)
                            ->orWhere('middle_name', 'like', $term)
                            ->orWhere('last_name', 'like', $term)
                            ->orWhere('contact', 'like', $term)
                            ->orWhereRaw('? like ?', [$roleLabel, $term]);
                    });
                }
            }
        }

        $personnel = $drivers->unionAll($conductors);

        // Preserve the current-personnel view for callers without a status filter.
        // Separation snapshots use their own IDs and must never open live profile actions.
        if (in_array($status, ['all', 'TERMINATED', 'RESIGNED'], true)) {
            $separated = DB::table('terminated_personnel')->select([
                'id', 'name', 'role', 'contact',
                DB::raw('NULL as birthday'),
                DB::raw('NULL as profile_picture_url'),
                'termination_type as status',
                DB::raw("CASE WHEN role = 'Driver' THEN 0 ELSE 1 END as role_order"),
                'name as sort_last_name',
                DB::raw("'' as sort_first_name"),
            ]);
            if ($search !== null && trim($search) !== '') {
                $term = '%'.str_replace(['%', '_'], ['\\%', '\\_'], trim($search)).'%';
                $separated->where(function ($query) use ($term): void {
                    $query->where('name', 'like', $term)
                        ->orWhere('role', 'like', $term)
                        ->orWhere('contact', 'like', $term);
                });
            }
            $personnel->unionAll($separated);
        }

        return DB::query()->fromSub($personnel, 'fleet_personnel')
            ->when($normalizedRole, fn ($query) => $query->where('role', $normalizedRole))
            ->when($status && $status !== 'all', fn ($query) => $query->where('status', $status));
    }

    /**
     * Paginated Fleet Management shift-history personnel entries.
     *
     * One shift has one driver and one conductor. The UI displays those as
     * separate history rows, so this query builds that split at the database
     * layer and paginates the final row set.
     */
    public function listFleetShiftHistoryEntries(int $perPage = 25, int $page = 1, ?string $search = null, ?string $shiftRange = null): Paginator
    {
        $base = $this->fleetShiftHistoryEntriesBaseQuery($search, $shiftRange);
        $total = (clone $base)->count();
        $rows = (clone $base)
            ->orderBy('time_in', 'desc')
            ->orderBy('id')
            ->forPage($page, $perPage)
            ->get();

        $items = $rows->map(function ($row) {
            $timeIn = $row->time_in ? Carbon::parse($row->time_in)->format('H:i:s') : '-';
            $timeOut = $row->time_out ? Carbon::parse($row->time_out)->format('H:i:s') : '-';
            $details = "Time in: {$timeIn} | Time out: {$timeOut} | Status: {$row->status}";
            if ($row->notes) {
                $details .= " | Notes: {$row->notes}";
            }

            return [
                'id' => (string) $row->id,
                'personnelName' => (string) $row->personnel_name,
                'role' => (string) $row->role,
                'vehicle' => (string) $row->vehicle,
                'shiftDate' => $row->time_in
                    ? Carbon::parse($row->time_in)->format('M j, Y')
                    : '-',
                'timeIn' => $timeIn,
                'timeOut' => $timeOut,
                'status' => (string) $row->status,
                'notes' => $row->notes ? (string) $row->notes : null,
                'details' => $details,
            ];
        });

        return new Paginator(
            $items,
            $total,
            $perPage,
            $page,
            ['path' => request()->url(), 'query' => request()->query()],
        );
    }

    public function countFleetShiftHistoryEntries(?string $search = null, ?string $shiftRange = null): int
    {
        return (int) $this->fleetShiftHistoryEntriesBaseQuery($search, $shiftRange)->count();
    }

    private function fleetShiftHistoryEntriesBaseQuery(?string $search = null, ?string $shiftRange = null): \Illuminate\Database\Query\Builder
    {
        $driverIdExpr = DB::connection()->getDriverName() === 'sqlite'
            ? "shift_id || ':driver'"
            : "CONCAT(shift_id, ':driver')";
        $conductorIdExpr = DB::connection()->getDriverName() === 'sqlite'
            ? "shift_id || ':conductor'"
            : "CONCAT(shift_id, ':conductor')";

        $driverEntries = DB::table('shift_logs')
            ->select([
                DB::raw("{$driverIdExpr} as id"),
                'driver_name as personnel_name',
                DB::raw("'Driver' as role"),
                DB::raw('COALESCE(unit_number, plate_number) as vehicle'),
                'time_in',
                'time_out',
                'status',
                'notes',
            ])
            ->whereNull('deleted_at')
            ->whereNotNull('driver_name')
            ->where('driver_name', '!=', '');

        $conductorEntries = DB::table('shift_logs')
            ->select([
                DB::raw("{$conductorIdExpr} as id"),
                'conductor_name as personnel_name',
                DB::raw("'Conductor' as role"),
                DB::raw('COALESCE(unit_number, plate_number) as vehicle'),
                'time_in',
                'time_out',
                'status',
                'notes',
            ])
            ->whereNull('deleted_at')
            ->whereNotNull('conductor_name')
            ->where('conductor_name', '!=', '');

        $rangeBounds = $this->fleetShiftHistoryRangeBounds($shiftRange);
        if ($rangeBounds !== null) {
            [$start, $end] = $rangeBounds;
            $driverEntries->whereBetween('time_in', [$start, $end]);
            $conductorEntries->whereBetween('time_in', [$start, $end]);
        }

        if ($search !== null && trim($search) !== '') {
            $term = '%'.str_replace(['%', '_'], ['\\%', '\\_'], trim($search)).'%';
            $applySearch = function ($query, string $personnelColumn, string $role) use ($term): void {
                $query->where(function ($searchQuery) use ($term, $personnelColumn, $role): void {
                    $searchQuery->where($personnelColumn, 'like', $term)
                        ->orWhere('unit_number', 'like', $term)
                        ->orWhere('plate_number', 'like', $term)
                        ->orWhere('status', 'like', $term)
                        ->orWhere('notes', 'like', $term)
                        ->orWhereRaw('? like ?', [$role, $term]);
                });
            };

            $applySearch($driverEntries, 'driver_name', 'Driver');
            $applySearch($conductorEntries, 'conductor_name', 'Conductor');
        }

        return DB::query()->fromSub($driverEntries->unionAll($conductorEntries), 'fleet_shift_entries');
    }

    private function fleetShiftHistoryRangeBounds(?string $shiftRange): ?array
    {
        $now = Carbon::now();

        return match ($shiftRange) {
            'today' => [
                $now->copy()->startOfDay(),
                $now->copy()->endOfDay(),
            ],
            'last_7_days' => [
                $now->copy()->subDays(6)->startOfDay(),
                $now->copy()->endOfDay(),
            ],
            'this_month' => [
                $now->copy()->startOfMonth(),
                $now->copy()->endOfMonth(),
            ],
            default => null,
        };
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
            ->with($this->profileEagerLoads());

        // Leave out the requesting admin, in the query itself so the page
        // totals stay accurate.
        if (! empty($filters['exclude_id'])) {
            $query->whereKeyNot($filters['exclude_id']);
        }

        if (! empty($filters['active_only'])) {
            $query->where(function ($activeQuery) {
                $activeQuery
                    ->whereDoesntHave('commuterProfile')
                    ->orWhereHas('commuterProfile', function ($profileQuery) {
                        $profileQuery->whereNotIn('account_status', ['PENDING', 'REJECTED']);
                    });
            });
        }

        if (! empty($filters['role'])) {
            $query->where('role', $filters['role']);
        }

        if (! empty($filters['search'])) {
            $this->applySearch($query, trim($filters['search']));
        }

        // Current fare type, not the applied one; unknown values are ignored like other filters.
        if (in_array($filters['commuter_type'] ?? null, ['REGULAR', 'STUDENT', 'SENIOR', 'PWD'], true)) {
            $query->whereHas('commuterProfile', fn (Builder $profile) => $profile->where('commuter_type', $filters['commuter_type']));
        }

        // SUSPENDED is the "blocked" filter: suspended accounts plus disabled
        // conductors (a conductor's only block mechanism).
        if (! empty($filters['account_status'])) {
            if ($filters['account_status'] === 'SUSPENDED') {
                $query->where(function (Builder $statusQuery) {
                    $statusQuery->whereHas('activeSuspension')
                        ->orWhereHas('commuterProfile', fn (Builder $profile) => $profile->where('account_status', 'SUSPENDED'))
                        ->orWhereHas('conductorProfile', fn (Builder $profile) => $profile->where('status', 'DISABLED'));
                });
            } else {
                $query->whereDoesntHave('activeSuspension')
                    ->whereDoesntHave('conductorProfile', fn (Builder $profile) => $profile->where('status', 'DISABLED'))
                    ->where(function (Builder $statusQuery) {
                        $statusQuery->whereDoesntHave('commuterProfile')
                            ->orWhereHas('commuterProfile', fn (Builder $profile) => $profile->whereIn('account_status', ['ACTIVE', 'APPROVED']));
                    });
            }
        }

        $sort = $filters['sort'] ?? 'recent';
        if ($sort === 'oldest') {
            $query->orderBy('created_at', 'asc');
        } elseif ($sort === 'alphabetical') {
            $query
                ->orderByRaw('COALESCE(
                    (SELECT surname FROM commuter_profiles WHERE commuter_profiles.id = users.id),
                    (SELECT last_name FROM conductor_profiles WHERE conductor_profiles.id = users.id),
                    users.email
                ) ASC')
                ->orderBy('email', 'asc');
        } else {
            $query->orderBy('created_at', 'desc');
        }

        return $query->paginate($perPage)
            ->withQueryString()
            ->through(fn (User $user) => $this->present($user));
    }

    /**
     * GET /admin/drivers?page=… — paginated/filterable/searchable driver
     * list for User Management's "Drivers" role filter.
     *
     * Only reached when the request includes a `page` param (see
     * AdminController::drivers()) — every other GET /admin/drivers caller
     * (Fleet Management, Lost & Found pickers, personnel dropdowns, …) keeps
     * getting the full unpaginated list they already rely on, unchanged.
     */
    public function listDrivers(array $filters): LengthAwarePaginator
    {
        $perPage = (int) ($filters['per_page'] ?? 20);
        $perPage = max(1, min($perPage, 100));

        $query = Driver::with('vehicle');

        if (! empty($filters['search'])) {
            foreach ($this->searchWords($filters['search']) as $word) {
                $term = '%'.$word.'%';
                $query->where(function (Builder $q) use ($term) {
                    $q->where('first_name', 'like', $term)
                        ->orWhere('middle_name', 'like', $term)
                        ->orWhere('last_name', 'like', $term)
                        ->orWhere('contact', 'like', $term)
                        ->orWhere('license_number', 'like', $term);
                });
            }
        }

        if (! empty($filters['status'])) {
            if ($filters['status'] === 'ACTIVE') {
                $query->where('status', 'ACTIVE');
            } else {
                // Mirrors the frontend's own "anything not ACTIVE reads as
                // Suspended" convention (see mapDriverToActiveUser client-side).
                $query->where(function (Builder $q) {
                    $q->whereNull('status')->orWhere('status', '!=', 'ACTIVE');
                });
            }
        }

        $sort = $filters['sort'] ?? 'recent';
        if ($sort === 'oldest') {
            $query->orderBy('created_at', 'asc');
        } elseif ($sort === 'alphabetical') {
            $query->orderBy('last_name', 'asc')->orderBy('first_name', 'asc');
        } else {
            $query->orderBy('created_at', 'desc');
        }

        return $query->paginate($perPage)->withQueryString();
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

        $commuterOnly = array_intersect_key($data, array_flip(['account_status', 'contact_number', 'birthdate']));

        if (! empty($commuterOnly) && ! $user->isCommuter()) {
            throw ValidationException::withMessages([
                'account_status' => ['Account status, contact number and date of birth can only be set on commuter accounts.'],
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

        if (array_key_exists('birthdate', $data)) {
            $profile->birthdate = $data['birthdate'];
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

        // Last-admin is checked first: with a single admin the target is
        // always the caller, so checking self first made this guard
        // unreachable and hid the more important reason for the refusal.
        if ($user->isAdmin() && $this->activeAdminCount() <= 1) {
            throw ValidationException::withMessages([
                'user' => ['Cannot delete the last administrator account.'],
            ]);
        }

        if ($user->id === $actingAdmin->id) {
            throw ValidationException::withMessages([
                'user' => ['You cannot delete your own account.'],
            ]);
        }

        $user->delete();

        return true;
    }

    public function suspendUser(string $id, array $data, User $actingAdmin): array
    {
        $user = User::with($this->profileEagerLoads())->find($id);

        if (! $user) {
            abort(404, 'User not found.');
        }

        if ($user->id === $actingAdmin->id) {
            throw ValidationException::withMessages([
                'user' => ['You cannot suspend your own account.'],
            ]);
        }

        // Conductors have one block mechanism: Disable Account
        // (AdminController::disableConductor), which re-checks the admin's
        // password and refuses during an active shift. A suspension here
        // would skip both checks.
        if ($user->isConductor()) {
            throw ValidationException::withMessages([
                'user' => ['Conductors cannot be suspended. Use Disable Account instead.'],
            ]);
        }

        $endsAt = ! empty($data['is_permanent'])
            ? null
            : Carbon::now()->addDays((int) $data['duration_days']);

        DB::transaction(function () use ($user, $data, $actingAdmin, $endsAt) {
            UserSuspension::where('user_id', $user->id)
                ->whereNull('lifted_at')
                ->update([
                    'lifted_at' => now(),
                    'lifted_by' => $actingAdmin->id,
                ]);

            UserSuspension::create([
                'user_id' => $user->id,
                'reason_code' => $data['reason_code'],
                'reason' => $data['reason'],
                'starts_at' => now(),
                'ends_at' => $endsAt,
                'is_permanent' => (bool) ($data['is_permanent'] ?? false),
                'suspended_by' => $actingAdmin->id,
            ]);

            $user->tokens()->delete();
        });

        return $this->present($user->fresh()->load($this->profileEagerLoads()));
    }

    public function unsuspendUser(string $id, User $actingAdmin): array
    {
        $user = User::with($this->profileEagerLoads())->find($id);

        if (! $user) {
            abort(404, 'User not found.');
        }

        if ($user->isConductor()) {
            throw ValidationException::withMessages([
                'user' => ['A disabled conductor is re-enabled by resetting their credentials in Fleet Management.'],
            ]);
        }

        DB::transaction(function () use ($user, $actingAdmin) {
            UserSuspension::where('user_id', $user->id)
                ->whereNull('lifted_at')
                ->update([
                    'lifted_at' => now(),
                    'lifted_by' => $actingAdmin->id,
                ]);

            if ($user->isCommuter() && $user->commuterProfile?->account_status === 'SUSPENDED') {
                $user->commuterProfile->update(['account_status' => 'ACTIVE']);
            }
        });

        return $this->present($user->fresh()->load($this->profileEagerLoads()));
    }

    public function suspensionHistory(string $id): array
    {
        $user = User::findOrFail($id);

        return $user->suspensions()
            ->latest('starts_at')
            ->get()
            ->map(fn (UserSuspension $suspension) => $this->presentSuspension($suspension))
            ->all();
    }

    // ── Internals ────────────────────────────────────────────────

    private function profileEagerLoads(): array
    {
        return [
            'adminProfile:id,first_name,middle_name,last_name,profile_picture_url',
            'conductorProfile:id,first_name,middle_name,last_name,generated_username,status,profile_picture_url',
            'commuterProfile:id,first_name,middle_name,suffix,surname,birthdate,gender,contact_number,commuter_type,applied_type,account_status,verified_at,username,id_image_url,profile_image_url,student_discount_expires_at',
            'activeSuspension',
        ];
    }

    private function applySearch($query, string $term): void
    {
        foreach ($this->searchWords($term) as $word) {
            $like = '%'.$word.'%';

            $query->where(function ($q) use ($like) {
                $q->where('email', 'like', $like)
                    ->orWhereHas('adminProfile', fn ($p) => $p
                        ->where('first_name', 'like', $like)
                        ->orWhere('middle_name', 'like', $like)
                        ->orWhere('last_name', 'like', $like))
                    ->orWhereHas('conductorProfile', fn ($p) => $p
                        ->where('first_name', 'like', $like)
                        ->orWhere('middle_name', 'like', $like)
                        ->orWhere('last_name', 'like', $like)
                        ->orWhere('generated_username', 'like', $like))
                    ->orWhereHas('commuterProfile', fn ($p) => $p
                        ->where('first_name', 'like', $like)
                        ->orWhere('middle_name', 'like', $like)
                        ->orWhere('surname', 'like', $like)
                        ->orWhere('suffix', 'like', $like)
                        ->orWhere('username', 'like', $like));
            });
        }
    }

    /**
     * Split a search box value into words. A full name lives across separate
     * first/middle/last columns, so matching the whole phrase against any one
     * column finds nothing ("vice ganda"); instead every word has to match at
     * least one searched column, in any order.
     *
     * @return list<string>
     */
    private function searchWords(string $search): array
    {
        return preg_split('/\s+/', trim($search), -1, PREG_SPLIT_NO_EMPTY) ?: [];
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

        // A conductor's status is the Disable Account flag, never a suspension.
        $isConductor = $user->isConductor();
        $suspension = $isConductor ? null : $user->activeSuspension;
        $accountStatus = $isConductor
            ? ($user->conductorProfile?->status === 'DISABLED' ? 'DISABLED' : 'ACTIVE')
            : ($suspension ? 'SUSPENDED' : $commuter?->account_status);
        $profileImageUrl = match ($user->role) {
            UserRole::ADMIN => $user->adminProfile?->profile_picture_url,
            UserRole::CONDUCTOR => $user->conductorProfile?->profile_picture_url,
            UserRole::COMMUTER => $commuter?->profile_image_url,
        };

        return [
            'id' => $user->id,
            'email' => $user->email,
            'role' => $user->role->value,
            'name' => $user->getDisplayName(),
            'profile_image_url' => $profileImageUrl,
            'first_name' => $commuter?->first_name,
            'middle_name' => $commuter?->middle_name,
            'suffix' => $commuter?->suffix,
            'last_name' => $commuter?->surname,
            'account_status' => $accountStatus,
            'student_renewal_required' => $commuter && ! $suspension && app(StudentRenewalService::class)->isForRenewal($commuter),
            'commuter_type' => $commuter?->commuter_type,
            'applied_type' => $commuter?->applied_type,
            'username' => $commuter?->username,
            'contact_number' => $commuter?->contact_number,
            'birthdate' => optional($commuter?->birthdate)->toDateString(),
            'gender' => $commuter?->gender,
            'id_image_url' => $this->registrationIdUrl($commuter?->id_image_url),
            'verified_at' => optional($commuter?->verified_at)->toIso8601String(),
            'created_at' => optional($user->created_at)->toIso8601String(),
            'suspension' => $suspension ? $this->presentSuspension($suspension) : null,
        ];
    }

    private function presentSuspension(UserSuspension $suspension): array
    {
        return [
            'id' => $suspension->id,
            'reason_code' => $suspension->reason_code,
            'reason' => $suspension->reason,
            'starts_at' => $suspension->starts_at?->toIso8601String(),
            'ends_at' => $suspension->ends_at?->toIso8601String(),
            'is_permanent' => $suspension->is_permanent,
            'lifted_at' => $suspension->lifted_at?->toIso8601String(),
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
    public function listPendingRegistrations(array $filters = []): LengthAwarePaginator
    {
        $perPage = max(1, min((int) ($filters['per_page'] ?? 15), 100));
        // Oldest first (FIFO review queue) unless the admin asks for most recent.
        $direction = ($filters['sort'] ?? 'oldest') === 'recent' ? 'desc' : 'asc';

        $paginator = User::where('role', UserRole::COMMUTER)
            ->whereHas('commuterProfile', function ($q) {
                $q->where('account_status', 'PENDING');
            })
            ->when($filters['applied_type'] ?? null, function (Builder $query, string $type) {
                $query->whereHas('commuterProfile', fn (Builder $profile) => $profile->where('applied_type', $type));
            })
            ->when($filters['id'] ?? null, function (Builder $query, string $id) {
                $query->where('users.id', $id);
            })
            ->when($filters['search'] ?? null, function (Builder $query, string $search) {
                $this->applySearch($query, trim($search));
            })
            ->with([
                'commuterProfile:id,first_name,middle_name,surname,birthdate,gender,email,contact_number,commuter_type,applied_type,account_status,id_image_url,profile_image_url,verified_at,rejection_reason,username,language_preference',
                // School details a Student filed at sign-up, reviewed here with the ID.
                'commuterProfile.discountApplications' => fn ($query) => $query
                    ->where('request_type', 'APPLICATION')
                    ->where('requested_type', 'STUDENT')
                    ->where('status', 'PENDING')
                    ->select(['id', 'commuter_id', 'school_name', 'education_level', 'grade_level', 'school_year', 'enrollment_term']),
            ])
            ->orderBy('users.created_at', $direction)
            // created_at has second precision; the id tie-breaker keeps
            // same-second sign-ups in a fixed order so paging never repeats
            // or skips an applicant, and 'recent' is the exact reverse of 'oldest'.
            ->orderBy('users.id', $direction)
            ->paginate($perPage);

        // Batch-fetch rejection history for every applicant on this page in
        // one query instead of one `registration_rejections` query per row
        // (previously via registrationGuard->historyFor()/rejectionCountFor()
        // inside the ->through() callback below).
        $historyByUser = $this->registrationGuard->historyForMany(
            $paginator->getCollection()->map(fn (User $user) => [
                'key' => $user->id,
                'email' => $user->email,
                'contact' => $user->commuterProfile?->contact_number,
            ])
        );

        return $paginator->through(function (User $user) use ($historyByUser) {
            $c = $user->commuterProfile;
            $rows = $historyByUser[$user->id] ?? collect();
            $history = $this->registrationHistoryPayloadFromRows($rows);
            $school = $c?->discountApplications->first();

            return [
                // Null for non-students and for sign-ups made before school details were asked.
                'student_details' => $school?->only(['school_name', 'education_level', 'grade_level', 'school_year', 'enrollment_term']),
                'id' => $user->id,
                'email' => $user->email,
                'first_name' => $c?->first_name,
                'middle_name' => $c?->middle_name,
                'surname' => $c?->surname,
                'birthdate' => $c?->birthdate?->toDateString(),
                'gender' => $c?->gender,
                'contact_number' => $c?->contact_number,
                'username' => $c?->username,
                'applied_type' => $c?->applied_type,
                'id_image_url' => $this->registrationIdUrl($c?->id_image_url),
                'profile_image_url' => $c?->profile_image_url,
                'account_status' => $c?->account_status,
                'language_preference' => $c?->language_preference,
                'verified_at' => $c?->verified_at?->toIso8601String(),
                'rejection_reason' => $c?->rejection_reason,
                // How many times this applicant's identity (email/contact)
                // has previously been rejected — surfaced so admins can spot
                // repeat submissions approaching the cooldown threshold.
                'rejection_count' => $rows->count(),
                'rejection_history' => $history['history'],
                'blocked_until' => $history['blocked_until'],
                'created_at' => optional($user->created_at)->toIso8601String(),
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
    public function listRejectedRegistrations(array $filters = []): LengthAwarePaginator
    {
        $perPage = max(1, min((int) ($filters['per_page'] ?? 15), 100));

        $paginator = User::withTrashed()
            ->where('role', UserRole::COMMUTER)
            ->whereHas('commuterProfile', function ($q) {
                $q->where('account_status', 'REJECTED');
            })
            ->when($filters['applied_type'] ?? null, function (Builder $query, string $type) {
                $query->whereHas('commuterProfile', fn (Builder $profile) => $profile->where('applied_type', $type));
            })
            ->when($filters['search'] ?? null, function (Builder $query, string $search) {
                foreach ($this->searchWords($search) as $word) {
                    $term = '%'.$word.'%';
                    $query->whereHas('commuterProfile', fn (Builder $profile) => $profile
                        ->where('first_name', 'like', $term)
                        ->orWhere('middle_name', 'like', $term)
                        ->orWhere('surname', 'like', $term)
                        ->orWhere('suffix', 'like', $term)
                        ->orWhere('email', 'like', $term)
                        ->orWhere('contact_number', 'like', $term)
                        ->orWhere('rejection_reason', 'like', $term));
                }
            })
            ->with(['commuterProfile:id,first_name,middle_name,surname,birthdate,gender,email,contact_number,commuter_type,applied_type,account_status,id_image_url,profile_image_url,verified_at,rejection_reason,username,language_preference'])
            ->orderBy('updated_at', 'desc') // most recently rejected first
            ->paginate($perPage);

        // Batch-fetch rejection history for the whole page in one query —
        // see the matching comment in listPendingRegistrations() above.
        $historyByUser = $this->registrationGuard->historyForMany(
            $paginator->getCollection()->map(fn (User $user) => [
                'key' => $user->id,
                'email' => $user->commuterProfile?->email,
                'contact' => $user->commuterProfile?->contact_number,
            ])
        );

        // Who rejected THIS specific account (for the "Reject By" column) —
        // matched by rejected_user_id, which is exact, unlike the identity
        // (email/contact) matching historyForMany uses to span an applicant's
        // full history across re-registrations. One extra query for the whole
        // page (not per-row) via a direct whereIn, kept separate from
        // RegistrationGuard so the identity-matching path used by the Pending
        // tab is untouched.
        $pageUserIds = $paginator->getCollection()->pluck('id');
        $rejectorByUserId = $pageUserIds->isEmpty()
            ? collect()
            : RegistrationRejection::query()
                ->whereIn('rejected_user_id', $pageUserIds)
                ->with(['rejectedBy:id,email', 'rejectedBy.adminProfile:id,first_name,middle_name,last_name'])
                ->get(['id', 'rejected_user_id', 'rejected_by'])
                ->keyBy('rejected_user_id');

        return $paginator->through(function (User $user) use ($historyByUser, $rejectorByUserId) {
            $c = $user->commuterProfile;
            $rows = $historyByUser[$user->id] ?? collect();
            $history = $this->registrationHistoryPayloadFromRows($rows);

            $rejector = $rejectorByUserId->get($user->id)?->rejectedBy;
            $rejectorProfile = $rejector?->adminProfile;

            return [
                'id' => $user->id,
                'email' => $c?->email ?? $user->email,
                'first_name' => $c?->first_name,
                'middle_name' => $c?->middle_name,
                'surname' => $c?->surname,
                'birthdate' => $c?->birthdate?->toDateString(),
                'gender' => $c?->gender,
                'contact_number' => $c?->contact_number,
                'username' => $c?->username,
                'applied_type' => $c?->applied_type,
                'id_image_url' => $this->registrationIdUrl($c?->id_image_url),
                'profile_image_url' => $c?->profile_image_url,
                'account_status' => $c?->account_status,
                'language_preference' => $c?->language_preference,
                'verified_at' => $c?->verified_at?->toIso8601String(),
                'rejection_reason' => $c?->rejection_reason,
                'rejection_count' => $rows->count(),
                'rejection_history' => $history['history'],
                'blocked_until' => $history['blocked_until'],
                'created_at' => optional($user->created_at)->toIso8601String(),
                'rejected_at' => optional($user->deleted_at)->toIso8601String(),
                'rejected_by_name' => $rejectorProfile
                    ? trim($rejectorProfile->first_name.' '.$rejectorProfile->last_name)
                    : null,
                'rejected_by_email' => $rejector?->email,
            ];
        });
    }

    /**
     * Builds the { history, blocked_until } payload from a Collection of
     * rejection rows already fetched by the caller — a batched lookup for a
     * whole page via RegistrationGuard::historyForMany(), so this doesn't
     * query `registration_rejections` again per row.
     */
    private function registrationHistoryPayloadFromRows(Collection $history): array
    {
        $activeBlock = $history->first(
            fn ($rejection) => $rejection->blocked_until?->isFuture()
        );

        return [
            'history' => $history->map(fn ($rejection) => [
                'reason' => $rejection->reason,
                'attempt_number' => $rejection->attempt_number,
                'blocked_until' => $rejection->blocked_until?->toIso8601String(),
                'rejected_at' => $rejection->created_at?->toIso8601String(),
            ])->values()->all(),
            'blocked_until' => $activeBlock?->blocked_until?->toIso8601String(),
        ];
    }

    /**
     * Return a short-lived URL for a private registration ID.
     * Existing absolute URLs are retained for backwards compatibility.
     */
    private function registrationIdUrl(?string $path): ?string
    {
        if (! $path || filter_var($path, FILTER_VALIDATE_URL)) {
            return $path;
        }

        $disk = config('filesystems.uploads.private_id_disk', 'r2_private');

        if ($disk === 'r2_private') {
            return Storage::disk($disk)->temporaryUrl(
                $path,
                now()->addMinutes(10)
            );
        }

        return Storage::disk($disk)->url($path);
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
            'id' => 'created',
            'timestamp' => optional($user->created_at)->toIso8601String(),
            'action' => 'Account Created',
            'details' => "Role: {$user->role->value}",
        ];

        // Commuter-specific events
        if ($user->commuterProfile) {
            $c = $user->commuterProfile;

            if ($c->verified_at) {
                $events[] = [
                    'id' => 'verified',
                    'timestamp' => $c->verified_at->toIso8601String(),
                    'action' => 'Account Verified',
                    'details' => "Commuter type: {$c->commuter_type}",
                ];
            }

            if ($c->account_status === 'REJECTED' && $c->rejection_reason) {
                $events[] = [
                    'id' => 'rejected',
                    'timestamp' => optional($user->deleted_at)->toIso8601String(),
                    'action' => 'Registration Rejected',
                    'details' => "Reason: {$c->rejection_reason}",
                ];
            }

            // Recent transactions (payment history)
            $transactions = Transaction::where('passenger_id', $c->id)
                ->orderBy('created_at', 'desc')
                ->limit(10)
                ->get();

            foreach ($transactions as $txn) {
                $events[] = [
                    'id' => "txn-{$txn->transaction_id}",
                    'timestamp' => optional($txn->created_at)->toIso8601String(),
                    'action' => 'Payment',
                    // payment_method/status are backed enums (PaymentMethod/
                    // PaymentStatus casts) — interpolate ->value, not the
                    // enum object itself (uncatchable TypeError otherwise).
                    'details' => "{$txn->payment_method->value} ₱{$txn->final_amount} — {$txn->pickup_name} → {$txn->dropoff_name} ({$txn->status->value})",
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
                    'id' => "shift-{$log->shift_id}",
                    'timestamp' => optional($log->time_in)->toIso8601String(),
                    'action' => $log->status === 'ACTIVE' ? 'Shift Started' : 'Shift Ended',
                    'details' => "Unit: {$log->unit_number} — {$log->driver_name}",
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
                'account_status' => ['This registration has already been processed (status: '.$profile->account_status.').'],
            ]);
        }

        DB::transaction(function () use ($profile): void {
            $profile->update([
                'commuter_type' => $profile->applied_type ?? 'REGULAR',
                'student_discount_expires_at' => $profile->applied_type === 'STUDENT' ? \App\Models\CommuterProfile::initialStudentExpiry() : null,
                'account_status' => 'APPROVED',
                'verified_at' => now(),
                'rejection_reason' => null,
            ]);
            $this->decideSignupStudentApplication($profile->id, 'APPROVED');
        });

        $fresh = $profile->fresh();

        // Send approval email to the commuter (best-effort — don't fail
        // the approval if the email can't be sent).
        $this->sendApprovalEmail($user, $fresh);

        return [
            'id' => $user->id,
            'email' => $user->email,
            'name' => $user->getDisplayName(),
            'commuter_type' => $fresh->commuter_type,
            'applied_type' => $fresh->applied_type,
            'account_status' => 'APPROVED',
            'verified_at' => $fresh->verified_at?->toIso8601String(),
            'rejection_reason' => null,
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
                'account_status' => ['This registration has already been processed (status: '.$profile->account_status.').'],
            ]);
        }

        // Record this rejection as a strike against the applicant's identity
        // (email + contact number) BEFORE the canonical email is rewritten.
        // Once the configured threshold is reached, this stamps a cooldown
        // (blocked_until) that AuthService::register / onsite store() enforce,
        // temporarily pausing re-registration. See App\Services\RegistrationGuard.
        $strike = $this->registrationGuard->recordRejection(
            email: $user->email,
            contact: $profile->contact_number,
            reason: $reason,
            rejectedUserId: $user->id,
            rejectedByAdminId: auth()->id(),
        );

        // Send rejection email to the commuter BEFORE rewriting the email
        // (best-effort — don't fail the rejection if the email can't be sent).
        // The strike carries the attempt number + any cooldown so the email can
        // tell the commuter whether they may re-register immediately.
        $this->sendRejectionEmail($user, $profile, $reason, $strike);

        // Rewrite the email to a unique placeholder BEFORE soft-deleting.
        // This frees the canonical email for re-registration (the users.email
        // column has a DB-level unique index that includes soft-deleted rows).
        // Key the placeholder on the user id (guaranteed unique) rather than a
        // timestamp — the same applicant can be rejected several times in quick
        // succession (they re-register between rejections), and a second-
        // precision timestamp would collide against the unique index.
        $placeholderEmail = 'rejected+'.$user->id.'@chatco.local';
        $user->update(['email' => $placeholderEmail]);

        // Free the username too. commuter_profiles.username has a DB-level
        // unique index, and the profile row is NOT soft-deleted (only the
        // User is), so the rejected applicant's username would otherwise stay
        // locked forever — blocking them (or anyone) from reusing it on a
        // fresh registration. Rewrite it to a unique placeholder keyed on the
        // user id (guaranteed unique, fits the 50-char column). The original
        // username isn't needed on a dead account — admins identify rejected
        // applicants by name/contact in the Rejected tab.
        $placeholderUsername = 'rejected_'.$user->id;

        $profile->update([
            'account_status' => 'REJECTED',
            'rejection_reason' => $reason,
            'username' => $placeholderUsername,
        ]);
        $this->decideSignupStudentApplication($profile->id, 'REJECTED', $reason);

        // Soft-delete the user (cascades to commuter_profile via shared PK).
        $user->delete();

        return [
            'id' => $user->id,
            'email' => $user->email, // placeholder
            'account_status' => 'REJECTED',
            'rejection_reason' => $reason,
            'attempt_number' => $strike->attempt_number,
            'blocked_until' => $strike->blocked_until?->toIso8601String(),
        ];
    }

    /**
     * Decide the Student application a self-signup files with its school
     * details (AuthService::register). It is reviewed together with the
     * registration, so it follows the registration's outcome. No-op for
     * other types and for sign-ups made before school details were asked.
     */
    private function decideSignupStudentApplication(string $commuterId, string $status, ?string $reason = null): void
    {
        DiscountApplication::where('commuter_id', $commuterId)
            ->where('request_type', 'APPLICATION')
            ->where('requested_type', 'STUDENT')
            ->where('status', 'PENDING')
            ->update([
                'status' => $status,
                'reason' => $reason,
                'reviewed_at' => now(),
                'reviewed_by' => auth()->id(),
            ]);
    }

    // ── Email helpers ──────────────────────────────────────────────

    /**
     * Default body copy for the approval email, used when an admin has never
     * saved `account_approved_template`. Deliberately message-only: the fare
     * type, verification date, and login button are rendered as UI by the
     * Blade view, so repeating them here would just duplicate the email.
     *
     * Keep in sync with initialAccountApprovedTemplate in the frontend's
     * settings-data.ts — the settings page writes its own default to the DB
     * on the first save, and the two shouldn't disagree.
     */
    private const DEFAULT_APPROVED_TEMPLATE =
        "Hi {name},\n\n"
        ."Great news — we've reviewed the ID you submitted and your CHATCO commuter account is now approved and active.\n\n"
        ."Log in with the email and password you registered with, and you're ready to ride.";

    /** Default body copy for the rejection email. See DEFAULT_APPROVED_TEMPLATE. */
    private const DEFAULT_REJECTED_TEMPLATE =
        "Hi {name},\n\n"
        ."Thanks for signing up with CHATCO. We've finished reviewing the ID attached to your commuter registration, "
        ."and unfortunately we weren't able to approve it this time.";

    /**
     * Send an approval notification email to the commuter.
     *
     * The prose comes from the admin-editable `account_approved_template`
     * setting; AccountApprovedMail wraps it in the branded HTML shell. The
     * fare-type row is suppressed when the admin's own template already prints
     * the type, so the commuter never reads it twice.
     *
     * Best-effort: errors are logged but never thrown — a mail outage must not
     * roll back an approval the admin already committed.
     */
    private function sendApprovalEmail(User $user, $profile): void
    {
        try {
            $template = Setting::where('key', 'account_approved_template')->value('value')
                ?: self::DEFAULT_APPROVED_TEMPLATE;

            $commuterType = $this->commuterTypeLabel($profile->commuter_type ?? 'REGULAR');
            $name = trim($profile->first_name.' '.$profile->surname);

            // {commuterName} / {rejectionReason} are the names the admin
            // settings page advertises; {name} / {reason} are the originals.
            // Both are accepted so a template saved under either vocabulary
            // still renders — an unsubstituted "{commuterName}" would otherwise
            // ship straight to the commuter's inbox.
            $body = strtr($template, [
                '{name}' => $name,
                '{commuterName}' => $name,
                '{commuter_type}' => $commuterType,
                '{commuterType}' => $commuterType,
            ]);

            Mail::to($user->email)->send(new AccountApprovedMail(
                body: $body,
                name: $name,
                email: $user->email,
                commuterType: $commuterType,
                verifiedAt: ($profile->verified_at ?? now())
                    ->timezone(config('app.timezone'))
                    ->format('M j, Y'),
                showCommuterType: ! $this->templateMentions($template, ['commuter_type', 'commuterType']),
            ));
        } catch (\Throwable $e) {
            Log::error('Failed to send approval email', [
                'error' => $e->getMessage(),
                'user_id' => $user->id,
            ]);
        }
    }

    /**
     * Send a rejection notification email to the commuter.
     *
     * Reads the `account_rejected_template` setting for the prose; the reason
     * callout, the "what to do next" block, and the cooldown banner are UI
     * rendered by AccountRejectedMail — each suppressed when the admin's
     * template already carries the matching placeholder inline.
     *
     * Best-effort: errors are logged but never thrown.
     */
    private function sendRejectionEmail(User $user, $profile, string $reason, ?RegistrationRejection $strike = null): void
    {
        try {
            $template = Setting::where('key', 'account_rejected_template')->value('value')
                ?: self::DEFAULT_REJECTED_TEMPLATE;

            // Tell the commuter what happens next: either re-register freely, or
            // (once the cooldown threshold is hit) wait out the pause.
            $isBlocked = (bool) ($strike && $strike->blocked_until);

            if ($isBlocked) {
                $retryDate = $strike->blocked_until
                    ->timezone(config('app.timezone'))
                    ->format('M j, Y \a\t g:i A');
                $nextSteps = "Because this registration has now been rejected {$strike->attempt_number} times, "
                    ."new sign-ups with this email or contact number are temporarily paused until {$retryDate} "
                    .'for security. Please try again after that date.';
            } else {
                $nextSteps = 'Fix what the reason above points to, then sign up again — there is no waiting period.';
            }

            $name = trim($profile->first_name.' '.$profile->surname);

            // See sendApprovalEmail() for why both placeholder vocabularies
            // are substituted.
            $body = strtr($template, [
                '{name}' => $name,
                '{commuterName}' => $name,
                '{reason}' => $reason,
                '{rejectionReason}' => $reason,
                '{next_steps}' => $nextSteps,
                '{nextSteps}' => $nextSteps,
            ]);

            Mail::to($user->email)->send(new AccountRejectedMail(
                body: $body,
                reason: $reason,
                nextSteps: $nextSteps,
                isBlocked: $isBlocked,
                showReason: ! $this->templateMentions($template, ['reason', 'rejectionReason']),
                showNextSteps: ! $this->templateMentions($template, ['next_steps', 'nextSteps']),
            ));
        } catch (\Throwable $e) {
            Log::error('Failed to send rejection email', [
                'error' => $e->getMessage(),
                'user_id' => $user->id,
            ]);
        }
    }

    /**
     * Whether an admin's template already prints one of these placeholders.
     *
     * Drives the "don't say it twice" rule: if the prose contains {reason},
     * the email skips its own reason callout. Checked against the RAW template
     * (before substitution), since afterwards the placeholder is gone.
     *
     * @param  string[]  $placeholders  Names without braces.
     */
    private function templateMentions(string $template, array $placeholders): bool
    {
        foreach ($placeholders as $placeholder) {
            if (str_contains($template, '{'.$placeholder.'}')) {
                return true;
            }
        }

        return false;
    }

    /** Human-readable label for a fare tier, for display in emails. */
    private function commuterTypeLabel(string $type): string
    {
        return match (strtoupper($type)) {
            'STUDENT' => 'Student',
            'SENIOR' => 'Senior citizen',
            'PWD' => 'PWD',
            default => 'Regular',
        };
    }
}
