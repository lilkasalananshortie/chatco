<?php

namespace Tests\Feature;

use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Voucher;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class CommuterVoucherWalletTest extends TestCase
{
    use RefreshDatabase;

    private User $commuter;

    protected function setUp(): void
    {
        parent::setUp();
        $this->commuter = User::factory()->commuter()->create();
        Sanctum::actingAs($this->commuter);
    }

    private function voucher(array $overrides = []): Voucher
    {
        return Voucher::create(array_merge([
            'commuter_id' => $this->commuter->commuterProfile->id,
            'code' => 'WALLET-'.strtoupper(Str::random(8)),
            'type' => 'FREE_RIDE',
            'status' => Voucher::STATUS_AVAILABLE,
            'amount' => null,
            'expires_at' => now()->addDays(3),
            'ride_origin' => 'Reward',
        ], $overrides));
    }

    public function test_mobile_wallet_matches_web_tabs_and_keeps_pagination_owned(): void
    {
        $own = [$this->voucher(), $this->voucher()];
        $this->voucher(['status' => 'USED']);
        $this->voucher(['status' => Voucher::STATUS_EXPIRED, 'expires_at' => now()->subDay()]);
        $other = User::factory()->commuter()->create();
        $this->voucher(['commuter_id' => $other->commuterProfile->id]);

        foreach (['available', 'used', 'expired'] as $status) {
            $query = '?status='.$status.'&per_page=1';
            $web = $this->getJson('/api/v1/commuter/vouchers'.$query)->assertOk();
            $mobile = $this->getJson('/api/v1/mobile/commuter/vouchers'.$query)->assertOk();
            $this->assertSame($web->json('data'), $mobile->json('data'));
        }

        $first = $this->getJson('/api/v1/mobile/commuter/vouchers?status=available&per_page=1')
            ->assertOk()->assertJsonCount(1, 'data.vouchers');
        $cursor = $first->json('data.nextCursor');
        $this->assertNotNull($cursor);
        $second = $this->getJson('/api/v1/mobile/commuter/vouchers?status=available&per_page=1&cursor='.urlencode($cursor))
            ->assertOk()->assertJsonCount(1, 'data.vouchers')->assertJsonPath('data.nextCursor', null);
        $this->assertEqualsCanonicalizing(
            array_map(fn (Voucher $voucher) => $voucher->id, $own),
            [$first->json('data.vouchers.0.id'), $second->json('data.vouchers.0.id')],
        );
    }

    public function test_mobile_wallet_validates_status_and_page_size(): void
    {
        $this->getJson('/api/v1/mobile/commuter/vouchers')->assertUnprocessable();
        $this->getJson('/api/v1/mobile/commuter/vouchers?status=deleted')->assertUnprocessable();
        $this->getJson('/api/v1/mobile/commuter/vouchers?status=available&per_page=51')->assertUnprocessable();
    }

    public function test_tabs_paginate_with_a_cursor_without_skipping_or_repeating(): void
    {
        foreach (range(1, 5) as $i) {
            $this->travel(1)->minutes();
            $this->voucher(['ride_origin' => "Reward {$i}"]);
        }
        $this->voucher(['status' => Voucher::STATUS_EXPIRED, 'expires_at' => now()->subDay()]);

        $first = $this->getJson('/api/v1/commuter/vouchers?status=available&per_page=2')->assertOk();
        $this->assertSame(['Reward 5', 'Reward 4'], array_column($first->json('data.vouchers'), 'rideOrigin'));
        $this->assertNotNull($cursor = $first->json('data.nextCursor'));

        $seen = array_column($first->json('data.vouchers'), 'id');
        while ($cursor) {
            $next = $this->getJson('/api/v1/commuter/vouchers?status=available&per_page=2&cursor='.$cursor)->assertOk();
            $seen = array_merge($seen, array_column($next->json('data.vouchers'), 'id'));
            $cursor = $next->json('data.nextCursor');
        }

        $this->assertCount(5, $seen);
        $this->assertCount(5, array_unique($seen));
        $this->getJson('/api/v1/commuter/vouchers?status=expired')->assertOk()->assertJsonCount(1, 'data.vouchers');
    }

    public function test_a_voucher_past_its_expiry_moves_to_the_expired_tab(): void
    {
        $voucher = $this->voucher(['expires_at' => now()->addHour()]);
        $this->travel(2)->hours();

        $this->getJson('/api/v1/commuter/vouchers?status=available')->assertOk()->assertJsonCount(0, 'data.vouchers');
        $this->getJson('/api/v1/commuter/vouchers?status=expired')->assertOk()
            ->assertJsonPath('data.vouchers.0.id', $voucher->id)
            ->assertJsonPath('data.vouchers.0.status', Voucher::STATUS_EXPIRED);
    }

    public function test_used_vouchers_carry_the_ride_they_paid_for(): void
    {
        $voucher = $this->voucher(['status' => 'USED']);
        $shift = ShiftLog::factory()->create();
        $paidAt = now()->subHour()->startOfSecond();
        Transaction::forceCreate([
            'transaction_id' => 'TXN-WALLET-1',
            'shift_id' => $shift->shift_id,
            'payment_method' => 'VOUCHER',
            'status' => 'PAID',
            'final_amount' => 0,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Malolos',
            'voucher_id' => $voucher->id,
            'paid_at' => $paidAt,
        ]);

        $this->getJson('/api/v1/commuter/vouchers?status=used')->assertOk()
            ->assertJsonPath('data.vouchers.0.usedRoute', 'Calumpit → Malolos')
            ->assertJsonPath('data.vouchers.0.usedAt', $paidAt->toIso8601String());
    }

    public function test_only_the_signed_in_commuters_vouchers_are_listed_and_status_is_validated(): void
    {
        $other = User::factory()->commuter()->create();
        $this->voucher(['commuter_id' => $other->commuterProfile->id]);

        $this->getJson('/api/v1/commuter/vouchers?status=available')->assertOk()->assertJsonCount(0, 'data.vouchers');
        $this->getJson('/api/v1/commuter/vouchers?status=deleted')->assertUnprocessable();
        $this->getJson('/api/v1/commuter/vouchers')->assertUnprocessable();
    }
}
