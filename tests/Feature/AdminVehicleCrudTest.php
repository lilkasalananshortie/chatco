<?php

namespace Tests\Feature;

use App\Enums\ShiftStatus;
use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * S5-T4 — Admin vehicle CRUD (behavioural coverage).
 *
 * RoleAccessMatrixTest covers access + the 409 active-shift delete guard;
 * this suite covers the CRUD behaviour: create persists, plate/unit
 * uniqueness (422), update persists, and list filter/search/pagination.
 */
class AdminVehicleCrudTest extends TestCase
{
    use RefreshDatabase;

    private int $seq = 0;

    private function makeAdmin(): User
    {
        $admin = User::create([
            'email'    => 'admin@gmail.com',
            'password' => Hash::make('password123'),
            'role'     => UserRole::ADMIN,
        ]);
        AdminProfile::create(['id' => $admin->id, 'first_name' => 'System', 'last_name' => 'Admin']);

        return $admin;
    }

    private function makeCommuter(): User
    {
        return User::create([
            'email'    => 'commuter@test.com',
            'password' => Hash::make('password123'),
            'role'     => UserRole::COMMUTER,
        ]);
    }

    private function makeVehicle(array $overrides = []): Vehicle
    {
        $this->seq++;

        return Vehicle::create(array_merge([
            'unit_number'  => "UNIT-{$this->seq}",
            'plate_number' => "PLT-{$this->seq}",
            'vehicle_type' => 'Jeepney',
            'status'       => 'ACTIVE',
        ], $overrides));
    }

    // ── Create ───────────────────────────────────────────────────

    public function test_admin_can_create_vehicle(): void
    {
        $admin = $this->makeAdmin();

        $response = $this->actingAs($admin)->postJson('/api/v1/admin/vehicles', [
            'unit_number'  => 'UNIT-NEW',
            'plate_number' => 'NEW-1234',
            'brand'        => 'Isuzu',
            'model'        => 'Elf NHR',
            'vehicle_type' => 'Bus',
        ]);

        $response->assertStatus(201)->assertJsonPath('success', true);
        $this->assertDatabaseHas('vehicles', [
            'unit_number'  => 'UNIT-NEW',
            'plate_number' => 'NEW-1234',
            'brand'        => 'Isuzu',
            'model'        => 'Elf NHR',
            'vehicle_type' => 'Bus',
        ]);
    }

    public function test_create_rejects_missing_brand_or_model(): void
    {
        $admin = $this->makeAdmin();

        $this->actingAs($admin)->postJson('/api/v1/admin/vehicles', [
            'unit_number'  => 'UNIT-NOBRAND',
            'plate_number' => 'NB-0001',
        ])->assertStatus(422)->assertJsonStructure(['errors' => ['brand', 'model']]);
    }

    public function test_create_rejects_duplicate_plate_or_unit(): void
    {
        $admin = $this->makeAdmin();
        $this->makeVehicle(['unit_number' => 'UNIT-DUP', 'plate_number' => 'DUP-0001']);

        $this->actingAs($admin)->postJson('/api/v1/admin/vehicles', [
            'unit_number'  => 'UNIT-DUP',     // duplicate
            'plate_number' => 'OTHER-9999',
        ])->assertStatus(422)->assertJsonStructure(['errors' => ['unit_number']]);

        $this->actingAs($admin)->postJson('/api/v1/admin/vehicles', [
            'unit_number'  => 'UNIT-OTHER',
            'plate_number' => 'DUP-0001',     // duplicate
        ])->assertStatus(422)->assertJsonStructure(['errors' => ['plate_number']]);
    }

    public function test_create_rejects_invalid_vehicle_type(): void
    {
        $admin = $this->makeAdmin();

        $this->actingAs($admin)->postJson('/api/v1/admin/vehicles', [
            'unit_number'  => 'UNIT-X',
            'plate_number' => 'X-0001',
            'vehicle_type' => 'Spaceship',
        ])->assertStatus(422)->assertJsonStructure(['errors' => ['vehicle_type']]);
    }

    // ── Read / list ──────────────────────────────────────────────

