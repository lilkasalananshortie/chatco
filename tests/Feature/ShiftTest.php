<?php

namespace Tests\Feature;

use App\Enums\ShiftStatus;
use App\Enums\PaymentMethod;
use App\Enums\PaymentStatus;
use App\Models\Driver;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ShiftTest extends TestCase
{
    use RefreshDatabase;

    private User $conductor;

    private Vehicle $vehicle;

    private Driver $driver;

    private Route $route;

    protected function setUp(): void
    {
        parent::setUp();

        $this->conductor = User::factory()->conductor()->create();
        $this->vehicle = Vehicle::factory()->create();
        $this->driver = Driver::factory()->create();
        $this->route = Route::factory()->create();
        $this->vehicle->update([
            'route_id' => $this->route->id,
            'driver_id' => $this->driver->id,
            'conductor_id' => $this->conductor->conductorProfile->id,
            'assignment_date' => now('Asia/Manila')->toDateString(),
            'assignment_approved_at' => now(),
        ]);
    }

    public function test_conductor_can_start_shift(): void
    {
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $response->assertCreated();

        $this->assertDatabaseHas('shift_logs', [
            'conductor_id' => $this->conductor->id,
            'driver_id' => $this->driver->id,
            'vehicle_id' => $this->vehicle->id,
            'route_id' => $this->route->id,
            'status' => ShiftStatus::ACTIVE->value,
        ]);

        $this->vehicle->refresh();
        $this->driver->refresh();
        $this->assertNotNull($this->vehicle->active_shift_id);
        $this->assertNotNull($this->driver->active_shift_id);
    }

    public function test_conductor_cannot_start_duplicate_shift(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => Vehicle::factory()->create()->id,
                'driver_id' => Driver::factory()->create()->id,
                'route_id' => $this->route->id,
            ]);

        $response->assertStatus(409);
    }

    public function test_conductor_cannot_start_shift_if_vehicle_in_use(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $otherConductor = User::factory()->conductor()->create();

        $response = $this->actingAs($otherConductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => Driver::factory()->create()->id,
                'route_id' => $this->route->id,
            ]);

        $response->assertStatus(409);
    }

    public function test_conductor_cannot_start_shift_if_driver_in_use(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $otherConductor = User::factory()->conductor()->create();

        $response = $this->actingAs($otherConductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => Vehicle::factory()->create()->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $response->assertStatus(409);
    }

    public function test_non_conductor_cannot_start_shift(): void
    {
        $commuter = User::factory()->commuter()->create();

        $response = $this->actingAs($commuter)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $response->assertForbidden();
    }

    public function test_conductor_can_end_shift_via_remittance(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $shift = ShiftLog::where('conductor_id', $this->conductor->id)->first();

        // Shift ends ONLY via remittance submission (POST /api/conductor/remittances)
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/remittances', [
                'shift_id' => $shift->shift_id,
                'total_collected' => 5000.00,
                'remitted_amount' => 5000.00,
            ]);

        $response->assertOk();

        $shift->refresh();
        // ShiftLog::casts()['status'] = ShiftStatus::class, so
        // $shift->status is a ShiftStatus enum instance — compare
        // enum-to-enum (not enum->value, which would be a string and
        // fail PHPUnit's strict type check).
        $this->assertEquals(ShiftStatus::ENDED, $shift->status);
        $this->assertNotNull($shift->time_out);

        $this->vehicle->refresh();
        $this->driver->refresh();
        $this->assertNull($this->vehicle->active_shift_id);
        $this->assertNull($this->vehicle->driver_id);
        $this->assertNull($this->vehicle->conductor_id);
        $this->assertNull($this->vehicle->assignment_date);
        $this->assertNull($this->vehicle->assignment_approved_at);
        $this->assertNull($this->driver->active_shift_id);
    }

    public function test_conductor_cannot_end_other_conductor_shift(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $shift = ShiftLog::where('conductor_id', $this->conductor->id)->first();

        $otherConductor = User::factory()->conductor()->create();

        $response = $this->actingAs($otherConductor)
            ->postJson('/api/v1/conductor/remittances', [
                'shift_id' => $shift->shift_id,
                'total_collected' => 5000.00,
                'remitted_amount' => 5000.00,
            ]);

        $response->assertStatus(403);
    }

    public function test_remittance_for_nonexistent_shift_returns_404(): void
    {
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/remittances', [
                'shift_id' => 'SHF-NONEXISTENT123',
                'total_collected' => 5000.00,
                'remitted_amount' => 5000.00,
            ]);

        $response->assertNotFound();
    }

    public function test_conductor_can_get_active_shift(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $response = $this->actingAs($this->conductor)
            ->getJson('/api/v1/conductor/shift');

        $response->assertOk();
        $response->assertJsonPath('data.status', ShiftStatus::ACTIVE->value);
    }

    public function test_conductor_transactions_are_paginated_at_twenty_five_per_page(): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'route_id' => $this->route->id,
            ]);

        $shift = ShiftLog::where('conductor_id', $this->conductor->id)->firstOrFail();

        foreach (range(1, 30) as $i) {
            Transaction::create([
                'transaction_id' => 'TXN-PAGE-'.$i,
                'shift_id' => $shift->shift_id,
                'payment_method' => PaymentMethod::CASH->value,
                'final_amount' => 20,
                'passenger_name' => 'Passenger '.$i,
                'status' => PaymentStatus::PAID->value,
                'created_at' => now()->subMinutes($i),
                'updated_at' => now()->subMinutes($i),
            ]);
        }

        $this->actingAs($this->conductor)
            ->getJson("/api/v1/conductor/transactions?shift_id={$shift->shift_id}&per_page=25&page=1")
            ->assertOk()
            ->assertJsonPath('data.current_page', 1)
            ->assertJsonPath('data.per_page', 25)
            ->assertJsonPath('data.total', 30)
            ->assertJsonPath('data.last_page', 2)
            ->assertJsonCount(25, 'data.data');

        $this->actingAs($this->conductor)
            ->getJson("/api/v1/conductor/transactions?shift_id={$shift->shift_id}&per_page=25&page=2")
            ->assertOk()
            ->assertJsonPath('data.current_page', 2)
            ->assertJsonCount(5, 'data.data');
    }

    public function test_conductor_gets_null_data_when_no_active_shift(): void
    {
        $response = $this->actingAs($this->conductor)
            ->getJson('/api/v1/conductor/shift');

        $response->assertOk();
        $response->assertJsonPath('data', null);
    }

    public function test_conductor_can_get_shift_logs(): void
    {
        // Create a shift directly via factory then start one via API
        ShiftLog::factory()->create([
            'conductor_id' => $this->conductor->id,
            'driver_id' => $this->driver->id,
            'vehicle_id' => $this->vehicle->id,
            'route_id' => $this->route->id,
            'status' => ShiftStatus::ENDED->value,
            'time_out' => now(),
        ]);

        $response = $this->actingAs($this->conductor)
            ->getJson('/api/v1/conductor/shift-logs');

        $response->assertOk();
    }
}
