<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\Driver;
use App\Models\FarePoint;
use App\Models\Hail;
use App\Models\PaymentGroup;
use App\Models\Remittance;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use App\Services\ShiftCloseoutService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class OfflineCashSafetyTest extends TestCase
{
    use RefreshDatabase;

    private const WEB_DEVICE = 'web-device-aaaaaaaa';

    private const MOBILE_DEVICE = 'mobile-device-bbbbbbbb';

    private User $conductor;

    private Vehicle $vehicle;

    private Driver $driver;

    private Route $route;

    private FarePoint $pickup;

    private FarePoint $dropoff;

    protected function setUp(): void
    {
        parent::setUp();

        $this->conductor = User::factory()->conductor()->create();
        $this->driver = Driver::factory()->create(['status' => 'ACTIVE']);
        $this->route = Route::factory()->create(['status' => 'ACTIVE']);
        $this->pickup = FarePoint::create([
            'route_id' => $this->route->id,
            'point_number' => 1,
            'code' => 'OFF-A',
            'name' => 'Offline A',
            'sub_stops' => [],
            'regular_fare' => 0,
            'discounted_fare' => 0,
        ]);
        $this->dropoff = FarePoint::create([
            'route_id' => $this->route->id,
            'point_number' => 2,
            'code' => 'OFF-B',
            'name' => 'Offline B',
            'sub_stops' => [],
            'regular_fare' => 15,
            'discounted_fare' => 12,
        ]);
        $this->vehicle = Vehicle::factory()->create([
            'status' => 'ACTIVE',
            'route_id' => $this->route->id,
            'driver_id' => $this->driver->id,
            'conductor_id' => $this->conductor->conductorProfile->id,
            'assignment_date' => now('Asia/Manila')->toDateString(),
            'assignment_approved_at' => now(),
        ]);
    }

    public function test_starting_shift_claims_device_and_other_device_cannot_record_cash(): void
    {
        $shift = $this->startShift();

        $this->assertSame(self::WEB_DEVICE, $shift->operating_device_id);
        $this->assertSame('WEB', $shift->operating_device_type);

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $this->cashPayload(self::MOBILE_DEVICE))
            ->assertStatus(409);

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $this->cashPayload(self::WEB_DEVICE))
            ->assertCreated();

        $this->assertDatabaseCount('transactions', 1);
        $this->assertSame(self::WEB_DEVICE, Transaction::first()->source_device_id);
    }

    public function test_shift_can_only_be_handed_off_after_current_device_releases_it(): void
    {
        $shift = $this->startShift();

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/claim', $this->devicePayload($shift, self::MOBILE_DEVICE, 'MOBILE'))
            ->assertStatus(409);
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/release', $this->devicePayload($shift, self::MOBILE_DEVICE, 'MOBILE'))
            ->assertStatus(409);

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/release', $this->devicePayload($shift, self::WEB_DEVICE, 'WEB'))
            ->assertOk()
            ->assertJsonPath('data.operating_device_id', null);
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/claim', $this->devicePayload($shift, self::MOBILE_DEVICE, 'MOBILE'))
            ->assertOk()
            ->assertJsonPath('data.operating_device_id', self::MOBILE_DEVICE);

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $this->cashPayload(self::WEB_DEVICE))
            ->assertStatus(409);
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $this->cashPayload(self::MOBILE_DEVICE))
            ->assertCreated();
    }

    public function test_admin_can_auditably_recover_a_lost_device_and_only_a_new_device_can_claim(): void
    {
        $shift = $this->startShift();
        $admin = User::factory()->create(['role' => UserRole::ADMIN]);
        $offlineCash = $this->cashPayload(self::WEB_DEVICE, 'admin-visible-offline-cash');
        $offlineCash['offline_created_at'] = now()->toIso8601String();
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $offlineCash)
            ->assertCreated();

        $this->actingAs($admin)
            ->postJson("/api/v1/admin/shifts/{$shift->shift_id}/device/recover", [
                'reason' => 'The conductor reported that the operating phone was lost.',
                'acknowledge_unsynced_cash_risk' => true,
            ])
            ->assertOk()
            ->assertJsonPath('data.shift.operating_device_id', null)
            ->assertJsonPath('data.recovery.previous_device_type', 'WEB');

        $this->assertDatabaseHas('shift_device_recoveries', [
            'shift_id' => $shift->shift_id,
            'recovered_by' => $admin->id,
            'previous_device_id' => self::WEB_DEVICE,
        ]);

        $this->actingAs($admin)
            ->getJson("/api/v1/admin/shift-logs?vehicle_id={$this->vehicle->id}")
            ->assertOk()
            ->assertJsonPath('data.data.0.synced_offline_cash_count', 1)
            ->assertJsonPath('data.data.0.latest_device_recovery.shift_id', $shift->shift_id);

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/claim', $this->devicePayload($shift, self::WEB_DEVICE, 'WEB'))
            ->assertStatus(409);

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/claim', $this->devicePayload($shift, self::MOBILE_DEVICE, 'MOBILE'))
            ->assertOk()
            ->assertJsonPath('data.operating_device_id', self::MOBILE_DEVICE);

        $this->actingAs($this->conductor)
            ->getJson('/api/v1/conductor/shift')
            ->assertOk()
            ->assertJsonPath('data.latest_device_recovery.shift_id', $shift->shift_id);
    }

    public function test_device_recovery_requires_admin_reason_and_risk_acknowledgement(): void
    {
        $shift = $this->startShift();
        $admin = User::factory()->create(['role' => UserRole::ADMIN]);

        $this->actingAs($admin)
            ->postJson("/api/v1/admin/shifts/{$shift->shift_id}/device/recover", [
                'reason' => 'Lost',
                'acknowledge_unsynced_cash_risk' => false,
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['reason', 'acknowledge_unsynced_cash_risk']);

        $this->assertDatabaseCount('shift_device_recoveries', 0);
        $this->assertSame(self::WEB_DEVICE, $shift->fresh()->operating_device_id);
    }

    public function test_non_admin_cannot_recover_device_and_repeated_recovery_is_rejected(): void
    {
        $shift = $this->startShift();

        $this->actingAs($this->conductor)
            ->postJson("/api/v1/admin/shifts/{$shift->shift_id}/device/recover", [
                'reason' => 'Attempted recovery by a non-admin account.',
                'acknowledge_unsynced_cash_risk' => true,
            ])
            ->assertStatus(403);

        $admin = User::factory()->create(['role' => UserRole::ADMIN]);
        $payload = [
            'reason' => 'The assigned operating device is permanently unavailable.',
            'acknowledge_unsynced_cash_risk' => true,
        ];
        $this->actingAs($admin)
            ->postJson("/api/v1/admin/shifts/{$shift->shift_id}/device/recover", $payload)
            ->assertOk();
        $this->actingAs($admin)
            ->postJson("/api/v1/admin/shifts/{$shift->shift_id}/device/recover", $payload)
            ->assertStatus(409);

        $this->assertDatabaseCount('shift_device_recoveries', 1);
    }

    public function test_only_operating_device_can_remit_and_end_shift(): void
    {
        $shift = $this->startShift();
        $this->recordOnlineCash(self::WEB_DEVICE);

        $payload = [
            'shift_id' => $shift->shift_id,
            'total_collected' => 15,
            'remitted_amount' => 15,
            'device_id' => self::MOBILE_DEVICE,
            'device_type' => 'MOBILE',
        ];
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/remittances', $payload)
            ->assertStatus(409);
        $this->assertTrue($shift->fresh()->is_active);

        $payload['device_id'] = self::WEB_DEVICE;
        $payload['device_type'] = 'WEB';
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/remittances', $payload)
            ->assertOk();
        $this->assertFalse($shift->fresh()->is_active);
    }

    public function test_other_device_cannot_initiate_gcash(): void
    {
        $this->startShift();

        $this->actingAs($this->conductor)->postJson('/api/v1/conductor/payments/gcash/initiate', [
            'payment_method' => 'GCASH',
            'pickup_name' => $this->pickup->name,
            'dropoff_name' => $this->dropoff->name,
            'pickup_stop_id' => $this->pickup->id,
            'dropoff_stop_id' => $this->dropoff->id,
            'device_id' => self::MOBILE_DEVICE,
            'device_type' => 'MOBILE',
        ])->assertStatus(409);

        $this->assertDatabaseCount('transactions', 0);
    }

    public function test_only_operating_device_can_change_shared_shift_operations(): void
    {
        $shift = $this->startShift();
        $otherDevice = [
            'device_id' => self::MOBILE_DEVICE,
            'device_type' => 'MOBILE',
        ];

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/break-status', ['is_on_break' => true] + $otherDevice)
            ->assertStatus(409);
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/capacity-status', ['capacity_status' => 'FULL'] + $otherDevice)
            ->assertStatus(409);
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
                'fix_timestamp' => now()->toIso8601String(),
            ] + $otherDevice)
            ->assertStatus(409);
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/break-status', ['is_on_break' => true])
            ->assertStatus(409);

        $commuter = User::factory()->commuter()->create();
        $hail = Hail::create([
            'commuter_id' => $commuter->id,
            'vehicle_id' => $this->vehicle->id,
            'commuter_lat' => 14.5995,
            'commuter_lng' => 120.9842,
            'distance_m' => 50,
            'status' => 'PENDING',
            'expires_at' => now()->addMinutes(3),
        ]);
        $this->actingAs($this->conductor)
            ->postJson("/api/v1/conductor/hails/{$hail->id}/accept", $otherDevice)
            ->assertStatus(409);

        $ownerDevice = [
            'device_id' => self::WEB_DEVICE,
            'device_type' => 'WEB',
        ];
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/break-status', ['is_on_break' => true] + $ownerDevice)
            ->assertOk();
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/capacity-status', ['capacity_status' => 'STANDING'] + $ownerDevice)
            ->assertOk();
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', [
                'lat' => 14.5995,
                'lng' => 120.9842,
                'fix_timestamp' => now()->toIso8601String(),
            ] + $ownerDevice)
            ->assertOk();
        $this->actingAs($this->conductor)
            ->postJson("/api/v1/conductor/hails/{$hail->id}/accept", $ownerDevice)
            ->assertOk()
            ->assertJsonPath('data.status', 'ACCEPTED');

        $this->assertTrue($shift->fresh()->is_on_break);
        $this->assertDatabaseHas('vehicle_locations', [
            'vehicle_id' => $this->vehicle->id,
            'shift_id' => $shift->shift_id,
            'capacity_status' => 'STANDING',
        ]);
    }

    public function test_offline_cash_recovers_into_auto_ended_shift_and_updates_pending_remittance(): void
    {
        $shift = $this->startShift();
        $this->recordOnlineCash(self::WEB_DEVICE);
        $offlineOccurredAt = now()->toIso8601String();

        app(ShiftCloseoutService::class)->close(
            $shift->shift_id,
            null,
            ShiftCloseoutService::REASON_STALE,
            $this->conductor->conductorProfile->id,
        );
        $this->assertSame(Remittance::STATUS_PENDING, $shift->fresh()->remittance->remittance_status);

        $payload = $this->cashPayload(self::WEB_DEVICE, 'offline-recovery-key');
        $payload['offline_created_at'] = $offlineOccurredAt;
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $payload)
            ->assertCreated();

        $remittance = $shift->fresh()->remittance;
        $this->assertSame(30.0, (float) $remittance->cash_total);
        $this->assertSame(30.0, (float) $remittance->total_collected);
        $this->assertSame(30.0, (float) $remittance->shortage);
        $this->assertSame(2, $remittance->total_passengers);
        $this->assertNotNull(Transaction::where('idempotency_key', 'offline-recovery-key')->first()->synced_at);
    }

    public function test_offline_recovery_is_idempotent(): void
    {
        $shift = $this->startShift();
        $this->recordOnlineCash(self::WEB_DEVICE);
        $offlineOccurredAt = now()->toIso8601String();
        app(ShiftCloseoutService::class)->close(
            $shift->shift_id,
            null,
            ShiftCloseoutService::REASON_STALE,
            $this->conductor->conductorProfile->id,
        );

        $payload = $this->cashPayload(self::WEB_DEVICE, 'same-offline-retry-key');
        $payload['offline_created_at'] = $offlineOccurredAt;
        $this->actingAs($this->conductor)->postJson('/api/v1/conductor/transactions', $payload)->assertCreated();
        $this->actingAs($this->conductor)->postJson('/api/v1/conductor/transactions', $payload)->assertCreated();

        $this->assertSame(1, Transaction::where('idempotency_key', 'same-offline-retry-key')->count());
        $this->assertSame(30.0, (float) $shift->fresh()->remittance->cash_total);
    }

    public function test_grouped_offline_cash_recovers_each_passenger_once(): void
    {
        $shift = $this->startShift();
        $this->recordOnlineCash(self::WEB_DEVICE);
        $offlineOccurredAt = now()->toIso8601String();
        app(ShiftCloseoutService::class)->close(
            $shift->shift_id,
            null,
            ShiftCloseoutService::REASON_STALE,
            $this->conductor->conductorProfile->id,
        );

        $payload = $this->cashPayload(self::WEB_DEVICE, 'offline-group-key');
        $payload['offline_created_at'] = $offlineOccurredAt;
        $payload['group_passengers'] = [
            ['type' => 'REGULAR', 'quantity' => 1],
            ['type' => 'STUDENT', 'quantity' => 1],
        ];
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $payload)
            ->assertCreated();
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $payload)
            ->assertCreated();

        $remittance = $shift->fresh()->remittance;
        $this->assertSame(42.0, (float) $remittance->cash_total);
        $this->assertSame(3, $remittance->total_passengers);
        $this->assertSame(1, PaymentGroup::where('idempotency_key', 'offline-group-key')->count());
    }

    public function test_offline_timestamp_outside_original_shift_is_rejected(): void
    {
        $shift = $this->startShift();
        $this->recordOnlineCash(self::WEB_DEVICE);
        app(ShiftCloseoutService::class)->close(
            $shift->shift_id,
            null,
            ShiftCloseoutService::REASON_STALE,
            $this->conductor->conductorProfile->id,
        );

        $payload = $this->cashPayload(self::WEB_DEVICE, 'outside-shift-key');
        $payload['offline_created_at'] = $shift->time_in->copy()->subHour()->toIso8601String();
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $payload)
            ->assertStatus(422);
        $this->assertDatabaseMissing('transactions', ['idempotency_key' => 'outside-shift-key']);
    }

    public function test_offline_cash_cannot_change_a_completed_remittance(): void
    {
        $shift = $this->startShift();
        $this->recordOnlineCash(self::WEB_DEVICE);
        $offlineOccurredAt = now()->toIso8601String();

        // Cash declaration now happens on the admin side: the conductor's
        // submission always leaves the remittance PENDING (see
        // ShiftService::endShiftViaRemittance), and only
        // ShiftCloseoutService::recordCashDeclaration() — the admin's cash
        // count — resolves it to COMPLETE. That resolution is what this test
        // actually protects against a late offline replay overwriting.
        $this->actingAs($this->conductor)->postJson('/api/v1/conductor/remittances', [
            'shift_id' => $shift->shift_id,
            'total_collected' => 15,
            'device_id' => self::WEB_DEVICE,
            'device_type' => 'WEB',
        ])->assertOk();
        app(ShiftCloseoutService::class)->recordCashDeclaration($shift->shift_id, 15);

        $payload = $this->cashPayload(self::WEB_DEVICE, 'too-late-offline-key');
        $payload['offline_created_at'] = $offlineOccurredAt;
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $payload)
            ->assertStatus(409);

        $this->assertSame(15.0, (float) $shift->fresh()->remittance->cash_total);
        $this->assertDatabaseMissing('transactions', ['idempotency_key' => 'too-late-offline-key']);
    }

    public function test_mobile_conductor_transactions_route_records_cash_successfully(): void
    {
        $shift = $this->startShift();
        // Hand off shift to mobile device
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/release', $this->devicePayload($shift, self::WEB_DEVICE, 'WEB'))
            ->assertOk();
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/claim', $this->devicePayload($shift, self::MOBILE_DEVICE, 'MOBILE'))
            ->assertOk();

        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/mobile/conductor/transactions', $this->cashPayload(self::MOBILE_DEVICE, 'mobile-direct-cash-1'))
            ->assertCreated();

        $this->assertSame('Cash fare recorded', $response->json('message'));
        $this->assertDatabaseHas('transactions', [
            'idempotency_key' => 'mobile-direct-cash-1',
            'source_device_id' => self::MOBILE_DEVICE,
        ]);
    }

    public function test_mobile_conductor_transactions_route_supports_offline_queue_sync(): void
    {
        $shift = $this->startShift();
        // Hand off shift to mobile device
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/release', $this->devicePayload($shift, self::WEB_DEVICE, 'WEB'))
            ->assertOk();
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/shifts/device/claim', $this->devicePayload($shift, self::MOBILE_DEVICE, 'MOBILE'))
            ->assertOk();

        $offlinePayload = $this->cashPayload(self::MOBILE_DEVICE, 'mobile-offline-queue-1');
        $offlinePayload['offline_created_at'] = now()->subMinutes(2)->toIso8601String();

        $this->actingAs($this->conductor)
            ->postJson('/api/v1/mobile/conductor/transactions', $offlinePayload)
            ->assertCreated();

        $this->assertDatabaseHas('transactions', [
            'idempotency_key' => 'mobile-offline-queue-1',
            'source_device_id' => self::MOBILE_DEVICE,
        ]);
        $this->assertNotNull(Transaction::where('idempotency_key', 'mobile-offline-queue-1')->value('synced_at'));
    }

    private function startShift(): ShiftLog
    {
        $this->actingAs($this->conductor)->postJson('/api/v1/conductor/shifts/start', [
            'vehicle_id' => $this->vehicle->id,
            'driver_id' => $this->driver->id,
            'route_id' => $this->route->id,
            'device_id' => self::WEB_DEVICE,
            'device_type' => 'WEB',
        ])->assertCreated();

        return ShiftLog::where('conductor_id', $this->conductor->conductorProfile->id)->firstOrFail();
    }

    private function recordOnlineCash(string $deviceId): void
    {
        $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/transactions', $this->cashPayload($deviceId))
            ->assertCreated();
    }

    private function cashPayload(string $deviceId, ?string $idempotencyKey = null): array
    {
        return [
            'shift_id' => ShiftLog::where('conductor_id', $this->conductor->conductorProfile->id)
                ->latest('created_at')
                ->value('shift_id'),
            'payment_method' => 'CASH',
            'pickup_name' => $this->pickup->name,
            'dropoff_name' => $this->dropoff->name,
            'pickup_stop_id' => $this->pickup->id,
            'dropoff_stop_id' => $this->dropoff->id,
            'passenger_role' => 'REGULAR',
            'idempotency_key' => $idempotencyKey ?? 'cash-'.fake()->uuid(),
            'device_id' => $deviceId,
            'device_type' => str_starts_with($deviceId, 'web-') ? 'WEB' : 'MOBILE',
        ];
    }

    private function devicePayload(ShiftLog $shift, string $deviceId, string $deviceType): array
    {
        return [
            'shift_id' => $shift->shift_id,
            'device_id' => $deviceId,
            'device_type' => $deviceType,
        ];
    }
}
