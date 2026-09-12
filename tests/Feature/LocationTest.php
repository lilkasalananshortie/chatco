<?php

namespace Tests\Feature;

use App\Models\Driver;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleLocation;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Sprint 2 — GPS tracking feature tests.
 *
 * Covers LocationService via the conductor + commuter API endpoints.
 * All role strings use the UserRole enum values (uppercase) and all
 * GPS payloads use the validated field names lat / lng (NOT
 * latitude / longitude), matching UpdateLocationRequest.
 */
class LocationTest extends TestCase
{
    use RefreshDatabase;

    private User $conductor;
    private Vehicle $vehicle;
    private Driver $driver;
    private Route $route;
    private ShiftLog $shift;

    protected function setUp(): void
    {
        parent::setUp();

        $this->conductor = User::factory()->conductor()->create();
        $this->vehicle = Vehicle::factory()->create();
        $this->driver = Driver::factory()->create();
        $this->route = Route::factory()->create();

        $this->shift = ShiftLog::create([
            'shift_id' => 'SFT-' . now()->format('YmdHis'),
            'conductor_id' => $this->conductor->id,
            'driver_id' => $this->driver->id,
            'vehicle_id' => $this->vehicle->id,
            'route_id' => $this->route->id,
            'conductor_name' => 'Conductor Test',
            'driver_name' => $this->driver->first_name . ' ' . $this->driver->last_name,
            'plate_number' => $this->vehicle->plate_number,
            'unit_number' => $this->vehicle->unit_number,
            'time_in' => now(),
            'status' => 'ACTIVE',
        ]);

        $this->vehicle->update(['active_shift_id' => $this->shift->shift_id]);
        $this->driver->update(['active_shift_id' => $this->shift->shift_id]);
    }

    public function test_conductor_can_update_location(): void
    {
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
            ]);

        $response->assertOk();

        $this->assertDatabaseHas('vehicle_locations', [
            'vehicle_id' => $this->vehicle->id,
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);
    }

    public function test_conductor_can_update_location_with_speed_and_heading(): void
    {
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
                'speed' => 45.50,
                'heading' => 180.00,
            ]);

        $response->assertOk();
    }

    public function test_utc_browser_fix_timestamp_is_stored_in_the_application_timezone(): void
    {
        Carbon::setTestNow(Carbon::create(2026, 8, 22, 14, 18, 40, 'Asia/Manila'));

        try {
            $this->actingAs($this->conductor)
                ->postJson('/api/v1/conductor/location', [
                    'lat' => 14.5995,
                    'lng' => 120.9842,
                    'fix_timestamp' => '2026-08-22T06:18:38.000Z',
                ])
                ->assertOk();

            $this->assertDatabaseHas('vehicle_locations', [
                'vehicle_id' => $this->vehicle->id,
                'fix_recorded_at' => '2026-08-22 14:18:38',
            ]);
        } finally {
            Carbon::setTestNow();
        }
    }

    public function test_location_update_requires_active_shift(): void
    {
        // End the shift, so the conductor no longer has an active one.
        $this->shift->update(['status' => 'ENDED', 'time_out' => now()]);
        $this->vehicle->update(['active_shift_id' => null]);
        $this->driver->update(['active_shift_id' => null]);

        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
            ]);

        $response->assertStatus(422);
    }

    public function test_location_update_validates_coordinates(): void
    {
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 999,
                'lng' => 999,
            ]);

        $response->assertStatus(422);
    }

    public function test_location_upsert_updates_existing(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
            ]);

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.6000,
                'lng' => 120.9850,
            ]);

        $this->assertEquals(1, VehicleLocation::count());
        $this->assertDatabaseHas('vehicle_locations', [
            'vehicle_id' => $this->vehicle->id,
            'lat' => 14.6000,
        ]);
    }

    public function test_commuter_can_get_all_active_locations(): void
    {
        $commuter = User::factory()->commuter()->create();

        VehicleLocation::create([
            'vehicle_id' => $this->vehicle->id,
            'conductor_id' => $this->conductor->id,
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $response = $this->actingAs($commuter)
            ->getJson('/api/v1/vehicles/locations');

        $response->assertOk();
        $response->assertJsonStructure([
            'success',
            'data' => [
                '*' => [
                    'vehicle_id',
                    'plate_number',
                    'lat',
                    'lng',
                ],
            ],
        ]);
    }

    public function test_conductor_can_update_capacity_status(): void
    {
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/capacity-status', [
                'capacity_status' => 'STANDING',
            ]);

        $response->assertOk();

        $this->assertDatabaseHas('vehicle_locations', [
            'vehicle_id' => $this->vehicle->id,
            'capacity_status' => 'STANDING',
        ]);
    }

    public function test_capacity_status_validates_enum(): void
    {
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/capacity-status', [
                'capacity_status' => 'INVALID',
            ]);

        $response->assertStatus(422);
    }

    public function test_non_conductor_cannot_update_location(): void
    {
        $commuter = User::factory()->commuter()->create();

        $response = $this->actingAs($commuter)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
            ]);

        $response->assertForbidden();
    }

    public function test_unauthenticated_cannot_access_locations(): void
    {
        $response = $this->getJson('/api/v1/vehicles/locations');
        $response->assertUnauthorized();
    }
}
