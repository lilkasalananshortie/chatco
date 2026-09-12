<?php

namespace Tests\Feature;

use App\Enums\PaymentMethod;
use App\Enums\PaymentStatus;
use App\Enums\ShiftStatus;
use App\Models\Driver;
use App\Models\Setting;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\Voucher;
use App\Services\RewardService;
use Carbon\CarbonInterface;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class RewardSettingsTest extends TestCase
{
    use RefreshDatabase;

    public function test_admin_can_save_integer_reward_threshold_at_supported_boundaries(): void
    {
        $admin = User::factory()->admin()->create();

        foreach ([1, Setting::MAX_RIDES_FOR_FREE_REWARD] as $threshold) {
            $this->actingAs($admin)
                ->putJson('/api/v1/admin/settings/'.Setting::RIDES_FOR_FREE_REWARD_KEY, [
                    'value' => $threshold,
                    'category' => 'financial',
                ])
                ->assertOk()
                ->assertJsonPath('success', true)
                ->assertJsonPath('data.key', Setting::RIDES_FOR_FREE_REWARD_KEY)
                ->assertJsonPath('data.value', (string) $threshold)
                ->assertJsonPath('data.category', 'financial')
                ->assertJsonPath('message', 'Setting updated successfully');

            $this->assertDatabaseHas('settings', [
                'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
                'value' => (string) $threshold,
            ]);
        }
    }

    public function test_reward_threshold_cache_is_invalidated_after_admin_update(): void
    {
        $admin = User::factory()->admin()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '10',
            'category' => 'financial',
        ]);

        $this->assertSame(10, Setting::rewardRule()['threshold']);

        $this->actingAs($admin)
            ->putJson('/api/v1/admin/settings/'.Setting::RIDES_FOR_FREE_REWARD_KEY, [
                'value' => 7,
                'category' => 'financial',
            ])
            ->assertOk();

        $this->assertSame(7, Setting::rewardRule()['threshold']);
    }

    public function test_rewards_response_archives_only_old_unusable_voucher_history(): void
    {
        $commuter = User::factory()->commuter()->create();

        for ($index = 0; $index < 55; $index++) {
            Voucher::forceCreate([
                'commuter_id' => $commuter->id,
                'code' => 'USED-'.str_pad((string) $index, 8, '0', STR_PAD_LEFT),
                'type' => 'REWARD',
                'status' => 'USED',
                'amount' => 0,
                'ride_origin' => 'Historical Reward',
            ]);
        }
        for ($index = 0; $index < 2; $index++) {
            Voucher::forceCreate([
                'commuter_id' => $commuter->id,
                'code' => 'OPEN-'.str_pad((string) $index, 8, '0', STR_PAD_LEFT),
                'type' => 'REWARD',
                'status' => Voucher::STATUS_AVAILABLE,
                'amount' => 0,
                'expires_at' => now()->addMonth(),
                'ride_origin' => 'Available Reward',
            ]);
        }

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.availableVoucherCount', 2)
            ->assertJsonPath('data.archivedVoucherCount', 5)
            ->assertJsonCount(52, 'data.vouchers');
    }

    #[DataProvider('invalidRewardThresholdProvider')]
    public function test_admin_cannot_save_invalid_reward_threshold(mixed $value): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin)
            ->putJson('/api/v1/admin/settings/'.Setting::RIDES_FOR_FREE_REWARD_KEY, [
                'value' => $value,
                'category' => 'financial',
            ])
            ->assertStatus(422)
            ->assertJsonPath('success', false)
            ->assertJsonPath('message', 'Validation failed')
            ->assertJsonValidationErrors('value');

        $this->assertDatabaseMissing('settings', [
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
        ]);
    }

    public static function invalidRewardThresholdProvider(): array
    {
        return [
            'zero' => [0],
            'negative' => [-1],
            'decimal number' => [2.5],
            'decimal text' => ['2.5'],
            'invalid text' => ['ten'],
            'empty text' => [''],
            'null' => [null],
            'above maximum' => [Setting::MAX_RIDES_FOR_FREE_REWARD + 1],
        ];
    }

    public function test_admin_cannot_omit_reward_threshold(): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin)
            ->putJson('/api/v1/admin/settings/'.Setting::RIDES_FOR_FREE_REWARD_KEY, [
                'category' => 'financial',
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors('value');
    }

    #[DataProvider('unsafeStoredRewardThresholdProvider')]
    public function test_reward_calculation_falls_back_for_unsafe_stored_threshold(string $storedValue): void
    {
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => $storedValue,
            'category' => 'financial',
        ]);

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.ridesNeeded', Setting::DEFAULT_RIDES_FOR_FREE_REWARD)
            ->assertJsonPath('data.currentCycleRides', 0);
    }

    public static function unsafeStoredRewardThresholdProvider(): array
    {
        return [
            'zero' => ['0'],
            'negative' => ['-5'],
            'decimal' => ['2.5'],
            'invalid text' => ['invalid'],
            'above maximum' => [(string) (Setting::MAX_RIDES_FOR_FREE_REWARD + 1)],
        ];
    }

    public function test_reward_progress_uses_valid_configured_threshold(): void
    {
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '3',
            'category' => 'financial',
        ]);

        $shift = $this->createShift();
        $rewardService = app(RewardService::class);
        $paidAtByRide = [];
        for ($ride = 1; $ride <= 7; $ride++) {
            $paidAt = now()->addMinutes($ride);
            $paidAtByRide[$ride] = $paidAt;
            $transaction = Transaction::forceCreate([
                'transaction_id' => 'TXN-RWD-'.str_pad((string) $ride, 4, '0', STR_PAD_LEFT),
                'shift_id' => $shift->shift_id,
                'payment_method' => PaymentMethod::CASH->value,
                'status' => PaymentStatus::PAID->value,
                'final_amount' => 15,
                'passenger_id' => $commuter->commuterProfile->id,
                'pickup_name' => 'Pickup',
                'dropoff_name' => 'Dropoff',
                'paid_at' => $paidAt,
                'reward_eligible' => true,
            ]);
            $rewardService->issueForRewardableRide($transaction, $paidAt);
        }

        $this->assertDatabaseCount('vouchers', 2);
        $this->assertSame(
            $paidAtByRide[3]->copy()->addDays(RewardService::VOUCHER_VALIDITY_DAYS)->toDateTimeString(),
            Voucher::where('reward_cycle_number', 1)->firstOrFail()->expires_at->toDateTimeString(),
        );
        $this->assertSame(
            $paidAtByRide[6]->copy()->addDays(RewardService::VOUCHER_VALIDITY_DAYS)->toDateTimeString(),
            Voucher::where('reward_cycle_number', 2)->firstOrFail()->expires_at->toDateTimeString(),
        );

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.totalRides', 7)
            ->assertJsonPath('data.ridesNeeded', 3)
            ->assertJsonPath('data.currentCycleRides', 1)
            ->assertJsonCount(2, 'data.vouchers');
    }

    public function test_rewards_page_does_not_create_historical_rewards(): void
    {
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '3',
            'category' => 'financial',
        ]);

        $shift = $this->createShift();
        for ($ride = 1; $ride <= 3; $ride++) {
            Transaction::forceCreate([
                'transaction_id' => 'TXN-HIST-'.str_pad((string) $ride, 4, '0', STR_PAD_LEFT),
                'shift_id' => $shift->shift_id,
                'payment_method' => PaymentMethod::CASH->value,
                'status' => PaymentStatus::PAID->value,
                'final_amount' => 15,
                'passenger_id' => $commuter->commuterProfile->id,
                'paid_at' => now()->subDay(),
                'reward_eligible' => true,
            ]);
        }

        $this->assertDatabaseCount('vouchers', 0);

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.totalRides', 3)
            ->assertJsonCount(0, 'data.vouchers');

        $this->assertDatabaseCount('vouchers', 0);
    }

    public function test_repeated_reward_events_keep_one_voucher_and_original_expiration(): void
    {
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '1',
            'category' => 'financial',
        ]);
        $shift = $this->createShift();
        $earnedAt = now();
        $transaction = Transaction::forceCreate([
            'transaction_id' => 'TXN-RWD-RETRY',
            'shift_id' => $shift->shift_id,
            'payment_method' => PaymentMethod::GCASH->value,
            'status' => PaymentStatus::PAID->value,
            'final_amount' => 15,
            'passenger_id' => $commuter->commuterProfile->id,
            'paid_at' => $earnedAt,
            'reward_eligible' => true,
        ]);

        $service = app(RewardService::class);
        $service->issueForRewardableRide($transaction, $earnedAt);
        $service->issueForRewardableRide($transaction, $earnedAt->copy()->addDay());

        $this->assertDatabaseCount('vouchers', 1);
        $this->assertSame(
            $earnedAt->copy()->addDays(RewardService::VOUCHER_VALIDITY_DAYS)->toDateTimeString(),
            Voucher::firstOrFail()->expires_at->toDateTimeString(),
        );
    }

    public function test_reducing_threshold_starts_fresh_progress_without_retroactive_vouchers(): void
    {
        $admin = User::factory()->admin()->create();
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '5',
            'reward_rule_version' => 1,
            'category' => 'financial',
        ]);
        $shift = $this->createShift();
        $service = app(RewardService::class);

        $oldRides = [];
        for ($ride = 1; $ride <= 4; $ride++) {
            $oldRides[] = $this->recordRewardableRide(
                $service,
                $shift,
                $commuter,
                'TXN-OLD-RULE-'.$ride,
                now()->addMinutes($ride),
            );
        }

        $this->assertDatabaseCount('vouchers', 0);
        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.totalRides', 4)
            ->assertJsonPath('data.ridesNeeded', 5)
            ->assertJsonPath('data.currentCycleRides', 4);

        $this->actingAs($admin)
            ->putJson('/api/v1/admin/settings/'.Setting::RIDES_FOR_FREE_REWARD_KEY, [
                'value' => 2,
                'category' => 'financial',
            ])
            ->assertOk();

        $this->assertDatabaseHas('settings', [
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '2',
            'reward_rule_version' => 2,
        ]);

        // Replaying an old qualifying event cannot move it into the new rule.
        $service->issueForRewardableRide($oldRides[0], now()->addHour());
        $this->assertDatabaseCount('vouchers', 0);
        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.totalRides', 4)
            ->assertJsonPath('data.ridesNeeded', 2)
            ->assertJsonPath('data.currentCycleRides', 0);

        $this->recordRewardableRide(
            $service,
            $shift,
            $commuter,
            'TXN-NEW-RULE-1',
            now()->addHours(2),
        );
        $this->assertDatabaseCount('vouchers', 0);

        $earnedAt = now()->addHours(3);
        $this->recordRewardableRide(
            $service,
            $shift,
            $commuter,
            'TXN-NEW-RULE-2',
            $earnedAt,
        );

        $voucher = Voucher::firstOrFail();
        $this->assertSame(1, $voucher->reward_cycle_number);
        $this->assertSame(2, $voucher->reward_rule_version);
        $this->assertSame($earnedAt->toDateTimeString(), $voucher->reward_earned_at->toDateTimeString());
        $this->assertSame(
            $earnedAt->copy()->addDays(RewardService::VOUCHER_VALIDITY_DAYS)->toDateTimeString(),
            $voucher->expires_at->toDateTimeString(),
        );
    }

    public function test_threshold_change_preserves_issued_voucher_and_continues_global_cycle_numbers(): void
    {
        $admin = User::factory()->admin()->create();
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '2',
            'reward_rule_version' => 1,
            'category' => 'financial',
        ]);
        $shift = $this->createShift();
        $service = app(RewardService::class);

        for ($ride = 1; $ride <= 2; $ride++) {
            $this->recordRewardableRide(
                $service,
                $shift,
                $commuter,
                'TXN-FIRST-CYCLE-'.$ride,
                now()->addMinutes($ride),
            );
        }

        $firstVoucher = Voucher::firstOrFail();
        $originalExpiration = $firstVoucher->expires_at->toDateTimeString();

        $this->actingAs($admin)
            ->putJson('/api/v1/admin/settings/'.Setting::RIDES_FOR_FREE_REWARD_KEY, [
                'value' => 3,
                'category' => 'financial',
            ])
            ->assertOk();

        for ($ride = 1; $ride <= 3; $ride++) {
            $this->recordRewardableRide(
                $service,
                $shift,
                $commuter,
                'TXN-SECOND-CYCLE-'.$ride,
                now()->addHours($ride),
            );
        }

        $this->assertDatabaseCount('vouchers', 2);
        $this->assertSame($originalExpiration, $firstVoucher->fresh()->expires_at->toDateTimeString());
        $this->assertSame(1, $firstVoucher->fresh()->reward_rule_version);
        $this->assertDatabaseHas('vouchers', [
            'commuter_id' => $commuter->commuterProfile->id,
            'reward_cycle_number' => 2,
            'reward_rule_version' => 2,
        ]);
    }

    public function test_saving_same_threshold_does_not_reset_incomplete_progress(): void
    {
        $admin = User::factory()->admin()->create();
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '3',
            'reward_rule_version' => 1,
            'category' => 'financial',
        ]);
        $shift = $this->createShift();
        $service = app(RewardService::class);

        $this->recordRewardableRide($service, $shift, $commuter, 'TXN-SAME-1', now());

        $this->actingAs($admin)
            ->putJson('/api/v1/admin/settings/'.Setting::RIDES_FOR_FREE_REWARD_KEY, [
                'value' => 3,
                'category' => 'financial',
            ])
            ->assertOk();

        $this->assertDatabaseHas('settings', [
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'reward_rule_version' => 1,
        ]);

        $this->recordRewardableRide($service, $shift, $commuter, 'TXN-SAME-2', now()->addMinute());
        $this->recordRewardableRide($service, $shift, $commuter, 'TXN-SAME-3', now()->addMinutes(2));

        $this->assertDatabaseCount('vouchers', 1);
        $this->assertSame(1, Voucher::firstOrFail()->reward_rule_version);
    }

    public function test_rewards_retrieval_restores_the_original_soft_deleted_reward_cycle(): void
    {
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '1',
            'reward_rule_version' => 1,
            'category' => 'financial',
        ]);
        $shift = $this->createShift();
        $service = app(RewardService::class);

        $this->recordRewardableRide($service, $shift, $commuter, 'TXN-DELETED-REWARD', now());
        $voucher = Voucher::firstOrFail();
        $originalId = $voucher->id;
        $originalCode = $voucher->code;
        $voucher->delete();

        $this->assertSoftDeleted($voucher);

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.availableVoucherCount', 1)
            ->assertJsonCount(1, 'data.vouchers')
            ->assertJsonFragment([
                'id' => $originalId,
                'code' => $originalCode,
                'status' => Voucher::STATUS_AVAILABLE,
            ]);

        $this->assertNotSoftDeleted('vouchers', ['id' => $originalId]);
        $this->assertDatabaseCount('vouchers', 1);
    }

    public function test_next_reward_restores_deleted_cycle_without_bypassing_idempotency(): void
    {
        $commuter = User::factory()->commuter()->create();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '1',
            'reward_rule_version' => 1,
            'category' => 'financial',
        ]);
        $shift = $this->createShift();
        $service = app(RewardService::class);

        $this->recordRewardableRide($service, $shift, $commuter, 'TXN-CYCLE-ONE', now());
        $firstVoucher = Voucher::firstOrFail();
        $firstVoucher->delete();

        $this->recordRewardableRide($service, $shift, $commuter, 'TXN-CYCLE-TWO', now()->addHour());

        $this->assertDatabaseCount('vouchers', 2);
        $this->assertNotSoftDeleted('vouchers', ['id' => $firstVoucher->id]);
        $this->assertSame($firstVoucher->code, $firstVoucher->fresh()->code);
        $this->assertSame(
            [1, 2],
            Voucher::orderBy('reward_cycle_number')->pluck('reward_cycle_number')->all(),
        );

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.availableVoucherCount', 2)
            ->assertJsonCount(2, 'data.vouchers');
    }

    public function test_restored_expired_reward_is_normalized_and_not_counted_as_available(): void
    {
        $commuter = User::factory()->commuter()->create();
        $voucher = $this->createVoucher($commuter, 'DELETED-EXPIRED-REWARD', [
            'reward_cycle_number' => 1,
            'reward_rule_version' => 1,
            'reward_earned_at' => now()->subDays(31),
            'expires_at' => now()->subDay(),
        ]);
        $voucher->delete();

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.availableVoucherCount', 0)
            ->assertJsonFragment([
                'id' => $voucher->id,
                'status' => Voucher::STATUS_EXPIRED,
            ]);

        $this->assertNotSoftDeleted('vouchers', ['id' => $voucher->id]);
        $this->assertSame(Voucher::STATUS_EXPIRED, $voucher->fresh()->status);
    }

    public function test_rewards_normalizes_expired_vouchers_before_listing_and_badge_counting(): void
    {
        $commuter = User::factory()->commuter()->create();
        $expired = $this->createVoucher($commuter, 'EXPIRED-LIST', [
            'expires_at' => now()->subMinute(),
        ]);
        $available = $this->createVoucher($commuter, 'VALID-LIST', [
            'expires_at' => now()->addDay(),
        ]);

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.availableVoucherCount', 1)
            ->assertJsonFragment([
                'id' => $expired->id,
                'status' => Voucher::STATUS_EXPIRED,
            ])
            ->assertJsonFragment([
                'id' => $available->id,
                'status' => Voucher::STATUS_AVAILABLE,
            ]);

        $this->assertSame(Voucher::STATUS_EXPIRED, $expired->fresh()->status);
        $this->assertSame(Voucher::STATUS_AVAILABLE, $available->fresh()->status);
    }

    public function test_expiration_normalization_does_not_rewrite_other_voucher_states(): void
    {
        $commuter = User::factory()->commuter()->create();
        $used = $this->createVoucher($commuter, 'USED-EXPIRED', [
            'status' => 'USED',
            'expires_at' => now()->subMinute(),
        ]);
        $alreadyExpired = $this->createVoucher($commuter, 'OLD-EXPIRED', [
            'status' => Voucher::STATUS_EXPIRED,
            'expires_at' => now()->subMinute(),
        ]);

        $this->actingAs($commuter)
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('data.availableVoucherCount', 0);

        $this->assertSame('USED', $used->fresh()->status);
        $this->assertSame(Voucher::STATUS_EXPIRED, $alreadyExpired->fresh()->status);
    }

    private function createVoucher(User $commuter, string $code, array $overrides = []): Voucher
    {
        return Voucher::create(array_merge([
            'code' => $code,
            'commuter_id' => $commuter->commuterProfile->id,
            'type' => 'REWARD',
            'status' => Voucher::STATUS_AVAILABLE,
            'amount' => 0,
            'expires_at' => now()->addDays(30),
            'ride_origin' => 'Reward Test',
        ], $overrides));
    }

    private function recordRewardableRide(
        RewardService $service,
        ShiftLog $shift,
        User $commuter,
        string $transactionId,
        CarbonInterface $earnedAt,
    ): Transaction {
        $transaction = Transaction::forceCreate([
            'transaction_id' => $transactionId,
            'shift_id' => $shift->shift_id,
            'payment_method' => PaymentMethod::CASH->value,
            'status' => PaymentStatus::PAID->value,
            'final_amount' => 15,
            'passenger_id' => $commuter->commuterProfile->id,
            'paid_at' => $earnedAt,
            'reward_eligible' => true,
        ]);

        $service->issueForRewardableRide($transaction, $earnedAt);

        return $transaction->fresh();
    }

    private function createShift(): ShiftLog
    {
        $conductor = User::factory()->conductor()->create();
        $vehicle = Vehicle::factory()->create();
        $driver = Driver::factory()->create();

        return ShiftLog::create([
            'shift_id' => 'SFT-REWARD-TEST',
            'conductor_id' => $conductor->id,
            'driver_id' => $driver->id,
            'vehicle_id' => $vehicle->id,
            'conductor_name' => 'Reward Conductor',
            'driver_name' => 'Reward Driver',
            'unit_number' => $vehicle->unit_number,
            'plate_number' => $vehicle->plate_number,
            'time_in' => now(),
            'is_active' => false,
            'status' => ShiftStatus::ENDED->value,
        ]);
    }
}
