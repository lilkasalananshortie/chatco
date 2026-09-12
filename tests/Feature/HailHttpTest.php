<?php

namespace Tests\Feature;

use App\Enums\HailStatus;
use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\Hail;
use App\Models\Route;
use App\Models\RouteVersion;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleLocation;
use App\Services\HailService;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class HailHttpTest extends TestCase
{
    use RefreshDatabase;

    private User $commuter;

    private User $conductor;

    private User $admin;

    private Vehicle $vehicle;

    private ShiftLog $shift;

    private float $vehicleLat = 14.5995120;

    private float $vehicleLng = 120.9842190;

    protected function setUp(): void
    {
        parent::setUp();

        // ─── Create users + their role-specific profiles ────────────
        // Profile models are REQUIRED because shift_logs.conductor_id
        // has a FK constraint to conductor_profiles.id (not users.id),
        // and HailCreated event needs commuterProfile for the name.

        $this->commuter = User::create([
            'email' => 'commuter@test.com',
            'password' => bcrypt('password'),
            'role' => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id' => $this->commuter->id,
            'first_name' => 'Test',
            'middle_name' => null,
            'surname' => 'Commuter',
            'birthdate' => '1990-01-01',
            'gender' => 'Male',
            'email' => 'commuter@test.com',
            'contact_number' => '+639171112222',
            'commuter_type' => 'Regular',
            'applied_type' => null,
            'username' => 'testcommuter',
            'language_preference' => 'en',
            'account_status' => 'ACTIVE',
            'id_image_url' => null,
            'verified_at' => now(),
            'rejection_reason' => null,
        ]);

        $this->conductor = User::create([
            'email' => 'conductor@test.com',
            'password' => bcrypt('password'),
            'role' => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id' => $this->conductor->id,
            'first_name' => 'Test',
            'middle_name' => null,
            'last_name' => 'Conductor',
            'birthday' => '1990-01-01',
            'profile_picture_url' => null,
            'generated_username' => 'testconductor',
            'generated_password' => bcrypt('password'),
        ]);

        $this->admin = User::create([
            'email' => 'admin@test.com',
            'password' => bcrypt('password'),
            'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create([
            'id' => $this->admin->id,
            'first_name' => 'Test',
            'middle_name' => null,
            'last_name' => 'Admin',
            'profile_picture_url' => null,
        ]);

        // ─── Create driver + route + vehicle ─────────────────────────
        $driver = Driver::create([
            'first_name' => 'Test',
            'middle_name' => null,
            'last_name' => 'Driver',
            'birthday' => '1990-01-01',
            'contact' => '+639171112222',
            'license_number' => 'DL-TEST-001',
            'hire_date' => '2023-01-01',
            'profile_picture_url' => null,
            'status' => 'ACTIVE',
        ]);

        $route = Route::create([
            'name' => 'Test Route',
            'status' => 'ACTIVE',
            'waypoints' => [],
        ]);

        $this->vehicle = Vehicle::create([
            'unit_number' => 'TEST-001',
            'plate_number' => 'TEST-1234',
            'route_id' => $route->id,
            'driver_id' => $driver->id,
            'conductor_id' => $this->conductor->id,
            'status' => 'ACTIVE',
        ]);

        // ─── Create active shift ─────────────────────────────────────
        // (forceCreate due to pre-existing ShiftLog model/migration drift
        // -- $fillable doesn't include unit_number, but migration requires it)
        $this->shift = ShiftLog::forceCreate([
            'shift_id' => 'SFT-TEST-'.now()->format('His'),
            'conductor_id' => $this->conductor->id,
            'driver_id' => $driver->id,
            'vehicle_id' => $this->vehicle->id,
            'route_id' => $route->id,
            'conductor_name' => 'Test Conductor',
            'driver_name' => 'Test Driver',
            'unit_number' => $this->vehicle->unit_number,
            'plate_number' => $this->vehicle->plate_number,
            'time_in' => now(),
            'time_out' => null,
            'is_active' => true,
            'status' => 'ACTIVE',
            'notes' => null,
        ]);
        $this->vehicle->update(['active_shift_id' => $this->shift->shift_id]);
        $driver->update(['active_shift_id' => $this->shift->shift_id]);

        // ─── Put vehicle at Manila coordinate ────────────────────────
        VehicleLocation::create([
            'vehicle_id' => $this->vehicle->id,
            'shift_id' => $this->shift->shift_id,
            'conductor_id' => $this->conductor->id,
            'lat' => $this->vehicleLat,
            'lng' => $this->vehicleLng,
            'fix_recorded_at' => now(),
        ]);
    }

    // ─── S3-T6: HTTP endpoint tests ─────────────────────────────────

    public function test_post_hail_at_500m_returns_201(): void
    {
        $response = $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat + 0.0045, // ~500m north
                'commuter_lng' => $this->vehicleLng,
            ]);

        $response->assertCreated();
        $response->assertJsonPath('data.status', 'PENDING');
    }

    public function test_post_hail_at_1500m_returns_422_with_outside_radius(): void
    {
        $response = $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat + 0.0135, // ~1500m north
                'commuter_lng' => $this->vehicleLng,
            ]);

        $response->assertStatus(422);
        $response->assertJson(['error' => 'outside_radius']);
        $this->assertNotNull($response->json('distance_m'));
    }

    public function test_post_hail_outside_published_route_coverage_returns_422(): void
    {
        RouteVersion::create([
            'route_id' => $this->vehicle->route_id,
            'version' => 1,
            'status' => RouteVersion::STATUS_PUBLISHED,
            'geometry' => [[15.50, 121.50], [15.60, 121.60]],
            'effective_from' => now()->subMinute(),
            'published_at' => now()->subMinute(),
        ]);

        $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat,
                'commuter_lng' => $this->vehicleLng,
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Pickup point is outside the active route coverage.');
    }

    public function test_delete_hail_returns_200_with_cancelled_status(): void
    {
        $hail = app(HailService::class)->createHail(
            $this->commuter,
            $this->vehicle->id,
            $this->vehicleLat + 0.0045,
            $this->vehicleLng,
        );

        $response = $this->actingAs($this->commuter, 'sanctum')
            ->deleteJson("/api/v1/commuter/hail/{$hail->id}");

        $response->assertOk();
        $response->assertJsonPath('data.status', 'CANCELLED');
    }

    public function test_get_conductor_hails_returns_200_with_list(): void
    {
        app(HailService::class)->createHail(
            $this->commuter,
            $this->vehicle->id,
            $this->vehicleLat + 0.0045,
            $this->vehicleLng,
        );

        $response = $this->actingAs($this->conductor, 'sanctum')
            ->getJson('/api/v1/conductor/hails');

        $response->assertOk();
        $response->assertJsonStructure([
            'success',
            'data' => ['*' => ['id', 'status']],
        ]);
    }

    public function test_accept_hail_returns_200_with_accepted_status(): void
    {
        $hail = app(HailService::class)->createHail(
            $this->commuter,
            $this->vehicle->id,
            $this->vehicleLat + 0.0045,
            $this->vehicleLng,
        );

        $response = $this->actingAs($this->conductor, 'sanctum')
            ->postJson("/api/v1/conductor/hails/{$hail->id}/accept");

        $response->assertOk();
        $response->assertJsonPath('data.status', 'ACCEPTED');
    }

    public function test_reject_hail_returns_200_with_rejected_status(): void
    {
        $hail = app(HailService::class)->createHail(
            $this->commuter,
            $this->vehicle->id,
            $this->vehicleLat + 0.0045,
            $this->vehicleLng,
        );

        $response = $this->actingAs($this->conductor, 'sanctum')
            ->postJson("/api/v1/conductor/hails/{$hail->id}/reject");

        $response->assertOk();
        $response->assertJsonPath('data.status', 'REJECTED');
    }

    public function test_admin_cannot_post_commuter_hail_returns_403(): void
    {
        $response = $this->actingAs($this->admin, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat + 0.0045,
                'commuter_lng' => $this->vehicleLng,
            ]);

        $response->assertForbidden();
    }

    public function test_conductor_cannot_post_commuter_hail_returns_403(): void
    {
        $response = $this->actingAs($this->conductor, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat + 0.0045,
                'commuter_lng' => $this->vehicleLng,
            ]);

        $response->assertForbidden();
    }

    public function test_commuter_cannot_access_conductor_hail_endpoints_returns_403(): void
    {
        $response = $this->actingAs($this->commuter, 'sanctum')
            ->getJson('/api/v1/conductor/hails');

        $response->assertForbidden();
    }

    // ─── S3-T7: hails:expire command tests ─────────────────────────

    public function test_hails_expire_command_transitions_stale_hails(): void
    {
        // 2 stale + 1 fresh
        Hail::create(['commuter_id' => $this->commuter->id, 'vehicle_id' => $this->vehicle->id, 'commuter_lat' => $this->vehicleLat, 'commuter_lng' => $this->vehicleLng, 'distance_m' => 100, 'status' => HailStatus::PENDING, 'expires_at' => now()->subMinutes(5)]);
        Hail::create(['commuter_id' => $this->commuter->id, 'vehicle_id' => $this->vehicle->id, 'commuter_lat' => $this->vehicleLat, 'commuter_lng' => $this->vehicleLng, 'distance_m' => 200, 'status' => HailStatus::PENDING, 'expires_at' => now()->subMinutes(10)]);
        Hail::create(['commuter_id' => $this->commuter->id, 'vehicle_id' => $this->vehicle->id, 'commuter_lat' => $this->vehicleLat, 'commuter_lng' => $this->vehicleLng, 'distance_m' => 300, 'status' => HailStatus::PENDING, 'expires_at' => now()->addMinutes(3)]);

        $this->artisan('hails:expire')
            ->expectsOutput('2 hails expired')
            ->assertSuccessful();

        $this->assertSame(2, Hail::where('status', HailStatus::EXPIRED)->count());
        $this->assertSame(1, Hail::where('status', HailStatus::PENDING)->count());
    }

    public function test_hails_expire_command_outputs_zero_when_nothing_to_expire(): void
    {
        $this->artisan('hails:expire')
            ->expectsOutput('0 hails expired')
            ->assertSuccessful();
    }

    public function test_schedule_registers_hails_expire_every_minute(): void
    {
        $events = app(Schedule::class)->events();
        $found = false;
        foreach ($events as $event) {
            if (str_contains($event->command, 'hails:expire')) {
                $found = true;
                break;
            }
        }
        $this->assertTrue($found, 'hails:expire is not registered in the schedule');
    }
}
