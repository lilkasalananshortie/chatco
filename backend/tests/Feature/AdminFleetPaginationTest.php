<?php

namespace Tests\Feature;

use App\Enums\ShiftStatus;
use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\TerminatedPersonnel;
use App\Models\User;
use App\Models\Vehicle;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class AdminFleetPaginationTest extends TestCase
{
    use RefreshDatabase;

    private function makeAdmin(): User
    {
        $admin = User::create([
            'email' => 'admin-fleet@test.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create(['id' => $admin->id, 'first_name' => 'Fleet', 'last_name' => 'Admin']);

        return $admin;
    }

    private function makeDriver(int $index): Driver
    {
        return Driver::create([
            'first_name' => 'Driver',
            'last_name' => str_pad((string) $index, 3, '0', STR_PAD_LEFT),
            'birthday' => '1985-01-01',
            'contact' => '+63917'.str_pad((string) $index, 7, '0', STR_PAD_LEFT),
            'license_number' => 'LIC-'.$index,
            'hire_date' => now()->toDateString(),
            'status' => 'ACTIVE',
        ]);
    }

    private function makeConductor(int $index): ConductorProfile
    {
        $user = User::create([
            'email' => "conductor{$index}@test.com",
            'password' => Hash::make('password123'),
            'role' => UserRole::CONDUCTOR,
        ]);

        return ConductorProfile::create([
            'id' => $user->id,
            'first_name' => 'Conductor',
            'last_name' => str_pad((string) $index, 3, '0', STR_PAD_LEFT),
            'birthday' => '1990-01-01',
            'generated_username' => "conductor{$index}",
            'generated_password' => Hash::make('password123'),
        ]);
    }

    public function test_personnel_endpoint_is_server_paginated(): void
    {
        $admin = $this->makeAdmin();

        for ($i = 1; $i <= 30; $i++) {
            $this->makeDriver($i);
        }
        for ($i = 1; $i <= 5; $i++) {
            $this->makeConductor($i);
        }

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/personnel?per_page=25&page=1');

        $response->assertOk()
            ->assertJsonPath('data.current_page', 1)
            ->assertJsonPath('data.per_page', 25)
            ->assertJsonPath('data.total', 35);

        $this->assertCount(25, $response->json('data.data'));
    }

    public function test_personnel_endpoint_filters_by_role_server_side(): void
    {
        $admin = $this->makeAdmin();

        for ($i = 1; $i <= 3; $i++) {
            $this->makeDriver($i);
        }
        for ($i = 1; $i <= 2; $i++) {
            $this->makeConductor($i);
        }

        $drivers = $this->actingAs($admin)->getJson('/api/v1/admin/personnel?role=driver&per_page=25&page=1');
        $drivers->assertOk()
            ->assertJsonPath('data.total', 3);
        $this->assertSame(['Driver', 'Driver', 'Driver'], array_column($drivers->json('data.data'), 'role'));

        $conductors = $this->actingAs($admin)->getJson('/api/v1/admin/personnel?role=conductor&per_page=25&page=1');
        $conductors->assertOk()
            ->assertJsonPath('data.total', 2);
        $this->assertSame(['Conductor', 'Conductor'], array_column($conductors->json('data.data'), 'role'));

        $this->actingAs($admin)->getJson('/api/v1/admin/personnel?role=driver&count_only=1')
            ->assertOk()
            ->assertJsonPath('data.total', 3)
            ->assertJsonMissingPath('data.data');
    }

    public function test_personnel_status_filter_includes_separation_records_and_excludes_inactive_profiles(): void
    {
        $admin = $this->makeAdmin();
        $this->makeDriver(1);
        $this->makeDriver(2)->update(['status' => 'SUSPENDED']);
        $this->makeDriver(3)->delete();
        $this->makeConductor(1);
        $this->makeConductor(2)->update(['status' => 'DISABLED']);

        foreach (['TERMINATED', 'RESIGNED'] as $status) {
            TerminatedPersonnel::create([
                'personnel_id' => 'former-'.$status,
                'personnel_type' => 'DRIVER',
                'name' => 'Former Driver '.$status,
                'role' => 'Driver',
                'contact' => '09170000000',
                'reason' => 'Separated from service',
                'termination_type' => $status,
                'terminated_date' => now()->toDateString(),
            ]);
        }

        foreach (['ACTIVE' => 2, 'TERMINATED' => 1, 'RESIGNED' => 1, 'all' => 6] as $status => $total) {
            $response = $this->actingAs($admin)->getJson('/api/v1/admin/personnel?status='.$status);
            $response->assertOk()->assertJsonPath('data.total', $total);
            if ($status !== 'all') {
                $this->assertSame(array_fill(0, $total, $status), array_column($response->json('data.data'), 'status'));
            }
            $this->actingAs($admin)->getJson('/api/v1/admin/personnel?status='.$status.'&count_only=1')
                ->assertOk()->assertJsonPath('data.total', $total);
        }

        $this->actingAs($admin)->getJson('/api/v1/admin/personnel?status=invalid')->assertUnprocessable();
    }

    public function test_personnel_status_filter_combines_with_role_search_and_pagination(): void
    {
        $admin = $this->makeAdmin();
        foreach (['Driver', 'Conductor'] as $role) {
            foreach (['TERMINATED', 'RESIGNED'] as $status) {
                for ($i = 1; $i <= 3; $i++) {
                    TerminatedPersonnel::create([
                        'personnel_id' => $role.$status.$i,
                        'personnel_type' => strtoupper($role),
                        'name' => 'Former '.$role.' '.$i,
                        'role' => $role,
                        'contact' => '09170000000',
                        'reason' => 'Separated from service',
                        'termination_type' => $status,
                        'terminated_date' => now()->toDateString(),
                    ]);
                }
            }
        }

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/personnel?status=RESIGNED&role=conductor&search=Former&per_page=2&page=2');
        $response->assertOk()
            ->assertJsonPath('data.total', 3)
            ->assertJsonPath('data.current_page', 2)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.role', 'Conductor')
            ->assertJsonPath('data.data.0.status', 'RESIGNED');

        $this->actingAs($admin)->getJson('/api/v1/admin/personnel?status=RESIGNED&role=conductor&search=Former&count_only=1')
            ->assertOk()->assertJsonPath('data.total', 3);
        $this->actingAs($admin)->getJson('/api/v1/admin/personnel?status=TERMINATED&search=missing')
            ->assertOk()->assertJsonPath('data.total', 0);
    }

    public function test_fleet_count_only_endpoints_return_totals_without_page_rows(): void
    {
        $admin = $this->makeAdmin();

        for ($i = 1; $i <= 3; $i++) {
            $this->makeDriver($i);
        }
        for ($i = 1; $i <= 2; $i++) {
            $this->makeConductor($i);
        }
        $driver = Driver::first();
        $conductor = ConductorProfile::first();
        $route = Route::create(['name' => 'Count Route', 'status' => 'ACTIVE']);
        $vehicle = Vehicle::create([
            'unit_number' => 'UNIT-COUNT',
            'plate_number' => 'CNT-001',
            'route_id' => $route->id,
            'status' => 'ACTIVE',
        ]);
        for ($i = 1; $i <= 2; $i++) {
            ShiftLog::create([
                'shift_id' => 'count-page-'.$i,
                'conductor_id' => $conductor->id,
                'driver_id' => $driver->id,
                'vehicle_id' => $vehicle->id,
                'route_id' => $route->id,
                'conductor_name' => 'Conductor 001',
                'driver_name' => 'Driver 001',
                'unit_number' => 'UNIT-COUNT',
                'plate_number' => 'CNT-001',
                'time_in' => now()->subHours($i),
                'status' => ShiftStatus::ENDED,
                'is_active' => false,
            ]);
        }
        for ($i = 1; $i <= 4; $i++) {
            TerminatedPersonnel::create([
                'personnel_id' => (string) $i,
                'personnel_type' => 'DRIVER',
                'name' => "Archived Driver {$i}",
                'role' => 'Driver',
                'contact' => '+639170000000',
                'reason' => 'Separated from service',
                'termination_type' => 'TERMINATED',
                'terminated_date' => now()->subDays($i)->toDateString(),
                'last_vehicle' => "UNIT-{$i}",
            ]);
        }

        $this->actingAs($admin)->getJson('/api/v1/admin/vehicles?count_only=1')
            ->assertOk()
            ->assertJsonPath('data.total', 1)
            ->assertJsonMissingPath('data.data');

        $this->actingAs($admin)->getJson('/api/v1/admin/personnel?count_only=1')
            ->assertOk()
            ->assertJsonPath('data.total', 5)
            ->assertJsonMissingPath('data.data');

        $this->actingAs($admin)->getJson('/api/v1/admin/terminated-personnel?count_only=1')
            ->assertOk()
            ->assertJsonPath('data.total', 4)
            ->assertJsonMissingPath('data.data');

        $this->actingAs($admin)->getJson('/api/v1/admin/shift-logs?entry_view=personnel&count_only=1')
            ->assertOk()
            ->assertJsonPath('data.total', 4)
            ->assertJsonMissingPath('data.data');
    }

    public function test_terminated_personnel_endpoint_is_server_paginated(): void
    {
        $admin = $this->makeAdmin();

        for ($i = 1; $i <= 30; $i++) {
            TerminatedPersonnel::create([
                'personnel_id' => (string) $i,
                'personnel_type' => 'DRIVER',
                'name' => "Archived Driver {$i}",
                'role' => 'Driver',
                'contact' => '+639170000000',
                'reason' => 'Separated from service',
                'termination_type' => 'TERMINATED',
                'terminated_date' => now()->subDays($i)->toDateString(),
                'last_vehicle' => "UNIT-{$i}",
            ]);
        }

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/terminated-personnel?per_page=25&page=1');

        $response->assertOk()
            ->assertJsonPath('data.current_page', 1)
            ->assertJsonPath('data.per_page', 25)
            ->assertJsonPath('data.total', 30);

        $this->assertCount(25, $response->json('data.data'));
    }

    public function test_shift_history_personnel_entries_are_server_paginated(): void
    {
        $admin = $this->makeAdmin();
        $driver = $this->makeDriver(1);
        $conductor = $this->makeConductor(1);
        $route = Route::create(['name' => 'Fleet Route', 'status' => 'ACTIVE']);
        $vehicle = Vehicle::create([
            'unit_number' => 'UNIT-FLEET',
            'plate_number' => 'FLT-001',
            'route_id' => $route->id,
            'status' => 'ACTIVE',
        ]);

        for ($i = 1; $i <= 13; $i++) {
            ShiftLog::create([
                'shift_id' => 'fleet-page-'.$i,
                'conductor_id' => $conductor->id,
                'driver_id' => $driver->id,
                'vehicle_id' => $vehicle->id,
                'route_id' => $route->id,
                'conductor_name' => 'Conductor 001',
                'driver_name' => 'Driver 001',
                'unit_number' => 'UNIT-FLEET',
                'plate_number' => 'FLT-001',
                'time_in' => now()->subHours($i),
                'status' => ShiftStatus::ENDED,
                'is_active' => false,
            ]);
        }

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/shift-logs?entry_view=personnel&per_page=25&page=1');

        $response->assertOk()
            ->assertJsonPath('data.current_page', 1)
            ->assertJsonPath('data.per_page', 25)
            ->assertJsonPath('data.total', 26);

        $this->assertCount(25, $response->json('data.data'));
    }

    public function test_shift_history_personnel_entries_filter_by_range_server_side(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-08-12 12:00:00'));

        try {
            $admin = $this->makeAdmin();
            $driver = $this->makeDriver(1);
            $conductor = $this->makeConductor(1);
            $route = Route::create(['name' => 'Fleet Range Route', 'status' => 'ACTIVE']);
            $vehicle = Vehicle::create([
                'unit_number' => 'UNIT-RANGE',
                'plate_number' => 'RNG-001',
                'route_id' => $route->id,
                'status' => 'ACTIVE',
            ]);

            foreach ([
                'range-today' => Carbon::parse('2026-08-12 08:00:00'),
                'range-week' => Carbon::parse('2026-08-09 08:00:00'),
                'range-month' => Carbon::parse('2026-08-01 08:00:00'),
                'range-old' => Carbon::parse('2026-07-20 08:00:00'),
            ] as $shiftId => $timeIn) {
                ShiftLog::create([
                    'shift_id' => $shiftId,
                    'conductor_id' => $conductor->id,
                    'driver_id' => $driver->id,
                    'vehicle_id' => $vehicle->id,
                    'route_id' => $route->id,
                    'conductor_name' => 'Conductor 001',
                    'driver_name' => 'Driver 001',
                    'unit_number' => 'UNIT-RANGE',
                    'plate_number' => 'RNG-001',
                    'time_in' => $timeIn,
                    'status' => ShiftStatus::ENDED,
                    'is_active' => false,
                ]);
            }

            $this->actingAs($admin)->getJson('/api/v1/admin/shift-logs?entry_view=personnel&shift_range=today&count_only=1')
                ->assertOk()
                ->assertJsonPath('data.total', 2);

            $this->actingAs($admin)->getJson('/api/v1/admin/shift-logs?entry_view=personnel&shift_range=last_7_days&count_only=1')
                ->assertOk()
                ->assertJsonPath('data.total', 4);

            $this->actingAs($admin)->getJson('/api/v1/admin/shift-logs?entry_view=personnel&shift_range=this_month&count_only=1')
                ->assertOk()
                ->assertJsonPath('data.total', 6);

            $this->actingAs($admin)->getJson('/api/v1/admin/shift-logs?entry_view=personnel&shift_range=all_time&count_only=1')
                ->assertOk()
                ->assertJsonPath('data.total', 8);
        } finally {
            Carbon::setTestNow();
        }
    }

    public function test_fleet_search_matches_full_names_across_name_columns(): void
    {
        $admin = $this->makeAdmin();
        $driver = $this->makeDriver(1);
        $driver->update(['first_name' => 'Mark', 'last_name' => 'Arone']);
        $conductor = $this->makeConductor(1);
        $conductor->update(['first_name' => 'Mark', 'last_name' => 'Bautista']);
        $this->makeDriver(2);
        $route = Route::create(['name' => 'Search Route', 'status' => 'ACTIVE']);
        Vehicle::create([
            'unit_number' => 'UNIT-MARK', 'plate_number' => 'SRC-001', 'route_id' => $route->id,
            'status' => 'ACTIVE', 'driver_id' => $driver->id,
        ]);
        Vehicle::create(['unit_number' => 'UNIT-OTHER', 'plate_number' => 'SRC-002', 'route_id' => $route->id, 'status' => 'ACTIVE']);

        // Partial, full, and reversed full names all narrow to the right person.
        foreach (['mark aro' => 1, 'Mark Arone' => 1, 'arone mark' => 1, 'mark' => 2, 'mark zzz' => 0] as $search => $total) {
            $this->actingAs($admin)->getJson('/api/v1/admin/personnel?search='.urlencode($search))
                ->assertOk()->assertJsonPath('data.total', $total);
        }

        // Vehicles: a crew name finds the unit it is assigned to; plate still works.
        $this->actingAs($admin)->getJson('/api/v1/admin/vehicles?search='.urlencode('mark arone'))
            ->assertOk()->assertJsonPath('data.total', 1)->assertJsonPath('data.data.0.unit_number', 'UNIT-MARK');
        $this->actingAs($admin)->getJson('/api/v1/admin/vehicles?search=SRC-002')
            ->assertOk()->assertJsonPath('data.total', 1);
    }

    public function test_vehicle_endpoint_returns_single_vehicle_details(): void
    {
        $admin = $this->makeAdmin();
        $route = Route::create(['name' => 'Fleet Route', 'status' => 'ACTIVE']);
        $vehicle = Vehicle::create([
            'unit_number' => 'UNIT-SINGLE',
            'plate_number' => 'SGL-001',
            'route_id' => $route->id,
            'status' => 'ACTIVE',
        ]);

        $response = $this->actingAs($admin)->getJson("/api/v1/admin/vehicles/{$vehicle->id}");

        $response->assertOk()
            ->assertJsonPath('data.id', $vehicle->id)
            ->assertJsonPath('data.unit_number', 'UNIT-SINGLE')
            ->assertJsonPath('data.route.id', $route->id);
    }

    public function test_vehicle_shift_logs_are_paginated_by_vehicle(): void
    {
        $admin = $this->makeAdmin();
        $driver = $this->makeDriver(1);
        $conductor = $this->makeConductor(1);
        $route = Route::create(['name' => 'Vehicle History Route', 'status' => 'ACTIVE']);
        $vehicle = Vehicle::create([
            'unit_number' => 'UNIT-HISTORY',
            'plate_number' => 'HST-001',
            'route_id' => $route->id,
            'status' => 'ACTIVE',
        ]);

        for ($i = 1; $i <= 12; $i++) {
            ShiftLog::create([
                'shift_id' => 'vehicle-page-'.$i,
                'conductor_id' => $conductor->id,
                'driver_id' => $driver->id,
                'vehicle_id' => $vehicle->id,
                'route_id' => $route->id,
                'conductor_name' => 'Conductor 001',
                'driver_name' => 'Driver 001',
                'unit_number' => 'UNIT-HISTORY',
                'plate_number' => 'HST-001',
                'time_in' => now()->subHours($i),
                'status' => ShiftStatus::ENDED,
                'is_active' => false,
            ]);
        }

        $response = $this->actingAs($admin)
            ->getJson("/api/v1/admin/shift-logs?vehicle_id={$vehicle->id}&per_page=5&page=2");

        $response->assertOk()
            ->assertJsonPath('data.current_page', 2)
            ->assertJsonPath('data.per_page', 5)
            ->assertJsonPath('data.total', 12);

        $this->assertCount(5, $response->json('data.data'));
    }
}
