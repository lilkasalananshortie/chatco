<?php

namespace Tests\Feature;

use App\Contracts\Payments\PaymentGateway;
use App\Enums\PaymentMethod;
use App\Enums\PaymentStatus;
use App\Enums\UserRole;
use App\Events\PaymentStatusUpdated;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\FarePoint;
use App\Models\PaymentEvent;
use App\Models\Route;
use App\Models\Setting;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\Voucher;
use App\Services\PaymentService;
use App\Services\TransactionService;
use Illuminate\Database\QueryException;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Tests\TestCase;

/**
 * Sprint 4 fare/payment flow over the provider-agnostic payment layer.
 *
 * Covers: cash recording + idempotency, GCash initiation (real gateway via
 * Http::fake AND the fake-gateway fallback when no keys), claim lifecycle,
 * provider-agnostic webhook with payment_events idempotency + state-machine
 * guard, dev simulation, earnings split, authorization, and schema audit.
 */
class TransactionFlowTest extends TestCase
{
    use RefreshDatabase;

    private User $conductor;

    private User $conductor2;

    private User $commuter1;

    private User $commuter2;

    private User $admin;

    private Vehicle $vehicle;

    private ShiftLog $shift;

    private ShiftLog $shift2;

    private ConductorProfile $conductorProfile2;

