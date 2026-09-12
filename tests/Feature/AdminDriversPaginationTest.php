<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\Driver;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * GET /api/v1/admin/drivers has two modes (see AdminController::drivers()):
 *  - No `page` param — the full, unfiltered list every dropdown/picker
 *    caller (Fleet Management, Lost & Found, personnel modals, …) already
 *    relies on. Must stay a flat array, unchanged.
 *  - `page` present — server-side paginated/filtered/sorted, used only by
 *    User Management's "Drivers" role filter.
 */
class AdminDriversPaginationTest extends TestCase
{
    use RefreshDatabase;

    private function makeAdmin(): User
    {
        $admin = User::create([
            'email' => 'admin-drivers@test.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create(['id' => $admin->id, 'first_name' => 'Drivers', 'last_name' => 'Admin']);

        return $admin;
    }

    private function makeDriver(int $index, string $status = 'ACTIVE'): Driver
    {
        return Driver::create([
            'first_name' => 'Driver',
            'last_name' => str_pad((string) $index, 3, '0', STR_PAD_LEFT),
            'birthday' => '1985-01-01',
            'contact' => '+63917'.str_pad((string) $index, 7, '0', STR_PAD_LEFT),
            'license_number' => 'LIC-'.str_pad((string) $index, 4, '0', STR_PAD_LEFT),
            'hire_date' => now()->toDateString(),
            'status' => $status,
        ]);
    }

    public function test_legacy_call_without_page_returns_full_unpaginated_array(): void
    {
        $admin = $this->makeAdmin();

        for ($i = 1; $i <= 25; $i++) {
            $this->makeDriver($i);
        }

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/drivers');

        $response->assertOk();
        // Flat array under `data`, not a paginator envelope — dropdown/picker
        // callers do `json.data.map(...)` directly.
        $this->assertIsArray($response->json('data'));
        $this->assertCount(25, $response->json('data'));
        $response->assertJsonMissingPath('data.current_page');
    }

    public function test_page_param_returns_server_side_paginated_envelope(): void
    {
        $admin = $this->makeAdmin();

        for ($i = 1; $i <= 30; $i++) {
            $this->makeDriver($i);
        }

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/drivers?page=1&per_page=20');

        $response->assertOk()
            ->assertJsonPath('data.current_page', 1)
            ->assertJsonPath('data.per_page', 20)
            ->assertJsonPath('data.total', 30);

        $this->assertCount(20, $response->json('data.data'));

        $page2 = $this->actingAs($admin)->getJson('/api/v1/admin/drivers?page=2&per_page=20');
        $page2->assertOk()->assertJsonPath('data.current_page', 2);
        $this->assertCount(10, $page2->json('data.data'));
    }

    public function test_page_param_filters_by_search_and_status_server_side(): void
    {
        $admin = $this->makeAdmin();

        $active = $this->makeDriver(1, 'ACTIVE');
        $this->makeDriver(2, 'SUSPENDED');
        $this->makeDriver(3, 'ACTIVE');

        $searchResponse = $this->actingAs($admin)
            ->getJson('/api/v1/admin/drivers?page=1&search='.$active->license_number);
        $searchResponse->assertOk()->assertJsonPath('data.total', 1);
        $this->assertSame($active->id, $searchResponse->json('data.data.0.id'));

        $activeOnly = $this->actingAs($admin)->getJson('/api/v1/admin/drivers?page=1&status=ACTIVE');
        $activeOnly->assertOk()->assertJsonPath('data.total', 2);

        $suspendedOnly = $this->actingAs($admin)->getJson('/api/v1/admin/drivers?page=1&status=SUSPENDED');
        $suspendedOnly->assertOk()->assertJsonPath('data.total', 1);
    }

    public function test_page_param_forbidden_for_non_admin(): void
    {
        $conductor = User::create([
            'email' => 'conductor-drivers@test.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::CONDUCTOR,
        ]);

        $this->actingAs($conductor)
            ->getJson('/api/v1/admin/drivers?page=1')
            ->assertForbidden();
    }
}
