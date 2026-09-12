<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Voucher;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class AdminVoucherPaginationTest extends TestCase
{
    use RefreshDatabase;

    public function test_admin_voucher_results_are_paginated(): void
    {
        $admin = User::factory()->admin()->create();
        Sanctum::actingAs($admin);

        for ($index = 0; $index < 25; $index++) {
            Voucher::forceCreate([
                'code' => 'ADMIN-'.str_pad((string) $index, 8, '0', STR_PAD_LEFT),
                'type' => 'FREE_RIDE',
                'status' => 'Active',
                'amount' => null,
                'ride_origin' => 'Any',
            ]);
        }

        $this->getJson('/api/v1/admin/vouchers?per_page=20&page=1')
            ->assertOk()
            ->assertJsonCount(20, 'data.data')
            ->assertJsonPath('data.current_page', 1)
            ->assertJsonPath('data.last_page', 2)
            ->assertJsonPath('data.total', 25);

        $this->getJson('/api/v1/admin/vouchers?per_page=20&page=2')
            ->assertOk()
            ->assertJsonCount(5, 'data.data')
            ->assertJsonPath('data.current_page', 2);
    }
}
