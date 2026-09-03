<?php

namespace App\Http\Controllers\Admin;

use App\Enums\ActivityLogCategory;
use App\Enums\PaymentMethod;
use App\Enums\PaymentStatus;
use App\Enums\ShiftStatus;
use App\Enums\UserRole;
use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\DeclareCashRequest;
use App\Models\CommuterLocation;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\Remittance;
use App\Models\ShiftLog;
use App\Models\TerminatedPersonnel;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use App\Services\ActivityLogService;
use App\Services\AdminService;
use App\Services\LocationService;
use App\Services\MediaStorageService;
use App\Services\ShiftCloseoutService;
use App\Traits\ApiResponse;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class AdminController extends Controller
{
    use ApiResponse;

    public function __construct(
        private AdminService $adminService,
        private LocationService $locationService,
        private ActivityLogService $activityLogService,
        private MediaStorageService $mediaStorage,
        private ShiftCloseoutService $shiftCloseoutService,
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
            'date_to' => $request->string('date_to')->toString() ?: null,
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
     * Returns the persisted overspeeding history (one row per overspeeding
     * episode, recorded live as vehicles exceed the speed limit).
     */
    public function overspeed(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'shift_id' => ['sometimes', 'string', 'max:20', 'exists:shift_logs,shift_id'],
            'date' => ['sometimes', 'date_format:Y-m-d'],
        ]);
        $history = $this->locationService->getOverspeedHistory(
            (int) ($validated['per_page'] ?? 25),
            $validated['shift_id'] ?? null,
            $validated['date'] ?? null,
        );

        return $this->successResponse($history, 'Overspeeding history retrieved');
    }

    public function demandZones(): JsonResponse
    {
        $cellSize = 0.005;
        $locations = CommuterLocation::query()
            ->where('updated_at', '>=', now()->subMinutes(5))
            ->get(['latitude', 'longitude']);

        $cells = [];
        foreach ($locations as $location) {
            $latBucket = (int) floor(($location->latitude + 90) / $cellSize);
            $lngBucket = (int) floor(($location->longitude + 180) / $cellSize);
            $key = "{$latBucket}:{$lngBucket}";

            if (! isset($cells[$key])) {
                $cells[$key] = [
                    'id' => "demand-{$latBucket}-{$lngBucket}",
                    'lat' => ($latBucket * $cellSize) - 90 + ($cellSize / 2),
                    'lng' => ($lngBucket * $cellSize) - 180 + ($cellSize / 2),
                    'commuter_count' => 0,
                ];
            }

            $cells[$key]['commuter_count']++;
        }

        $zones = collect($cells)
            ->map(function (array $cell) {
                $count = $cell['commuter_count'];
                $intensity = $count >= 10 ? 'HIGH' : ($count >= 4 ? 'MEDIUM' : 'LOW');

                return $cell + [
                    'intensity' => $intensity,
                    'radius_meters' => match ($intensity) {
                        'HIGH' => 500,
                        'MEDIUM' => 350,
                        default => 250,
                    },
                ];
            })
            ->sortByDesc('commuter_count')
            ->values();

        return $this->successResponse($zones, 'Demand zones retrieved');
    }

    /**
     * GET /api/v1/admin/drivers
     *
     * Two modes, distinguished by the presence of `page`:
     *  - No `page` (legacy/default): the full, unfiltered driver list —
     *    what Fleet Management, Lost & Found, and the personnel/vehicle
     *    pickers call today to populate dropdowns. They need every driver
     *    at once, not one page, so this path is untouched.
     *  - `page` present: a server-side paginated + filterable + searchable
     *    list (same Laravel-paginator envelope as GET /admin/users), used by
     *    User Management's "Drivers" role filter so it no longer downloads
     *    the whole table to filter/sort/paginate in the browser.
     */
    public function drivers(Request $request): JsonResponse
    {
        if (! $request->filled('page')) {
            $drivers = Driver::with('vehicle')->get();

            return $this->successResponse($drivers, 'Drivers retrieved');
        }

        $drivers = $this->adminService->listDrivers([
            'search' => $request->string('search')->toString() ?: null,
            'status' => $request->string('status')->toString() ?: null,
            'sort' => $request->string('sort')->toString() ?: 'recent',
            'per_page' => $request->integer('per_page', 20),
        ]);

        return $this->successResponse($drivers, 'Drivers retrieved');
    }

    /**
     * GET /api/v1/admin/personnel
     *
     * Paginated Fleet Management personnel view. Combines drivers and
     * conductors without loading either full table into the browser.
     */
    public function personnel(Request $request): JsonResponse
    {
        $perPage = max(1, min((int) $request->integer('per_page', 25), 100));
        $page = max(1, (int) $request->integer('page', 1));
        $search = $request->string('search')->toString() ?: null;
        $role = $request->string('role')->toString() ?: null;

        if ($request->boolean('count_only')) {
            return $this->successResponse([
                'total' => $this->adminService->countFleetPersonnel($search, $role),
            ], 'Personnel count retrieved');
        }

        $personnel = $this->adminService->listFleetPersonnel($perPage, $page, $search, $role);

        return $this->successResponse($personnel, 'Personnel retrieved');
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
        $request->merge([
            'license_number' => strtoupper(trim((string) $request->input('license_number'))),
        ]);

        $validated = $request->validate([
            'first_name' => 'required|string|max:100',
            'middle_name' => 'nullable|string|max:100',
            'last_name' => 'required|string|max:100',
            'birthday' => 'required|date|before:today',
            'contact' => ['required', 'string', 'regex:/^09[0-9]{9}$/'],
            'license_number' => ['required', 'string', 'regex:/^[A-Z][0-9]{2}-[0-9]{2}-[0-9]{6}$/', 'unique:drivers,license_number'],
            'profile_picture_url' => 'nullable|string|max:500',
            'profile_picture' => 'nullable|image|mimes:jpeg,jpg,png,webp|max:5120',
        ], [
            'contact.regex' => 'Enter an 11-digit mobile number starting with 09 (e.g. 09171234567).',
            'license_number.regex' => 'Use the Philippine LTO format N01-23-045678 (one letter, four digits, then six digits).',
        ]);

        $driverId = (string) Str::uuid();
        $newPictureUrl = $request->hasFile('profile_picture')
            ? $this->mediaStorage->storeProfileImage($request->file('profile_picture'), 'driver', $driverId)
            : ($validated['profile_picture_url'] ?? null);

        try {
            $driver = DB::transaction(function () use ($validated, $driverId, $newPictureUrl): Driver {
                $driver = new Driver([
                    'first_name' => $validated['first_name'],
                    'middle_name' => $validated['middle_name'] ?? null,
                    'last_name' => $validated['last_name'],
                    'birthday' => $validated['birthday'],
                    'contact' => $validated['contact'],
                    'license_number' => $validated['license_number'],
                    'hire_date' => now()->toDateString(),
                    'profile_picture_url' => $newPictureUrl,
                    'status' => 'ACTIVE',
                ]);
                $driver->id = $driverId;
                $driver->save();

                return $driver;
            });
        } catch (\Throwable $e) {
            if ($request->hasFile('profile_picture')) {
                $this->mediaStorage->deletePublicUrl($newPictureUrl);
            }
            throw $e;
        }

        $driver->load(['vehicle']);

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            "Added driver {$driver->first_name} {$driver->last_name}",
            $request->user(),
        );

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
        $request->merge([
            'license_number' => strtoupper(trim((string) $request->input('license_number'))),
        ]);

        $validated = $request->validate([
            'first_name' => 'required|string|max:100',
            'middle_name' => 'nullable|string|max:100',
            'last_name' => 'required|string|max:100',
            'birthday' => 'required|date|before:today',
            'contact' => ['required', 'string', 'regex:/^09[0-9]{9}$/'],
            'license_number' => ['required', 'string', 'regex:/^[A-Z][0-9]{2}-[0-9]{2}-[0-9]{6}$/', 'unique:drivers,license_number,'.$id],
            'profile_picture_url' => 'nullable|string|max:500',
            'profile_picture' => 'nullable|image|mimes:jpeg,jpg,png,webp|max:5120',
        ], [
            'contact.regex' => 'Enter an 11-digit mobile number starting with 09 (e.g. 09171234567).',
            'license_number.regex' => 'Use the Philippine LTO format N01-23-045678 (one letter, four digits, then six digits).',
        ]);

        $oldPictureUrl = $driver->profile_picture_url;
        $newPictureUrl = $oldPictureUrl;
        $hasNewUpload = $request->hasFile('profile_picture');
        if ($hasNewUpload) {
            $newPictureUrl = $this->mediaStorage->storeProfileImage($request->file('profile_picture'), 'driver', $driver->id);
        } elseif ($request->has('profile_picture_url')) {
            $newPictureUrl = $validated['profile_picture_url'] ?? null;
        }

        try {
            DB::transaction(function () use ($driver, $validated, $newPictureUrl): void {
                $driver->update([
                    'first_name' => $validated['first_name'],
                    'middle_name' => $validated['middle_name'] ?? null,
                    'last_name' => $validated['last_name'],
                    'birthday' => $validated['birthday'],
                    'contact' => $validated['contact'],
                    'license_number' => $validated['license_number'],
                    'profile_picture_url' => $newPictureUrl,
                ]);
            });
        } catch (\Throwable $e) {
            if ($hasNewUpload) {
                $this->mediaStorage->deletePublicUrl($newPictureUrl);
            }
            throw $e;
        }

        if ($hasNewUpload || ($request->has('profile_picture_url') && $newPictureUrl !== $oldPictureUrl)) {
            $this->mediaStorage->deletePublicUrl($oldPictureUrl);
        }

        $driver->load(['vehicle']);

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            "Updated driver {$driver->first_name} {$driver->last_name}",
            $request->user(),
        );

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
            'license_front_image_url' => $driver->license_front_image_url,
            'license_back_image_url' => $driver->license_back_image_url,
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
                'name' => trim(($driver->vehicle->conductor->first_name ?? '').' '.($driver->vehicle->conductor->last_name ?? '')),
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
     * POST /api/v1/admin/drivers/{id}/license-images
     *
     * Stores one or both sides of a driver's license on the configured
     * private ID disk. The image itself is only served through the
     * authenticated showDriverLicenseImage endpoint below.
     */
    public function uploadDriverLicenseImages(Request $request, string $id): JsonResponse
    {
        $driver = Driver::findOrFail($id);

        $validated = $request->validate([
            'front' => ['sometimes', 'file', 'image', 'mimes:jpeg,jpg,png,webp', 'max:5120'],
            'back' => ['sometimes', 'file', 'image', 'mimes:jpeg,jpg,png,webp', 'max:5120'],
        ]);

        if (! isset($validated['front']) && ! isset($validated['back'])) {
            return response()->json([
                'success' => false,
                'data' => null,
                'message' => 'At least one license image is required.',
                'errors' => ['license_images' => ['Upload a front or back license image.']],
                'meta' => null,
            ], 422);
        }

        $diskName = config('filesystems.uploads.private_id_disk', 'r2_private');
        $disk = Storage::disk($diskName);
        $oldPaths = [];
        $newPaths = [];

        DB::transaction(function () use ($driver, $validated, $diskName, &$oldPaths, &$newPaths): void {
            foreach (['front', 'back'] as $side) {
                if (! isset($validated[$side])) {
                    continue;
                }

                $column = "license_{$side}_image_url";
                $file = $validated[$side];
                $extension = strtolower($file->getClientOriginalExtension() ?: 'jpg');
                $path = $file->storeAs(
                    "driver-licenses/{$driver->id}",
                    "{$side}-".Str::uuid().".{$extension}",
                    $diskName
                );

                $oldPaths[] = $driver->{$column};
                $newPaths[] = $path;
                $driver->update([$column => $path]);
            }
        });

        foreach ($oldPaths as $oldPath) {
            if ($oldPath && ! in_array($oldPath, $newPaths, true)) {
                $disk->delete($oldPath);
            }
        }

        $driver = $driver->fresh();

        return $this->successResponse([
            'id' => $driver->id,
            'license_front_image_url' => $driver->license_front_image_url,
            'license_back_image_url' => $driver->license_back_image_url,
        ], 'License image(s) uploaded successfully');
    }

    /**
     * DELETE /api/v1/admin/drivers/{id}/license-images/{side}
     * Removes one side of a driver's license document.
     */
    public function destroyDriverLicenseImage(string $id, string $side): JsonResponse
    {
        abort_unless(in_array($side, ['front', 'back'], true), 404);

        $driver = Driver::findOrFail($id);
        $column = "license_{$side}_image_url";
        $path = $driver->{$column};

        if ($path) {
            Storage::disk(config('filesystems.uploads.private_id_disk', 'r2_private'))->delete($path);
            $driver->update([$column => null]);
        }

        return $this->successResponse(null, 'License image removed successfully');
    }

    /**
     * GET /api/v1/admin/drivers/{id}/license-images/{side}
     * Streams a license image to an authenticated admin only.
     */
    public function showDriverLicenseImage(string $id, string $side)
    {
        abort_unless(in_array($side, ['front', 'back'], true), 404);

        $driver = Driver::findOrFail($id);
        $path = $driver->{"license_{$side}_image_url"};
        abort_if(! $path, 404);

        $disk = Storage::disk(config('filesystems.uploads.private_id_disk', 'r2_private'));
        abort_unless($disk->exists($path), 404);

        $stream = $disk->readStream($path);
        abort_unless(is_resource($stream), 404);

        return response()->stream(function () use ($stream): void {
            fpassthru($stream);
            fclose($stream);
        }, 200, [
            'Content-Type' => $disk->mimeType($path) ?: 'application/octet-stream',
            'Content-Disposition' => 'inline',
            'Cache-Control' => 'private, no-store',
        ]);
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
                'data' => null,
                'message' => 'Conflict',
                'errors' => [
                    'driver' => [
                        'Cannot remove a driver who is currently on an active shift. '.
                        'End the shift (via conductor remittance) before removing this driver.',
                    ],
                ],
                'meta' => null,
            ], 409);
        }

        $fullName = trim(($driver->first_name ?? '').' '.($driver->last_name ?? ''));
        $lastVehicle = $driver->vehicle
            ? ($driver->vehicle->unit_number ?: $driver->vehicle->plate_number)
            : null;

        // Record the termination BEFORE the soft-delete so we capture the
        // driver's current state (name/contact/last vehicle). Wrap in a
        // transaction so we never end up with a terminated_personnel row
        // pointing at a driver that wasn't actually deleted (or vice versa).
        DB::transaction(function () use ($driver, $fullName, $lastVehicle, $validated) {
            TerminatedPersonnel::create([
                'personnel_id' => $driver->id,
                'personnel_type' => 'DRIVER',
                'name' => $fullName ?: 'Unknown Driver',
                'role' => 'Driver',
                'contact' => $driver->contact,
                'reason' => $validated['reason'],
                'termination_type' => $validated['termination_type'],
                'terminated_date' => now()->toDateString(),
                'last_vehicle' => $lastVehicle,
                'date_joined' => $driver->hire_date?->toDateString(),
            ]);
            $driver->delete();
        });

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            'Terminated driver '.($fullName ?: 'Unknown Driver'),
            $request->user(),
        );

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
                'data' => null,
                'message' => 'Validation failed',
                'errors' => ['user' => ['You cannot remove your own account.']],
                'meta' => null,
            ], 422);
        }

        // If the conductor is currently on an active shift, reject — the
        // active_shift_id lives on the vehicle, so we check the conductor's
        // assigned vehicle.
        if ($conductor->vehicle && $conductor->vehicle->active_shift_id) {
            return response()->json([
                'success' => false,
                'data' => null,
                'message' => 'Conflict',
                'errors' => [
                    'conductor' => [
                        'Cannot remove a conductor who is currently on an active shift. '.
                        'End the shift (via conductor remittance) before removing this conductor.',
                    ],
                ],
                'meta' => null,
            ], 409);
        }

        $fullName = trim(($conductor->first_name ?? '').' '.($conductor->last_name ?? ''));
        $lastVehicle = $conductor->vehicle
            ? ($conductor->vehicle->unit_number ?: $conductor->vehicle->plate_number)
            : null;

        DB::transaction(function () use ($user, $conductor, $fullName, $lastVehicle, $validated) {
            TerminatedPersonnel::create([
                'personnel_id' => $conductor->id,
                'personnel_type' => 'CONDUCTOR',
                'name' => $fullName ?: 'Unknown Conductor',
                'role' => 'Conductor',
                'contact' => null,
                'reason' => $validated['reason'],
                'termination_type' => $validated['termination_type'],
                'terminated_date' => now()->toDateString(),
                'last_vehicle' => $lastVehicle,
                'date_joined' => $conductor->created_at?->toDateString(),
            ]);
            // Revoke ALL tokens BEFORE soft-deleting — so the conductor is
            // instantly logged out everywhere and can't use the account.
            $user->tokens()->delete();
            // Soft-deletes the user — cascades to conductor_profile via shared PK.
            $user->delete();
        });

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            'Terminated conductor '.($fullName ?: 'Unknown Conductor'),
            $request->user(),
        );

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
    public function disableConductor(Request $request, string $id): JsonResponse
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
                'data' => null,
                'message' => 'Conflict',
                'errors' => [
                    'conductor' => [
                        'Cannot disable a conductor who is currently on an active shift. '.
                        'End the shift first.',
                    ],
                ],
                'meta' => null,
            ], 409);
        }

        // Revoke ALL tokens — the conductor is instantly logged out everywhere.
        $user->tokens()->delete();

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            "Disabled conductor {$conductor->first_name} {$conductor->last_name}",
            $request->user(),
        );

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
    public function resetConductorCredentials(Request $request, string $id): JsonResponse
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
            substr($firstNameTrimmed, 0, 1).'.'.preg_replace('/\s+/', '', $lastName)
        );

        $birthdayFormatted = Carbon::parse($birthday)->format('mdY');
        $firstNameParts = preg_split('/\s+/', $firstNameTrimmed);
        $firstPart = strtolower($firstNameParts[0]);
        $restParts = implode('', array_map('strtolower', array_slice($firstNameParts, 1)));
        $generatedPassword = $firstPart.'.'.$restParts.$birthdayFormatted;

        // Ensure username uniqueness — append a number if taken.
        $originalUsername = $generatedUsername;
        $counter = 1;
        while (User::where('email', $generatedUsername.'@chatco.local')
            ->where('id', '!=', $user->id)
            ->exists()) {
            $generatedUsername = $originalUsername.$counter;
            $counter++;
        }

        // Update the user's password + email (derived from username).
        $user->update([
            'email' => $generatedUsername.'@chatco.local',
            'password' => $generatedPassword,
        ]);

        // Update the conductor profile with the new credentials.
        $conductor->update([
            'generated_username' => $generatedUsername,
            'generated_password' => $generatedPassword,
        ]);

        // Revoke ALL tokens — the conductor must re-login with the new credentials.
        $user->tokens()->delete();

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            "Reset login credentials for conductor {$conductor->first_name} {$conductor->last_name}",
            $request->user(),
        );

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
        $perPage = max(1, min((int) $request->integer('per_page', 50), 100));

        $query = TerminatedPersonnel::query()
            ->when($request->string('search')->toString(), function ($query, string $search): void {
                $term = '%'.str_replace(['%', '_'], ['\\%', '\\_'], trim($search)).'%';
                $query->where(function ($subQuery) use ($term): void {
                    $subQuery->where('name', 'like', $term)
                        ->orWhere('role', 'like', $term)
                        ->orWhere('contact', 'like', $term)
                        ->orWhere('reason', 'like', $term)
                        ->orWhere('last_vehicle', 'like', $term)
                        ->orWhere('termination_type', 'like', $term);
                });
            });

        if ($request->boolean('count_only')) {
            return $this->successResponse([
                'total' => (int) $query->count(),
            ], 'Terminated personnel count retrieved');
        }

        $records = $query
            ->orderBy('terminated_date', 'desc')
            ->orderBy('created_at', 'desc')
            ->paginate($perPage)
            ->withQueryString();

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
     * Editable: first_name, middle_name, last_name, birthday, contact, profile_picture_url.
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
            'contact' => ['required', 'string', 'regex:/^09[0-9]{9}$/'],
            'profile_picture_url' => 'nullable|string|max:500',
            'profile_picture' => 'nullable|image|mimes:jpeg,jpg,png,webp|max:5120',
        ], [
            'contact.regex' => 'Enter an 11-digit mobile number starting with 09 (e.g. 09171234567).',
        ]);

        $oldPictureUrl = $conductor->profile_picture_url;
        $newPictureUrl = $oldPictureUrl;
        $hasNewUpload = $request->hasFile('profile_picture');
        if ($hasNewUpload) {
            $newPictureUrl = $this->mediaStorage->storeProfileImage($request->file('profile_picture'), 'conductor', $conductor->id);
        } elseif ($request->has('profile_picture_url')) {
            $newPictureUrl = $validated['profile_picture_url'] ?? null;
        }

        try {
            DB::transaction(function () use ($conductor, $validated, $newPictureUrl): void {
                $conductor->update([
                    'first_name' => $validated['first_name'],
                    'middle_name' => $validated['middle_name'] ?? null,
                    'last_name' => $validated['last_name'],
                    'birthday' => $validated['birthday'],
                    'contact' => $validated['contact'],
                    'profile_picture_url' => $newPictureUrl,
                ]);
            });
        } catch (\Throwable $e) {
            if ($hasNewUpload) {
                $this->mediaStorage->deletePublicUrl($newPictureUrl);
            }
            throw $e;
        }

        if ($hasNewUpload || ($request->has('profile_picture_url') && $newPictureUrl !== $oldPictureUrl)) {
            $this->mediaStorage->deletePublicUrl($oldPictureUrl);
        }

        $conductor->load(['vehicle.route', 'vehicle.driver']);

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            "Updated conductor {$conductor->first_name} {$conductor->last_name}",
            $request->user(),
        );

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
            'contact' => $conductor->contact,
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
                'name' => trim(($conductor->vehicle->driver->first_name ?? '').' '.($conductor->vehicle->driver->last_name ?? '')),
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
            'contact' => ['required', 'string', 'regex:/^09[0-9]{9}$/'],
            'profile_picture_url' => 'nullable|string|max:500',
        ], [
            'contact.regex' => 'Enter an 11-digit mobile number starting with 09 (e.g. 09171234567).',
        ]);

        $firstName = $validated['first_name'];
        $lastName = $validated['last_name'];
        $birthday = $validated['birthday'];

        // Generate username: firstinitial.lastname (e.g., j.delacruz)
        // Uses the first character of the first name (after trimming) so a
        // compound first name like "Mhaku Jose" still produces "m.delacruz".
        $firstNameTrimmed = trim($firstName);
        $generatedUsername = strtolower(
            substr($firstNameTrimmed, 0, 1).'.'.preg_replace('/\s+/', '', $lastName)
        );

        // Generate password: firstword.restwordsMMDDYYYY
        // For a single-word first name "Juan" → "juan.05142000"
        // For a compound first name "Mhaku Jose" → "mhaku.jose05142000"
        // (no spaces in the password — the dot separates the first word from
        // any remaining words, and the birthday is appended directly)
        $birthdayFormatted = Carbon::parse($birthday)->format('mdY');
        $firstNameParts = preg_split('/\s+/', $firstNameTrimmed);
        $firstPart = strtolower($firstNameParts[0]);
        $restParts = implode('', array_map('strtolower', array_slice($firstNameParts, 1)));
        $generatedPassword = $firstPart.'.'.$restParts.$birthdayFormatted;

        // Email is derived from username (conductor accounts don't have a real
        // email — they log in with the generated username via a custom field).
        // We store it as username@chatco.local to satisfy the NOT NULL email
        // constraint on the users table.
        $email = $generatedUsername.'@chatco.local';

        // Ensure username/email uniqueness — append a number if taken.
        $originalUsername = $generatedUsername;
        $counter = 1;
        while (User::where('email', $email)->exists()) {
            $generatedUsername = $originalUsername.$counter;
            $email = $generatedUsername.'@chatco.local';
            $counter++;
        }

        $userId = (string) Str::uuid();
        $newPictureUrl = $request->hasFile('profile_picture')
            ? $this->mediaStorage->storeProfileImage($request->file('profile_picture'), 'conductor', $userId)
            : ($validated['profile_picture_url'] ?? null);

        try {
            $conductor = DB::transaction(function () use ($email, $generatedPassword, $userId, $firstName, $validated, $lastName, $birthday, $generatedUsername, $newPictureUrl): ConductorProfile {
                $user = new User([
                    'email' => $email,
                    'password' => $generatedPassword,
                    'role' => UserRole::CONDUCTOR,
                ]);
                $user->id = $userId;
                $user->save();

                return ConductorProfile::create([
                    'id' => $user->id,
                    'first_name' => $firstName,
                    'middle_name' => $validated['middle_name'] ?? null,
                    'last_name' => $lastName,
                    'birthday' => $birthday,
                    'contact' => $validated['contact'],
                    'profile_picture_url' => $newPictureUrl,
                    'generated_username' => $generatedUsername,
                    'generated_password' => $generatedPassword,
                ]);
            });
        } catch (\Throwable $e) {
            if ($request->hasFile('profile_picture')) {
                $this->mediaStorage->deletePublicUrl($newPictureUrl);
            }
            throw $e;
        }

        $this->activityLogService->record(
            ActivityLogCategory::PERSONNEL,
            "Added conductor {$conductor->first_name} {$conductor->last_name}",
            $request->user(),
        );

        return $this->successResponse([
            'id' => $conductor->id,
            'first_name' => $conductor->first_name,
            'last_name' => $conductor->last_name,
            'generated_username' => $generatedUsername,
            'generated_password' => $generatedPassword,
        ], 'Conductor account created successfully', 201);
    }

    // Vehicle CRUD moved to AdminVehicleController — this method removed.

    public function transactions(Request $request): JsonResponse
    {
        $perPage = (int) $request->integer('per_page', 100);

        $query = Transaction::with(['shiftLog', 'passenger', 'payer', 'passengerBreakdown', 'paymentGroup:id,reference_number'])
            ->orderBy('created_at', 'desc');

        if ($request->has('shift_id')) {
            // Comma-separated shift_id batches multiple shifts into one request
            // (e.g. the admin remittance conductor modal's Transactions tab)
            // instead of one round trip per shift.
            $shiftIds = array_filter(array_map('trim', explode(',', (string) $request->input('shift_id'))));
            if (count($shiftIds) > 1) {
                $query->whereIn('shift_id', $shiftIds);
            } else {
                $query->where('shift_id', $request->input('shift_id'));
            }
        }
        // Plain range comparisons on created_at (not whereDate(), which wraps
        // the column in a function and blocks index use) so this resolves as
        // an index range scan against transactions_created_at_index as the
        // table grows, instead of a full scan.
        if ($request->filled('date')) {
            $day = Carbon::parse($request->input('date'))->startOfDay();
            $query->where('created_at', '>=', $day)
                ->where('created_at', '<', $day->copy()->addDay());
        }
        if ($request->filled('date_from')) {
            $query->where('created_at', '>=', Carbon::parse($request->input('date_from'))->startOfDay());
        }
        if ($request->filled('date_to')) {
            $query->where('created_at', '<', Carbon::parse($request->input('date_to'))->addDay()->startOfDay());
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
        // Cap raised from 100 to 500: the Analytics Overview/Reports tabs and
        // the CSV/PDF/Excel exports (frontend/app/(admin)/analytics/page.tsx)
        // request per_page=500 to get the full scoped range in one page. The
        // old 100 cap silently truncated `data` for any range with more than
        // 100 remittances while `total` still reported the real count.
        $perPage = max(1, min((int) $request->integer('per_page', 100), 500));
        $page = max(1, (int) $request->integer('page', 1));
        $statusFilter = $request->filled('status')
            ? strtoupper((string) $request->input('status'))
            : null;

        $completedQuery = Remittance::query()
            ->with(['shift:shift_id,status,time_in,time_out', 'vehicle:id,unit_number,plate_number', 'driver:id,first_name,last_name']);
        // Plain comparisons, not whereDate() — `date` is already a native DATE
        // column, so wrapping it in whereDate()'s CAST(...) still blocks the
        // remittances_date_index range scan and forces a full table scan.
        if ($request->filled('date_from')) {
            $completedQuery->where('date', '>=', $request->input('date_from'));
        }
        if ($request->filled('date_to')) {
            $completedQuery->where('date', '<=', $request->input('date_to'));
        }
        if ($request->filled('date')) {
            $completedQuery->where('date', $request->input('date'));
        }
        if ($statusFilter) {
            if ($statusFilter === 'REMITTED') {
                $completedQuery->whereIn('remittance_status', [
                    Remittance::STATUS_COMPLETE,
                    Remittance::STATUS_SHORTAGE,
                    Remittance::STATUS_OVERAGE,
                    'Remitted',
                ]);
            } elseif ($statusFilter === 'OVERDUE') {
                $completedQuery->where('remittance_status', Remittance::STATUS_PENDING)
                    ->where('remittance_due_at', '<', now());
            } else {
                $completedQuery->where('remittance_status', $statusFilter);
            }
        }
        if ($request->filled('search')) {
            $search = '%'.str_replace(['%', '_'], ['\\%', '\\_'], (string) $request->input('search')).'%';
            $completedQuery->where(function ($query) use ($search): void {
                $query->where('conductor_name', 'like', $search)
                    ->orWhere('driver_name', 'like', $search)
                    ->orWhere('shift_id', 'like', $search);
            });
        }
        // Exact-name filters from the admin's Conductor/Driver dropdowns. Applied
        // server-side (not just to the current page in memory) so switching to a
        // specific conductor/driver returns every matching shift, not only
        // whichever ones happened to land on the currently loaded page.
        if ($request->filled('conductor')) {
            $completedQuery->where('conductor_name', $request->input('conductor'));
        }
        if ($request->filled('driver')) {
            $completedQuery->where('driver_name', $request->input('driver'));
        }

        $completedRows = $completedQuery
            ->get()
            ->map(function (Remittance $remittance): array {
                $remittance->setAttribute(
                    'is_overdue',
                    $remittance->remittance_status === Remittance::STATUS_PENDING
                        && $remittance->remittance_due_at?->isPast(),
                );
                // Distinguishes a real, ended remittance awaiting the admin's cash
                // declaration from a still-active shift (both are STATUS_PENDING) —
                // the frontend needs this to know which PENDING rows can take the
                // "Declare Cash" action.
                $remittance->setAttribute('is_active_shift', false);

                return $remittance->toArray();
            });

        $activeRows = collect();
        if ($statusFilter === null || $statusFilter === Remittance::STATUS_PENDING) {
            $activeQuery = ShiftLog::query()
                ->where('status', ShiftStatus::ACTIVE->value)
                ->whereDoesntHave('remittance');

            if ($request->filled('date_from')) {
                $activeQuery->where('time_in', '>=', Carbon::parse($request->input('date_from'))->startOfDay());
            }
            if ($request->filled('date_to')) {
                $activeQuery->where('time_in', '<=', Carbon::parse($request->input('date_to'))->endOfDay());
            }
            if ($request->filled('date')) {
                $activeQuery
                    ->where('time_in', '>=', Carbon::parse($request->input('date'))->startOfDay())
                    ->where('time_in', '<=', Carbon::parse($request->input('date'))->endOfDay());
            }
            if ($request->filled('search')) {
                $search = '%'.str_replace(['%', '_'], ['\\%', '\\_'], (string) $request->input('search')).'%';
                $activeQuery->where(function ($query) use ($search): void {
                    $query->where('conductor_name', 'like', $search)
                        ->orWhere('driver_name', 'like', $search)
                        ->orWhere('shift_id', 'like', $search);
                });
            }
            if ($request->filled('conductor')) {
                $activeQuery->where('conductor_name', $request->input('conductor'));
            }
            if ($request->filled('driver')) {
                $activeQuery->where('driver_name', $request->input('driver'));
            }

            $activeShifts = $activeQuery
                ->get(['shift_id', 'conductor_id', 'driver_id', 'vehicle_id', 'conductor_name', 'driver_name', 'unit_number', 'time_in', 'time_out']);
            $shiftIds = $activeShifts->pluck('shift_id');
            $totalsByShift = $shiftIds->isEmpty()
                ? collect()
                : Transaction::query()
                    ->whereIn('shift_id', $shiftIds)
                    ->where('status', PaymentStatus::PAID->value)
                    ->select('shift_id')
                    ->selectRaw('COALESCE(SUM(CASE WHEN payment_method = ? THEN final_amount ELSE 0 END), 0) AS cash_total', [PaymentMethod::CASH->value])
                    ->selectRaw('COALESCE(SUM(CASE WHEN payment_method = ? THEN final_amount ELSE 0 END), 0) AS gcash_total', [PaymentMethod::GCASH->value])
                    ->selectRaw('COALESCE(SUM(total_passengers), 0) AS total_passengers')
                    ->groupBy('shift_id')
                    ->get()
                    ->keyBy('shift_id');

            $activeRows = $activeShifts->map(function (ShiftLog $shift) use ($totalsByShift): array {
                $totals = $totalsByShift->get($shift->shift_id);
                $cashTotal = (float) ($totals->cash_total ?? 0);
                $gcashTotal = (float) ($totals->gcash_total ?? 0);

                return [
                    'shift_id' => $shift->shift_id,
                    'conductor_id' => $shift->conductor_id,
                    'driver_id' => $shift->driver_id,
                    'vehicle_id' => $shift->vehicle_id,
                    'date' => $shift->time_in?->toDateString(),
                    'conductor_name' => $shift->conductor_name,
                    'driver_name' => $shift->driver_name,
                    'unit_number' => $shift->unit_number,
                    'total_passengers' => (int) ($totals->total_passengers ?? 0),
                    'time_in' => $shift->time_in,
                    'time_out' => $shift->time_out,
                    'total_collected' => $cashTotal,
                    'remitted_amount' => 0,
                    'shortage' => 0,
                    'overage' => 0,
                    'cash_total' => $cashTotal,
                    'gcash_total' => $gcashTotal,
                    'remittance_status' => Remittance::STATUS_PENDING,
                    'remittance_due_at' => null,
                    'remitted_at' => null,
                    'reminder_count' => 0,
                    'is_overdue' => false,
                    'is_active_shift' => true,
                ];
            });
        }

        $rows = $completedRows
            ->concat($activeRows)
            ->sort(function (array $a, array $b): int {
                $dateCompare = strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
                if ($dateCompare !== 0) {
                    return $dateCompare;
                }

                return strcmp((string) ($b['time_in'] ?? ''), (string) ($a['time_in'] ?? ''));
            })
            ->values();

        $total = $rows->count();
        $items = $rows->forPage($page, $perPage)->values();

        return $this->successResponse([
            'current_page' => $page,
            'data' => $items,
            'from' => $items->isEmpty() ? null : (($page - 1) * $perPage) + 1,
            'last_page' => max(1, (int) ceil($total / $perPage)),
            'per_page' => $perPage,
            'to' => $items->isEmpty() ? null : (($page - 1) * $perPage) + $items->count(),
            'total' => $total,
        ], 'Remittances retrieved');
    }

    /**
     * POST /api/admin/remittances/{shiftId}/cash-declaration
     *
     * The admin's physical cash count for a conductor's ended, still-PENDING
     * remittance. Resolves it to COMPLETE/SHORTAGE/OVERAGE — see
     * ShiftCloseoutService::recordCashDeclaration(). 409s if this remittance's
     * cash was already declared (not PENDING), 404 if the shift_id doesn't
     * correspond to a real Remittance row (e.g. a still-active shift).
     */
    public function declareCash(DeclareCashRequest $request, string $shiftId): JsonResponse
    {
        $remittance = $this->shiftCloseoutService->recordCashDeclaration(
            $shiftId,
            (float) $request->validated('cash_declared'),
        );

        return $this->successResponse($remittance->load(['shift', 'vehicle', 'driver']), 'Cash declaration recorded');
    }

    public function shiftLogs(Request $request): JsonResponse
    {
        $perPage = max(1, min((int) $request->integer('per_page', 100), 100));
        $page = max(1, (int) $request->integer('page', 1));

        if ($request->query('entry_view') === 'personnel') {
            $shiftRange = $request->string('shift_range')->toString() ?: null;

            if ($request->boolean('count_only')) {
                return $this->successResponse([
                    'total' => $this->adminService->countFleetShiftHistoryEntries(
                        $request->string('search')->toString() ?: null,
                        $shiftRange,
                    ),
                ], 'Shift history count retrieved');
            }

            $entries = $this->adminService->listFleetShiftHistoryEntries(
                $perPage,
                $page,
                $request->string('search')->toString() ?: null,
                $shiftRange,
            );

            return $this->successResponse($entries, 'Shift history entries retrieved');
        }

        $query = ShiftLog::query();

        if ($request->has('vehicle_id')) {
            $query->where('vehicle_id', $request->input('vehicle_id'));
        }

        if ($request->has('conductor_id')) {
            $query->where('conductor_id', $request->input('conductor_id'));
        }

        if ($request->has('driver_id')) {
            $query->where('driver_id', $request->input('driver_id'));
        }

        if ($request->filled('search')) {
            $search = '%'.str_replace(['%', '_'], ['\\%', '\\_'], (string) $request->input('search')).'%';
            $query->where(function ($searchQuery) use ($search): void {
                $searchQuery->where('driver_name', 'like', $search)
                    ->orWhere('conductor_name', 'like', $search)
                    ->orWhere('unit_number', 'like', $search)
                    ->orWhere('plate_number', 'like', $search)
                    ->orWhere('status', 'like', $search)
                    ->orWhere('notes', 'like', $search);
            });
        }

        if ($request->boolean('count_only')) {
            return $this->successResponse([
                'total' => (int) $query->count(),
            ], 'Shift log count retrieved');
        }

        $shiftLogs = $query
            ->with(['vehicle', 'driver', 'route', 'latestDeviceRecovery'])
            ->withCount([
                'transactions as synced_offline_cash_count' => function ($transactions): void {
                    $transactions
                        ->where('payment_method', PaymentMethod::CASH)
                        ->whereNotNull('offline_created_at')
                        ->whereNotNull('synced_at');
                },
            ])
            ->orderBy('time_in', 'desc')
            ->paginate($perPage)
            ->withQueryString();

        return $this->successResponse($shiftLogs, 'Shift logs retrieved');
    }
}
