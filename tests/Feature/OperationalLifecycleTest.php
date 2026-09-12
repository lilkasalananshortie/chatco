<?php

namespace Tests\Feature;

use App\Enums\HailStatus;
use App\Enums\PaymentMethod;
use App\Enums\PaymentStatus;
use App\Enums\ShiftStatus;
use App\Models\Announcement;
use App\Models\Driver;
use App\Models\Hail;
use App\Models\OverspeedEvent;
use App\Models\PaymentGroup;
use App\Models\Remittance;
use App\Models\Route;
use App\Models\Setting;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use App\Models\VehicleLocation;
use App\Services\LocationService;
use App\Services\ShiftCloseoutService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Tests\TestCase;

class OperationalLifecycleTest extends TestCase
{
    use RefreshDatabase;

    public function test_conductor_can_start_shift_from_unassigned_available_vehicle_and_driver(): void
    {
        $conductor = User::factory()->conductor()->create();
        $driver = Driver::factory()->create();
        $route = Route::factory()->create();
        $vehicle = Vehicle::factory()->create(['route_id' => $route->id]);

        $this->actingAs($conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $vehicle->id,
                'driver_id' => $driver->id,
                'route_id' => $route->id,
            ])
            ->assertCreated();

        $vehicle->refresh();
        $this->assertSame($conductor->id, $vehicle->conductor_id);
        $this->assertSame($driver->id, $vehicle->driver_id);
        $this->assertSame(now('Asia/Manila')->toDateString(), $vehicle->assignment_date->toDateString());
        $this->assertNotNull($vehicle->assignment_approved_at);
    }

    public function test_starting_a_shift_notifies_every_admin(): void
    {
        $admin = User::factory()->create(['role' => 'ADMIN']);
        $otherAdmin = User::factory()->create(['role' => 'ADMIN']);
        $conductor = User::factory()->conductor()->create();
        $driver = Driver::factory()->create();
        $route = Route::factory()->create();
        $vehicle = Vehicle::factory()->create(['route_id' => $route->id]);

        $this->actingAs($conductor)
            ->postJson('/api/v1/conductor/shifts/start', [
                'vehicle_id' => $vehicle->id,
                'driver_id' => $driver->id,
                'route_id' => $route->id,
            ])
            ->assertCreated();

        foreach ([$admin, $otherAdmin] as $recipient) {
            $notification = Announcement::where('type', 'SHIFT_STARTED')
                ->where('user_id', $recipient->id)
                ->first();
            $this->assertNotNull($notification, "Admin {$recipient->id} was not notified.");
            $this->assertStringContainsString($vehicle->unit_number, $notification->message);
            // reference_id names the vehicle so the admin bell can deep-link
            // straight to its Vehicle Details modal on Fleet Management.
            $this->assertSame($vehicle->id, $notification->reference_id);
        }
        // Never broadcast to everyone — only the two admin accounts above.
        $this->assertSame(2, Announcement::where('type', 'SHIFT_STARTED')->count());
    }

    public function test_conductor_cannot_start_shift_with_vehicle_assigned_to_another_conductor(): void
    {
        $conductor = User::factory()->conductor()->create();
        $otherConductor = User::factory()->conductor()->create();
        $driver = Driver::factory()->create();
        $route = Route::factory()->create();
        $vehicle = Vehicle::factory()->create([
            'route_id' => $route->id,
            'conductor_id' => $otherConductor->id,
            'assignment_date' => now('Asia/Manila')->toDateString(),
            'assignment_approved_at' => now(),
        ]);

        $this->actingAs($conductor)->postJson('/api/v1/conductor/shifts/start', [
            'vehicle_id' => $vehicle->id,
            'driver_id' => $driver->id,
            'route_id' => $route->id,
        ])->assertForbidden();
    }

    public function test_conductor_unit_and_driver_lists_include_unassigned_available_resources(): void
    {
        $conductor = User::factory()->conductor()->create();
        $otherConductor = User::factory()->conductor()->create();
        $route = Route::factory()->create();
        $availableVehicle = Vehicle::factory()->create(['route_id' => $route->id]);
        $availableDriver = Driver::factory()->create();
        $otherDriver = Driver::factory()->create();
        $otherVehicle = Vehicle::factory()->create([
            'route_id' => $route->id,
            'driver_id' => $otherDriver->id,
            'conductor_id' => $otherConductor->id,
            'assignment_date' => now('Asia/Manila')->toDateString(),
            'assignment_approved_at' => now(),
        ]);

        $this->actingAs($conductor)
            ->getJson('/api/v1/conductor/units')
            ->assertOk()
            ->assertJsonFragment(['id' => $availableVehicle->id])
            ->assertJsonMissing(['id' => $otherVehicle->id]);

        $this->actingAs($conductor)
            ->getJson('/api/v1/conductor/drivers')
            ->assertOk()
            ->assertJsonFragment(['id' => $availableDriver->id])
            ->assertJsonMissing(['id' => $otherDriver->id]);
    }

    public function test_remitted_vehicle_and_driver_return_to_available_conductor_lists(): void
    {
        [$conductor, $driver, $vehicle, , $shift] = $this->activeShift();

        app(ShiftCloseoutService::class)->close(
            $shift->shift_id,
            0,
            ShiftCloseoutService::REASON_MANUAL,
            $conductor->id,
        );

        $this->actingAs($conductor)
            ->getJson('/api/v1/conductor/units')
            ->assertOk()
            ->assertJsonFragment(['id' => $vehicle->id]);

        $this->actingAs($conductor)
            ->getJson('/api/v1/conductor/drivers')
            ->assertOk()
            ->assertJsonFragment(['id' => $driver->id]);
    }

    public function test_admin_remittances_include_active_shift_as_pending_with_live_totals(): void
    {
        $admin = User::factory()->admin()->create();
        [, , , , $shift] = $this->activeShift();

        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 45.0, ['total_passengers' => 2]);
        $this->fare($shift, PaymentMethod::GCASH, PaymentStatus::PAID, 80.0, ['total_passengers' => 1]);
        $this->fare($shift, PaymentMethod::GCASH, PaymentStatus::PENDING, 120.0, ['total_passengers' => 1]);

        $response = $this->actingAs($admin)
            ->getJson('/api/v1/admin/remittances?date='.now()->toDateString());

        $response->assertOk();
        $row = collect($response->json('data.data'))
            ->firstWhere('shift_id', $shift->shift_id);

        $this->assertNotNull($row);
        $this->assertSame(Remittance::STATUS_PENDING, $row['remittance_status']);
        $this->assertSame('45', (string) $row['cash_total']);
        $this->assertSame('80', (string) $row['gcash_total']);
        $this->assertSame(3, $row['total_passengers']);
    }

    public function test_conductor_remittance_submission_always_leaves_cash_pending_for_admin(): void
    {
        [$conductor, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 100);

        $this->actingAs($conductor)
            ->postJson("/api/v1/conductor/remittances", [
                'shift_id' => $shift->shift_id,
                'total_collected' => 100,
            ])
            ->assertOk();

        $remittance = Remittance::findOrFail($shift->shift_id);
        $this->assertSame(Remittance::STATUS_PENDING, $remittance->remittance_status);
        $this->assertSame('0.00', $remittance->remitted_amount);
    }

    public function test_admin_can_declare_cash_and_resolve_a_pending_remittance(): void
    {
        $admin = User::factory()->admin()->create();
        [$conductor, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 100);
        app(ShiftCloseoutService::class)->close($shift->shift_id, null, ShiftCloseoutService::REASON_MANUAL, $conductor->id);
        $this->assertSame(Remittance::STATUS_PENDING, Remittance::findOrFail($shift->shift_id)->remittance_status);

        $this->actingAs($admin)
            ->postJson("/api/v1/admin/remittances/{$shift->shift_id}/cash-declaration", ['cash_declared' => 75])
            ->assertOk()
            ->assertJsonPath('data.remittance_status', Remittance::STATUS_SHORTAGE);

        $remittance = Remittance::findOrFail($shift->shift_id);
        $this->assertSame(Remittance::STATUS_SHORTAGE, $remittance->remittance_status);
        $this->assertSame('75.00', $remittance->remitted_amount);
        $this->assertSame('25.00', $remittance->shortage);
        $this->assertNotNull($remittance->remitted_at);
    }

    public function test_admin_cannot_declare_cash_twice_for_the_same_remittance(): void
    {
        $admin = User::factory()->admin()->create();
        [$conductor, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 100);
        app(ShiftCloseoutService::class)->close($shift->shift_id, null, ShiftCloseoutService::REASON_MANUAL, $conductor->id);

        $this->actingAs($admin)
            ->postJson("/api/v1/admin/remittances/{$shift->shift_id}/cash-declaration", ['cash_declared' => 100])
            ->assertOk();

        $this->actingAs($admin)
            ->postJson("/api/v1/admin/remittances/{$shift->shift_id}/cash-declaration", ['cash_declared' => 100])
            ->assertStatus(409);
    }

    public function test_cash_declaration_endpoint_requires_admin_role(): void
    {
        $conductor = User::factory()->conductor()->create();
        [, , , , $shift] = $this->activeShift();

        $this->actingAs($conductor)
            ->postJson("/api/v1/admin/remittances/{$shift->shift_id}/cash-declaration", ['cash_declared' => 50])
            ->assertStatus(403);
    }

    public function test_manual_closeout_calculates_exact_shortage_and_overage_from_authoritative_cash(): void
    {
        foreach ([
            [100.0, Remittance::STATUS_COMPLETE, 0.0, 0.0],
            [75.0, Remittance::STATUS_SHORTAGE, 25.0, 0.0],
            [125.0, Remittance::STATUS_OVERAGE, 0.0, 25.0],
        ] as [$actual, $status, $shortage, $overage]) {
            [$conductor, , , , $shift] = $this->activeShift();
            $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 100);

            app(ShiftCloseoutService::class)->close(
                $shift->shift_id,
                $actual,
                ShiftCloseoutService::REASON_MANUAL,
                $conductor->id,
            );

            $remittance = Remittance::findOrFail($shift->shift_id);
            $this->assertSame($status, $remittance->remittance_status);
            $this->assertSame(number_format($shortage, 2, '.', ''), $remittance->shortage);
            $this->assertSame(number_format($overage, 2, '.', ''), $remittance->overage);
        }
    }

    public function test_manual_remittance_completion_notifies_admins(): void
    {
        $admin = User::factory()->create(['role' => 'ADMIN']);
        [$conductor, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 100);

        app(ShiftCloseoutService::class)->close(
            $shift->shift_id,
            100,
            ShiftCloseoutService::REASON_MANUAL,
            $conductor->id,
        );

        $notification = Announcement::where('type', 'REMITTANCE_COMPLETED')
            ->where('user_id', $admin->id)
            ->first();
        $this->assertNotNull($notification);
        $this->assertStringContainsString($shift->unit_number, $notification->message);
        // reference_id names the shift so the admin bell can deep-link straight
        // to its Conductor Detail modal on the Remittance tracker.
        $this->assertSame($shift->shift_id, $notification->reference_id);
    }

    public function test_automatic_closeout_with_nothing_owed_notifies_admins(): void
    {
        $admin = User::factory()->create(['role' => 'ADMIN']);
        [, , , , $shift] = $this->activeShift();
        // No fares recorded — expected cash is 0, so the STALE closeout below
        // resolves straight to COMPLETE without any conductor action.

        app(ShiftCloseoutService::class)->close($shift->shift_id, null, ShiftCloseoutService::REASON_STALE);

        $this->assertSame(Remittance::STATUS_COMPLETE, Remittance::findOrFail($shift->shift_id)->remittance_status);
        $this->assertSame(
            1,
            Announcement::where('type', 'REMITTANCE_COMPLETED')->where('user_id', $admin->id)->count(),
        );
    }

    public function test_resolving_a_previously_pending_remittance_notifies_admins_once(): void
    {
        $admin = User::factory()->create(['role' => 'ADMIN']);
        [$conductor, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 80);
        $service = app(ShiftCloseoutService::class);

        // Stale auto-closeout: cash is owed, nobody physically submitted it yet → PENDING, no notification.
        $service->close($shift->shift_id, null, ShiftCloseoutService::REASON_STALE);
        $this->assertSame(0, Announcement::where('type', 'REMITTANCE_COMPLETED')->count());

        // The conductor later submits the cash manually — this resolves the PENDING remittance.
        $service->close($shift->shift_id, 80, ShiftCloseoutService::REASON_MANUAL, $conductor->id);

        $this->assertSame(Remittance::STATUS_COMPLETE, Remittance::findOrFail($shift->shift_id)->remittance_status);
        $this->assertSame(
            1,
            Announcement::where('type', 'REMITTANCE_COMPLETED')->where('user_id', $admin->id)->count(),
        );
    }

    public function test_automatic_closeout_creates_one_pending_obligation_without_marking_cash_remitted(): void
    {
        [, , $vehicle, , $shift] = $this->activeShift(now()->subHours(13));
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 80);
        Setting::create(['key' => 'max_shift_hours', 'value' => '12', 'category' => 'operations']);

        $this->artisan('shifts:auto-end-stale')->assertSuccessful();
        $this->artisan('shifts:auto-end-stale')->assertSuccessful();

        $remittance = Remittance::findOrFail($shift->shift_id);
        $this->assertSame(Remittance::STATUS_PENDING, $remittance->remittance_status);
        $this->assertSame('80.00', $remittance->cash_total);
        $this->assertSame('0.00', $remittance->remitted_amount);
        $this->assertNull($remittance->remitted_at);
        $this->assertNotNull($remittance->remittance_due_at);
        $this->assertSame(1, Remittance::where('shift_id', $shift->shift_id)->count());
        $this->assertNull($vehicle->fresh()->active_shift_id);
    }

    public function test_manual_and_automatic_closeout_winners_preserve_one_authoritative_result(): void
    {
        [, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 70);
        $service = app(ShiftCloseoutService::class);

        $service->close($shift->shift_id, 70, ShiftCloseoutService::REASON_MANUAL);
        $service->close($shift->shift_id, null, ShiftCloseoutService::REASON_MIDNIGHT);

        $this->assertSame(1, Remittance::where('shift_id', $shift->shift_id)->count());
        $this->assertSame(Remittance::STATUS_COMPLETE, Remittance::findOrFail($shift->shift_id)->remittance_status);
        $this->expectException(HttpException::class);
        $service->lockActiveShift($shift->shift_id);
    }

    public function test_stale_shift_command_processes_a_backlog_larger_than_fifty(): void
    {
        Setting::create(['key' => 'max_shift_hours', 'value' => '12', 'category' => 'operations']);
        foreach (range(1, 55) as $_) {
            $this->activeShift(now()->subHours(13));
        }

        $this->artisan('shifts:auto-end-stale')->assertSuccessful();

        $this->assertSame(0, ShiftLog::query()->active()->count());
        $this->assertSame(55, Remittance::count());
    }

    public function test_normalized_group_rows_are_not_multiplied_again_in_passenger_total(): void
    {
        [, , , , $shift] = $this->activeShift();
        $groupId = (string) Str::uuid();
        PaymentGroup::create([
            'id' => $groupId,
            'reference_number' => 'MP-TEST-'.Str::random(8),
            'shift_id' => $shift->shift_id,
            'payment_method' => PaymentMethod::CASH->value,
            'pickup_name' => 'A',
            'dropoff_name' => 'B',
            'passenger_count' => 3,
            'passenger_breakdown' => [],
            'total_amount' => 60,
        ]);
        foreach (range(1, 3) as $position) {
            $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 20, [
                'group_id' => $groupId,
                'group_position' => $position,
                'total_passengers' => 3,
            ]);
        }

        app(ShiftCloseoutService::class)->close($shift->shift_id, 60, ShiftCloseoutService::REASON_MANUAL);

        $this->assertSame(3, Remittance::findOrFail($shift->shift_id)->total_passengers);
    }

    public function test_only_paid_physical_cash_is_due_while_gcash_and_free_rides_remain_separate(): void
    {
        [, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 45);
        $this->fare($shift, PaymentMethod::GCASH, PaymentStatus::PAID, 80);
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::FAILED, 100);
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 0);

        app(ShiftCloseoutService::class)->close($shift->shift_id, null, ShiftCloseoutService::REASON_STALE);

        $remittance = Remittance::findOrFail($shift->shift_id);
        $this->assertSame('45.00', $remittance->cash_total);
        $this->assertSame('80.00', $remittance->gcash_total);
        $this->assertSame(3, $remittance->total_passengers);
        $this->assertSame(Remittance::STATUS_PENDING, $remittance->remittance_status);
    }

    public function test_remittance_reminders_respect_grace_interval_and_stop_after_completion(): void
    {
        [$conductor, , , , $shift] = $this->activeShift();
        $this->fare($shift, PaymentMethod::CASH, PaymentStatus::PAID, 50);
        Setting::create(['key' => 'remittance_grace_minutes', 'value' => '30', 'category' => 'operations']);
        Setting::create(['key' => 'remittance_reminder_interval_minutes', 'value' => '60', 'category' => 'operations']);
        app(ShiftCloseoutService::class)->close($shift->shift_id, null, ShiftCloseoutService::REASON_STALE);

        $this->artisan('remittances:send-reminders')->assertSuccessful();
        $this->assertSame(0, Announcement::where('type', 'REMITTANCE_REMINDER')->count());

        Remittance::where('shift_id', $shift->shift_id)->update(['remittance_due_at' => now()->subMinute()]);
        $this->artisan('remittances:send-reminders')->assertSuccessful();
        $this->artisan('remittances:send-reminders')->assertSuccessful();
        $this->assertSame(1, Announcement::where('type', 'REMITTANCE_REMINDER')->where('user_id', $conductor->id)->count());
        $this->assertSame(1, Remittance::findOrFail($shift->shift_id)->reminder_count);

        app(ShiftCloseoutService::class)->close(
            $shift->shift_id,
            50,
            ShiftCloseoutService::REASON_MANUAL,
            $conductor->id,
        );
        Remittance::where('shift_id', $shift->shift_id)->update(['last_reminder_at' => now()->subHours(2)]);
        $this->artisan('remittances:send-reminders')->assertSuccessful();
        $this->assertSame(1, Announcement::where('type', 'REMITTANCE_REMINDER')->count());
    }

    public function test_midnight_reset_closes_old_shift_preserves_pending_cash_and_does_not_clear_today_assignment(): void
    {
        [, , $oldVehicle, , $oldShift] = $this->activeShift(now('Asia/Manila')->subDay());
        $cash = $this->fare($oldShift, PaymentMethod::CASH, PaymentStatus::PAID, 90);
        $overspeed = OverspeedEvent::create([
            'shift_id' => $oldShift->shift_id,
            'conductor_id' => $oldShift->conductor_id,
            'driver_id' => $oldShift->driver_id,
            'vehicle_id' => $oldShift->vehicle_id,
            'top_speed' => 70,
            'threshold' => 50,
            'date' => now()->subDay()->toDateString(),
            'last_logged_at' => now()->subDay(),
        ]);
        VehicleLocation::factory()->create([
            'vehicle_id' => $oldVehicle->id,
            'shift_id' => $oldShift->shift_id,
            'fix_recorded_at' => now()->subDay(),
        ]);
        [, , $todayVehicle] = $this->crew(now('Asia/Manila')->toDateString());

        $this->artisan('vehicles:reset-daily-assignments')->assertSuccessful();

        $this->assertSame(ShiftStatus::ENDED, $oldShift->fresh()->status);
        $this->assertSame(Remittance::STATUS_PENDING, Remittance::findOrFail($oldShift->shift_id)->remittance_status);
        $this->assertNull(VehicleLocation::where('vehicle_id', $oldVehicle->id)->first());
        $this->assertNotNull($todayVehicle->fresh()->conductor_id);
        $this->assertSame(now('Asia/Manila')->toDateString(), $todayVehicle->fresh()->assignment_date->toDateString());
        $this->assertDatabaseHas('transactions', ['transaction_id' => $cash->transaction_id]);
        $this->assertDatabaseHas('overspeed_events', ['id' => $overspeed->id]);
    }

    public function test_pending_gcash_expiration_is_idempotent_and_terminal_payments_are_untouched(): void
    {
        [, , , , $shift] = $this->activeShift();
        $pending = $this->fare($shift, PaymentMethod::GCASH, PaymentStatus::PENDING, 40);
        $paid = $this->fare($shift, PaymentMethod::GCASH, PaymentStatus::PAID, 50);
        $cancelled = $this->fare($shift, PaymentMethod::GCASH, PaymentStatus::CANCELLED, 60);
        $refunded = $this->fare($shift, PaymentMethod::GCASH, PaymentStatus::REFUNDED, 70);
        Transaction::whereKey($pending->transaction_id)->update(['created_at' => now()->subHours(2)]);
        Transaction::whereKey($paid->transaction_id)->update(['created_at' => now()->subHours(2)]);
        Transaction::whereKey($cancelled->transaction_id)->update(['created_at' => now()->subHours(2)]);
        Transaction::whereKey($refunded->transaction_id)->update(['created_at' => now()->subHours(2)]);

        $this->artisan('payments:expire-stale')->assertSuccessful();
        $this->artisan('payments:expire-stale')->assertSuccessful();

        $this->assertSame(PaymentStatus::EXPIRED, $pending->fresh()->status);
        $this->assertSame(PaymentStatus::PAID, $paid->fresh()->status);
        $this->assertSame(PaymentStatus::CANCELLED, $cancelled->fresh()->status);
        $this->assertSame(PaymentStatus::REFUNDED, $refunded->fresh()->status);
    }

    public function test_operational_settings_reject_unsafe_values_and_accept_supported_values(): void
    {
        $admin = User::factory()->admin()->create();

        foreach ([
            'speed_limit_kmh' => [0, 50],
            'max_shift_hours' => [0, 12],
            'remittance_grace_minutes' => [0, 30],
            'remittance_reminder_interval_minutes' => [4, 60],
        ] as $key => [$invalid, $valid]) {
            $this->actingAs($admin)
                ->putJson("/api/v1/admin/settings/{$key}", ['value' => $invalid, 'category' => 'operations'])
                ->assertUnprocessable()
                ->assertJsonValidationErrors('value');

            $this->actingAs($admin)
                ->putJson("/api/v1/admin/settings/{$key}", ['value' => $valid, 'category' => 'operations'])
                ->assertOk();

            $this->assertDatabaseHas('settings', ['key' => $key, 'value' => (string) $valid]);
        }
    }

    public function test_speed_updates_keep_highest_valid_value_and_reject_stale_samples(): void
    {
        [$conductor, , , , $shift] = $this->activeShift();
        Setting::create(['key' => 'speed_limit_kmh', 'value' => '50', 'category' => 'operations']);
        $service = app(LocationService::class);

        $service->updateLocation($conductor, 14.9, 120.8, 80, null, null, 10, now()->subSecond()->toIso8601String());
        $service->updateLocation($conductor, 14.9, 120.8, 65, null, null, 10, now()->toIso8601String());

        $this->assertSame(80, OverspeedEvent::where('shift_id', $shift->shift_id)->firstOrFail()->top_speed);

        $service->updateLocation($conductor, 14.9, 120.8, 120, null, null, 200, now()->addSecond()->toIso8601String());
        $this->assertSame(80, OverspeedEvent::where('shift_id', $shift->shift_id)->firstOrFail()->top_speed);

        $this->expectException(HttpException::class);
        $service->updateLocation($conductor, 14.9, 120.8, 60, null, null, 10, now()->subMinutes(5)->toIso8601String());
    }

    public function test_overspeed_events_track_separate_episodes_per_shift(): void
    {
        [$conductor, , , , $shift] = $this->activeShift();
        Setting::create(['key' => 'speed_limit_kmh', 'value' => '50', 'category' => 'operations']);
        $service = app(LocationService::class);

        // First episode: over the limit, then back under it.
        $service->updateLocation($conductor, 14.9, 120.8, 80, null, null, 10, now()->subSeconds(4)->toIso8601String());
        $service->updateLocation($conductor, 14.9, 120.8, 40, null, null, 10, now()->subSeconds(3)->toIso8601String());
        // Second, independent episode: over the limit again.
        $service->updateLocation($conductor, 14.9, 120.8, 90, null, null, 10, now()->subSeconds(2)->toIso8601String());

        $events = OverspeedEvent::where('shift_id', $shift->shift_id)->orderBy('id')->get();
        $this->assertCount(2, $events);
        $this->assertSame(80, $events[0]->top_speed);
        $this->assertNotNull($events[0]->ended_at);
        $this->assertSame(90, $events[1]->top_speed);
        $this->assertNull($events[1]->ended_at);
    }

    public function test_new_overspeed_episode_notifies_every_admin_once(): void
    {
        $admin = User::factory()->admin()->create();
        $otherAdmin = User::factory()->admin()->create();
        [$conductor, , , , $shift] = $this->activeShift();
        Setting::create(['key' => 'speed_limit_kmh', 'value' => '50', 'category' => 'operations']);
        $service = app(LocationService::class);

        // Two consecutive pings, both over the limit — the same open episode.
        // Notifying on every ping would spam the bell every few seconds, so
        // only the FIRST one (the episode starting) should notify.
        $service->updateLocation($conductor, 14.9, 120.8, 80, null, null, 10, now()->subSeconds(2)->toIso8601String());
        $service->updateLocation($conductor, 14.9, 120.8, 90, null, null, 10, now()->subSecond()->toIso8601String());

        $event = OverspeedEvent::where('shift_id', $shift->shift_id)->firstOrFail();

        foreach ([$admin, $otherAdmin] as $recipient) {
            $notification = Announcement::where('type', 'OVERSPEED_FLAGGED')
                ->where('user_id', $recipient->id)
                ->first();
            $this->assertNotNull($notification, "Admin {$recipient->id} was not notified.");
            $this->assertStringContainsString($shift->unit_number, $notification->message);
            // reference_id names the episode so the admin bell can deep-link
            // straight to it (scrolled + highlighted) on Live Monitoring.
            $this->assertSame((string) $event->id, $notification->reference_id);
        }
        // One notification per episode (per admin), not one per GPS ping.
        $this->assertSame(2, Announcement::where('type', 'OVERSPEED_FLAGGED')->count());
    }

    public function test_reentering_overspeed_after_slowing_down_notifies_again(): void
    {
        $admin = User::factory()->admin()->create();
        [$conductor, , , , $shift] = $this->activeShift();
        Setting::create(['key' => 'speed_limit_kmh', 'value' => '50', 'category' => 'operations']);
        $service = app(LocationService::class);

        // First episode: over the limit, then back under it (closes the episode).
        $service->updateLocation($conductor, 14.9, 120.8, 80, null, null, 10, now()->subSeconds(4)->toIso8601String());
        $service->updateLocation($conductor, 14.9, 120.8, 40, null, null, 10, now()->subSeconds(3)->toIso8601String());
        // Second, independent episode: over the limit again — a genuinely new flag.
        $service->updateLocation($conductor, 14.9, 120.8, 90, null, null, 10, now()->subSeconds(2)->toIso8601String());

        $this->assertSame(
            2,
            Announcement::where('type', 'OVERSPEED_FLAGGED')->where('user_id', $admin->id)->count(),
        );
    }

    public function test_admin_overspeed_history_is_paginated_and_filters_chatco_shift_ids(): void
    {
        $admin = User::factory()->admin()->create();
        [, , , , $wantedShift] = $this->activeShift();
        [, , , , $otherShift] = $this->activeShift();

        foreach ([[$wantedShift, 80], [$otherShift, 70]] as [$shift, $speed]) {
            OverspeedEvent::create([
                'shift_id' => $shift->shift_id,
                'conductor_id' => $shift->conductor_id,
                'driver_id' => $shift->driver_id,
                'vehicle_id' => $shift->vehicle_id,
                'top_speed' => $speed,
                'threshold' => 50,
                'date' => now()->toDateString(),
                'last_logged_at' => now(),
            ]);
        }

        $this->actingAs($admin)
            ->getJson('/api/v1/admin/monitoring/overspeed?shift_id='.$wantedShift->shift_id.'&per_page=1')
            ->assertOk()
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.speed', 80);
    }

    public function test_closeout_cancels_open_hails_but_preserves_their_history(): void
    {
        [, , $vehicle, , $shift] = $this->activeShift();
        $commuter = User::factory()->commuter()->create();
        $hail = Hail::create([
            'commuter_id' => $commuter->id,
            'vehicle_id' => $vehicle->id,
            'status' => HailStatus::ACCEPTED,
            'commuter_lat' => 14.9,
            'commuter_lng' => 120.8,
            'distance_m' => 50,
            'expires_at' => now()->addMinute(),
        ]);

        app(ShiftCloseoutService::class)->close($shift->shift_id, null, ShiftCloseoutService::REASON_STALE);

        $this->assertSame(HailStatus::CANCELLED, $hail->fresh()->status);
        $this->assertDatabaseHas('hails', ['id' => $hail->id]);
    }

    /** @return array{User, Driver, Vehicle, Route} */
    private function crew(?string $assignmentDate = null): array
    {
        $conductor = User::factory()->conductor()->create();
        $driver = Driver::factory()->create();
        $route = Route::factory()->create();
        $vehicle = Vehicle::factory()->create([
            'route_id' => $route->id,
            'driver_id' => $driver->id,
            'conductor_id' => $conductor->id,
            'assignment_date' => $assignmentDate ?? now('Asia/Manila')->toDateString(),
            'assignment_approved_at' => now(),
        ]);
        $driver->update(['vehicle_id' => $vehicle->id]);

        return [$conductor, $driver, $vehicle, $route];
    }

    /** @return array{User, Driver, Vehicle, Route, ShiftLog} */
    private function activeShift($timeIn = null): array
    {
        [$conductor, $driver, $vehicle, $route] = $this->crew();
        $shift = ShiftLog::create([
            'shift_id' => 'SHF-'.strtoupper(Str::random(14)),
            'conductor_id' => $conductor->id,
            'driver_id' => $driver->id,
            'vehicle_id' => $vehicle->id,
            'route_id' => $route->id,
            'conductor_name' => 'Test Conductor',
            'driver_name' => 'Test Driver',
            'unit_number' => $vehicle->unit_number,
            'plate_number' => $vehicle->plate_number,
            'time_in' => $timeIn ?? now(),
            'status' => ShiftStatus::ACTIVE->value,
            'is_active' => true,
        ]);
        $vehicle->update(['active_shift_id' => $shift->shift_id]);
        $driver->update(['active_shift_id' => $shift->shift_id]);

        return [$conductor, $driver, $vehicle, $route, $shift];
    }

    private function fare(
        ShiftLog $shift,
        PaymentMethod $method,
        PaymentStatus $status,
        float $amount,
        array $overrides = [],
    ): Transaction {
        return Transaction::create(array_merge([
            'transaction_id' => 'TXN-'.strtoupper(Str::random(16)),
            'shift_id' => $shift->shift_id,
            'payment_method' => $method->value,
            'status' => $status->value,
            'final_amount' => $amount,
            'total_passengers' => 1,
            'paid_at' => $status === PaymentStatus::PAID ? now() : null,
        ], $overrides));
    }
}
