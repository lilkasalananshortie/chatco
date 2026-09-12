<?php

namespace Tests\Feature;

use App\Enums\PaymentMethod;
use App\Enums\PaymentStatus;
use App\Enums\ShiftStatus;
use App\Enums\UserRole;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\FarePoint;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class MobileWebTransactionIsolationTest extends TestCase
{
    use RefreshDatabase;

    private User $conductor;
    private Vehicle $vehicle;
    private Driver $driver;
    private Route $route;
    private ShiftLog $shift;
    private FarePoint $stop1;
    private FarePoint $stop2;

    protected function setUp(): void
    {
        parent::setUp();

        $this->conductor = User::create([
            'email' => 'conductor_test@example.com',
            'password' => bcrypt('password'),
            'role' => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id' => $this->conductor->id,
            'first_name' => 'Maria',
            'last_name' => 'Reyes',
            'birthday' => '1990-01-01',
            'contact_number' => '09171234567',
            'generated_username' => 'mreyes',
            'generated_password' => bcrypt('password'),
        ]);

        $this->vehicle = Vehicle::create([
            'unit_number' => '101',
            'plate_number' => 'ABC-1234',
            'status' => 'ACTIVE',
        ]);

        $this->driver = Driver::create([
            'first_name' => 'Pedro',
            'last_name' => 'Penduko',
            'birthday' => '1990-01-01',
            'contact' => '+639181234567',
            'license_number' => 'N01-12-123456',
            'hire_date' => '2023-01-01',
            'status' => 'ACTIVE',
        ]);

        $this->route = Route::create([
            'name' => 'Cubao - Antipolo',
            'origin' => 'Cubao',
            'destination' => 'Antipolo',
            'status' => 'ACTIVE',
            'is_active' => true,
            'waypoints' => [],
        ]);

        $this->stop1 = FarePoint::create([
            'route_id' => $this->route->id,
            'point_number' => 1,
            'code' => 'CUB',
            'name' => 'Cubao',
            'regular_fare' => 15,
            'discounted_fare' => 12,
        ]);

        $this->stop2 = FarePoint::create([
            'route_id' => $this->route->id,
            'point_number' => 2,
            'code' => 'ANT',
            'name' => 'Antipolo',
            'regular_fare' => 25,
            'discounted_fare' => 20,
        ]);

        $this->shift = ShiftLog::create([
            'shift_id' => 'SHF-TEST-PHASE2',
            'conductor_id' => $this->conductor->conductorProfile->id,
            'driver_id' => $this->driver->id,
            'vehicle_id' => $this->vehicle->id,
            'route_id' => $this->route->id,
            'conductor_name' => 'Maria Reyes',
            'driver_name' => 'Pedro Penduko',
            'unit_number' => '101',
            'plate_number' => 'ABC-1234',
            'status' => ShiftStatus::ACTIVE->value,
            'is_active' => true,
            'time_in' => now()->subHour(),
            'operating_device_id' => 'chatco_mobile_claimed_device_123',
            'operating_device_type' => 'MOBILE',
            'operating_device_claimed_at' => now()->subHour(),
        ]);
    }

    public function test_web_conductor_can_record_cash_fare_when_mobile_device_claimed_on_shift(): void
    {
        Sanctum::actingAs($this->conductor);

        // Web conductor hits /api/v1/conductor/transactions without mobile device ID
        $response = $this->postJson('/api/v1/conductor/transactions', [
            'payment_method' => 'CASH',
            'pickup_name' => 'Cubao',
            'dropoff_name' => 'Antipolo',
            'pickup_stop_id' => $this->stop1->id,
            'dropoff_stop_id' => $this->stop2->id,
            'final_amount' => 15.00,
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('data.payment_method', PaymentMethod::CASH->value)
            ->assertJsonPath('data.status', PaymentStatus::PAID->value);

        $this->assertDatabaseHas('transactions', [
            'shift_id' => $this->shift->shift_id,
            'payment_method' => PaymentMethod::CASH->value,
            'status' => PaymentStatus::PAID->value,
        ]);
    }

    public function test_mobile_conductor_can_record_cash_with_offline_metadata(): void
    {
        Sanctum::actingAs($this->conductor);

        $offlineTimestamp = now()->subMinutes(10)->toISOString();
        $response = $this->postJson('/api/v1/mobile/conductor/transactions', [
            'shift_id' => $this->shift->shift_id,
            'payment_method' => 'CASH',
            'pickup_name' => 'Cubao',
            'dropoff_name' => 'Antipolo',
            'pickup_stop_id' => $this->stop1->id,
            'dropoff_stop_id' => $this->stop2->id,
            'final_amount' => 15.00,
            'idempotency_key' => 'idemp-mobile-single-1',
            'device_id' => 'chatco_mobile_claimed_device_123',
            'device_type' => 'MOBILE',
            'offline_created_at' => $offlineTimestamp,
        ]);

        $response->assertStatus(201);
        $this->assertDatabaseHas('transactions', [
            'shift_id' => $this->shift->shift_id,
            'idempotency_key' => 'idemp-mobile-single-1',
            'source_device_id' => 'chatco_mobile_claimed_device_123',
        ]);
    }

    public function test_mobile_conductor_batch_sync_processes_queued_tickets(): void
    {
        Sanctum::actingAs($this->conductor);

        $offlineTime = now()->subMinutes(5)->toISOString();
        $batch = [
            'transactions' => [
                [
                    'shift_id' => $this->shift->shift_id,
                    'payment_method' => 'CASH',
                    'pickup_name' => 'Cubao',
                    'dropoff_name' => 'Antipolo',
                    'idempotency_key' => 'batch-item-1',
                    'device_id' => 'chatco_mobile_claimed_device_123',
                    'device_type' => 'MOBILE',
                    'offline_created_at' => $offlineTime,
                    'final_amount' => 15.00,
                ],
                [
                    'shift_id' => $this->shift->shift_id,
                    'payment_method' => 'CASH',
                    'pickup_name' => 'Cubao',
                    'dropoff_name' => 'Antipolo',
                    'idempotency_key' => 'batch-item-2',
                    'device_id' => 'chatco_mobile_claimed_device_123',
                    'device_type' => 'MOBILE',
                    'offline_created_at' => $offlineTime,
                    'final_amount' => 15.00,
                ],
            ],
        ];

        $response = $this->postJson('/api/v1/mobile/conductor/transactions/sync', $batch);

        $response->assertStatus(200)
            ->assertJsonPath('data.synced_count', 2)
            ->assertJsonPath('data.failed_count', 0);

        $this->assertDatabaseHas('transactions', ['idempotency_key' => 'batch-item-1']);
        $this->assertDatabaseHas('transactions', ['idempotency_key' => 'batch-item-2']);
    }

    public function test_mobile_batch_sync_is_idempotent(): void
    {
        Sanctum::actingAs($this->conductor);

        $offlineTime = now()->subMinutes(5)->toISOString();
        $batch = [
            'transactions' => [
                [
                    'shift_id' => $this->shift->shift_id,
                    'payment_method' => 'CASH',
                    'pickup_name' => 'Cubao',
                    'dropoff_name' => 'Antipolo',
                    'idempotency_key' => 'batch-idemp-1',
                    'device_id' => 'chatco_mobile_claimed_device_123',
                    'device_type' => 'MOBILE',
                    'offline_created_at' => $offlineTime,
                    'final_amount' => 15.00,
                ],
            ],
        ];

        // Send first time
        $res1 = $this->postJson('/api/v1/mobile/conductor/transactions/sync', $batch);
        $res1->assertStatus(200)->assertJsonPath('data.synced_count', 1);

        // Send second time (simulating network retry)
        $res2 = $this->postJson('/api/v1/mobile/conductor/transactions/sync', $batch);
        $res2->assertStatus(200)->assertJsonPath('data.synced_count', 1);

        // Verify only 1 row exists in database
        $this->assertEquals(1, Transaction::where('idempotency_key', 'batch-idemp-1')->count());
    }

    // =========================================================================
    // Phase 3 — Session & Device Lock Decoupling Tests
    // =========================================================================

    /**
     * A WEB login must not revoke an active MOBILE token, and vice versa.
     * Both platform tokens must remain valid simultaneously.
     */
    public function test_web_login_does_not_revoke_active_mobile_token(): void
    {
        // Conductor logs in on MOBILE first
        $mobileResponse = $this->postJson('/api/v1/auth/login', [
            'login'       => 'mreyes',
            'password'    => 'password',
            'device_id'   => 'mobile-11111111111111111',
            'device_type' => 'MOBILE',
        ])->assertOk();
        $mobileToken = $mobileResponse->json('data.token');

        // Conductor then logs in on WEB
        $webResponse = $this->postJson('/api/v1/auth/login', [
            'login'       => 'mreyes',
            'password'    => 'password',
            'device_id'   => 'web-2222222222222222222',
            'device_type' => 'WEB',
        ])->assertOk();
        $webToken = $webResponse->json('data.token');

        // Both tokens must be valid
        $this->withHeader('Authorization', "Bearer {$mobileToken}")
            ->getJson('/api/v1/user')
            ->assertOk();

        $this->withHeader('Authorization', "Bearer {$webToken}")
            ->getJson('/api/v1/user')
            ->assertOk();

        // Conductor holds exactly 2 tokens (one per platform)
        $this->assertSame(2, $this->conductor->tokens()->count());
    }

    /**
     * A MOBILE login must not revoke an active WEB token.
     */
    public function test_mobile_login_does_not_revoke_active_web_token(): void
    {
        // Conductor logs in on WEB first
        $webResponse = $this->postJson('/api/v1/auth/login', [
            'login'       => 'mreyes',
            'password'    => 'password',
            'device_id'   => 'web-aaaaaaaaaaaaaaaaaaa',
            'device_type' => 'WEB',
        ])->assertOk();
        $webToken = $webResponse->json('data.token');

        // Conductor then logs in on MOBILE
        $mobileResponse = $this->postJson('/api/v1/auth/login', [
            'login'       => 'mreyes',
            'password'    => 'password',
            'device_id'   => 'mobile-bbbbbbbbbbbbbbbbbbb',
            'device_type' => 'MOBILE',
        ])->assertOk();
        $mobileToken = $mobileResponse->json('data.token');

        // WEB token must still be valid — Phase 3 isolation
        $this->withHeader('Authorization', "Bearer {$webToken}")
            ->getJson('/api/v1/user')
            ->assertOk();

        // MOBILE token is also valid
        $this->withHeader('Authorization', "Bearer {$mobileToken}")
            ->getJson('/api/v1/user')
            ->assertOk();
    }

    /**
     * A second MOBILE login must revoke only the first MOBILE token
     * and must leave the WEB token completely untouched.
     */
    public function test_second_mobile_login_revokes_first_mobile_token_not_web_token(): void
    {
        // Login on WEB
        $webResponse = $this->postJson('/api/v1/auth/login', [
            'login'       => 'mreyes',
            'password'    => 'password',
            'device_id'   => 'web-cccccccccccccccccccc',
            'device_type' => 'WEB',
        ])->assertOk();
        $webToken = $webResponse->json('data.token');

        // Login on MOBILE (first device)
        $this->postJson('/api/v1/auth/login', [
            'login'       => 'mreyes',
            'password'    => 'password',
            'device_id'   => 'mobile-ddddddddddddddddddd',
            'device_type' => 'MOBILE',
        ])->assertOk();

        // Login on MOBILE (second device — should revoke first MOBILE token only)
        $mobile2Response = $this->postJson('/api/v1/auth/login', [
            'login'       => 'mreyes',
            'password'    => 'password',
            'device_id'   => 'mobile-eeeeeeeeeeeeeeeeeee',
            'device_type' => 'MOBILE',
        ])->assertOk();
        $mobileToken2 = $mobile2Response->json('data.token');

        // Exactly 2 tokens remain: auth-token:WEB + auth-token:MOBILE (second device)
        $this->assertSame(2, $this->conductor->tokens()->count());

        // WEB token still valid
        $this->withHeader('Authorization', "Bearer {$webToken}")
            ->getJson('/api/v1/user')
            ->assertOk();

        // Second MOBILE token valid
        $this->withHeader('Authorization', "Bearer {$mobileToken2}")
            ->getJson('/api/v1/user')
            ->assertOk();
    }
}
