<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Enums\ShiftStatus;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\Remittance;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Week 5 — Role-Scoped Data Access Gate.
 *
 * Systematically verifies every Sprint 5 endpoint (and the broader API)
 * enforces auth:sanctum + the correct role middleware, and that no
 * endpoint leaks another role's or another user's data.
 *
 * Coverage:
 *  1. Cross-role access matrix — wrong actors get 401/403, right role 2xx.
 *  2. Foreign-ID scoping — commuter/conductor endpoints scope to auth()->id(),
 *     never a request-supplied id.
 *  3. Admin endpoints all behind role:ADMIN; no impersonation endpoint.
 *  4. No admin-only field leaks (password hash, tokens, other users' rows).
 *  5. grep confirms no remaining notImplementedResponse() on shipped S5 routes.
 *
 * NOTE: Tests use actingAs($user) (session guard) rather than Bearer tokens
 * because the app's default guard is 'web' (session), not 'sanctum'. The
 * role:ADMIN/CONDUCTOR/COMMUTER middleware checks $request->user() which is
 * populated by the session guard. This matches the pattern used by the
 * existing Sprint2RoleAccessTest.
 */
class RoleAccessMatrixTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $conductor;
    private User $commuter;

    protected function setUp(): void
    {
        parent::setUp();

        // ── Admin ──────────────────────────────────────────────────────
        $this->admin = User::create([
            'email'    => 'admin@matrix.test',
            'password' => Hash::make('password123'),
            'role'     => UserRole::ADMIN,
        ]);
        AdminProfile::create([
            'id'         => $this->admin->id,
            'first_name' => 'Admin',
            'last_name'  => 'Matrix',
        ]);

        // ── Conductor ──────────────────────────────────────────────────
        $this->conductor = User::create([
            'email'    => 'conductor@matrix.test',
            'password' => Hash::make('password123'),
            'role'     => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id'                 => $this->conductor->id,
            'first_name'         => 'Conductor',
            'last_name'          => 'Matrix',
            'birthday'           => '1990-01-01',
            'generated_username' => 'conductor_matrix',
            'generated_password' => Hash::make('password123'),
        ]);

        // ── Commuter ───────────────────────────────────────────────────
        $this->commuter = User::create([
            'email'    => 'commuter@matrix.test',
            'password' => Hash::make('password123'),
            'role'     => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id'                  => $this->commuter->id,
            'first_name'          => 'Commuter',
            'surname'             => 'Matrix',
            'birthdate'           => '1995-01-01',
            'gender'              => 'Male',
            'email'               => 'commuter@matrix.test',
            'contact_number'      => '+639170000000',
            'commuter_type'       => 'Regular',
            'username'            => 'commuter_matrix',
            'language_preference' => 'en',
            'account_status'      => 'ACTIVE',
            'verified_at'         => now(),
        ]);
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 1: Cross-role access matrix — data providers
    // ═════════════════════════════════════════════════════════════════════

    /**
     * @return array<string, array{method: string, uri: string, allowed: list<string>}>
     */
    public static function s5RouteMatrixProvider(): array
    {
        return [
            // ── Conductor S5 ────────────────────────────────────────────
            'conductor.remittances.index' => [
                'method'  => 'GET',
                'uri'     => '/api/v1/conductor/remittances',
                'allowed' => ['conductor'],
            ],

            // ── Admin S5 — Vehicles (CRUD) ──────────────────────────────
            'admin.vehicles.index' => [
                'method'  => 'GET',
                'uri'     => '/api/v1/admin/vehicles',
                'allowed' => ['admin'],
            ],
            'admin.vehicles.store' => [
                'method'  => 'POST',
                'uri'     => '/api/v1/admin/vehicles',
                'allowed' => ['admin'],
            ],

            // ── Admin S5 — Analytics ────────────────────────────────────
            'admin.analytics' => [
                'method'  => 'GET',
                'uri'     => '/api/v1/admin/analytics',
                'allowed' => ['admin'],
            ],

            // ── Admin S5 — Conductors ───────────────────────────────────
            'admin.conductors.index' => [
                'method'  => 'GET',
                'uri'     => '/api/v1/admin/conductors',
                'allowed' => ['admin'],
            ],
            'admin.conductors.store' => [
                'method'  => 'POST',
                'uri'     => '/api/v1/admin/conductors',
                'allowed' => ['admin'],
            ],

            // ── Admin S5 — Drivers ──────────────────────────────────────
            'admin.drivers.store' => [
                'method'  => 'POST',
                'uri'     => '/api/v1/admin/drivers',
                'allowed' => ['admin'],
            ],
        ];
    }

    /**
     * @dataProvider s5RouteMatrixProvider
     */
    public function test_cross_role_access_matrix(string $method, string $uri, array $allowed): void
    {
        // ── No auth (no actingAs) → 401 ────────────────────────────────
        $this->json($method, $uri, $this->payloadFor($uri))
            ->assertStatus(401);

        // ── Each role: allowed roles get 2xx, forbidden roles get 403 ──
        $actors = [
            'admin'     => $this->admin,
            'conductor' => $this->conductor,
            'commuter'  => $this->commuter,
        ];

        foreach ($actors as $role => $user) {
            $response = $this->actingAs($user)
                ->json($method, $uri, $this->payloadFor($uri));

            if (in_array($role, $allowed, true)) {
                // Allowed role: expect 2xx (200, 201, or 422 if validation fails on a route that needs valid data)
                $this->assertContains(
                    $response->status(),
                    [200, 201, 422],
                    "Role [{$role}] should be allowed access to {$method} {$uri} but got {$response->status()}."
                );
            } else {
                $this->assertSame(
                    403,
                    $response->status(),
                    "Role [{$role}] should be FORBIDDEN from {$method} {$uri} but got {$response->status()}."
                );
            }
        }
    }

    /**
     * Build a minimal valid payload for POST routes that need one.
     */
    private function payloadFor(string $uri): array
    {
        return match ($uri) {
            '/api/v1/admin/vehicles' => [
                'unit_number'  => 'UNIT-MATRIX-' . uniqid(),
                'plate_number' => 'MAT-' . uniqid(),
                'vehicle_type' => 'Jeepney',
                'status'       => 'ACTIVE',
            ],
            '/api/v1/admin/conductors' => [
                'first_name' => 'Test',
                'last_name'  => 'Conductor',
                'birthday'   => '1990-01-01',
                'contact'    => '09170000001',
            ],
            '/api/v1/admin/drivers' => [
                'first_name'      => 'Test',
                'last_name'       => 'Driver',
                'birthday'        => '1985-01-01',
                'contact'         => '09170000000',
                'license_number'  => 'LIC-' . uniqid(),
            ],
            default => [],
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 2: Foreign-ID scoping — conductor remittances
    // ═════════════════════════════════════════════════════════════════════

    public function test_conductor_remittances_index_scoped_to_auth_conductor(): void
    {
        // Create a SECOND conductor with a remittance.
        $otherConductor = User::create([
            'email'    => 'other-conductor@matrix.test',
            'password' => Hash::make('password123'),
            'role'     => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id'                 => $otherConductor->id,
            'first_name'         => 'Other',
            'last_name'          => 'Conductor',
            'birthday'           => '1990-01-01',
            'generated_username' => 'other_conductor',
            'generated_password' => Hash::make('password123'),
        ]);

        $route = Route::create(['name' => 'Test Route', 'status' => 'ACTIVE']);
        $driver = Driver::create([
            'first_name'      => 'Driver',
            'last_name'       => 'One',
            'birthday'        => '1985-01-01',
            'contact'         => '+639170000000',
            'license_number'  => 'LIC-1',
            'hire_date'       => now()->toDateString(),
            'status'          => 'ACTIVE',
        ]);
        $vehicle = Vehicle::create([
            'unit_number'  => 'UNIT-OTHER',
            'plate_number' => 'OTHER-001',
            'route_id'     => $route->id,
            'status'       => 'ACTIVE',
        ]);

        // Create a real ShiftLog first (remittances.shift_id is a FK to
        // shift_logs.shift_id with cascadeOnDelete — a remittance cannot
        // exist without a parent shift log).
        $shiftId = 'shift-other-' . uniqid();
        ShiftLog::create([
            'shift_id'       => $shiftId,
            'conductor_id'   => $otherConductor->id,
            'driver_id'      => $driver->id,
            'vehicle_id'     => $vehicle->id,
            'conductor_name' => 'Other Conductor',
            'driver_name'    => 'Driver One',
            'unit_number'    => 'UNIT-OTHER',
            'plate_number'   => 'OTHER-001',
            'time_in'        => now()->subHours(8),
            'status'         => ShiftStatus::ENDED,
            'is_active'      => false,
        ]);

        // Remittance owned by the OTHER conductor — all FK columns populated.
        Remittance::create([
            'shift_id'         => $shiftId,
            'conductor_id'     => $otherConductor->id,
            'driver_id'        => $driver->id,
            'vehicle_id'       => $vehicle->id,
            'conductor_name'   => 'Other Conductor',
            'driver_name'      => 'Driver One',
            'unit_number'      => 'UNIT-OTHER',
            'date'             => now()->toDateString(),
            'time_in'          => now()->subHours(8),
            'time_out'         => now(),
            'total_collected'  => 500,
            'remitted_amount'  => 500,
            'shortage'         => 0,
            'remittance_status'=> 'Remitted',
            'cash_total'       => 500,
            'gcash_total'      => 0,
            'total_passengers' => 10,
        ]);

        // Auth conductor (NOT the owner) requests the list.
        $response = $this->actingAs($this->conductor)
            ->getJson('/api/v1/conductor/remittances');

        $response->assertOk();
        $data = $response->json('data.data');
        $this->assertIsArray($data);
        $this->assertEmpty($data, 'Conductor should NOT see another conductor\'s remittances.');
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 3: Admin endpoints behind role:ADMIN — no impersonation
    // ═════════════════════════════════════════════════════════════════════

    public function test_no_impersonation_or_user_switching_endpoint_exists(): void
    {
        // Grep the route file for any suspicious patterns.
        $routeFile = file_get_contents(base_path('routes/api.php'));
        $this->assertStringNotContainsString('impersonate', $routeFile, 'No impersonation route should exist.');
        $this->assertStringNotContainsString('switch-user', $routeFile, 'No user-switching route should exist.');
        $this->assertStringNotContainsString('as-user', $routeFile, 'No as-user route should exist.');
    }

    public function test_admin_vehicle_delete_blocks_active_shift_with_409(): void
    {
        $route = Route::create(['name' => 'Test Route', 'status' => 'ACTIVE']);
        $driver = Driver::create([
            'first_name'      => 'Driver',
            'last_name'       => 'Active',
            'birthday'        => '1985-01-01',
            'contact'         => '+639170000000',
            'license_number'  => 'LIC-ACTIVE',
            'hire_date'       => now()->toDateString(),
            'status'          => 'ACTIVE',
        ]);

        // Create the Vehicle FIRST (without active_shift_id) so the
        // ShiftLog's vehicle_id FK has a valid target.
        $vehicle = Vehicle::create([
            'unit_number'  => 'UNIT-ACTIVE',
            'plate_number' => 'ACTIVE-001',
            'route_id'     => $route->id,
            'status'       => 'ACTIVE',
            // no active_shift_id yet — set after the ShiftLog exists
        ]);

        // Create a real ShiftLog pointing to the vehicle.
        $shiftId = 'shift-active-' . uniqid();
        ShiftLog::create([
            'shift_id'       => $shiftId,
            'conductor_id'   => $this->conductor->id,
            'driver_id'      => $driver->id,
            'vehicle_id'     => $vehicle->id,
            'conductor_name' => 'Conductor Matrix',
            'driver_name'    => 'Driver Active',
            'unit_number'    => 'UNIT-ACTIVE',
            'plate_number'   => 'ACTIVE-001',
            'time_in'        => now(),
            'status'         => ShiftStatus::ACTIVE,
            'is_active'      => true,
        ]);

        // NOW link the vehicle to the active shift.
        $vehicle->update(['active_shift_id' => $shiftId]);

        $response = $this->actingAs($this->admin)
            ->deleteJson("/api/v1/admin/vehicles/{$vehicle->id}");

        $response->assertStatus(409);
        $response->assertJson(['success' => false]);
        $this->assertStringContainsString(
            'active shift',
            $response->json('errors.vehicle.0'),
            '409 error message should mention the active shift.'
        );
    }

    public function test_admin_vehicle_delete_succeeds_when_no_active_shift(): void
    {
        $route = Route::create(['name' => 'Test Route 2', 'status' => 'ACTIVE']);
        $vehicle = Vehicle::create([
            'unit_number'  => 'UNIT-FREE',
            'plate_number' => 'FREE-001',
            'route_id'     => $route->id,
            'status'       => 'ACTIVE',
            // no active_shift_id
        ]);

        $response = $this->actingAs($this->admin)
            ->deleteJson("/api/v1/admin/vehicles/{$vehicle->id}");

        $response->assertOk();
        $response->assertJson(['success' => true]);
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 4: No admin-only field leaks
    // ═════════════════════════════════════════════════════════════════════

    public function test_auth_login_response_does_not_leak_password_hash(): void
    {
        $response = $this->postJson('/api/v1/auth/login', [
            'login'    => 'conductor@matrix.test',
            'password' => 'password123',
        ]);

        $response->assertOk();
        $response->assertJsonMissingPath('data.password');
        $response->assertJsonMissingPath('data.password_hash');
        $response->assertDontSee('"password"', false);
    }

    public function test_conductor_profile_response_does_not_leak_password_or_tokens(): void
    {
        $response = $this->actingAs($this->conductor)
            ->getJson('/api/v1/conductor/profile');

        $response->assertOk();
        $response->assertJsonMissingPath('data.password');
        $response->assertJsonMissingPath('data.remember_token');
        $response->assertJsonMissingPath('data.tokens');
        // Conductor profile should NOT include admin-only fields
        $response->assertJsonMissingPath('data.conductorProfile.generated_password');
    }

    public function test_user_endpoint_does_not_leak_password(): void
    {
        $response = $this->actingAs($this->conductor)
            ->getJson('/api/v1/user');

        $response->assertOk();
        $response->assertJsonMissingPath('user.password');
        $response->assertJsonMissingPath('data.password');
        $response->assertJsonMissingPath('user.remember_token');
        $response->assertJsonMissingPath('data.remember_token');
    }

    public function test_admin_show_conductor_does_not_leak_generated_password(): void
    {
        $response = $this->actingAs($this->admin)
            ->getJson("/api/v1/admin/conductors/{$this->conductor->id}");

        $response->assertOk();
        // showConductor returns the ConductorProfile — generated_password is the
        // bcrypt hash of the conductor's login password. Should NOT be exposed.
        $response->assertJsonMissingPath('data.generated_password');
        $response->assertDontSee('generated_password', false);
    }

    public function test_admin_show_driver_does_not_leak_password(): void
    {
        $driver = Driver::create([
            'first_name'      => 'Test',
            'last_name'       => 'Driver',
            'birthday'        => '1985-01-01',
            'contact'         => '+639170000000',
            'license_number'  => 'LIC-TEST-' . uniqid(),
            'hire_date'       => now()->toDateString(),
            'status'          => 'ACTIVE',
        ]);

        $response = $this->actingAs($this->admin)
            ->getJson("/api/v1/admin/drivers/{$driver->id}");

        $response->assertOk();
        $response->assertJsonMissingPath('data.password');
        $response->assertJsonMissingPath('data.remember_token');
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 5: No notImplementedResponse() on shipped S5 routes
    // ═════════════════════════════════════════════════════════════════════

    public function test_no_not_implemented_on_s5_admin_routes(): void
    {
        $s5AdminRoutes = [
            ['GET', '/api/v1/admin/vehicles'],
            ['GET', '/api/v1/admin/analytics'],
            ['GET', '/api/v1/admin/conductors'],
        ];

        foreach ($s5AdminRoutes as [$method, $uri]) {
            $response = $this->actingAs($this->admin)
                ->json($method, $uri);

            $this->assertNotEquals(
                501,
                $response->status(),
                "{$method} {$uri} returned 501 Not Implemented — S5 routes must be fully implemented."
            );
            $response->assertJsonMissing(['message' => 'Not Implemented']);
        }
    }

    public function test_no_not_implemented_on_s5_conductor_routes(): void
    {
        $s5ConductorRoutes = [
            ['GET', '/api/v1/conductor/remittances'],
        ];

        foreach ($s5ConductorRoutes as [$method, $uri]) {
            $response = $this->actingAs($this->conductor)
                ->json($method, $uri);

            $this->assertNotEquals(
                501,
                $response->status(),
                "{$method} {$uri} returned 501 Not Implemented — S5 routes must be fully implemented."
            );
            $response->assertJsonMissing(['message' => 'Not Implemented']);
        }
    }

    /**
     * Grep-style assertion: no notImplementedResponse() in the S5 controller
     * methods (AdminVehicleController, AdminController::analytics/storeDriver/
     * updateDriver/showDriver/showConductor/conductors/storeConductor,
     * ConductorController::remittancesIndex).
     */
    public function test_no_not_implemented_call_in_s5_controller_methods(): void
    {
        $files = [
            app_path('Http/Controllers/Admin/AdminVehicleController.php'),
            app_path('Services/AdminService.php'),
            app_path('Services/ConductorService.php'),
        ];

        foreach ($files as $file) {
            $contents = file_get_contents($file);
            $this->assertStringNotContainsString(
                'notImplementedResponse',
                $contents,
                "{$file} must not contain notImplementedResponse() — S5 file."
            );
        }
    }
}
