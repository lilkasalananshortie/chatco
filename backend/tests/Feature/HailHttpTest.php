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
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleLocation;
use App\Services\HailService;
use App\Services\LocationService;
use Illuminate\Broadcasting\Broadcasters\LogBroadcaster;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Queue;
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

        // â”€â”€â”€ Create users + their role-specific profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€â”€ Create driver + route + vehicle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€â”€ Create active shift â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€â”€ Put vehicle at Manila coordinate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        VehicleLocation::create([
            'vehicle_id' => $this->vehicle->id,
            'shift_id' => $this->shift->shift_id,
            'conductor_id' => $this->conductor->id,
            'lat' => $this->vehicleLat,
            'lng' => $this->vehicleLng,
            'fix_recorded_at' => now(),
        ]);
    }

    // â”€â”€â”€ S3-T6: HTTP endpoint tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

    public function test_post_hail_to_offline_unit_returns_422_even_within_radius(): void
    {
        // No GPS update for over 5 minutes = phone offline, hidden on the map.
        $this->travel(LocationService::COMMUTER_FRESH_SECONDS + 1)->seconds();

        $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat + 0.0045, // ~500m north
                'commuter_lng' => $this->vehicleLng,
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Vehicle is offline');

        $this->assertSame(0, Hail::count());
    }

    public function test_post_hail_to_unit_on_break_returns_422_even_within_radius(): void
    {
        $this->shift->update(['is_on_break' => true, 'break_started_at' => now()]);

        $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat + 0.0045, // ~500m north
                'commuter_lng' => $this->vehicleLng,
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Vehicle is currently on break')
            ->assertJsonMissingPath('errors');

        $this->assertSame(0, Hail::count());
    }

    public function test_hail_creation_and_cancellation_broadcast_without_a_queue_worker(): void
    {
        config(['queue.default' => 'database']);
        Queue::fake();

        $broadcaster = \Mockery::mock(LogBroadcaster::class);
        Broadcast::extend('hail-test', fn () => $broadcaster);
        config(['broadcasting.default' => 'hail-test', 'broadcasting.connections.hail-test.driver' => 'hail-test']);
        $broadcaster->shouldReceive('broadcast')->once()->withArgs(function ($channels, $name, $payload) {
            return $name === 'HailCreated'
                && array_map(fn ($channel) => $channel->name, $channels) === ["private-vehicle.{$this->vehicle->id}.hails"]
                && Hail::whereKey($payload['hail_id'])->where('status', HailStatus::PENDING)->exists();
        });
        $broadcaster->shouldReceive('broadcast')->once()->withArgs(function ($channels, $name, $payload) {
            return $name === 'HailStatusChanged'
                && array_map(fn ($channel) => $channel->name, $channels) === [
                    "private-commuter.{$this->commuter->id}.hails",
                    "private-vehicle.{$this->vehicle->id}.hails",
                ]
                && $payload['status'] === 'CANCELLED'
                && Hail::whereKey($payload['hail_id'])->where('status', HailStatus::CANCELLED)->exists();
        });

        $created = $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat,
                'commuter_lng' => $this->vehicleLng,
            ])->assertCreated();

        $this->deleteJson('/api/v1/commuter/hail/'.$created->json('data.id'))
            ->assertOk()->assertJsonPath('data.status', 'CANCELLED');

        Queue::assertNothingPushed();
    }

    public function test_broadcast_outage_does_not_fail_committed_hail_or_cancellation(): void
    {
        $broadcaster = \Mockery::mock(LogBroadcaster::class);
        Broadcast::extend('hail-test', fn () => $broadcaster);
        config(['broadcasting.default' => 'hail-test', 'broadcasting.connections.hail-test.driver' => 'hail-test']);
        $broadcaster->shouldReceive('broadcast')->twice()->andThrow(new \RuntimeException('Broadcast unavailable'));

        $created = $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat,
                'commuter_lng' => $this->vehicleLng,
            ])->assertCreated();
        $id = $created->json('data.id');
        $this->assertDatabaseHas('hails', ['id' => $id, 'status' => 'PENDING']);

        $this->deleteJson('/api/v1/commuter/hail/'.$id)
            ->assertOk()->assertJsonPath('data.status', 'CANCELLED');
        $this->assertDatabaseHas('hails', ['id' => $id, 'status' => 'CANCELLED']);
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
        Route::whereKey($this->vehicle->route_id)->update(['geometry' => json_encode([[15.50, 121.50], [15.60, 121.60]])]);

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

    public function test_hail_reaches_every_unit_whose_radius_covers_the_commuter(): void
    {
        $inRange = $this->addOnDutyUnit('TEST-002', $this->vehicleLat + 0.009, $this->vehicleLng); // ~1km from vehicle, ~500m from commuter
        $outOfRange = $this->addOnDutyUnit('TEST-003', $this->vehicleLat + 0.03, $this->vehicleLng); // ~2.8km from commuter
        $onBreak = $this->addOnDutyUnit('TEST-004', $this->vehicleLat + 0.0045, $this->vehicleLng, onBreak: true);

        $created = $this->actingAs($this->commuter, 'sanctum')
            ->postJson('/api/v1/commuter/hail', [
                'vehicle_id' => $this->vehicle->id,
                'commuter_lat' => $this->vehicleLat + 0.0045,
                'commuter_lng' => $this->vehicleLng,
            ])->assertCreated()
            ->assertJsonPath('data.vehicle_id', $this->vehicle->id);

        $this->assertEqualsCanonicalizing(
            [$this->vehicle->id, $inRange->id],
            Hail::pending()->pluck('vehicle_id')->all(),
        );
        $this->assertSame(0, Hail::whereIn('vehicle_id', [$outOfRange->id, $onBreak->id])->count());

        // Cancelling the returned hail hides the pickup point on both units.
        $this->deleteJson('/api/v1/commuter/hail/'.$created->json('data.id'))->assertOk();
        $this->assertSame(0, Hail::pending()->count());
        $this->assertSame(2, Hail::where('status', HailStatus::CANCELLED)->count());
    }

    public function test_cancel_still_clears_other_units_when_picked_units_copy_already_closed(): void
    {
        $other = $this->addOnDutyUnit('TEST-002', $this->vehicleLat + 0.0045, $this->vehicleLng);
        $hail = app(HailService::class)->createHail($this->commuter, $this->vehicle->id, $this->vehicleLat, $this->vehicleLng);
        // e.g. the picked unit ended its shift, which cancels only its own copy.
        $hail->update(['status' => HailStatus::CANCELLED]);

        $this->actingAs($this->commuter, 'sanctum')
            ->deleteJson("/api/v1/commuter/hail/{$hail->id}")
            ->assertStatus(409);

        $this->assertDatabaseHas('hails', ['vehicle_id' => $other->id, 'status' => 'CANCELLED']);
    }

    public function test_cancelling_another_commuters_hail_leaves_own_hails_untouched(): void
    {
        $intruder = User::create(['email' => 'other@test.com', 'password' => bcrypt('password'), 'role' => UserRole::COMMUTER]);
        $hail = app(HailService::class)->createHail($this->commuter, $this->vehicle->id, $this->vehicleLat, $this->vehicleLng);

        $this->actingAs($intruder, 'sanctum')
            ->deleteJson("/api/v1/commuter/hail/{$hail->id}")
            ->assertForbidden();

        $this->assertDatabaseHas('hails', ['id' => $hail->id, 'status' => 'PENDING']);
    }

    private function addOnDutyUnit(string $unitNumber, float $lat, float $lng, bool $onBreak = false): Vehicle
    {
        $conductor = User::create(['email' => strtolower($unitNumber).'@test.com', 'password' => bcrypt('password'), 'role' => UserRole::CONDUCTOR]);
        ConductorProfile::create([
            'id' => $conductor->id,
            'first_name' => 'Unit',
            'middle_name' => null,
            'last_name' => $unitNumber,
            'birthday' => '1990-01-01',
            'profile_picture_url' => null,
            'generated_username' => strtolower($unitNumber),
            'generated_password' => bcrypt('password'),
        ]);
        $vehicle = Vehicle::create([
            'unit_number' => $unitNumber,
            'plate_number' => $unitNumber.'-P',
            'route_id' => $this->vehicle->route_id,
            'conductor_id' => $conductor->id,
            'status' => 'ACTIVE',
        ]);
        $driver = Driver::create([
            'first_name' => 'Unit',
            'middle_name' => null,
            'last_name' => 'Driver',
            'birthday' => '1990-01-01',
            'contact' => '+639171112222',
            'license_number' => 'DL-'.$unitNumber,
            'hire_date' => '2023-01-01',
            'profile_picture_url' => null,
            'status' => 'ACTIVE',
        ]);
        $shift = ShiftLog::forceCreate([
            'shift_id' => 'SFT-'.$unitNumber,
            'conductor_id' => $conductor->id,
            'driver_id' => $driver->id,
            'vehicle_id' => $vehicle->id,
            'route_id' => $this->vehicle->route_id,
            'conductor_name' => 'Unit '.$unitNumber,
            'driver_name' => 'Driver',
            'unit_number' => $unitNumber,
            'plate_number' => $vehicle->plate_number,
            'time_in' => now(),
            'is_active' => true,
            'status' => 'ACTIVE',
            'is_on_break' => $onBreak,
        ]);
        $vehicle->update(['active_shift_id' => $shift->shift_id]);
        VehicleLocation::create([
            'vehicle_id' => $vehicle->id,
            'shift_id' => $shift->shift_id,
            'conductor_id' => $conductor->id,
            'lat' => $lat,
            'lng' => $lng,
            'fix_recorded_at' => now(),
        ]);

        return $vehicle;
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

    // â”€â”€â”€ S3-T7: hails:expire command tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