    public function test_list_is_paginated_and_filterable(): void
    {
        $admin = $this->makeAdmin();
        $this->makeVehicle(['status' => 'ACTIVE', 'plate_number' => 'AAA-0001', 'unit_number' => 'UNIT-A']);
        $this->makeVehicle(['status' => 'MAINTENANCE', 'plate_number' => 'BBB-0002', 'unit_number' => 'UNIT-B']);

        // Unfiltered: both vehicles.
        $this->actingAs($admin)->getJson('/api/v1/admin/vehicles')
            ->assertStatus(200)
            ->assertJsonStructure(['data' => ['current_page', 'data', 'total']])
            ->assertJsonPath('data.total', 2);

        // Status filter.
        $this->actingAs($admin)->getJson('/api/v1/admin/vehicles?status=MAINTENANCE')
            ->assertStatus(200)
            ->assertJsonPath('data.total', 1);

        // Search by plate.
        $this->actingAs($admin)->getJson('/api/v1/admin/vehicles?search=AAA')
            ->assertStatus(200)
            ->assertJsonPath('data.total', 1);
    }

    // ── Update ───────────────────────────────────────────────────

    public function test_admin_can_update_vehicle(): void
    {
        $admin = $this->makeAdmin();
        $vehicle = $this->makeVehicle(['status' => 'ACTIVE']);

        $this->actingAs($admin)->putJson("/api/v1/admin/vehicles/{$vehicle->id}", [
            'status'       => 'MAINTENANCE',
            'vehicle_type' => 'Van',
        ])->assertStatus(200);

        $this->assertDatabaseHas('vehicles', [
            'id'           => $vehicle->id,
            'status'       => 'MAINTENANCE',
            'vehicle_type' => 'Van',
        ]);
    }

    public function test_update_allows_keeping_own_plate_number(): void
    {
        $admin = $this->makeAdmin();
        $vehicle = $this->makeVehicle(['plate_number' => 'KEEP-0001', 'unit_number' => 'UNIT-KEEP']);

        // Re-sending the same plate must NOT trip the unique rule (ignore self).
        $this->actingAs($admin)->putJson("/api/v1/admin/vehicles/{$vehicle->id}", [
            'plate_number' => 'KEEP-0001',
            'status'       => 'INACTIVE',
        ])->assertStatus(200);
    }

    // ── Delete ───────────────────────────────────────────────────

    public function test_admin_can_soft_delete_vehicle(): void
    {
        $admin = $this->makeAdmin();
        $vehicle = $this->makeVehicle();

        $this->actingAs($admin)->deleteJson("/api/v1/admin/vehicles/{$vehicle->id}")
            ->assertStatus(200);

        $this->assertSoftDeleted('vehicles', ['id' => $vehicle->id]);
    }

    public function test_delete_blocked_with_409_when_on_active_shift(): void
    {
        $admin = $this->makeAdmin();

        $conductor = User::create([
            'email' => 'c@test.com', 'password' => Hash::make('password123'), 'role' => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id' => $conductor->id, 'first_name' => 'C', 'last_name' => 'One',
            'birthday' => '1990-01-01', 'generated_username' => 'c_one', 'generated_password' => Hash::make('x'),
        ]);
        $driver = Driver::create([
            'first_name' => 'D', 'last_name' => 'One', 'birthday' => '1985-01-01',
            'contact' => '+639170000000', 'license_number' => 'LIC-A', 'hire_date' => now()->toDateString(), 'status' => 'ACTIVE',
        ]);
        $vehicle = $this->makeVehicle();

        $shiftId = 'shift-active-' . uniqid();
        ShiftLog::create([
            'shift_id' => $shiftId, 'conductor_id' => $conductor->id, 'driver_id' => $driver->id,
            'vehicle_id' => $vehicle->id, 'conductor_name' => 'C One', 'driver_name' => 'D One',
            'unit_number' => $vehicle->unit_number, 'plate_number' => $vehicle->plate_number,
            'time_in' => now(), 'status' => ShiftStatus::ACTIVE, 'is_active' => true,
        ]);
        $vehicle->update(['active_shift_id' => $shiftId]);

        $this->actingAs($admin)->deleteJson("/api/v1/admin/vehicles/{$vehicle->id}")
            ->assertStatus(409);

        $this->assertDatabaseHas('vehicles', ['id' => $vehicle->id, 'deleted_at' => null]);
    }

    // ── Authorization ────────────────────────────────────────────

    public function test_vehicle_routes_forbidden_for_non_admin(): void
    {
        $commuter = $this->makeCommuter();
        $vehicle = $this->makeVehicle();

        $this->actingAs($commuter)->getJson('/api/v1/admin/vehicles')->assertStatus(403);
        $this->actingAs($commuter)->postJson('/api/v1/admin/vehicles', [
            'unit_number' => 'U', 'plate_number' => 'P',
        ])->assertStatus(403);
        $this->actingAs($commuter)->deleteJson("/api/v1/admin/vehicles/{$vehicle->id}")->assertStatus(403);
    }
}