    protected function setUp(): void
    {
        parent::setUp();

        $this->conductor = User::create([
            'email' => 'conductor1@test.com', 'password' => bcrypt('password'), 'role' => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id' => $this->conductor->id, 'first_name' => 'Conductor', 'last_name' => 'One',
            'birthday' => '1990-01-01', 'generated_username' => 'conductor1', 'generated_password' => bcrypt('password'),
        ]);

        $this->conductor2 = User::create([
            'email' => 'conductor2@test.com', 'password' => bcrypt('password'), 'role' => UserRole::CONDUCTOR,
        ]);
        $this->conductorProfile2 = ConductorProfile::create([
            'id' => $this->conductor2->id, 'first_name' => 'Conductor', 'last_name' => 'Two',
            'birthday' => '1990-01-01', 'generated_username' => 'conductor2', 'generated_password' => bcrypt('password'),
        ]);

        $this->commuter1 = User::create([
            'email' => 'commuter1@test.com', 'password' => bcrypt('password'), 'role' => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id' => $this->commuter1->id, 'first_name' => 'Commuter', 'surname' => 'One', 'birthdate' => '1990-01-01',
            'gender' => 'Male', 'email' => 'commuter1@test.com', 'contact_number' => '+639171112222',
            'commuter_type' => 'Regular', 'username' => 'commuter1', 'language_preference' => 'en',
            'account_status' => 'ACTIVE', 'verified_at' => now(),
        ]);

        $this->commuter2 = User::create([
            'email' => 'commuter2@test.com', 'password' => bcrypt('password'), 'role' => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id' => $this->commuter2->id, 'first_name' => 'Commuter', 'surname' => 'Two', 'birthdate' => '1990-01-01',
            'gender' => 'Female', 'email' => 'commuter2@test.com', 'contact_number' => '+639172223333',
            'commuter_type' => 'Regular', 'username' => 'commuter2', 'language_preference' => 'en',
            'account_status' => 'ACTIVE', 'verified_at' => now(),
        ]);

        $this->admin = User::create([
            'email' => 'admin@test.com', 'password' => bcrypt('password'), 'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create(['id' => $this->admin->id, 'first_name' => 'Admin', 'last_name' => 'User']);

        $driver = Driver::create([
            'first_name' => 'Test', 'last_name' => 'Driver', 'birthday' => '1990-01-01', 'contact' => '+639171112222',
            'license_number' => 'DL-TEST-001', 'hire_date' => '2023-01-01', 'status' => 'ACTIVE',
        ]);
        $route = Route::create(['name' => 'Test Route', 'status' => 'ACTIVE', 'waypoints' => []]);
        foreach ([
            [1, 'CAL', 'Calumpit', 0, 0, ['Calumpit Sub Area']],
            [2, 'BUS', 'Bustos', 15, 12, ['Bustos Sub Area']],
            [3, 'PUL', 'Pulilan', 100, 100, []],
            [4, 'PLA', 'Plaridel', 125, 120, []],
            [5, 'A01', 'A', 200, 200, []],
            [6, 'B01', 'B', 215, 212, []],
            [7, 'C01', 'C', 300, 300, []],
            [8, 'D01', 'D', 320, 316, []],
            [9, 'E01', 'E', 400, 400, []],
            [10, 'F01', 'F', 410, 408, []],
            [11, 'LGA', 'Legacy A', 500, 500, []],
            [12, 'LGB', 'Legacy B', 515, 512, []],
        ] as [$number, $code, $name, $regular, $discounted, $subStops]) {
            FarePoint::create([
                'route_id' => $route->id,
                'point_number' => $number,
                'code' => $code,
                'name' => $name,
                'sub_stops' => $subStops,
                'regular_fare' => $regular,
                'discounted_fare' => $discounted,
            ]);
        }

        $this->vehicle = Vehicle::create([
            'unit_number' => 'TEST-001', 'plate_number' => 'TEST-1234', 'route_id' => $route->id,
            'driver_id' => $driver->id, 'conductor_id' => $this->conductor->id, 'status' => 'ACTIVE',
        ]);
        $this->shift = ShiftLog::forceCreate([
            'shift_id' => 'SFT-TEST-1', 'conductor_id' => $this->conductor->id, 'driver_id' => $driver->id,
            'vehicle_id' => $this->vehicle->id, 'route_id' => $route->id, 'conductor_name' => 'Conductor One',
            'driver_name' => 'Test Driver', 'unit_number' => 'TEST-001', 'plate_number' => 'TEST-1234',
            'time_in' => now(), 'time_out' => null, 'is_active' => true, 'status' => 'ACTIVE',
        ]);
        $this->vehicle->update(['active_shift_id' => $this->shift->shift_id]);

        $vehicle2 = Vehicle::create([
            'unit_number' => 'TEST-002', 'plate_number' => 'TEST-5678', 'route_id' => $route->id,
            'driver_id' => $driver->id, 'conductor_id' => $this->conductorProfile2->id, 'status' => 'ACTIVE',
        ]);
        $this->shift2 = ShiftLog::forceCreate([
            'shift_id' => 'SFT-TEST-2', 'conductor_id' => $this->conductorProfile2->id, 'driver_id' => $driver->id,
            'vehicle_id' => $vehicle2->id, 'route_id' => $route->id, 'conductor_name' => 'Conductor Two',
            'driver_name' => 'Test Driver', 'unit_number' => 'TEST-002', 'plate_number' => 'TEST-5678',
            'time_in' => now(), 'time_out' => null, 'is_active' => true, 'status' => 'ACTIVE',
        ]);
        $vehicle2->update(['active_shift_id' => $this->shift2->shift_id]);
    }

    // ─── 1. Cash Recording ──────────────────────────────────────────

    public function test_cash_fare_uses_authoritative_matrix_amount_and_fare_point_ids(): void
    {
        $txn = app(TransactionService::class)->recordCashFare($this->conductor, [
            'final_amount' => 1.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);

        $this->assertSame(PaymentMethod::CASH, $txn->payment_method);
        $this->assertSame(PaymentStatus::PAID, $txn->status);
        $this->assertNotNull($txn->pickup_stop_id);
        $this->assertNotNull($txn->dropoff_stop_id);
        $this->assertNotNull($txn->paid_at);
        $this->assertSame(15.00, (float) $txn->final_amount);
    }

    public function test_cash_endpoint_ignores_tampered_amounts_and_validates_sub_area(): void
    {
        $pickup = FarePoint::where('name', 'Calumpit')->firstOrFail();
        $dropoff = FarePoint::where('name', 'Bustos')->firstOrFail();
        Sanctum::actingAs($this->conductor);

        $response = $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'CASH',
            'final_amount' => 1,
            'base_fare' => 1,
            'discount_amount' => 0,
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'pickup_name' => 'Calumpit · Calumpit Sub Area',
            'dropoff_name' => 'Bustos · Bustos Sub Area',
            'passenger_role' => 'STUDENT',
        ]);

        $response->assertCreated()
            ->assertJsonPath('data.final_amount', '12.00')
            ->assertJsonPath('data.base_fare', '15.00')
            ->assertJsonPath('data.discount_amount', '3.00')
            ->assertJsonPath('data.pickup_name', 'Calumpit · Calumpit Sub Area')
            ->assertJsonPath('data.dropoff_name', 'Bustos · Bustos Sub Area');
    }

    public function test_bound_cash_commuter_type_overrides_client_discount_claim(): void
    {
        $this->commuter1->commuterProfile->update(['commuter_type' => 'STUDENT']);
        $pickup = FarePoint::where('name', 'Calumpit')->firstOrFail();
        $dropoff = FarePoint::where('name', 'Bustos')->firstOrFail();
        Sanctum::actingAs($this->conductor);

        $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'CASH',
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'pickup_name' => $pickup->name,
            'dropoff_name' => $dropoff->name,
            'passenger_id' => $this->commuter1->commuterProfile->id,
            'passenger_role' => 'REGULAR',
        ])->assertCreated()
            ->assertJsonPath('data.final_amount', '12.00')
            ->assertJsonPath('data.passenger_role', 'STUDENT');
    }

    public function test_group_cash_endpoint_recalculates_every_passenger_amount(): void
    {
        $pickup = FarePoint::where('name', 'Calumpit')->firstOrFail();
        $dropoff = FarePoint::where('name', 'Bustos')->firstOrFail();
        Sanctum::actingAs($this->conductor);

        $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'CASH',
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'pickup_name' => $pickup->name,
            'dropoff_name' => $dropoff->name,
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2],
                ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 99, 'base_fare' => 99],
            ],
        ])->assertCreated()
            ->assertJsonPath('data.total_amount', 42)
            ->assertJsonPath('data.passenger_count', 3)
            ->assertJsonPath('data.transactions.0.final_amount', '15.00')
            ->assertJsonPath('data.transactions.2.final_amount', '12.00');
    }

    public function test_gcash_endpoint_recalculates_single_and_group_amounts(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        $pickup = FarePoint::where('name', 'Calumpit')->firstOrFail();
        $dropoff = FarePoint::where('name', 'Bustos')->firstOrFail();
        Sanctum::actingAs($this->conductor);

        $this->postJson('/api/v1/conductor/payments/gcash/initiate', [
            'payment_method' => 'GCASH',
            'final_amount' => 1,
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'pickup_name' => $pickup->name,
            'dropoff_name' => $dropoff->name,
        ])->assertCreated()
            ->assertJsonPath('data.amount', 15);

        // Release the one-pending-payment slot before creating the grouped QR.
        Transaction::query()->update(['status' => PaymentStatus::CANCELLED->value]);

        $this->postJson('/api/v1/conductor/payments/gcash/initiate', [
            'payment_method' => 'GCASH',
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'pickup_name' => $pickup->name,
            'dropoff_name' => $dropoff->name,
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2],
                ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 99],
            ],
        ])->assertCreated()
            ->assertJsonPath('data.amount', 42);
    }

    public function test_server_rejects_wrong_sub_area_and_cross_route_points(): void
    {
        $pickup = FarePoint::where('name', 'Calumpit')->firstOrFail();
        $dropoff = FarePoint::where('name', 'Bustos')->firstOrFail();
        Sanctum::actingAs($this->conductor);

        $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'CASH',
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'pickup_name' => 'Not a Calumpit sub-area',
            'dropoff_name' => $dropoff->name,
        ])->assertStatus(422);

        $otherRoute = Route::create(['name' => 'Other Route', 'status' => 'ACTIVE', 'waypoints' => []]);
        $otherPoint = FarePoint::create([
            'route_id' => $otherRoute->id,
            'point_number' => 1,
            'code' => 'OTH',
            'name' => 'Other Point',
            'regular_fare' => 15,
            'discounted_fare' => 12,
        ]);

        $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'CASH',
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $otherPoint->id,
            'pickup_name' => $pickup->name,
            'dropoff_name' => $otherPoint->name,
        ])->assertStatus(422);
    }

    public function test_voucher_ride_ignores_client_amounts_and_uses_server_fare_snapshot(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter1);
        $pickup = FarePoint::where('name', 'Calumpit')->firstOrFail();
        $dropoff = FarePoint::where('name', 'Bustos')->firstOrFail();
        Sanctum::actingAs($this->conductor);

        $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'VOUCHER',
            'final_amount' => 999,
            'base_fare' => 999,
            'discount_amount' => 0,
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'pickup_name' => $pickup->name,
            'dropoff_name' => $dropoff->name,
            'voucher_code' => $voucher->code,
            'passenger_id' => $this->commuter1->commuterProfile->id,
        ])->assertCreated()
            ->assertJsonPath('data.final_amount', '0.00')
            ->assertJsonPath('data.base_fare', '15.00')
            ->assertJsonPath('data.discount_amount', '15.00');
    }

    public function test_offline_retry_can_target_owned_originating_shift_only(): void
    {
        $svc = app(TransactionService::class);

        $txn = $svc->recordCashFare($this->conductor, [
            'shift_id' => $this->shift->shift_id,
            'final_amount' => 15.00,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
        ]);

        $this->assertSame($this->shift->shift_id, $txn->shift_id);

        $this->assertAbort(403, fn () => $svc->recordCashFare($this->conductor, [
            'shift_id' => $this->shift2->shift_id,
            'final_amount' => 15.00,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
        ]));
    }

    public function test_cash_fare_appears_in_get_shift_transactions(): void
    {
        $svc = app(TransactionService::class);
        $txn = $svc->recordCashFare($this->conductor, ['final_amount' => 20.00, 'pickup_name' => 'Pulilan', 'dropoff_name' => 'Plaridel']);
        $list = $svc->getShiftTransactions($this->conductor, $this->shift->shift_id);

        $this->assertCount(1, $list);
        $this->assertSame($txn->transaction_id, $list->first()->transaction_id);
    }

    public function test_double_submitting_cash_fare_with_same_idempotency_key_does_not_create_duplicate(): void
    {
        $svc = app(TransactionService::class);
        $data = ['final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos', 'idempotency_key' => 'fixed-key-123'];

        $txn1 = $svc->recordCashFare($this->conductor, $data);
        $txn2 = $svc->recordCashFare($this->conductor, $data);

        $this->assertSame($txn1->transaction_id, $txn2->transaction_id);
        $this->assertSame(1, Transaction::count());
    }

    public function test_identical_cash_fares_with_different_keys_are_both_recorded(): void
    {
        $svc = app(TransactionService::class);
        $base = ['final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos'];

        $txn1 = $svc->recordCashFare($this->conductor, $base + ['idempotency_key' => 'key-a']);
        $txn2 = $svc->recordCashFare($this->conductor, $base + ['idempotency_key' => 'key-b']);

        $this->assertNotSame($txn1->transaction_id, $txn2->transaction_id);
        $this->assertSame(2, Transaction::count());
    }

    // ─── 1b. Cash Receipt Claim (paper QR → reward credit) ──────────

    public function test_cash_fare_mints_a_receipt_token_but_gcash_claim_cannot_use_it(): void
    {
        $txn = app(TransactionService::class)->recordCashFare($this->conductor, [
            'final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);

        $this->assertNotNull($txn->qr_token, 'cash receipt QR needs a token to print');
        $this->assertNull($txn->passenger_id, 'cash involves no account until claimed');

        // The cash token must not be redeemable through the GCash path — that
        // path binds PENDING rows and would hand out a ride that was not paid
        // through the gateway.
        $this->expectException(HttpException::class);
        app(TransactionService::class)->claimGcash($this->commuter1, $txn->qr_token);
    }

    public function test_receipt_claim_binds_passenger_and_counts_toward_rewards(): void
    {
        $svc = app(TransactionService::class);
        $txn = $svc->recordCashFare($this->conductor, [
            'final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);

        $profileId = $this->commuter1->commuterProfile->id;
        $this->assertSame(0, $this->paidRideCountFor($profileId));

        $result = $svc->claimCashReceipt($this->commuter1, $txn->qr_token);

        $this->assertFalse($result['already_claimed']);
        $this->assertSame($txn->transaction_id, $result['transaction_id']);
        $this->assertSame($profileId, $txn->fresh()->passenger_id);
        // The binding IS the "+1" — rewards are derived from this count.
        $this->assertSame(1, $this->paidRideCountFor($profileId));
    }

    public function test_receipt_claim_is_idempotent_for_the_same_commuter(): void
    {
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '1',
            'category' => 'financial',
        ]);
        $svc = app(TransactionService::class);
        $txn = $svc->recordCashFare($this->conductor, [
            'final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);

        $svc->claimCashReceipt($this->commuter1, $txn->qr_token);
        $second = $svc->claimCashReceipt($this->commuter1, $txn->qr_token);

        $this->assertTrue($second['already_claimed'], 're-scanning must not double-count');
        $this->assertSame(1, $this->paidRideCountFor($this->commuter1->commuterProfile->id));
        $this->assertSame(1, Voucher::where('commuter_id', $this->commuter1->commuterProfile->id)->count());
    }

    public function test_receipt_claim_rejects_a_second_commuter_with_409(): void
    {
        $svc = app(TransactionService::class);
        $txn = $svc->recordCashFare($this->conductor, [
            'final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);
        $svc->claimCashReceipt($this->commuter1, $txn->qr_token);

        try {
            $svc->claimCashReceipt($this->commuter2, $txn->qr_token);
            $this->fail('a claimed receipt must not be claimable again');
        } catch (HttpException $e) {
            $this->assertSame(409, $e->getStatusCode());
        }

        $this->assertSame(0, $this->paidRideCountFor($this->commuter2->commuterProfile->id));
    }

    public function test_receipt_claim_returns_410_once_past_the_ttl(): void
    {
        $svc = app(TransactionService::class);
        $txn = $svc->recordCashFare($this->conductor, [
            'final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);

        // Age the receipt one hour beyond the configured window.
        $ttl = (int) config('payments.cash_receipt_ttl_hours', 6);
        $txn->forceFill(['created_at' => now()->subHours($ttl + 1)])->save();

        try {
            $svc->claimCashReceipt($this->commuter1, $txn->qr_token);
            $this->fail('an expired receipt must not be claimable');
        } catch (HttpException $e) {
            $this->assertSame(410, $e->getStatusCode());
        }

        $this->assertNull($txn->fresh()->passenger_id);
    }

    public function test_receipt_claim_still_works_just_inside_the_ttl(): void
    {
        $svc = app(TransactionService::class);
        $txn = $svc->recordCashFare($this->conductor, [
            'final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);

        $ttl = (int) config('payments.cash_receipt_ttl_hours', 6);
        $txn->forceFill(['created_at' => now()->subHours($ttl)->addMinutes(5)])->save();

        $result = $svc->claimCashReceipt($this->commuter1, $txn->qr_token);

        $this->assertFalse($result['already_claimed']);
    }

    public function test_receipt_claim_rejects_a_gcash_token_with_422(): void
    {
        $gcash = $this->createPendingGcashTransaction();

        try {
            app(TransactionService::class)->claimCashReceipt($this->commuter1, $gcash->qr_token);
            $this->fail('a GCash QR must not be claimable as a cash receipt');
        } catch (HttpException $e) {
            $this->assertSame(422, $e->getStatusCode());
        }

        $this->assertNull($gcash->fresh()->passenger_id);
    }

    public function test_receipt_claim_returns_404_for_an_unknown_token(): void
    {
        try {
            app(TransactionService::class)->claimCashReceipt($this->commuter1, 'not-a-real-token');
            $this->fail('an unknown token must 404');
        } catch (HttpException $e) {
            $this->assertSame(404, $e->getStatusCode());
        }
    }

    public function test_voucher_ride_mints_no_receipt_token(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter1, ['code' => 'REWARD-TESTCODE']);

        $txn = app(TransactionService::class)->recordCashFare($this->conductor, [
            'final_amount' => 15.00,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'payment_method' => PaymentMethod::VOUCHER->value,
            'voucher_code' => $voucher->code,
        ]);

        // Already bound to the commuter and free — nothing left to claim.
        $this->assertNull($txn->qr_token);
    }

    public function test_two_competing_redemption_attempts_create_only_one_free_ride(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter1);
        Sanctum::actingAs($this->conductor);

        $payload = [
            'payment_method' => PaymentMethod::VOUCHER->value,
            'final_amount' => 0,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'voucher_code' => $voucher->code,
            'passenger_id' => $this->commuter1->commuterProfile->id,
            'idempotency_key' => 'voucher-attempt-one',
        ];

        $this->postJson('/api/v1/conductor/transactions', $payload)
            ->assertCreated();

        $this->postJson('/api/v1/conductor/transactions', array_merge($payload, [
            'idempotency_key' => 'voucher-attempt-two',
        ]))
            ->assertStatus(409)
            ->assertJsonPath('message', 'This voucher has already been used or is no longer available.');

        $this->assertSame(1, Transaction::where('voucher_id', $voucher->id)->count());
        $this->assertSame('USED', $voucher->fresh()->status);
    }

    public function test_voucher_returns_to_available_when_transaction_creation_fails(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter1);

        DB::statement(<<<'SQL'
            CREATE TRIGGER fail_voucher_transaction
            BEFORE INSERT ON transactions
            WHEN NEW.voucher_id IS NOT NULL
            BEGIN
                SELECT RAISE(ABORT, 'forced voucher transaction failure');
            END
        SQL);

        try {
            app(TransactionService::class)->recordCashFare($this->conductor, [
                'payment_method' => PaymentMethod::VOUCHER->value,
                'final_amount' => 0,
                'pickup_name' => 'Calumpit',
                'dropoff_name' => 'Bustos',
                'voucher_code' => $voucher->code,
                'passenger_id' => $this->commuter1->commuterProfile->id,
            ]);
            $this->fail('The forced transaction insert failure should propagate.');
        } catch (QueryException) {
            // Expected: the enclosing DB transaction must roll the voucher back.
        } finally {
            DB::statement('DROP TRIGGER IF EXISTS fail_voucher_transaction');
        }

        $this->assertSame('AVAILABLE', $voucher->fresh()->status);
        $this->assertSame(0, Transaction::where('voucher_id', $voucher->id)->count());
    }

    public function test_already_used_voucher_returns_conflict(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter1, ['status' => 'USED']);

        $this->assertAbort(409, fn () => app(TransactionService::class)->recordCashFare($this->conductor, [
            'payment_method' => PaymentMethod::VOUCHER->value,
            'final_amount' => 0,
            'voucher_code' => $voucher->code,
            'passenger_id' => $this->commuter1->commuterProfile->id,
        ]));

        $this->assertSame(0, Transaction::where('voucher_id', $voucher->id)->count());
    }

    public function test_expired_voucher_is_rejected_without_consuming_it(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter1, [
            'expires_at' => now()->subMinute(),
        ]);

        $this->assertAbort(422, fn () => app(TransactionService::class)->recordCashFare($this->conductor, [
            'payment_method' => PaymentMethod::VOUCHER->value,
            'final_amount' => 0,
            'voucher_code' => $voucher->code,
            'passenger_id' => $this->commuter1->commuterProfile->id,
        ]));

        $this->assertSame('EXPIRED', $voucher->fresh()->status);
        $this->assertSame(0, Transaction::where('voucher_id', $voucher->id)->count());
    }

    public function test_voucher_belonging_to_another_commuter_is_rejected(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter2);

        $this->assertAbort(422, fn () => app(TransactionService::class)->recordCashFare($this->conductor, [
            'payment_method' => PaymentMethod::VOUCHER->value,
            'final_amount' => 0,
            'voucher_code' => $voucher->code,
            'passenger_id' => $this->commuter1->commuterProfile->id,
        ]));

        $this->assertSame('AVAILABLE', $voucher->fresh()->status);
        $this->assertSame(0, Transaction::where('voucher_id', $voucher->id)->count());
    }

    public function test_unique_voucher_constraint_blocks_duplicate_links_but_allows_normal_null_vouchers(): void
    {
        $voucher = $this->createRewardVoucher($this->commuter1);
        $transaction = app(TransactionService::class)->recordCashFare($this->conductor, [
            'payment_method' => PaymentMethod::VOUCHER->value,
            'final_amount' => 0,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'voucher_code' => $voucher->code,
            'passenger_id' => $this->commuter1->commuterProfile->id,
        ]);

        $duplicate = $transaction->replicate();
        $duplicate->transaction_id = 'TXN-DUPLICATE-VOUCHER';

        try {
            $duplicate->save();
            $this->fail('The database must reject a second transaction for one voucher.');
        } catch (UniqueConstraintViolationException) {
            // Expected database backstop.
        }

        app(TransactionService::class)->recordCashFare($this->conductor, [
            'final_amount' => 15, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);
        app(TransactionService::class)->recordCashFare($this->conductor, [
            'final_amount' => 20, 'pickup_name' => 'C', 'dropoff_name' => 'D',
        ]);

        $this->assertSame(2, Transaction::whereNull('voucher_id')->count());
        $this->assertSame(1, Transaction::where('voucher_id', $voucher->id)->count());
    }

    public function test_group_cash_creates_one_paid_receipt_per_passenger_and_one_reward_slot(): void
    {
        $group = app(TransactionService::class)->recordGroupedCashFare($this->conductor, [
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'idempotency_key' => 'group-cash-test',
            'group_passengers' => [
                ['type' => 'STUDENT', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
            ],
        ]);

        $this->assertSame(3, $group->passenger_count);
        $this->assertSame(42.0, (float) $group->total_amount);
        $this->assertStringStartsWith('MP-', $group->reference_number);
        $this->assertCount(3, $group->transactions);
        $this->assertSame(3, $group->transactions->pluck('transaction_id')->unique()->count());
        $this->assertTrue($group->transactions->every(fn ($transaction) => $transaction->pickup_name === 'Calumpit' && $transaction->dropoff_name === 'Bustos'));
        $this->assertSame('STUDENT', $group->transactions->first()->passenger_role);
        $this->assertSame(12.0, (float) $group->transactions->first()->final_amount);
        $this->assertSame(1, $group->transactions->where('reward_eligible', true)->count());
        $this->assertSame(1, $group->transactions->whereNotNull('qr_token')->count());
        $this->assertTrue($group->transactions->every(fn ($transaction) => $transaction->status === PaymentStatus::PAID));
    }

    public function test_group_cash_endpoint_is_immediately_visible_in_receipts(): void
    {
        Sanctum::actingAs($this->conductor);

        $created = $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'CASH',
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'idempotency_key' => 'group-cash-http-test',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
                ['type' => 'STUDENT', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
            ],
        ]);

        $created->assertCreated()
            ->assertJsonCount(3, 'data.transactions')
            ->assertJsonPath('data.passenger_count', 3);
        $this->assertStringStartsWith('MP-', $created->json('data.multiple_payment_reference'));

        Sanctum::actingAs($this->admin);
        $this->getJson('/api/v1/admin/transactions?per_page=10')
            ->assertOk()
            ->assertJsonCount(3, 'data.data');
    }

    public function test_admin_transactions_date_filters_scope_by_created_at(): void
    {
        $svc = app(TransactionService::class);
        $todayTxn = $svc->recordCashFare($this->conductor, ['final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos']);
        $oldTxn = $svc->recordCashFare($this->conductor, ['final_amount' => 20.00, 'pickup_name' => 'Pulilan', 'dropoff_name' => 'Plaridel']);

        DB::table('transactions')
            ->where('transaction_id', $oldTxn->transaction_id)
            ->update(['created_at' => now()->subDays(10)]);

        Sanctum::actingAs($this->admin);

        // Exact-date match (the receipts page's date picker) returns only today's row.
        $this->getJson('/api/v1/admin/transactions?date='.now()->toDateString())
            ->assertOk()
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.transaction_id', $todayTxn->transaction_id);

        // Lower-bound match (the "Today"/"Last 7 Days"/"This Month" presets) excludes the backdated row.
        $this->getJson('/api/v1/admin/transactions?date_from='.now()->toDateString())
            ->assertOk()
            ->assertJsonCount(1, 'data.data');

        // No date filter ("All Time") still returns every transaction, unfiltered.
        $this->getJson('/api/v1/admin/transactions')
            ->assertOk()
            ->assertJsonCount(2, 'data.data');
    }

    public function test_group_gcash_settles_all_receipts_but_credits_only_the_payer_once(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 42,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
                ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
            ],
        ]);

        $anchor = $result['transaction'];
        $this->assertSame(42.0, $result['amount']);
        $this->assertSame(0.0, (float) $anchor->final_amount);
        $this->assertNull($anchor->payment_reference);
        $this->assertCount(4, $result['receipts']);
        $pending = app(TransactionService::class)->findPendingGcashForConductor($this->conductor);
        $this->assertSame($anchor->transaction_id, $pending['transaction']->transaction_id);
        $this->assertSame($anchor->qr_token, $pending['qr_token']);
        $claim = app(TransactionService::class)->claimGcash($this->commuter1, $anchor->qr_token);
        $this->assertSame(57.0, $claim['amount']);
        app(PaymentService::class)->transitionTo($anchor->fresh(), PaymentStatus::PAID);

        $receipts = Transaction::where('group_id', $anchor->group_id)->get();
        $this->assertTrue($receipts->every(fn ($transaction) => $transaction->status === PaymentStatus::PAID));
        $this->assertTrue($receipts->every(fn ($transaction) => $transaction->payer_name === 'Commuter One'));
        $this->assertSame(1, $this->paidRideCountFor($this->commuter1->commuterProfile->id));
    }

    public function test_group_gcash_claim_reprices_the_verified_discounted_payer(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        $this->createFarePoints();
        $this->commuter1->commuterProfile->update(['commuter_type' => 'STUDENT']);

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 42,
            'pickup_name' => 'Test Pickup',
            'dropoff_name' => 'Test Dropoff',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
                ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
            ],
        ]);

        $anchor = $result['transaction'];
        $claim = app(TransactionService::class)->claimGcash($this->commuter1, $anchor->qr_token);
        $anchor->refresh();
        $group = $anchor->paymentGroup()->firstOrFail();

        $this->assertSame(54.0, $claim['amount']);
        $this->assertSame(60.0, $claim['regular_amount']);
        $this->assertSame(6.0, $claim['discount_amount']);
        $this->assertSame('STUDENT', $claim['passenger_role']);
        $this->assertSame(12.0, (float) $anchor->final_amount);
        $this->assertSame(3.0, (float) $anchor->discount_amount);
        $this->assertSame(54.0, (float) $group->total_amount);
        $this->assertSame(4, $group->passenger_count);
        $this->assertSame([
            ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
            ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
            ['type' => 'STUDENT', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
        ], $group->passenger_breakdown);
    }

    // ─── GCash voucher redemption (commuter covers their own seat) ──

    public function test_solo_gcash_voucher_redemption_settles_immediately_at_zero_pesos(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        $voucher = $this->createRewardVoucher($this->commuter1);

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 15,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
        ]);
        $transaction = $result['transaction'];
        $claim = app(TransactionService::class)->claimGcash($this->commuter1, $transaction->qr_token);
        $this->assertTrue($claim['voucher_available']);

        $redeemed = app(TransactionService::class)->redeemVoucherForGcash($this->commuter1, $transaction->transaction_id);

        $this->assertSame(0.0, $redeemed['amount']);
        $transaction->refresh();
        $this->assertSame(PaymentMethod::VOUCHER, $transaction->payment_method);
        $this->assertSame(PaymentStatus::PAID, $transaction->status);
        $this->assertSame(0.0, (float) $transaction->final_amount);
        $this->assertSame($voucher->id, $transaction->voucher_id);
        $this->assertNotNull($transaction->paid_at);
        $this->assertSame('USED', $voucher->fresh()->status);
        // A voucher-paid ride must never count toward earning another voucher.
        $this->assertSame(0, $this->paidRideCountFor($this->commuter1->commuterProfile->id));
    }

    public function test_group_gcash_voucher_redemption_covers_only_the_payer(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        $voucher = $this->createRewardVoucher($this->commuter1);

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 42,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
                ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
            ],
        ]);
        $anchor = $result['transaction'];
        $claim = app(TransactionService::class)->claimGcash($this->commuter1, $anchor->qr_token);
        $this->assertSame(57.0, $claim['amount']); // 42 companions + 15 payer's own regular fare
        $this->assertTrue($claim['voucher_available']);
        $group = $anchor->fresh()->paymentGroup()->firstOrFail();
        $originalReference = $anchor->fresh()->payment_reference;

        $redeemed = app(TransactionService::class)->redeemVoucherForGcash($this->commuter1, $anchor->transaction_id);

        // Only the payer's own ₱15 seat is covered — the response amount now
        // reflects just the remaining companions' total.
        $this->assertSame(42.0, $redeemed['amount']);

        $anchor->refresh();
        $this->assertSame(PaymentMethod::VOUCHER, $anchor->payment_method);
        $this->assertSame(0.0, (float) $anchor->final_amount);
        $this->assertSame($voucher->id, $anchor->voucher_id);
        $this->assertSame('USED', $voucher->fresh()->status);
        // Group is not settled yet — companions still owe their fares via a
        // freshly re-issued (smaller) GCash intent.
        $this->assertSame(PaymentStatus::PENDING, $anchor->status);
        $this->assertNotSame($originalReference, $anchor->payment_reference);
        $this->assertSame(42.0, (float) $group->fresh()->total_amount);

        $companions = Transaction::where('group_id', $anchor->group_id)
            ->where('transaction_id', '!=', $anchor->transaction_id)
            ->get();
        $this->assertCount(3, $companions);
        $this->assertTrue($companions->every(fn ($t) => $t->status === PaymentStatus::PENDING && $t->payment_method === PaymentMethod::GCASH));

        // Companions' payment settles the rest of the group — the voucher row
        // rides along to PAID with them, still labeled VOUCHER/₱0.
        app(PaymentService::class)->transitionTo($anchor->fresh(), PaymentStatus::PAID);
        $anchor->refresh();
        $this->assertSame(PaymentStatus::PAID, $anchor->status);
        $this->assertSame(PaymentMethod::VOUCHER, $anchor->payment_method);
        $this->assertSame(0.0, (float) $anchor->final_amount);
        $this->assertTrue(Transaction::where('group_id', $anchor->group_id)->get()->every(fn ($t) => $t->status === PaymentStatus::PAID));
        // Still no reward progress from a voucher-covered ride.
        $this->assertSame(0, $this->paidRideCountFor($this->commuter1->commuterProfile->id));
    }

    public function test_voucher_redemption_rejects_a_transaction_that_is_not_the_caller_s(): void
    {
        $this->createRewardVoucher($this->commuter1);
        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 15, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);
        app(TransactionService::class)->claimGcash($this->commuter2, $result['transaction']->qr_token);

        $this->assertAbort(403, fn () => app(TransactionService::class)->redeemVoucherForGcash(
            $this->commuter1, $result['transaction']->transaction_id
        ));
    }

    public function test_voucher_redemption_requires_an_available_voucher(): void
    {
        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 15, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos',
        ]);
        $claim = app(TransactionService::class)->claimGcash($this->commuter1, $result['transaction']->qr_token);
        $this->assertFalse($claim['voucher_available']);

        $this->assertAbort(422, fn () => app(TransactionService::class)->redeemVoucherForGcash(
            $this->commuter1, $result['transaction']->transaction_id
        ));
    }

    public function test_failed_group_gcash_after_voucher_redemption_returns_the_voucher(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        $voucher = $this->createRewardVoucher($this->commuter1);

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 42,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
                ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
            ],
        ]);
        $anchor = $result['transaction'];
        app(TransactionService::class)->claimGcash($this->commuter1, $anchor->qr_token);
        app(TransactionService::class)->redeemVoucherForGcash($this->commuter1, $anchor->transaction_id);

        $this->assertSame('USED', $voucher->fresh()->status);

        // The companions' remaining GCash charge never completes.
        app(PaymentService::class)->transitionTo($anchor->fresh(), PaymentStatus::FAILED);

        $this->assertSame('AVAILABLE', $voucher->fresh()->status);
        $anchor->refresh();
        $this->assertSame(PaymentStatus::FAILED, $anchor->status);
    }

    public function test_multi_passenger_cash_is_one_transaction_with_server_calculated_breakdown(): void
    {
        [$pickup, $dropoff] = $this->createFarePoints();

        $transaction = app(TransactionService::class)->recordMultiPassengerCashFare($this->conductor, [
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'idempotency_key' => 'normalized-cash-test',
            'passengers' => [
                ['passenger_type' => 'REGULAR', 'quantity' => 2],
                ['passenger_type' => 'STUDENT', 'quantity' => 1],
                ['passenger_type' => 'SENIOR', 'quantity' => 1],
                ['passenger_type' => 'PWD', 'quantity' => 1],
            ],
        ]);

        $this->assertSame(1, Transaction::count());
        $this->assertSame(5, $transaction->total_passengers);
        $this->assertSame(75.0, (float) $transaction->gross_amount);
        $this->assertSame(9.0, (float) $transaction->discount_amount);
        $this->assertSame(66.0, (float) $transaction->final_amount);
        $this->assertCount(4, $transaction->passengerBreakdown);
    }

    public function test_multi_passenger_endpoint_rejects_zero_negative_and_unknown_types(): void
    {
        [$pickup, $dropoff] = $this->createFarePoints();
        $base = [
            'payment_method' => 'CASH',
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
        ];

        foreach ([
            [['passenger_type' => 'REGULAR', 'quantity' => 0]],
            [['passenger_type' => 'STUDENT', 'quantity' => -1]],
            [['passenger_type' => 'ADULT', 'quantity' => 1]],
        ] as $passengers) {
            $this->actingAs($this->conductor, 'sanctum')
                ->postJson('/api/v1/conductor/transactions', $base + ['passengers' => $passengers])
                ->assertStatus(422);
        }
    }

    public function test_multi_gcash_snapshots_payer_and_counts_one_reward_after_repeated_settlement(): void
    {
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '1',
            'category' => 'financial',
        ]);
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        [$pickup, $dropoff] = $this->createFarePoints();

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'pickup_stop_id' => $pickup->id,
            'dropoff_stop_id' => $dropoff->id,
            'passengers' => [
                ['passenger_type' => 'REGULAR', 'quantity' => 2],
                ['passenger_type' => 'PWD', 'quantity' => 2],
            ],
        ]);
        $transaction = $result['transaction'];
        app(TransactionService::class)->claimGcash($this->commuter1, $transaction->qr_token);
        app(PaymentService::class)->transitionTo($transaction->fresh(), PaymentStatus::PAID);
        app(PaymentService::class)->transitionTo($transaction->fresh(), PaymentStatus::PAID);

        $transaction->refresh();
        $this->assertSame($this->commuter1->commuterProfile->id, $transaction->payer_id);
        $this->assertSame('Commuter One', $transaction->payer_name_snapshot);
        $this->assertSame(1, $this->paidRideCountFor($this->commuter1->commuterProfile->id));
        $this->assertSame(1, Voucher::where('commuter_id', $this->commuter1->commuterProfile->id)->count());

        $this->actingAs($this->admin, 'sanctum')
            ->getJson('/api/v1/admin/transactions')
            ->assertOk()
            ->assertJsonPath('data.data.0.total_passengers', 4)
            ->assertJsonPath('data.data.0.payer_name_snapshot', 'Commuter One')
            ->assertJsonCount(2, 'data.data.0.passenger_breakdown');
    }

    public function test_historical_single_passenger_row_remains_readable_without_breakdown(): void
    {
        $transaction = app(TransactionService::class)->recordCashFare($this->conductor, [
            'final_amount' => 15,
            'pickup_name' => 'Legacy A',
            'dropoff_name' => 'Legacy B',
            'passenger_role' => 'REGULAR',
        ]);

        $this->assertSame(1, $transaction->total_passengers);
        $this->assertCount(0, $transaction->passengerBreakdown()->get());
    }

    /** PAID non-voucher rides bound to a commuter — what rewards counts. */
    private function paidRideCountFor(string $profileId): int
    {
        return Transaction::where('passenger_id', $profileId)
            ->where('status', PaymentStatus::PAID->value)
            ->where('payment_method', '!=', PaymentMethod::VOUCHER->value)
            ->where('reward_eligible', true)
            ->count();
    }

    private function createFarePoints(): array
    {
        $pickup = FarePoint::create([
            'route_id' => $this->shift->route_id,
            'point_number' => 1,
            'code' => 'TST-01',
            'name' => 'Test Pickup',
            'regular_fare' => 15,
            'discounted_fare' => 12,
        ]);
        $dropoff = FarePoint::create([
            'route_id' => $this->shift->route_id,
            'point_number' => 2,
            'code' => 'TST-02',
            'name' => 'Test Dropoff',
            'regular_fare' => 30,
            'discounted_fare' => 24,
        ]);

        return [$pickup, $dropoff];
    }

    // ─── 2. GCash Initiation ────────────────────────────────────────

    public function test_gcash_initiate_creates_pending_row_via_real_gateway(): void
    {
        Http::fake([
            'api.paymongo.com/v1/payment_intents' => Http::response(['data' => ['id' => 'pi_test_123', 'attributes' => ['status' => 'awaiting_payment_method']]], 200),
            'api.paymongo.com/v1/payment_methods' => Http::response(['data' => ['id' => 'pm_test_123', 'attributes' => ['type' => 'gcash']]], 200),
            'api.paymongo.com/v1/payment_intents/pi_test_123/attach' => Http::response(['data' => ['id' => 'pi_test_123', 'attributes' => [
                'status' => 'awaiting_next_action',
                'next_action' => ['redirect' => ['url' => 'https://test.checkout.url/abc']],
            ]]], 200),
        ]);
        $this->configurePayMongo();

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 25.00, 'pickup_name' => 'Pulilan', 'dropoff_name' => 'Plaridel',
        ]);

        $this->assertSame(PaymentMethod::GCASH, $result['transaction']->payment_method);
        $this->assertSame(PaymentStatus::PENDING, $result['transaction']->status);
        $this->assertNotEmpty($result['qr_token']);
        $this->assertSame('https://test.checkout.url/abc', $result['checkout_url']);
        $this->assertSame(25.00, $result['amount']);
        $this->assertSame('paymongo', $result['transaction']->payment_provider);
        $this->assertSame('pi_test_123', $result['transaction']->payment_reference);
    }

    public function test_gcash_initiate_falls_back_to_fake_gateway_when_unconfigured(): void
    {
        // No PayMongo keys → PaymentServiceProvider binds the FakeGateway.
        // Save the original secret, clear it, re-bind, then restore after.
        $originalSecret = config('payments.gateways.paymongo.secret');
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 25.00, 'pickup_name' => 'Pulilan', 'dropoff_name' => 'Plaridel',
        ]);

        $this->assertSame(PaymentStatus::PENDING, $result['transaction']->status);
        $this->assertSame('fake', $result['transaction']->payment_provider);
        $this->assertNull($result['checkout_url']); // no real authorize page without keys
        $this->assertNotEmpty($result['qr_token']);  // QR + claim flow still works

        // Restore the original config so subsequent tests use the real gateway.
        config(['payments.gateways.paymongo.secret' => $originalSecret]);
        $this->forgetGateway();
    }

    // ─── 3. GCash Claim ─────────────────────────────────────────────

    public function test_gcash_claim_binds_passenger_id_and_returns_checkout_url(): void
    {
        $txn = $this->createPendingGcashTransaction();
        $result = app(TransactionService::class)->claimGcash($this->commuter1, $txn->qr_token);

        $this->assertSame($txn->transaction_id, $result['transaction_id']);
        $this->assertSame($txn->payment_checkout_url, $result['checkout_url']);

        $txn->refresh();
        $this->assertSame($this->commuter1->commuterProfile->id, $txn->passenger_id);
    }

    public function test_gcash_claim_automatically_applies_all_verified_role_discounts(): void
    {
        FarePoint::create([
            'route_id' => $this->shift->route_id,
            'point_number' => 1,
            'code' => 'PUL',
            'name' => 'Pulilan',
            'regular_fare' => 13,
            'discounted_fare' => 12,
        ]);
        FarePoint::create([
            'route_id' => $this->shift->route_id,
            'point_number' => 2,
            'code' => 'PLA',
            'name' => 'Plaridel',
            'regular_fare' => 38,
            'discounted_fare' => 32,
        ]);

        foreach (['STUDENT', 'SENIOR', 'PWD'] as $commuterType) {
            $this->commuter1->commuterProfile->update(['commuter_type' => $commuterType]);
            $transaction = $this->createPendingGcashTransaction(['final_amount' => 25]);
            $result = app(TransactionService::class)->claimGcash($this->commuter1, $transaction->qr_token);

            $this->assertSame(20.0, $result['amount']);
            $this->assertSame(25.0, $result['regular_amount']);
            $this->assertSame(5.0, $result['discount_amount']);
            $this->assertSame($commuterType, $result['passenger_role']);
            $this->assertDatabaseHas('transactions', [
                'transaction_id' => $transaction->transaction_id,
                'passenger_role' => $commuterType,
                'final_amount' => 20,
                'discount_amount' => 5,
            ]);
        }
    }

    public function test_gcash_claim_keeps_regular_fare_for_regular_commuter(): void
    {
        $this->commuter1->commuterProfile->update(['commuter_type' => 'REGULAR']);
        $transaction = $this->createPendingGcashTransaction(['final_amount' => 25]);

        $result = app(TransactionService::class)->claimGcash($this->commuter1, $transaction->qr_token);

        $this->assertSame(25.0, $result['amount']);
        $this->assertSame(25.0, $result['regular_amount']);
        $this->assertSame(0.0, $result['discount_amount']);
        $this->assertSame('REGULAR', $result['passenger_role']);
        $this->assertDatabaseHas('transactions', [
            'transaction_id' => $transaction->transaction_id,
            'passenger_role' => 'REGULAR',
            'final_amount' => 25,
            'discount_amount' => null,
        ]);
    }

    public function test_gcash_claim_is_idempotent_for_same_commuter(): void
    {
        $txn = $this->createPendingGcashTransaction();
        $svc = app(TransactionService::class);
        $svc->claimGcash($this->commuter1, $txn->qr_token);
        $result = $svc->claimGcash($this->commuter1, $txn->qr_token);
        $this->assertSame($txn->transaction_id, $result['transaction_id']);
    }

    public function test_gcash_claim_rejects_second_commuter_with_409(): void
    {
        $txn = $this->createPendingGcashTransaction();
        $svc = app(TransactionService::class);
        $svc->claimGcash($this->commuter1, $txn->qr_token);
        $this->assertAbort(409, fn () => $svc->claimGcash($this->commuter2, $txn->qr_token));
    }

    public function test_gcash_claim_returns_410_for_already_paid_transaction(): void
    {
        $txn = $this->createPendingGcashTransaction();
        app(PaymentService::class)->transitionTo($txn, PaymentStatus::PAID);
        $this->assertAbort(410, fn () => app(TransactionService::class)->claimGcash($this->commuter1, $txn->qr_token));
    }

    public function test_gcash_claim_returns_410_for_expired_transaction(): void
    {
        $txn = $this->createPendingGcashTransaction(['created_at' => now()->subMinutes(10)]);
        $this->assertAbort(410, fn () => app(TransactionService::class)->claimGcash($this->commuter1, $txn->qr_token));
    }

    public function test_gcash_claim_returns_404_for_missing_qr_token(): void
    {
        $this->assertAbort(404, fn () => app(TransactionService::class)->claimGcash($this->commuter1, 'nonexistent_token'));
    }

    public function test_conductor_cancel_invalidates_pending_transaction_and_scan_token(): void
    {
        $transaction = $this->createPendingGcashTransaction();
        $qrToken = $transaction->qr_token;
        Sanctum::actingAs($this->conductor);

        $this->postJson("/api/v1/payments/{$transaction->transaction_id}/cancel")
            ->assertOk()
            ->assertJsonPath('data.status', 'CANCELLED');

        $transaction->refresh();
        $this->assertSame(PaymentStatus::CANCELLED, $transaction->status);
        $this->assertNull($transaction->qr_token);
        $this->assertNull($transaction->payment_checkout_url);
        $this->assertAbort(404, fn () => app(TransactionService::class)->claimGcash($this->commuter1, $qrToken));
    }

    public function test_conductor_cancel_confirms_paymongo_cancellation_before_local_update(): void
    {
        $this->configurePayMongo();
        $transaction = $this->createPendingGcashTransaction();
        $statusAtProviderCall = null;
        Http::fake(function ($request) use ($transaction, &$statusAtProviderCall) {
            $statusAtProviderCall = $transaction->fresh()->status;

            return Http::response([
                'data' => [
                    'id' => $transaction->payment_reference,
                    'attributes' => ['status' => 'cancelled'],
                ],
            ]);
        });
        Sanctum::actingAs($this->conductor);

        $this->postJson("/api/v1/payments/{$transaction->transaction_id}/cancel")
            ->assertOk()
            ->assertJsonPath('data.status', 'CANCELLED');

        $this->assertSame(PaymentStatus::PENDING, $statusAtProviderCall);
        $this->assertSame(PaymentStatus::CANCELLED, $transaction->fresh()->status);
        Http::assertSent(fn ($request): bool => $request->method() === 'POST'
            && $request->url() === "https://api.paymongo.com/v1/payment_intents/{$transaction->payment_reference}/cancel");
    }

    public function test_provider_cancellation_failure_keeps_local_payment_pending(): void
    {
        $this->configurePayMongo();
        $transaction = $this->createPendingGcashTransaction();
        Http::fake(function ($request) use ($transaction) {
            if ($request->method() === 'POST') {
                return Http::response(['errors' => [['detail' => 'Payment cannot be cancelled']]], 500);
            }

            return Http::response([
                'data' => [
                    'id' => $transaction->payment_reference,
                    'attributes' => ['status' => 'awaiting_next_action'],
                ],
            ]);
        });
        Sanctum::actingAs($this->conductor);

        $this->postJson("/api/v1/payments/{$transaction->transaction_id}/cancel")
            ->assertStatus(502);

        $transaction->refresh();
        $this->assertSame(PaymentStatus::PENDING, $transaction->status);
        $this->assertNotNull($transaction->qr_token);
        $this->assertNotNull($transaction->payment_checkout_url);
    }

    public function test_conductor_cancel_invalidates_every_group_receipt(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 42,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
                ['type' => 'PWD', 'quantity' => 1, 'final_amount' => 12, 'base_fare' => 15, 'discount_amount' => 3],
            ],
        ]);
        $anchor = $result['transaction'];
        $qrToken = $anchor->qr_token;
        Sanctum::actingAs($this->conductor);

        $this->postJson("/api/v1/payments/{$anchor->transaction_id}/cancel")
            ->assertOk()
            ->assertJsonPath('data.status', 'CANCELLED');

        $receipts = Transaction::where('group_id', $anchor->group_id)->get();
        $this->assertCount(4, $receipts);
        $this->assertTrue($receipts->every(fn ($transaction) => $transaction->status === PaymentStatus::CANCELLED));
        $this->assertTrue($receipts->every(fn ($transaction) => $transaction->qr_token === null));
        $this->assertTrue($receipts->every(fn ($transaction) => $transaction->payment_checkout_url === null));
        $this->assertAbort(404, fn () => app(TransactionService::class)->claimGcash($this->commuter1, $qrToken));
    }

    // ─── 4. Webhook (provider-agnostic, idempotent, state-machine guarded) ──

    public function test_late_paid_webhook_flags_every_cancelled_group_receipt_for_refund(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();
        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 30,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
            ],
        ]);
        $anchor = $result['transaction'];
        app(TransactionService::class)->claimGcash($this->commuter1, $anchor->qr_token);
        Sanctum::actingAs($this->conductor);
        $this->postJson("/api/v1/payments/{$anchor->transaction_id}/cancel")->assertOk();
        $anchor->refresh();

        $this->configurePayMongo();
        [$payload, $headers] = $this->signedPaymongoWebhook(
            'payment.paid',
            $anchor->payment_reference,
            'evt_cancelled_group_paid_late'
        );
        $this->withHeaders($headers)->postJson('/api/v1/payments/webhook', $payload)->assertOk();

        $receipts = Transaction::where('group_id', $anchor->group_id)->get();
        $this->assertGreaterThan(1, $receipts->count());
        $this->assertTrue($receipts->every(
            fn (Transaction $transaction): bool => $transaction->status === PaymentStatus::PAID
                && $transaction->reward_eligible === false
                && $transaction->payment_reconciliation_status === 'REFUND_REQUIRED'
        ));
        $this->assertSame(0, $this->paidRideCountFor($this->commuter1->commuterProfile->id));
        $this->assertDatabaseHas('payment_events', ['event_id' => 'evt_cancelled_group_paid_late']);
    }

    public function test_webhook_with_valid_payment_paid_flips_to_paid_and_broadcasts(): void
    {
        Event::fake([PaymentStatusUpdated::class]);
        $this->configurePayMongo();
        $txn = $this->createPendingGcashTransaction();

        [$payload, $headers] = $this->signedPaymongoWebhook('payment.paid', $txn->payment_reference);
        $this->withHeaders($headers)->postJson('/api/v1/payments/webhook', $payload)->assertStatus(200);

        $txn->refresh();
        $this->assertSame(PaymentStatus::PAID, $txn->status);
        $this->assertNotNull($txn->paid_at);
        $this->assertDatabaseHas('payment_events', ['provider' => 'paymongo', 'transaction_id' => $txn->transaction_id]);

        Event::assertDispatched(PaymentStatusUpdated::class, fn ($e) => $e->transaction->transaction_id === $txn->transaction_id && $e->status === 'PAID');
    }

    public function test_webhook_with_invalid_signature_returns_400_and_no_state_change(): void
    {
        Event::fake([PaymentStatusUpdated::class]);
        $this->configurePayMongo();
        $txn = $this->createPendingGcashTransaction();

        $response = $this->postJson('/api/v1/payments/webhook', [
            'data' => ['id' => 'evt_x', 'attributes' => ['type' => 'payment.paid', 'data' => ['attributes' => ['payment_intent_id' => $txn->payment_reference]]]],
        ], ['Paymongo-Signature' => 't=12345,te=invalid,li=invalid']);

        $response->assertStatus(400);
        $txn->refresh();
        $this->assertSame(PaymentStatus::PENDING, $txn->status);
        Event::assertNotDispatched(PaymentStatusUpdated::class);
    }

    public function test_webhook_duplicate_event_is_idempotent(): void
    {
        Event::fake([PaymentStatusUpdated::class]);
        $this->configurePayMongo();
        Setting::create([
            'key' => Setting::RIDES_FOR_FREE_REWARD_KEY,
            'value' => '1',
            'category' => 'financial',
        ]);
        $txn = $this->createPendingGcashTransaction([
            'passenger_id' => $this->commuter1->commuterProfile->id,
            'payer_id' => $this->commuter1->commuterProfile->id,
            'reward_eligible' => true,
        ]);

        [$payload, $headers] = $this->signedPaymongoWebhook('payment.paid', $txn->payment_reference, 'evt_fixed_1');

        $this->withHeaders($headers)->postJson('/api/v1/payments/webhook', $payload)->assertStatus(200);
        $txn->refresh();
        $firstPaidAt = $txn->paid_at;

        // Replay the SAME event id → suppressed by payment_events unique key.
        $this->withHeaders($headers)->postJson('/api/v1/payments/webhook', $payload)->assertStatus(200);
        $txn->refresh();

        $this->assertSame(PaymentStatus::PAID, $txn->status);
        $this->assertSame($firstPaidAt->toIso8601String(), $txn->paid_at->toIso8601String());
        $this->assertSame(1, PaymentEvent::count());
        $this->assertSame(1, Voucher::where('commuter_id', $this->commuter1->commuterProfile->id)->count());
        Event::assertDispatchedTimes(PaymentStatusUpdated::class, 1);
    }

    public function test_webhook_different_event_ids_for_the_same_transaction_do_not_duplicate_the_transition(): void
    {
        Event::fake([PaymentStatusUpdated::class]);
        $this->configurePayMongo();
        $txn = $this->createPendingGcashTransaction();

        [$firstPayload, $firstHeaders] = $this->signedPaymongoWebhook(
            'payment.paid',
            $txn->payment_reference,
            'evt_paid_first'
        );
        [$secondPayload, $secondHeaders] = $this->signedPaymongoWebhook(
            'payment.paid',
            $txn->payment_reference,
            'evt_paid_second'
        );

        $this->withHeaders($firstHeaders)->postJson('/api/v1/payments/webhook', $firstPayload)->assertOk();
        $firstPaidAt = $txn->fresh()->paid_at;
        $this->withHeaders($secondHeaders)->postJson('/api/v1/payments/webhook', $secondPayload)->assertOk();

        $this->assertSame(PaymentStatus::PAID, $txn->fresh()->status);
        $this->assertSame($firstPaidAt->toIso8601String(), $txn->fresh()->paid_at->toIso8601String());
        $this->assertSame(2, PaymentEvent::where('transaction_id', $txn->transaction_id)->count());
        Event::assertDispatchedTimes(PaymentStatusUpdated::class, 1);
    }

    public function test_webhook_competing_paid_and_failed_events_preserve_the_first_terminal_state(): void
    {
        $this->configurePayMongo();

        $paidFirst = $this->createPendingGcashTransaction();
        [$paidPayload, $paidHeaders] = $this->signedPaymongoWebhook(
            'payment.paid',
            $paidFirst->payment_reference,
            'evt_competing_paid_first'
        );
        [$lateFailedPayload, $lateFailedHeaders] = $this->signedPaymongoWebhook(
            'payment.failed',
            $paidFirst->payment_reference,
            'evt_competing_failed_late'
        );

        $this->withHeaders($paidHeaders)->postJson('/api/v1/payments/webhook', $paidPayload)->assertOk();
        $this->withHeaders($lateFailedHeaders)->postJson('/api/v1/payments/webhook', $lateFailedPayload)->assertOk();
        $this->assertSame(PaymentStatus::PAID, $paidFirst->fresh()->status);

        $failedFirst = $this->createPendingGcashTransaction();
        [$failedPayload, $failedHeaders] = $this->signedPaymongoWebhook(
            'payment.failed',
            $failedFirst->payment_reference,
            'evt_competing_failed_first'
        );
        [$latePaidPayload, $latePaidHeaders] = $this->signedPaymongoWebhook(
            'payment.paid',
            $failedFirst->payment_reference,
            'evt_competing_paid_late'
        );

        $this->withHeaders($failedHeaders)->postJson('/api/v1/payments/webhook', $failedPayload)->assertOk();
        $this->withHeaders($latePaidHeaders)->postJson('/api/v1/payments/webhook', $latePaidPayload)->assertOk();
        $this->assertSame(PaymentStatus::FAILED, $failedFirst->fresh()->status);

        $this->assertSame(4, PaymentEvent::whereIn('transaction_id', [
            $paidFirst->transaction_id,
            $failedFirst->transaction_id,
        ])->count());
    }

    public function test_late_paid_webhook_after_local_cancellation_requires_refund_and_blocks_rewards(): void
    {
        Event::fake([PaymentStatusUpdated::class]);
        $this->configurePayMongo();
        $txn = $this->createPendingGcashTransaction([
            'status' => PaymentStatus::CANCELLED->value,
            'passenger_id' => $this->commuter1->commuterProfile->id,
            'reward_eligible' => true,
        ]);

        [$payload, $headers] = $this->signedPaymongoWebhook(
            'payment.paid',
            $txn->payment_reference,
            'evt_after_cancelled'
        );
        $this->withHeaders($headers)->postJson('/api/v1/payments/webhook', $payload)->assertOk();

        $txn->refresh();
        $this->assertSame(PaymentStatus::PAID, $txn->status);
        $this->assertNotNull($txn->paid_at);
        $this->assertFalse($txn->reward_eligible);
        $this->assertSame('REFUND_REQUIRED', $txn->payment_reconciliation_status);
        $this->assertSame(
            'Provider reported a successful payment after local cancellation.',
            $txn->payment_reconciliation_reason
        );
        $this->assertNotNull($txn->payment_reconciliation_required_at);
        $this->assertDatabaseHas('payment_events', [
            'event_id' => 'evt_after_cancelled',
            'transaction_id' => $txn->transaction_id,
            'status' => PaymentStatus::PAID->value,
        ]);
        $this->assertSame(0, $this->paidRideCountFor($this->commuter1->commuterProfile->id));
        Event::assertDispatched(PaymentStatusUpdated::class);

        Sanctum::actingAs($this->admin);
        $this->getJson('/api/v1/admin/transactions?per_page=10')
            ->assertOk()
            ->assertJsonPath('data.data.0.payment_reconciliation_status', 'REFUND_REQUIRED')
            ->assertJsonPath(
                'data.data.0.payment_reconciliation_reason',
                'Provider reported a successful payment after local cancellation.'
            );
    }

    public function test_webhook_returns_retryable_error_and_rolls_back_on_temporary_database_failure(): void
    {
        Event::fake([PaymentStatusUpdated::class]);
        $this->configurePayMongo();
        $txn = $this->createPendingGcashTransaction();
        [$payload, $headers] = $this->signedPaymongoWebhook(
            'payment.paid',
            $txn->payment_reference,
            'evt_temporary_database_failure'
        );

        DB::unprepared(<<<'SQL'
CREATE TRIGGER fail_payment_event_insert
BEFORE INSERT ON payment_events
BEGIN
    SELECT RAISE(ABORT, 'temporary database failure');
END
SQL);

        try {
            $this->withHeaders($headers)
                ->postJson('/api/v1/payments/webhook', $payload)
                ->assertStatus(503)
                ->assertJsonPath('error', 'Temporary payment processing failure');
        } finally {
            DB::unprepared('DROP TRIGGER IF EXISTS fail_payment_event_insert');
        }

        $this->assertSame(PaymentStatus::PENDING, $txn->fresh()->status);
        $this->assertDatabaseMissing('payment_events', ['event_id' => 'evt_temporary_database_failure']);
        Event::assertNotDispatched(PaymentStatusUpdated::class);
    }

    public function test_webhook_keeps_every_group_receipt_consistent_under_competing_events(): void
    {
        config(['payments.gateways.paymongo.secret' => null]);
        $this->forgetGateway();

        $result = app(TransactionService::class)->initiateGcashFare($this->conductor, [
            'final_amount' => 30,
            'pickup_name' => 'Calumpit',
            'dropoff_name' => 'Bustos',
            'group_passengers' => [
                ['type' => 'REGULAR', 'quantity' => 2, 'final_amount' => 15, 'base_fare' => 15, 'discount_amount' => 0],
            ],
        ]);
        $anchor = $result['transaction'];
        app(TransactionService::class)->claimGcash($this->commuter1, $anchor->qr_token);
        $anchor->refresh();

        $this->configurePayMongo();
        [$paidPayload, $paidHeaders] = $this->signedPaymongoWebhook(
            'payment.paid',
            $anchor->payment_reference,
            'evt_group_paid'
        );
        [$failedPayload, $failedHeaders] = $this->signedPaymongoWebhook(
            'payment.failed',
            $anchor->payment_reference,
            'evt_group_failed_late'
        );

        $this->withHeaders($paidHeaders)->postJson('/api/v1/payments/webhook', $paidPayload)->assertOk();
        $this->withHeaders($failedHeaders)->postJson('/api/v1/payments/webhook', $failedPayload)->assertOk();

        $receipts = Transaction::where('group_id', $anchor->group_id)->get();
        $this->assertGreaterThan(1, $receipts->count());
        $this->assertTrue($receipts->every(
            fn (Transaction $transaction): bool => $transaction->status === PaymentStatus::PAID
                && $transaction->paid_at !== null
        ));
        $this->assertSame($this->commuter1->commuterProfile->id, $anchor->fresh()->payer_id);
        $this->assertTrue($receipts->every(
            fn (Transaction $transaction): bool => $transaction->payer_name === 'Commuter One'
        ));
    }

    public function test_webhook_cannot_regress_a_paid_payment(): void
    {
        $this->configurePayMongo();
        $txn = $this->createPendingGcashTransaction();
        app(PaymentService::class)->transitionTo($txn, PaymentStatus::PAID);

        // A later "failed" event (distinct id) must NOT move PAID → FAILED.
        [$payload, $headers] = $this->signedPaymongoWebhook('payment.failed', $txn->payment_reference, 'evt_failed_1');
        $this->withHeaders($headers)->postJson('/api/v1/payments/webhook', $payload)->assertStatus(200);

        $txn->refresh();
        $this->assertSame(PaymentStatus::PAID, $txn->status);
    }

    // ─── 5. Dev simulation ──────────────────────────────────────────

    public function test_simulation_drives_pending_gcash_to_paid_when_enabled(): void
    {
        config(['payments.allow_simulation' => true]);
        $txn = $this->createPendingGcashTransaction();
        app(TransactionService::class)->claimGcash($this->commuter1, $txn->qr_token);

        $this->actingAs($this->commuter1, 'sanctum')
            ->postJson("/api/v1/payments/{$txn->transaction_id}/simulate", ['status' => 'PAID'])
            ->assertOk()
            ->assertJsonPath('data.status', 'PAID');

        $this->assertSame(PaymentStatus::PAID, $txn->fresh()->status);
    }

    public function test_simulation_is_forbidden_when_disabled(): void
    {
        config(['payments.allow_simulation' => false]);
        $txn = $this->createPendingGcashTransaction();
        app(TransactionService::class)->claimGcash($this->commuter1, $txn->qr_token);

        $this->actingAs($this->commuter1, 'sanctum')
            ->postJson("/api/v1/payments/{$txn->transaction_id}/simulate", ['status' => 'PAID'])
            ->assertStatus(403);
    }

    // ─── 6. Earnings split ──────────────────────────────────────────

    public function test_get_shift_earnings_returns_correct_cash_vs_gcash_split(): void
    {
        $svc = app(TransactionService::class);
        $svc->recordCashFare($this->conductor, ['final_amount' => 15.00, 'pickup_name' => 'A', 'dropoff_name' => 'B']);
        $svc->recordCashFare($this->conductor, ['final_amount' => 20.00, 'pickup_name' => 'C', 'dropoff_name' => 'D']);
        $svc->recordCashFare($this->conductor, ['final_amount' => 10.00, 'pickup_name' => 'E', 'dropoff_name' => 'F']);

        $this->createPendingGcashTransaction(['final_amount' => 25.00]); // PENDING → excluded
        $paidGcash = $this->createPendingGcashTransaction(['final_amount' => 30.00]);
        app(PaymentService::class)->transitionTo($paidGcash, PaymentStatus::PAID);

        $earnings = $svc->getShiftEarnings($this->conductor, $this->shift->shift_id);

        $this->assertSame(50.00, $earnings['cash_total']);
        $this->assertSame(30.00, $earnings['gcash_total']);
        $this->assertSame(80.00, $earnings['total']);
    }

    public function test_gcash_totals_are_not_included_in_remitted_cash_figure(): void
    {
        $svc = app(TransactionService::class);
        $svc->recordCashFare($this->conductor, ['final_amount' => 25.00, 'pickup_name' => 'A', 'dropoff_name' => 'B']);
        $svc->recordCashFare($this->conductor, ['final_amount' => 25.00, 'pickup_name' => 'C', 'dropoff_name' => 'D']);
        $paidGcash = $this->createPendingGcashTransaction(['final_amount' => 100.00]);
        app(PaymentService::class)->transitionTo($paidGcash, PaymentStatus::PAID);

        $earnings = $svc->getShiftEarnings($this->conductor, $this->shift->shift_id);

        $this->assertSame(35.00, $earnings['cash_total']);
        $this->assertSame(100.00, $earnings['gcash_total']);
        $this->assertNotSame($earnings['total'], $earnings['cash_total']);
    }

    // ─── 7. Authorization ───────────────────────────────────────────

    public function test_conductor_cannot_read_another_conductor_shift_transactions(): void
    {
        $svc = app(TransactionService::class);
        $svc->recordCashFare($this->conductor, ['final_amount' => 15.00, 'pickup_name' => 'Calumpit', 'dropoff_name' => 'Bustos']);
        $this->assertAbort(403, fn () => $svc->getShiftTransactions($this->conductor2, $this->shift->shift_id));
    }

    public function test_commuter_sees_only_their_own_payments(): void
    {
        $svc = app(TransactionService::class);
        $txn1 = $this->createPendingGcashTransaction();
        $svc->claimGcash($this->commuter1, $txn1->qr_token);
        $txn2 = $this->createPendingGcashTransaction();
        $svc->claimGcash($this->commuter2, $txn2->qr_token);

        $response = $this->actingAs($this->commuter1, 'sanctum')->getJson('/api/v1/commuter/payments');

        $response->assertOk();
        $response->assertJsonCount(1, 'data.data'); // paginated payload
        $response->assertJsonPath('data.data.0.transaction_id', $txn1->transaction_id);
    }

    public function test_old_payment_page_includes_exact_feedback_state_beyond_one_hundred_records(): void
    {
        $shiftRows = [];
        $transactionRows = [];
        $feedbackRows = [];
        $now = now();

        for ($index = 0; $index < 101; $index++) {
            $suffix = str_pad((string) $index, 3, '0', STR_PAD_LEFT);
            $shiftId = "SFT-FBH-{$suffix}";
            $createdAt = $now->copy()->subMinutes(101 - $index);

            $shiftRows[] = [
                'shift_id' => $shiftId,
                'conductor_id' => $this->shift->conductor_id,
                'conductor_name' => $this->shift->conductor_name,
                'driver_id' => $this->shift->driver_id,
                'driver_name' => $this->shift->driver_name,
                'vehicle_id' => $this->shift->vehicle_id,
                'unit_number' => $this->shift->unit_number,
                'plate_number' => $this->shift->plate_number,
                'route_id' => $this->shift->route_id,
                'time_in' => $createdAt,
                'time_out' => $createdAt->copy()->addHour(),
                'is_active' => false,
                'status' => 'ENDED',
                'created_at' => $createdAt,
                'updated_at' => $createdAt,
            ];
            $transactionRows[] = [
                'transaction_id' => "TXN-FBH-{$suffix}",
                'shift_id' => $shiftId,
                'payment_method' => PaymentMethod::GCASH->value,
                'status' => PaymentStatus::PAID->value,
                'final_amount' => 20,
                'passenger_id' => $this->commuter1->id,
                'pickup_name' => 'Pickup',
                'dropoff_name' => 'Dropoff',
                'reward_eligible' => true,
                'paid_at' => $createdAt,
                'created_at' => $createdAt,
                'updated_at' => $createdAt,
            ];
            $feedbackRows[] = [
                'id' => (string) Str::uuid(),
                'shift_id' => $shiftId,
                'vehicle_id' => $this->shift->vehicle_id,
                'driver_id' => $this->shift->driver_id,
                'conductor_id' => $this->shift->conductor_id,
                'commuter_id' => $this->commuter1->id,
                'rating' => 5,
                'conductor_rating' => 5,
                'created_at' => $createdAt,
                'updated_at' => $createdAt,
            ];
        }

        DB::table('shift_logs')->insert($shiftRows);
        DB::table('transactions')->insert($transactionRows);
        DB::table('feedback')->insert($feedbackRows);

        $this->actingAs($this->commuter1, 'sanctum')
            ->getJson('/api/v1/commuter/payments?page=6&per_page=20')
            ->assertOk()
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.transaction_id', 'TXN-FBH-000')
            ->assertJsonPath('data.data.0.feedback_exists', true)
            ->assertJsonPath('data.data.0.can_leave_feedback', false)
            ->assertJsonPath('data.data.0.feedback.shift_id', 'SFT-FBH-000');
    }

    // ─── 8. Schema audit ────────────────────────────────────────────

    public function test_no_wallet_table_exists(): void
    {
        $this->assertFalse(\Schema::hasTable('wallets'));
    }

    public function test_no_balance_column_on_transactions(): void
    {
        $this->assertFalse(\Schema::hasColumn('transactions', 'balance'));
    }

    public function test_no_balance_column_on_commuter_profiles(): void
    {
        $this->assertFalse(\Schema::hasColumn('commuter_profiles', 'balance'));
    }

    // ─── Helpers ────────────────────────────────────────────────────

    private function createPendingGcashTransaction(array $overrides = []): Transaction
    {
        $defaults = [
            'transaction_id' => 'TXN-GCASH-'.strtoupper(Str::random(10)),
            'shift_id' => $this->shift->shift_id,
            'payment_method' => PaymentMethod::GCASH->value,
            'status' => PaymentStatus::PENDING->value,
            'final_amount' => 25.00,
            'pickup_name' => 'Pulilan', 'dropoff_name' => 'Plaridel',
            'conductor_name' => 'Conductor One', 'unit_number' => 'TEST-001', 'driver_name' => 'Test Driver',
            'qr_token' => Str::random(32),
            'payment_provider' => 'paymongo',
            'payment_reference' => 'pi_test_'.Str::random(10),
            'payment_checkout_url' => 'https://test.checkout.url/'.Str::random(8),
            'paid_at' => null,
        ];

        $txn = Transaction::forceCreate(array_merge($defaults, $overrides));
        if (isset($overrides['created_at'])) {
            $txn->forceFill(['created_at' => $overrides['created_at']])->save();
            $txn->refresh();
        }

        return $txn;
    }

    private function createRewardVoucher(User $owner, array $overrides = []): Voucher
    {
        return Voucher::create(array_merge([
            'commuter_id' => $owner->commuterProfile->id,
            'code' => 'REWARD-'.strtoupper(Str::random(8)),
            'type' => 'REWARD',
            'status' => 'AVAILABLE',
            'amount' => 0,
            'expires_at' => now()->addDays(30),
            'ride_origin' => 'Test reward',
        ], $overrides));
    }

    /**
     * Configure the PayMongo gateway with test keys and re-bind the singleton.
     */
    private function configurePayMongo(): void
    {
        config([
            'payments.default' => 'paymongo',
            'payments.gateways.paymongo.secret' => 'sk_test_fake_key',
            'payments.gateways.paymongo.webhook_secret' => 'whsec_test_secret',
        ]);
        $this->forgetGateway();
    }

    private function forgetGateway(): void
    {
        $this->app->forgetInstance(PaymentGateway::class);
    }

    /**
     * Build a PayMongo webhook payload + matching signature header.
     *
     * @return array{0: array, 1: array<string,string>}
     */
    private function signedPaymongoWebhook(string $type, string $reference, ?string $eventId = null): array
    {
        $payload = [
            'data' => [
                'id' => $eventId ?? 'evt_'.Str::random(10),
                'attributes' => [
                    'type' => $type,
                    'data' => ['attributes' => ['payment_intent_id' => $reference]],
                ],
            ],
        ];
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES);
        $timestamp = time();
        $sig = hash_hmac('sha256', $timestamp.'.'.$body, 'whsec_test_secret');

        return [$payload, [
            'Paymongo-Signature' => "t={$timestamp},te={$sig},li={$sig}",
            'Content-Type' => 'application/json',
        ]];
    }

    /**
     * Assert that the given callback aborts with the expected HTTP status.
     */
    private function assertAbort(int $status, callable $callback): void
    {
        try {
            $callback();
            $this->fail("Expected HTTP {$status} abort, but none was thrown.");
        } catch (HttpException $e) {
            $this->assertSame($status, $e->getStatusCode());
        }
    }
}
