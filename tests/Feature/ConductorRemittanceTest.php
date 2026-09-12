<?php

namespace Tests\Feature;

use App\Enums\ShiftStatus;
use App\Enums\UserRole;
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
 * S5-T2 — Conductor remittance history read (GET /conductor/remittances).
 *
 * Behavioural coverage complementing RoleAccessMatrixTest (which only proves
 * the access/scoping): asserts the endpoint returns the conductor's OWN
 * remittances with correct content + pagination shape.
 */
class ConductorRemittanceTest extends TestCase
{
    use RefreshDatabase;

    private int $seq = 0;

    private function makeConductor(string $email): User
    {
        $this->seq++;
        $conductor = User::create([
            'email'    => $email,
            'password' => Hash::make('password123'),
            'role'     => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id'                 => $conductor->id,
            'first_name'         => 'Cond',
            'last_name'          => 'Uctor' . $this->seq,
            'birthday'           => '1990-01-01',
            'generated_username' => 'conductor' . $this->seq,
            'generated_password' => Hash::make('password123'),
        ]);

        return $conductor;
    }

    private function makeCommuter(): User
    {
        $this->seq++;
        $commuter = User::create([
            'email'    => "commuter{$this->seq}@test.com",
            'password' => Hash::make('password123'),
            'role'     => UserRole::COMMUTER,
        ]);

        return $commuter;
    }

    /**
     * Create a remittance (and its parent shift log) owned by $conductor.
     */
    private function makeRemittance(User $conductor, array $overrides = []): Remittance
    {
        $this->seq++;
        $route = Route::create(['name' => "Route {$this->seq}", 'status' => 'ACTIVE']);
        $driver = Driver::create([
            'first_name'     => 'Driver',
            'last_name'      => "D{$this->seq}",
            'birthday'       => '1985-01-01',
            'contact'        => '+639170000000',
            'license_number' => "LIC-{$this->seq}",
            'hire_date'      => now()->toDateString(),
            'status'         => 'ACTIVE',
        ]);
        $vehicle = Vehicle::create([
            'unit_number'  => "UNIT-{$this->seq}",
            'plate_number' => "PLT-{$this->seq}",
            'route_id'     => $route->id,
            'status'       => 'ACTIVE',
        ]);

        $shiftId = 'shift-' . $this->seq . '-' . uniqid();
        ShiftLog::create([
            'shift_id'       => $shiftId,
            'conductor_id'   => $conductor->id,
            'driver_id'      => $driver->id,
            'vehicle_id'     => $vehicle->id,
            'conductor_name' => 'Cond Uctor',
            'driver_name'    => 'Driver D',
            'unit_number'    => $vehicle->unit_number,
            'plate_number'   => $vehicle->plate_number,
            'time_in'        => now()->subHours(8),
            'status'         => ShiftStatus::ENDED,
            'is_active'      => false,
        ]);

        return Remittance::create(array_merge([
            'shift_id'          => $shiftId,
            'conductor_id'      => $conductor->id,
            'driver_id'         => $driver->id,
            'vehicle_id'        => $vehicle->id,
            'conductor_name'    => 'Cond Uctor',
            'driver_name'       => 'Driver D',
            'unit_number'       => $vehicle->unit_number,
            'date'              => now()->toDateString(),
            'time_in'           => now()->subHours(8),
            'time_out'          => now(),
            'total_collected'   => 500,
            'remitted_amount'   => 500,
            'shortage'          => 0,
            'remittance_status' => 'Remitted',
            'cash_total'        => 500,
            'gcash_total'       => 0,
            'total_passengers'  => 10,
        ], $overrides));
    }

    public function test_conductor_sees_only_their_own_remittances_paginated(): void
    {
        $conductor = $this->makeConductor('mine@test.com');
        $other = $this->makeConductor('other@test.com');

        $this->makeRemittance($conductor, ['total_collected' => 750, 'remitted_amount' => 750, 'cash_total' => 750]);
        $this->makeRemittance($conductor, ['total_collected' => 300, 'remitted_amount' => 300, 'cash_total' => 300]);
        $this->makeRemittance($other); // must NOT appear

        $response = $this->actingAs($conductor)->getJson('/api/v1/conductor/remittances');

        $response->assertStatus(200);
        $response->assertJsonStructure([
            'data' => ['current_page', 'data' => [['shift_id', 'conductor_id', 'total_collected', 'remitted_amount']], 'total'],
        ]);

        $this->assertEquals(2, $response->json('data.total'));
        foreach ($response->json('data.data') as $row) {
            $this->assertEquals($conductor->id, $row['conductor_id']);
        }
    }

    public function test_remittance_list_is_empty_for_conductor_with_none(): void
    {
        $conductor = $this->makeConductor('empty@test.com');

        $response = $this->actingAs($conductor)->getJson('/api/v1/conductor/remittances');

        $response->assertStatus(200);
        $this->assertEquals(0, $response->json('data.total'));
        $this->assertSame([], $response->json('data.data'));
    }

    public function test_remittance_read_forbidden_for_non_conductor(): void
    {
        $commuter = $this->makeCommuter();

        $this->actingAs($commuter)
            ->getJson('/api/v1/conductor/remittances')
            ->assertStatus(403);
    }

    public function test_remittance_read_requires_authentication(): void
    {
        $this->getJson('/api/v1/conductor/remittances')->assertStatus(401);
    }
}
