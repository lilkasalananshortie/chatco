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
    // Shared conductor session and device ownership transfer tests
    // =========================================================================

    /** A WEB login revokes the previous MOBILE session. */
    public function test_web_login_revokes_active_mobile_session(): void
    {
        $mobileResponse = $this->postJson('/api/v1/auth/login', [
            'login' => 'mreyes', 'password' => 'password',
            'device_id' => 'mobile-11111111111111111', 'device_type' => 'MOBILE',
        ])->assertOk();
        $mobileToken = $mobileResponse->json('data.token');

        $webResponse = $this->postJson('/api/v1/auth/login', [
            'login' => 'mreyes', 'password' => 'password',
            'device_id' => 'web-2222222222222222222', 'device_type' => 'WEB',
        ])->assertOk();
        $webToken = $webResponse->json('data.token');

        $this->withHeader('Authorization', "Bearer {$mobileToken}")
            ->getJson('/api/v1/user')->assertUnauthorized();
        $this->withHeader('Authorization', "Bearer {$webToken}")
            ->getJson('/api/v1/user')->assertOk();
        $this->assertSame(1, $this->conductor->tokens()->count());
    }

    /** A MOBILE login revokes the previous WEB session. */
    public function test_mobile_login_revokes_active_web_session(): void
    {
        $webResponse = $this->postJson('/api/v1/auth/login', [
            'login' => 'mreyes', 'password' => 'password',
            'device_id' => 'web-aaaaaaaaaaaaaaaaaaa', 'device_type' => 'WEB',
        ])->assertOk();
        $webToken = $webResponse->json('data.token');

        $mobileResponse = $this->postJson('/api/v1/auth/login', [
            'login' => 'mreyes', 'password' => 'password',
            'device_id' => 'mobile-bbbbbbbbbbbbbbbbbbb', 'device_type' => 'MOBILE',
        ])->assertOk();
        $mobileToken = $mobileResponse->json('data.token');

        $this->withHeader('Authorization', "Bearer {$webToken}")
            ->getJson('/api/v1/user')->assertUnauthorized();
        $this->withHeader('Authorization', "Bearer {$mobileToken}")
            ->getJson('/api/v1/user')->assertOk();
        $this->assertSame(1, $this->conductor->tokens()->count());
    }

    /** Each later conductor login replaces the previous session on either platform. */
    public function test_second_mobile_login_revokes_all_prior_conductor_sessions(): void
    {
        $webResponse = $this->postJson('/api/v1/auth/login', [
            'login' => 'mreyes', 'password' => 'password',
            'device_id' => 'web-cccccccccccccccccccc', 'device_type' => 'WEB',
        ])->assertOk();
        $webToken = $webResponse->json('data.token');

        $mobile1Response = $this->postJson('/api/v1/auth/login', [
            'login' => 'mreyes', 'password' => 'password',
            'device_id' => 'mobile-ddddddddddddddddddd', 'device_type' => 'MOBILE',
        ])->assertOk();
        $mobileToken1 = $mobile1Response->json('data.token');

        $mobile2Response = $this->postJson('/api/v1/auth/login', [
            'login' => 'mreyes', 'password' => 'password',
            'device_id' => 'mobile-eeeeeeeeeeeeeeeeeee', 'device_type' => 'MOBILE',
        ])->assertOk();
        $mobileToken2 = $mobile2Response->json('data.token');

        $this->assertSame(1, $this->conductor->tokens()->count());
        $this->withHeader('Authorization', "Bearer {$webToken}")
            ->getJson('/api/v1/user')->assertUnauthorized();
        $this->withHeader('Authorization', "Bearer {$mobileToken1}")
            ->getJson('/api/v1/user')->assertUnauthorized();
        $this->withHeader('Authorization', "Bearer {$mobileToken2}")
            ->getJson('/api/v1/user')->assertOk();
    }
}
