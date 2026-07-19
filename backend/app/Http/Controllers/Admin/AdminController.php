<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreRouteRequest;
use App\Http\Requests\Admin\UpdateRouteRequest;
use App\Enums\UserRole;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\Remittance;
use App\Models\Route as RouteModel;
use App\Models\ShiftLog;
use App\Models\TerminatedPersonnel;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use App\Services\AdminService;
use App\Services\LocationService;
use App\Traits\ApiResponse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class AdminController extends Controller
{
    use ApiResponse;

    public function __construct(
        private AdminService $adminService,
        private LocationService $locationService
    ) {}

    public function dashboard(): JsonResponse
    {
        // Returns the same analytics summary as /admin/analytics (default
        // 30-day window) — the frontend dashboard page fetches /analytics
        // directly, but this endpoint exists for completeness and any future
        // dashboard-specific aggregations.
        $data = $this->adminService->analytics([]);

        return $this->successResponse($data, 'Dashboard data retrieved');
    }

    /**
     * GET /api/v1/admin/analytics?date_from=&date_to=
     * Aggregated business metrics from real DB tables (transactions,
     * remittances, vehicles, shift_logs). Supports optional date range
     * filtering; defaults to last 30 days.
     */
    public function analytics(Request $request): JsonResponse
    {
        $filters = [
            'date_from' => $request->string('date_from')->toString() ?: null,
            'date_to'   => $request->string('date_to')->toString() ?: null,
        ];

        $data = $this->adminService->analytics($filters);

        return $this->successResponse($data, 'Analytics retrieved');
    }

    /**
     * GET /api/v1/admin/monitoring
     * Returns the live fleet monitoring view: all vehicles with an ACTIVE
     * shift, their latest GPS position, capacity status, speed, driver +
     * conductor names, and a `is_stale` flag (true if the last location
     * update was more than 10 minutes ago).
     *
     * Designed for 5-second polling from the admin monitoring dashboard.
     */
    public function monitoring(): JsonResponse
    {
        $fleet = $this->locationService->getMonitoringFleet();

        return $this->successResponse($fleet, 'Live fleet retrieved');
    }

    /**
     * GET /api/v1/admin/monitoring/overspeed
     * Returns the persisted overspeeding history (one incident per shift,
     * recorded live as vehicles exceed the speed limit).
     */
    public function overspeed(Request $request): JsonResponse
    {
        $history = $this->locationService->getOverspeedHistory();

        return $this->successResponse($history, 'Overspeeding history retrieved');
    }

    public function drivers(): JsonResponse
    {
        $drivers = Driver::with('vehicle')->get();

        return $this->successResponse($drivers, 'Drivers retrieved');
    }

    /**
     * POST /api/v1/admin/drivers
     * Creates a new driver.
     *
     * Required fields: first_name, last_name, birthday, contact, license_number.
     * Optional: middle_name, profile_picture_url.
     * hire_date defaults to today (admin can edit later if backdating).
     */
    public function storeDriver(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'first_name' => 'required|string|max:100',
            'middle_name' => 'nullable|string|max:100',
            'last_name' => 'required|string|max:100',
            'birthday' => 'required|date|before:today',
            'contact' => 'required|string|max:20',
            'license_number' => 'required|string|max:50|unique:drivers,license_number',
            'profile_picture_url' => 'nullable|string|max:500',
        ]);

        $driver = Driver::create([
            'first_name' => $validated['first_name'],
            'middle_name' => $validated['middle_name'] ?? null,
            'last_name' => $validated['last_name'],
            'birthday' => $validated['birthday'],
            'contact' => $validated['contact'],
            'license_number' => $validated['license_number'],
            'hire_date' => now()->toDateString(),
            'profile_picture_url' => $validated['profile_picture_url'] ?? null,
            'status' => 'ACTIVE',
        ]);

        $driver->load(['vehicle']);

        return $this->successResponse($driver, 'Driver created successfully', 201);
    }

    /**
     * PUT/PATCH /api/v1/admin/drivers/{id}
     * Updates an existing driver.
     *
     * Required fields: first_name, last_name, birthday, contact, license_number.
     * Optional: middle_name, profile_picture_url.
     */
    public function updateDriver(Request $request, string $id): JsonResponse
    {
        $driver = Driver::findOrFail($id);

        $validated = $request->validate([
            'first_name' => 'required|string|max:100',
            'middle_name' => 'nullable|string|max:100',
            'last_name' => 'required|string|max:100',
            'birthday' => 'required|date|before:today',
            'contact' => 'required|string|max:20',
            'license_number' => 'required|string|max:50|unique:drivers,license_number,' . $id,
            'profile_picture_url' => 'nullable|string|max:500',
        ]);

        $driver->update([
            'first_name' => $validated['first_name'],
            'middle_name' => $validated['middle_name'] ?? null,
            'last_name' => $validated['last_name'],
            'birthday' => $validated['birthday'],
            'contact' => $validated['contact'],
            'license_number' => $validated['license_number'],
            'profile_picture_url' => $validated['profile_picture_url'] ?? $driver->profile_picture_url,
        ]);

        $driver->load(['vehicle']);

        return $this->successResponse($driver, 'Driver updated successfully');
    }

    /**
     * GET /api/v1/admin/drivers/{id}
     * Returns a single driver with full details for the profile modal.
     * Includes: vehicle assignment, recent shift logs (assignment history).
     */
    public function showDriver(string $id): JsonResponse
    {
        $driver = Driver::with(['vehicle.route', 'vehicle.conductor'])
            ->findOrFail($id);

        // Fetch recent shift logs for this driver (assignment history).
        $shiftLogs = ShiftLog::with(['vehicle', 'route'])
            ->where('driver_id', $id)
            ->orderBy('time_in', 'desc')
            ->limit(20)
            ->get();

        $data = [
            'id' => $driver->id,
            'first_name' => $driver->first_name,
            'middle_name' => $driver->middle_name,
            'last_name' => $driver->last_name,
            'birthday' => $driver->birthday?->toDateString(),
            'contact' => $driver->contact,
            'license_number' => $driver->license_number,
            'hire_date' => $driver->hire_date?->toDateString(),
            'profile_picture_url' => $driver->profile_picture_url,
            'status' => $driver->status,
            'vehicle' => $driver->vehicle ? [
                'id' => $driver->vehicle->id,
                'unit_number' => $driver->vehicle->unit_number,
                'plate_number' => $driver->vehicle->plate_number,
                'route' => $driver->vehicle->route?->name,
            ] : null,
            'conductor_partner' => $driver->vehicle?->conductor ? [
                'id' => $driver->vehicle->conductor->id,
                'name' => trim(($driver->vehicle->conductor->first_name ?? '') . ' ' . ($driver->vehicle->conductor->last_name ?? '')),
            ] : null,
            'assigned_route' => $driver->vehicle?->route?->name ?? 'Malolos - Meycauayan - Calumpit',
            'shift_logs' => $shiftLogs->map(function ($log) {
                return [
                    'shift_id' => $log->shift_id,
                    'unit_number' => $log->unit_number,
                    'plate_number' => $log->plate_number,
                    'route' => $log->route?->name,
                    'time_in' => $log->time_in?->toDateTimeString(),
                    'time_out' => $log->time_out?->toDateTimeString(),
                    'status' => $log->status,
                ];
            }),
        ];

        return $this->successResponse($data, 'Driver details retrieved');
    }

    /**
     * DELETE /api/v1/admin/drivers/{id}
     * Soft-deletes a driver AND records the termination in terminated_personnel.
     *
     * Request body (JSON):
     *   - reason (required, string) — why the driver is being removed
     *   - termination_type (required, 'TERMINATED' | 'RESIGNED')
     *
     * If the driver currently has an active_shift_id, we reject with 409 so
     * the conductor's active shift is never orphaned — same pattern as
     * vehicle deletion.
     *
     * We capture the driver's name, contact, and last assigned vehicle
     * BEFORE soft-deleting, so the terminated_personnel record is immutable
     * even if the underlying driver row is later purged.
     */
    public function destroyDriver(Request $request, string $id): JsonResponse
    {
        $validated = $request->validate([
            'reason' => 'required|string|max:1000',
            'termination_type' => ['required', Rule::in(['TERMINATED', 'RESIGNED'])],
        ]);

        $driver = Driver::with('vehicle')->findOrFail($id);

        if ($driver->active_shift_id) {
            return response()->json([
                'success' => false,
                'data'    => null,
                'message' => 'Conflict',
                'errors'  => [
                    'driver' => [
                        'Cannot remove a driver who is currently on an active shift. ' .
                        'End the shift (via conductor remittance) before removing this driver.',
                    ],
                ],
                'meta'    => null,
            ], 409);
        }

        $fullName = trim(($driver->first_name ?? '') . ' ' . ($driver->last_name ?? ''));
        $lastVehicle = $driver->vehicle
            ? ($driver->vehicle->unit_number ?: $driver->vehicle->plate_number)
            : null;

        // Record the termination BEFORE the soft-delete so we capture the
        // driver's current state (name/contact/last vehicle). Wrap in a
        // transaction so we never end up with a terminated_personnel row
        // pointing at a driver that wasn't actually deleted (or vice versa).
        DB::transaction(function () use ($driver, $fullName, $lastVehicle, $validated) {
            TerminatedPersonnel::create([
                'personnel_id'      => $driver->id,
                'personnel_type'    => 'DRIVER',
                'name'              => $fullName ?: 'Unknown Driver',
                'role'              => 'Driver',
                'contact'           => $driver->contact,
                'reason'            => $validated['reason'],
                'termination_type'  => $validated['termination_type'],
                'terminated_date'   => now()->toDateString(),
                'last_vehicle'      => $lastVehicle,
            ]);
            $driver->delete();
        });

        return $this->successResponse(null, 'Driver removed successfully');
    }

    /**
     * DELETE /api/v1/admin/conductors/{id}
     * Soft-deletes a conductor's user account AND records the termination.
     *
     * This is SEPARATE from the generic DELETE /admin/users/{id} because the
     * Fleet Management "Remove Personnel" flow captures a reason +
     * termination_type that needs to be persisted. The generic user delete
     * (AdminUserController::destroy → AdminService::deleteUser) is for
     * admin/commuter account management and doesn't track termination context.
     *
     * conductor_profile.id is the shared PK with users.id, so soft-deleting
     * the user cascades to the conductor profile (same PK).
     */
    public function destroyConductor(Request $request, string $id): JsonResponse
    {
        $validated = $request->validate([
            'reason' => 'required|string|max:1000',
            'termination_type' => ['required', Rule::in(['TERMINATED', 'RESIGNED'])],
        ]);

        $conductor = ConductorProfile::with('vehicle')->findOrFail($id);
        $user = User::find($id);

        if (! $user) {
            return $this->errorResponse('Conductor user account not found.', 404);
        }

        // Prevent self-deletion (same guard as AdminService::deleteUser).
        if ($request->user() && $request->user()->id === $user->id) {
            return response()->json([
                'success' => false,
                'data'    => null,
                'message' => 'Validation failed',
                'errors'  => ['user' => ['You cannot remove your own account.']],
                'meta'    => null,
            ], 422);
        }

        // If the conductor is currently on an active shift, reject — the
        // active_shift_id lives on the vehicle, so we check the conductor's
        // assigned vehicle.
        if ($conductor->vehicle && $conductor->vehicle->active_shift_id) {
            return response()->json([
                'success' => false,
                'data'    => null,
                'message' => 'Conflict',
                'errors'  => [
                    'conductor' => [
                        'Cannot remove a conductor who is currently on an active shift. ' .
                        'End the shift (via conductor remittance) before removing this conductor.',
                    ],
                ],
                'meta'    => null,
            ], 409);
        }

        $fullName = trim(($conductor->first_name ?? '') . ' ' . ($conductor->last_name ?? ''));
        $lastVehicle = $conductor->vehicle
            ? ($conductor->vehicle->unit_number ?: $conductor->vehicle->plate_number)
            : null;

        DB::transaction(function () use ($user, $conductor, $fullName, $lastVehicle, $validated) {
            TerminatedPersonnel::create([
                'personnel_id'      => $conductor->id,
                'personnel_type'    => 'CONDUCTOR',
                'name'              => $fullName ?: 'Unknown Conductor',
                'role'              => 'Conductor',
                'contact'           => null,
                'reason'            => $validated['reason'],
                'termination_type'  => $validated['termination_type'],
                'terminated_date'   => now()->toDateString(),
                'last_vehicle'      => $lastVehicle,
            ]);
            // Revoke ALL tokens BEFORE soft-deleting — so the conductor is
            // instantly logged out everywhere and can't use the account.
            $user->tokens()->delete();
            // Soft-deletes the user — cascades to conductor_profile via shared PK.
            $user->delete();
        });

        return $this->successResponse(null, 'Conductor removed successfully');
    }

    /**
     * POST /api/v1/admin/conductors/{id}/disable
     *
     * Manually disables a conductor's account WITHOUT terminating them.
     * Revokes all Sanctum tokens (instant logout — can't log in again until
     * re-enabled). Does NOT soft-delete the user or create a terminated_personnel
     * record. Useful for temporary suspensions (e.g. investigation).
     *
     * To re-enable, the admin uses PUT /admin/users/{id} to set account_status
     * back to ACTIVE (or simply generates new credentials via reset-credentials).
     */
    public function disableConductor(string $id): JsonResponse
    {
        $conductor = ConductorProfile::with('user')->findOrFail($id);
        $user = $conductor->user;

        if (! $user) {
            return $this->errorResponse('Conductor user account not found.', 404);
        }

        // Reject if the conductor is currently on an active shift.
        if ($conductor->vehicle && $conductor->vehicle->active_shift_id) {
            return response()->json([
                'success' => false,
                'data'    => null,
                'message' => 'Conflict',
                'errors'  => [
                    'conductor' => [
                        'Cannot disable a conductor who is currently on an active shift. ' .
                        'End the shift first.',
                    ],
                ],
                'meta'    => null,
            ], 409);
        }

        // Revoke ALL tokens — the conductor is instantly logged out everywhere.
        $user->tokens()->delete();

        return $this->successResponse(null, 'Conductor account disabled. All sessions revoked.');
    }

    /**
     * POST /api/v1/admin/conductors/{id}/reset-credentials
     *
     * Regenerates the conductor's username + password. The new credentials
     * are returned ONCE in the response (same as storeConductor) so the admin
     * can hand them to the conductor. All existing Sanctum tokens for the
     * user are revoked (the conductor must log in with the new credentials).
     */
    public function resetConductorCredentials(string $id): JsonResponse
    {
        $conductor = ConductorProfile::with('user')->findOrFail($id);
        $user = $conductor->user;

        if (! $user) {
            return $this->errorResponse('Conductor user account not found.', 404);
        }

        // Regenerate credentials using the same deterministic algorithm as storeConductor.
        $firstName = $conductor->first_name ?? '';
        $lastName = $conductor->last_name ?? '';
        $birthday = $conductor->birthday?->toDateString() ?? '2000-01-01';

        $firstNameTrimmed = trim($firstName);
        $generatedUsername = strtolower(
            substr($firstNameTrimmed, 0, 1) . '.' . preg_replace('/\s+/', '', $lastName)
        );

        $birthdayFormatted = \Carbon\Carbon::parse($birthday)->format('mdY');
        $firstNameParts = preg_split('/\s+/', $firstNameTrimmed);
        $firstPart = strtolower($firstNameParts[0]);
        $restParts = implode('', array_map('strtolower', array_slice($firstNameParts, 1)));
        $generatedPassword = $firstPart . '.' . $restParts . $birthdayFormatted;

        // Ensure username uniqueness — append a number if taken.
        $originalUsername = $generatedUsername;
        $counter = 1;
        while (User::where('email', $generatedUsername . '@chatco.local')
            ->where('id', '!=', $user->id)
            ->exists()) {
            $generatedUsername = $originalUsername . $counter;
            $counter++;
        }

        // Update the user's password + email (derived from username).
        $user->update([
            'email' => $generatedUsername . '@chatco.local',
            'password' => $generatedPassword,
        ]);

        // Update the conductor profile with the new credentials.
        $conductor->update([
            'generated_username' => $generatedUsername,
            'generated_password' => $generatedPassword,
        ]);

        // Revoke ALL tokens — the conductor must re-login with the new credentials.
        $user->tokens()->delete();

        return $this->successResponse([
            'id' => $conductor->id,
            'first_name' => $conductor->first_name,
            'last_name' => $conductor->last_name,
            'generated_username' => $generatedUsername,
            'generated_password' => $generatedPassword,
        ], 'Credentials reset successfully. The conductor must log in with the new credentials.');
    }

    /**
     * GET /api/v1/admin/terminated-personnel
     * Lists all terminated personnel records, newest first. Powers the
     * "Separated Personnel" section of the Fleet Management Records & History tab.
     */
    public function terminatedPersonnel(Request $request): JsonResponse
    {
        $perPage = (int) $request->integer('per_page', 50);

        $records = TerminatedPersonnel::query()
            ->orderBy('terminated_date', 'desc')
            ->orderBy('created_at', 'desc')
            ->paginate($perPage);

        return $this->successResponse($records, 'Terminated personnel retrieved');
    }

    /**
     * GET /api/v1/admin/users/{id}/activity
     * Returns a chronological activity timeline for a user. Reuses existing
     * data sources (transactions, shift_logs, verification dates) instead of
     * a separate audit_logs table. Powers the User History modal.
     */
    public function userActivity(string $id): JsonResponse
    {
        $events = $this->adminService->getUserActivity($id);

        return $this->successResponse($events, 'User activity retrieved');
    }

    /**
     * PUT/PATCH /api/v1/admin/conductors/{id}
     * Updates a conductor's editable profile fields.
     *
     * Editable: first_name, middle_name, last_name, birthday, profile_picture_url.
     * NOT editable here: generated_username, generated_password (regenerate-
     * credentials is a separate flow — see G7 in the admin audit).
     *
     * Mirrors the updateDriver validation rules + transactional pattern.
     */
    public function updateConductor(Request $request, string $id): JsonResponse
    {
        $conductor = ConductorProfile::findOrFail($id);

        $validated = $request->validate([
            'first_name' => 'required|string|max:100',
            'middle_name' => 'nullable|string|max:100',
            'last_name' => 'required|string|max:100',
            'birthday' => 'required|date|before:today',
            'profile_picture_url' => 'nullable|string|max:500',
        ]);

        $conductor->update([
            'first_name' => $validated['first_name'],
            'middle_name' => $validated['middle_name'] ?? null,
            'last_name' => $validated['last_name'],
            'birthday' => $validated['birthday'],
            'profile_picture_url' => $validated['profile_picture_url'] ?? $conductor->profile_picture_url,
        ]);

        $conductor->load(['vehicle.route', 'vehicle.driver']);

        return $this->successResponse($conductor, 'Conductor updated successfully');
    }

    /**
     * GET /api/v1/admin/conductors/{id}
     * Returns a single conductor with full details for the profile modal.
     * Includes: vehicle assignment, recent shift logs (assignment history).
     */
    public function showConductor(string $id): JsonResponse
    {
        $conductor = ConductorProfile::with(['vehicle.route', 'vehicle.driver'])
            ->findOrFail($id);

        // Fetch recent shift logs for this conductor (assignment history).
        $shiftLogs = ShiftLog::with(['vehicle', 'route', 'driver'])
            ->where('conductor_id', $id)
            ->orderBy('time_in', 'desc')
            ->limit(20)
            ->get();

        $data = [
            'id' => $conductor->id,
            'first_name' => $conductor->first_name,
            'middle_name' => $conductor->middle_name,
            'last_name' => $conductor->last_name,
            'birthday' => $conductor->birthday?->toDateString(),
            'profile_picture_url' => $conductor->profile_picture_url,
            'generated_username' => $conductor->generated_username,
            'vehicle' => $conductor->vehicle ? [
                'id' => $conductor->vehicle->id,
                'unit_number' => $conductor->vehicle->unit_number,
                'plate_number' => $conductor->vehicle->plate_number,
                'route' => $conductor->vehicle->route?->name,
            ] : null,
            'driver_partner' => $conductor->vehicle?->driver ? [
                'id' => $conductor->vehicle->driver->id,
                'name' => trim(($conductor->vehicle->driver->first_name ?? '') . ' ' . ($conductor->vehicle->driver->last_name ?? '')),
            ] : null,
            'assigned_route' => $conductor->vehicle?->route?->name ?? 'Malolos - Meycauayan - Calumpit',
            'shift_logs' => $shiftLogs->map(function ($log) {
                return [
                    'shift_id' => $log->shift_id,
                    'unit_number' => $log->unit_number,
                    'plate_number' => $log->plate_number,
                    'route' => $log->route?->name,
                    'driver_name' => $log->driver_name,
                    'time_in' => $log->time_in?->toDateTimeString(),
                    'time_out' => $log->time_out?->toDateTimeString(),
                    'status' => $log->status,
                ];
            }),
        ];

        return $this->successResponse($data, 'Conductor details retrieved');
    }

    /**
     * GET /api/v1/admin/conductors
     * Lists all conductor profiles (for the Personnel tab).
     */
    public function conductors(): JsonResponse
    {
        $conductors = ConductorProfile::with(['vehicle.route', 'vehicle.driver'])
            ->orderBy('last_name', 'asc')
            ->get();

        return $this->successResponse($conductors, 'Conductors retrieved');
    }

    /**
     * POST /api/v1/admin/conductors
     * Creates a new conductor account: a User (with CONDUCTOR role) + a
     * ConductorProfile. The username/password are generated server-side
     * (deterministic from name + birthday) and returned in the response so
     * the admin can hand them to the conductor.
     */
    public function storeConductor(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'first_name' => 'required|string|max:100',
            'middle_name' => 'nullable|string|max:100',
            'last_name' => 'required|string|max:100',
            'birthday' => 'required|date|before:today',
            'profile_picture_url' => 'nullable|string|max:500',
        ]);

        $firstName = $validated['first_name'];
        $lastName = $validated['last_name'];
        $birthday = $validated['birthday'];

        // Generate username: firstinitial.lastname (e.g., j.delacruz)
        // Uses the first character of the first name (after trimming) so a
        // compound first name like "Mhaku Jose" still produces "m.delacruz".
        $firstNameTrimmed = trim($firstName);
        $generatedUsername = strtolower(
            substr($firstNameTrimmed, 0, 1) . '.' . preg_replace('/\s+/', '', $lastName)
        );

        // Generate password: firstword.restwordsMMDDYYYY
        // For a single-word first name "Juan" → "juan.05142000"
        // For a compound first name "Mhaku Jose" → "mhaku.jose05142000"
        // (no spaces in the password — the dot separates the first word from
        // any remaining words, and the birthday is appended directly)
        $birthdayFormatted = \Carbon\Carbon::parse($birthday)->format('mdY');
        $firstNameParts = preg_split('/\s+/', $firstNameTrimmed);
        $firstPart = strtolower($firstNameParts[0]);
        $restParts = implode('', array_map('strtolower', array_slice($firstNameParts, 1)));
        $generatedPassword = $firstPart . '.' . $restParts . $birthdayFormatted;

        // Email is derived from username (conductor accounts don't have a real
        // email — they log in with the generated username via a custom field).
        // We store it as username@chatco.local to satisfy the NOT NULL email
        // constraint on the users table.
        $email = $generatedUsername . '@chatco.local';

        // Ensure username/email uniqueness — append a number if taken.
        $originalUsername = $generatedUsername;
        $counter = 1;
        while (User::where('email', $email)->exists()) {
            $generatedUsername = $originalUsername . $counter;
            $email = $generatedUsername . '@chatco.local';
            $counter++;
        }

        // Create the User account (CONDUCTOR role).
        $user = User::create([
            'email' => $email,
            'password' => $generatedPassword,
            'role' => UserRole::CONDUCTOR,
        ]);

        // Create the ConductorProfile (shares the same UUID PK as the User).
        $conductor = ConductorProfile::create([
            'id' => $user->id,
            'first_name' => $firstName,
            'middle_name' => $validated['middle_name'] ?? null,
            'last_name' => $lastName,
            'birthday' => $birthday,
            'profile_picture_url' => $validated['profile_picture_url'] ?? null,
            'generated_username' => $generatedUsername,
            'generated_password' => $generatedPassword,
        ]);

        return $this->successResponse([
            'id' => $conductor->id,
            'first_name' => $conductor->first_name,
            'last_name' => $conductor->last_name,
            'generated_username' => $generatedUsername,
            'generated_password' => $generatedPassword,
        ], 'Conductor account created successfully', 201);
    }

    // Vehicle CRUD moved to AdminVehicleController — this method removed.

    public function routes(): JsonResponse
    {
        $routes = RouteModel::orderBy('name', 'asc')->get();

        return $this->successResponse($routes, 'Routes retrieved');
    }

    /**
     * POST /api/v1/admin/routes
     */
    public function storeRoute(StoreRouteRequest $request): JsonResponse
    {
        $validated = $request->validated();

        $route = RouteModel::create([
            'name' => $validated['name'],
            'status' => $validated['status'] ?? 'ACTIVE',
            'waypoints' => $validated['waypoints'] ?? null,
        ]);

        return $this->successResponse($route, 'Route created successfully', 201);
    }

    /**
     * PUT/PATCH /api/v1/admin/routes/{id}
     */
    public function updateRoute(UpdateRouteRequest $request, string $id): JsonResponse
    {
        $route = RouteModel::findOrFail($id);

        $validated = $request->validated();
        $route->update(array_filter($validated, fn ($v) => $v !== null));

        return $this->successResponse($route, 'Route updated successfully');
    }

    /**
     * DELETE /api/v1/admin/routes/{id}
     */
    public function destroyRoute(string $id): JsonResponse
    {
        $route = RouteModel::findOrFail($id);
        $route->delete();

        return $this->successResponse(null, 'Route deleted successfully');
    }

    public function transactions(Request $request): JsonResponse
    {
        $perPage = (int) $request->integer('per_page', 100);

        $query = Transaction::with(['shiftLog', 'passenger'])
            ->orderBy('created_at', 'desc');

        if ($request->has('shift_id')) {
            $query->where('shift_id', $request->input('shift_id'));
        }

        $transactions = $query->paginate($perPage);

        return $this->successResponse($transactions, 'Transactions retrieved');
    }

    /**
     * GET /api/v1/admin/remittances
     *
     * Returns a unified list of remittances:
     * 1. Active shifts WITH transactions -> mapped as "Pending"
     * 2. Completed remittances -> mapped as "Remitted"
     *
     * This allows admin to see a shift appear as "Pending" the moment
     * the conductor records their first cash fare, before they click
     * "Remit to Admin".
     */
    public function remittances(Request $request): JsonResponse
    {
        $perPage = (int) $request->integer('per_page', 100);
        $page = (int) $request->integer('page', 1);

        // 1. Completed remittances
        $completedRemittances = Remittance::query()
            ->orderBy('date', 'desc')
            ->orderBy('time_in', 'desc')
            ->get()
            ->map(function ($r) {
                return [
                    'shift_id' => $r->shift_id,
                    'conductor_name' => $r->conductor_name,
                    'driver_name' => $r->driver_name,
                    'unit_number' => $r->unit_number,
                    'date' => $r->date,
                    'time_in' => $r->time_in,
                    'time_out' => $r->time_out,
                    'cash_total' => (float) $r->cash_total,
                    'gcash_total' => (float) $r->gcash_total,
                    'total_passengers' => $r->total_passengers,
                    'remittance_status' => 'Remitted',
                ];
            });

        // 2. Active shifts with transactions (Pending)
        $pendingShifts = ShiftLog::where('status', 'ACTIVE')
            ->whereHas('transactions')
            ->with(['vehicle', 'driver'])
            ->get()
            ->map(function ($s) {
                $cashTotal = (float) DB::table('transactions')
                    ->where('shift_id', $s->shift_id)
                    ->where('payment_method', 'CASH')
                    ->where('status', 'PAID')
                    ->sum('final_amount');

                $gcashTotal = (float) DB::table('transactions')
                    ->where('shift_id', $s->shift_id)
                    ->where('payment_method', 'GCASH')
                    ->where('status', 'PAID')
                    ->sum('final_amount');

                $totalPassengers = (int) DB::table('transactions')
                    ->where('shift_id', $s->shift_id)
                    ->where('status', 'PAID')
                    ->count();

                return [
                    'shift_id' => $s->shift_id,
                    'conductor_name' => $s->conductor_name,
                    'driver_name' => $s->driver_name,
                    'unit_number' => $s->unit_number,
                    'date' => $s->time_in ? $s->time_in->toDateString() : null,
                    'time_in' => $s->time_in,
                    'time_out' => null, // Still active
                    'cash_total' => $cashTotal,
                    'gcash_total' => $gcashTotal,
                    'total_passengers' => $totalPassengers,
                    'remittance_status' => 'Pending',
                ];
            });

        // Merge: Pending first, then Remitted
        $unified = $pendingShifts->concat($completedRemittances);

        // Manual pagination on the merged collection (can't use ->paginate()
        // because we're merging two separate queries).
        $total = $unified->count();
        $offset = ($page - 1) * $perPage;
        $items = $unified->slice($offset, $perPage)->values();

        // Return in the same shape as Laravel's paginator so the frontend
        // can use the same extraction logic.
        $paginated = new \Illuminate\Pagination\LengthAwarePaginator(
            $items,
            $total,
            $perPage,
            $page,
            ['path' => $request->url(), 'query' => $request->query()]
        );

        return $this->successResponse($paginated, 'Remittances retrieved');
    }

    public function shiftLogs(Request $request): JsonResponse
    {
        $query = ShiftLog::with(['vehicle', 'driver', 'route'])
            ->orderBy('time_in', 'desc');

        if ($request->has('vehicle_id')) {
            $query->where('vehicle_id', $request->input('vehicle_id'));
        }

        if ($request->has('conductor_id')) {
            $query->where('conductor_id', $request->input('conductor_id'));
        }

        if ($request->has('driver_id')) {
            $query->where('driver_id', $request->input('driver_id'));
        }

        $perPage = (int) $request->integer('per_page', 100);

        $shiftLogs = $query->paginate($perPage);

        return $this->successResponse($shiftLogs, 'Shift logs retrieved');
    }
}