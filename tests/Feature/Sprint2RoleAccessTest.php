<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\Driver;
use App\Models\Route;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Sprint 2 — RBAC matrix for shift + location endpoints.
 *
 * All role assignments use the UserRole enum-backed factory state
 * methods (->conductor(), ->commuter(), ->admin()) so the role
 * column receives the uppercase enum value the EnsureUserRole
 * middleware expects. All shift-start URLs use the plural
 * /api/conductor/shifts/start route.
 */
class Sprint2RoleAccessTest extends TestCase
{
    use RefreshDatabase;

    public function test_commuter_cannot_access_conductor_shift_start(): void
    {
        $commuter = User::factory()->commuter()->create();
        $vehicle = Vehicle::factory()->create();
        $driver = Driver::factory()->create();

        $response = $this->actingAs($commuter)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $vehicle->id,
                'driver_id' => $driver->id,
            ]);

        $response->assertForbidden();
    }

    public function test_admin_cannot_start_shift(): void
    {
        $admin = User::factory()->admin()->create();
        $vehicle = Vehicle::factory()->create();
        $driver = Driver::factory()->create();

        $response = $this->actingAs($admin)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $vehicle->id,
                'driver_id' => $driver->id,
            ]);

        $response->assertForbidden();
    }

    public function test_commuter_cannot_update_vehicle_location(): void
    {
        $commuter = User::factory()->commuter()->create();

        $response = $this->actingAs($commuter)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
            ]);

        $response->assertForbidden();
    }

    public function test_admin_cannot_update_vehicle_location(): void
    {
        $admin = User::factory()->admin()->create();

        $response = $this->actingAs($admin)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
            ]);

        $response->assertForbidden();
    }

    public function test_conductor_can_access_own_routes(): void
    {
        $conductor = User::factory()->conductor()->create();

        $response = $this->actingAs($conductor)
            ->getJson('/api/v1/conductor/shift');

        $response->assertOk();
    }

    public function test_any_authenticated_user_can_view_vehicle_locations(): void
    {
        $commuter = User::factory()->commuter()->create();
        $admin = User::factory()->admin()->create();

        $commuterResponse = $this->actingAs($commuter)
            ->getJson('/api/v1/vehicles/locations');
        $commuterResponse->assertOk();

        $adminResponse = $this->actingAs($admin)
            ->getJson('/api/v1/vehicles/locations');
        $adminResponse->assertOk();
    }

    public function test_guest_cannot_access_any_protected_route(): void
    {
        $this->getJson('/api/v1/conductor/shift')->assertUnauthorized();
        $this->getJson('/api/v1/vehicles/locations')->assertUnauthorized();
        $this->postJson('/api/v1/conductor/location', [])->assertUnauthorized();
        $this->postJson('/api/v1/conductor/shifts/start', [])->assertUnauthorized();
    }
}
