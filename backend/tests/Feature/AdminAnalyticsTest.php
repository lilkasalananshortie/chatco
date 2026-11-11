<?php

namespace Tests\Feature;

use App\Enums\ShiftStatus;
use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\FarePoint;
use App\Models\Feedback;
use App\Models\PaymentGroup;
use App\Models\Remittance;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * S5-T6 — Admin analytics aggregation.
 *
 * The aggregation math had NO automated coverage before this suite. These
 * tests assert the totals reconcile with the seeded rows and that the
 * date-range filter actually narrows the window.
 */
class AdminAnalyticsTest extends TestCase
{
    use RefreshDatabase;

    private int $seq = 0;
    private string $shiftId;

    protected function setUp(): void
    {
        parent::setUp();
        // One real parent shift to satisfy the transactions.shift_id FK.
        $this->shiftId = $this->seedShift();
    }

    private function makeAdmin(): User
    {
        $admin = User::create([
            'email'    => 'admin@gmail.com',
            'password' => Hash::make('password123'),
            'role'     => UserRole::ADMIN,
        ]);
        AdminProfile::create(['id' => $admin->id, 'first_name' => 'System', 'last_name' => 'Admin']);

        return $admin;
    }

    private function seedShift(): string
    {
        $conductor = User::create([
            'email' => 'cond@test.com', 'password' => Hash::make('x'), 'role' => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id' => $conductor->id, 'first_name' => 'C', 'last_name' => 'One',
            'birthday' => '1990-01-01', 'generated_username' => 'c_one', 'generated_password' => Hash::make('x'),
        ]);
        $route = Route::create(['name' => 'R1', 'status' => 'ACTIVE']);
        $driver = Driver::create([
            'first_name' => 'D', 'last_name' => 'One', 'birthday' => '1985-01-01',
            'contact' => '+639170000000', 'license_number' => 'LIC-A', 'hire_date' => now()->toDateString(), 'status' => 'ACTIVE',
        ]);
        $vehicle = Vehicle::create([
            'unit_number' => 'UNIT-1', 'plate_number' => 'PLT-1', 'route_id' => $route->id, 'status' => 'ACTIVE',
        ]);
        $shiftId = 'shift-analytics-' . uniqid();
        ShiftLog::create([
            'shift_id' => $shiftId, 'conductor_id' => $conductor->id, 'driver_id' => $driver->id,
            'vehicle_id' => $vehicle->id, 'conductor_name' => 'C One', 'driver_name' => 'D One',
            'unit_number' => 'UNIT-1', 'plate_number' => 'PLT-1', 'time_in' => now()->subHours(8),
            'status' => ShiftStatus::ENDED, 'is_active' => false,
        ]);

        return $shiftId;
    }

    /**
     * Create a transaction with an explicit status / method / amount and an
     * optional created_at (defaults to now). created_at is set via a raw
     * update because it is not mass-assignable.
     */
    private function makeTransaction(string $status, string $method, float $amount, ?\DateTimeInterface $createdAt = null, array $attributes = []): Transaction
    {
        $this->seq++;
        $tx = Transaction::create([
            'transaction_id' => 'TXN-' . $this->seq . '-' . uniqid(),
            'shift_id'       => $this->shiftId,
            'payment_method' => $method,
            'final_amount'   => $amount,
            'status'         => $status,
            'pickup_name'    => 'A',
            'dropoff_name'   => 'B',
            ...$attributes,
        ]);

        if ($createdAt !== null) {
            DB::table('transactions')->where('transaction_id', $tx->transaction_id)
                ->update(['created_at' => $createdAt]);
        }
        return $tx;
    }

    public function test_analytics_totals_reconcile_with_seeded_transactions(): void
    {
        $admin = $this->makeAdmin();

        // PAID (count toward revenue): cash 100 + 50, gcash 200.
        $this->makeTransaction('PAID', 'CASH', 100.00);
        $this->makeTransaction('PAID', 'CASH', 50.00);
        $this->makeTransaction('PAID', 'GCASH', 200.00);
        // PENDING (must NOT count toward revenue, but counts as pending).
        $this->makeTransaction('PENDING', 'GCASH', 999.00);

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/analytics');

        $response->assertStatus(200);
        $totals = $response->json('data.totals');

        $this->assertEquals(150.0, $totals['cash_total']);
        $this->assertEquals(200.0, $totals['gcash_total']);
        $this->assertEquals(350.0, $totals['total_fares']);
        $this->assertEquals(3, $totals['paid_count']);
        $this->assertEquals(1, $totals['pending_count']);

        // Invariant: cash_total + gcash_total == total_fares.
        $this->assertEquals(
            $totals['total_fares'],
            $totals['cash_total'] + $totals['gcash_total'],
        );

        // Payment split counts.
        $split = $response->json('data.payment_split');
        $this->assertEquals(2, $split['cash']['count']);
        $this->assertEquals(1, $split['gcash']['count']);
    }

    public function test_date_filter_excludes_out_of_range_transactions(): void
    {
        $admin = $this->makeAdmin();

        $this->makeTransaction('PAID', 'CASH', 100.00, now());                // recent
        $this->makeTransaction('PAID', 'CASH', 999.00, now()->subDays(60));   // old — should be excluded

        $response = $this->actingAs($admin)->getJson(
            '/api/v1/admin/analytics?date_from=' . now()->subDays(7)->toDateString()
            . '&date_to=' . now()->toDateString()
        );

        $response->assertStatus(200);
        // Only the recent 100 falls in the 7-day window.
        $this->assertEquals(100.0, $response->json('data.totals.cash_total'));
        $this->assertEquals(1, $response->json('data.totals.paid_count'));
    }

    public function test_today_daily_totals_exclude_other_days_and_unsettled_or_free_rides(): void
    {
        $this->travelTo(now()->startOfDay()->addMinutes(5));
        $admin = $this->makeAdmin();
        $today = now()->startOfDay();

        $this->makeTransaction('PAID', 'CASH', 100, $today);
        $this->makeTransaction('PAID', 'GCASH', 200, $today->copy()->endOfDay());
        $this->makeTransaction('PAID', 'VOUCHER', 0, $today);
        $this->makeTransaction('PENDING', 'GCASH', 999, $today);
        $this->makeTransaction('FAILED', 'GCASH', 999, $today);
        $this->makeTransaction('PAID', 'CASH', 700, $today->copy()->subSecond());
        $this->makeTransaction('PAID', 'CASH', 800, $today->copy()->addDay());

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk();
        $this->assertSame($today->toDateString(), $response->json('data.date_range.to'));
        $day = collect($response->json('data.daily_series'))->firstWhere('date', $today->toDateString());

        $this->assertEquals(300, $day['cash'] + $day['gcash']);
        $this->assertSame(2, $day['paid_count']);
        $this->assertSame(3, $day['count']);
        // The other dashboard metrics keep their existing 30-day window.
        $this->assertEquals(1000, $response->json('data.totals.total_fares'));
        $this->assertSame(3, $response->json('data.totals.paid_count'));
    }

    public function test_today_daily_totals_are_zero_when_only_earlier_days_have_rides(): void
    {
        $this->travelTo(now()->startOfDay()->addMinutes(5));
        $admin = $this->makeAdmin();
        $this->makeTransaction('PAID', 'CASH', 500, now()->subDay());

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk();
        $day = collect($response->json('data.daily_series'))->firstWhere('date', now()->toDateString());

        $this->assertEquals(0, $day['cash'] + $day['gcash']);
        $this->assertSame(0, $day['paid_count']);
        $this->assertSame(0, $day['count']);
        $this->assertEquals(500, $response->json('data.totals.total_fares'));
    }

    public function test_weekly_dashboard_pickups_combine_major_places_for_cash_and_gcash_only(): void
    {
        $this->travelTo(now()->setDate(2026, 10, 14)->setTime(12, 0));
        $admin = $this->makeAdmin();
        $route = Route::firstOrFail();
        $major = FarePoint::create([
            'route_id' => $route->id, 'point_number' => 1, 'code' => 'WAWA',
            'name' => 'Wawa', 'regular_fare' => 15, 'discounted_fare' => 12,
        ]);
        $other = FarePoint::create([
            'route_id' => $route->id, 'point_number' => 2, 'code' => 'BAL',
            'name' => 'Balite', 'regular_fare' => 15, 'discounted_fare' => 12,
        ]);
        $monday = now()->startOfWeek(\Carbon\Carbon::MONDAY);
        $from = ['pickup_stop_id' => $major->id, 'dropoff_stop_id' => $other->id];
        $this->makeTransaction('PAID', 'CASH', 15, $monday, [...$from, 'pickup_name' => 'Wawa · Market']);
        $this->makeTransaction('PAID', 'GCASH', 15, now(), [...$from, 'pickup_name' => 'Wawa · Church']);
        $this->makeTransaction('PAID', 'CASH', 15, now(), [...$from, 'pickup_name' => 'Wawa']);
        $this->makeTransaction('PAID', 'GCASH', 15, now(), [
            'pickup_stop_id' => $other->id, 'pickup_name' => 'Balite',
            'dropoff_stop_id' => $major->id, 'dropoff_name' => 'Wawa',
        ]);
        $this->makeTransaction('PAID', 'CASH', 15, $monday->copy()->subSecond(), $from);
        $this->makeTransaction('PAID', 'GCASH', 15, now()->addDay(), $from);
        foreach (['PENDING', 'FAILED', 'CANCELLED', 'EXPIRED'] as $status) {
            $this->makeTransaction($status, 'GCASH', 15, now(), $from);
        }
        $this->makeTransaction('PAID', 'VOUCHER', 0, now(), $from);

        $response = $this->actingAs($admin)->getJson('/api/v1/admin/analytics?pickup_period=week')->assertOk();
        $this->assertSame([
            ['name' => 'Wawa', 'count' => 3],
            ['name' => 'Balite', 'count' => 1],
        ], $response->json('data.pickup_points'));
        $this->assertSame(30, $response->json('data.date_range.days'));
        $this->assertEquals(75, $response->json('data.totals.total_fares'));

        // Analytics without the dashboard option skips this query; its Pickup
        // Points report comes from heatmap_zones instead.
        $analytics = $this->actingAs($admin)->getJson('/api/v1/admin/analytics?date_from=2026-10-11&date_to=2026-10-11')->assertOk();
        $this->assertSame([], $analytics->json('data.pickup_points'));
    }

    public function test_analytics_pickup_report_counts_fare_points_without_coordinates_like_the_dashboard(): void
    {
        $this->travelTo(now()->setDate(2026, 11, 10)->setTime(12, 0));
        $admin = $this->makeAdmin();
        $route = Route::firstOrFail();
        // The cooperative fare matrix seeds every point with null coordinates.
        $points = collect(range(1, 17))->map(fn ($n) => FarePoint::create([
            'route_id' => $route->id, 'point_number' => $n, 'code' => "P{$n}",
            'name' => sprintf('Point %02d', $n), 'regular_fare' => 15, 'discounted_fare' => 12,
        ]));
        $first = $points->first();
        $this->makeTransaction('PAID', 'CASH', 15, now(), ['pickup_stop_id' => $first->id]);
        $this->makeTransaction('PAID', 'GCASH', 15, now(), ['pickup_stop_id' => $first->id]);
        $this->makeTransaction('PAID', 'VOUCHER', 0, now(), ['pickup_stop_id' => $first->id]);
        $this->makeTransaction('PENDING', 'GCASH', 15, now(), ['pickup_stop_id' => $first->id]);
        $points->skip(1)->each(fn ($point) => $this->makeTransaction('PAID', 'CASH', 15, now(), ['pickup_stop_id' => $point->id]));

        $from = now()->startOfWeek(\Carbon\Carbon::MONDAY)->toDateString();
        $zones = $this->actingAs($admin)
            ->getJson("/api/v1/admin/analytics?date_from={$from}&date_to=".now()->toDateString())
            ->assertOk()->json('data.heatmap_zones');

        // All 17 points listed (no top-15 cap), voucher and pending rides excluded.
        $this->assertCount(17, $zones);
        $this->assertSame(['Point 01', 2, null, null], [$zones[0]['zone'], $zones[0]['commuters'], $zones[0]['lat'], $zones[0]['lng']]);
        $this->assertSame(['Point 02', 1], [$zones[1]['zone'], $zones[1]['commuters']]);

        // Same counts as the dashboard card over the same week.
        $dashboard = $this->actingAs($admin)->getJson('/api/v1/admin/analytics?pickup_period=week')->assertOk()->json('data.pickup_points');
        $this->assertSame(
            array_slice(array_map(fn ($z) => ['name' => $z['zone'], 'count' => $z['commuters']], $zones), 0, 10),
            $dashboard,
        );
    }

    public function test_weekly_dashboard_pickups_reset_on_monday_and_have_an_empty_state(): void
    {
        $this->travelTo(now()->setDate(2026, 10, 12)->startOfDay());
        $admin = $this->makeAdmin();
        $point = FarePoint::create([
            'route_id' => Route::firstOrFail()->id, 'point_number' => 1, 'code' => 'WAWA',
            'name' => 'Wawa', 'regular_fare' => 15, 'discounted_fare' => 12,
        ]);
        $this->makeTransaction('PAID', 'CASH', 15, now()->subSecond(), ['pickup_stop_id' => $point->id]);

        $this->actingAs($admin)->getJson('/api/v1/admin/analytics?pickup_period=week')
            ->assertOk()->assertJsonPath('data.pickup_points', []);
        $this->makeTransaction('PAID', 'CASH', 15, now(), ['pickup_stop_id' => $point->id]);
        $this->actingAs($admin)->getJson('/api/v1/admin/analytics?pickup_period=week')
            ->assertOk()->assertJsonPath('data.pickup_points', [['name' => 'Wawa', 'count' => 1]]);
    }

    public function test_dashboard_pickup_period_rejects_unsupported_values(): void
    {
        $this->actingAs($this->makeAdmin())->getJson('/api/v1/admin/analytics?pickup_period=month')
            ->assertUnprocessable()->assertJsonValidationErrors('pickup_period');
    }

    public function test_analytics_response_shape_is_complete(): void
    {
        $admin = $this->makeAdmin();

        $this->actingAs($admin)->getJson('/api/v1/admin/analytics')
            ->assertStatus(200)
            ->assertJsonStructure([
                'data' => [
                    'date_range'    => ['from', 'to', 'days'],
                    'totals'        => ['total_fares', 'cash_total', 'gcash_total', 'paid_count', 'pending_count'],
                    'payment_split' => ['cash' => ['count', 'total'], 'gcash' => ['count', 'total']],
                    'daily_series',
                    'remittances'   => ['total_remitted', 'total_collected', 'total_shortage', 'count'],
                    'fleet'         => ['active_vehicles', 'total_vehicles', 'active_conductors', 'total_conductors'],
                ],
            ]);
    }

    private function makeGroup(string $method, int $seats): string
    {
        $groupId = (string) Str::uuid();
        PaymentGroup::create([
            'id' => $groupId, 'reference_number' => 'MP-TEST-'.Str::random(8), 'shift_id' => $this->shiftId,
            'payment_method' => $method, 'pickup_name' => 'A', 'dropoff_name' => 'B',
            'passenger_count' => $seats, 'passenger_breakdown' => [], 'total_amount' => 0,
        ]);

        return $groupId;
    }

    /** Another shift on the seeded crew, for a second remittance row (remittances are keyed by shift). */
    private function extraShift(): string
    {
        $shift = ShiftLog::findOrFail($this->shiftId);
        $shiftId = 'shift-analytics-'.uniqid();
        ShiftLog::create([
            ...$shift->only(['conductor_id', 'driver_id', 'vehicle_id', 'conductor_name', 'driver_name', 'unit_number', 'plate_number']),
            'shift_id' => $shiftId, 'time_in' => now()->subHours(4), 'status' => ShiftStatus::ENDED, 'is_active' => false,
        ]);

        return $shiftId;
    }

    private function makeRemittance(string $shiftId, string $status, float $collected, float $remitted): void
    {
        $shift = ShiftLog::findOrFail($shiftId);
        Remittance::create([
            ...$shift->only(['shift_id', 'conductor_id', 'driver_id', 'vehicle_id', 'conductor_name', 'driver_name', 'unit_number', 'time_in']),
            'date' => now()->toDateString(), 'time_out' => now(),
            'total_collected' => $collected, 'cash_total' => $collected, 'gcash_total' => 0,
            'remitted_amount' => $remitted, 'shortage' => max(0, $collected - $remitted), 'overage' => 0,
            'remittance_status' => $status, 'total_passengers' => 1,
        ]);
    }

    public function test_group_seats_count_once_and_avg_fare_is_per_paying_passenger(): void
    {
        $admin = $this->makeAdmin();
        // Cash group of 3 seats: one row per seat, each repeating the group size.
        $groupId = $this->makeGroup('CASH', 3);
        foreach (range(1, 3) as $position) {
            $this->makeTransaction('PAID', 'CASH', 50.00, null, [
                'group_id' => $groupId, 'group_position' => $position, 'total_passengers' => 3, 'discount_amount' => 0,
            ]);
        }
        // One ungrouped multi-passenger cash row carrying 2 passengers.
        $this->makeTransaction('PAID', 'CASH', 100.00, null, ['total_passengers' => 2, 'discount_amount' => 10]);
        // A free reward ride: no revenue, but a passenger and a full-fare discount.
        $this->makeTransaction('PAID', 'VOUCHER', 0.00, null, ['total_passengers' => 1, 'discount_amount' => 25]);

        $totals = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk()->json('data.totals');

        $this->assertSame(6, $totals['total_passengers']); // 3 seats + 2 + 1, not 3*3 + 2 + 1
        $this->assertSame(5, $totals['paying_passengers']);
        $this->assertEquals(50.0, $totals['avg_fare']); // 250 / 5 paying passengers
        $this->assertEquals(35.0, $totals['discount_total']);
        $this->assertSame(4, $totals['paid_count']); // rows settled for money, unchanged meaning
    }

    public function test_gcash_success_counts_each_payment_once(): void
    {
        $admin = $this->makeAdmin();
        // One settled two-seat group payment and one failed single payment.
        $groupId = $this->makeGroup('GCASH', 2);
        foreach (range(1, 2) as $position) {
            $this->makeTransaction('PAID', 'GCASH', 40.00, null, ['group_id' => $groupId, 'group_position' => $position, 'total_passengers' => 2]);
        }
        $this->makeTransaction('FAILED', 'GCASH', 40.00);

        $health = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk()->json('data.gcash_health');

        $this->assertSame(2, $health['attempts']);
        $this->assertSame(1, $health['settled']);
        $this->assertSame(1, $health['failed']);
        $this->assertEquals(50.0, $health['success_rate']);
    }

    public function test_unremitted_shift_is_awaiting_not_shortage(): void
    {
        $admin = $this->makeAdmin();
        $this->makeRemittance($this->shiftId, 'SHORTAGE', 1000, 900);
        // Ended but cash not handed in yet: stored with shortage = all expected cash.
        $this->makeRemittance($this->extraShift(), 'PENDING', 500, 0);

        $remittances = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk()->json('data.remittances');

        $this->assertEquals(100.0, $remittances['total_shortage']);
        $this->assertEquals(10.0, $remittances['shortage_rate']);
        $this->assertSame(1, $remittances['awaiting_count']);
        $this->assertEquals(500.0, $remittances['awaiting_amount']);
        // Unchanged meaning, read by the dashboard's Pending Remittance card.
        $this->assertEquals(1500.0, $remittances['total_collected']);
        $this->assertEquals(900.0, $remittances['total_remitted']);
    }

    public function test_removed_conductors_are_not_counted_in_fleet_total(): void
    {
        $admin = $this->makeAdmin();
        $removed = User::create(['email' => 'gone@test.com', 'password' => Hash::make('x'), 'role' => UserRole::CONDUCTOR]);
        ConductorProfile::create([
            'id' => $removed->id, 'first_name' => 'G', 'last_name' => 'One',
            'birthday' => '1990-01-01', 'generated_username' => 'g_one', 'generated_password' => Hash::make('x'),
        ]);
        $removed->delete(); // what Fleet Management's Remove Personnel does

        $this->actingAs($admin)->getJson('/api/v1/admin/analytics')
            ->assertOk()
            ->assertJsonPath('data.fleet.total_conductors', 1);
    }

    public function test_shifts_and_per_unit_revenue_reconcile_with_total_fares(): void
    {
        $admin = $this->makeAdmin();
        ShiftLog::whereKey($this->shiftId)->update(['time_out' => now()->subHours(2)]); // 6h shift
        $this->makeTransaction('PAID', 'CASH', 100.00, null, ['total_passengers' => 2]);
        $this->makeTransaction('PAID', 'GCASH', 50.00, null, ['total_passengers' => 1]);
        $this->makeTransaction('PAID', 'VOUCHER', 0.00, null, ['total_passengers' => 1]);
        $this->makeTransaction('PENDING', 'GCASH', 999.00); // never revenue
        $this->makeTransaction('PAID', 'CASH', 70.00, now()->subDays(40)); // outside the window

        $second = $this->extraShift(); // same crew, still running (no time_out)
        $this->makeTransaction('PAID', 'CASH', 30.00, null, ['shift_id' => $second, 'total_passengers' => 1]);

        $data = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk()->json('data');

        $this->assertSame(2, $data['service']['shifts_run']);
        $this->assertSame(360, $data['service']['avg_shift_minutes']); // only the ended shift
        $this->assertCount(1, $data['performance']['units']);
        $unit = $data['performance']['units'][0];
        $this->assertSame('UNIT-1', $unit['unit_number']);
        $this->assertSame(2, $unit['shifts']);
        $this->assertSame(5, $unit['passengers']); // 2 + 1 + voucher 1 + 1
        $this->assertEquals(180.0, $unit['revenue']);
        $this->assertEquals($data['totals']['total_fares'], $unit['revenue']);
        $this->assertSame('C One', $data['performance']['conductors'][0]['name']);
        $this->assertEquals(180.0, $data['performance']['conductors'][0]['revenue']);
    }

    public function test_ratings_and_safety_are_scoped_to_the_window(): void
    {
        $admin = $this->makeAdmin();
        $shift = ShiftLog::findOrFail($this->shiftId);
        $review = fn (int $rating, ?int $conductorRating, $createdAt = null) => tap(Feedback::create([
            'id' => (string) Str::uuid(), 'shift_id' => $shift->shift_id, 'vehicle_id' => $shift->vehicle_id,
            'driver_id' => $shift->driver_id, 'conductor_id' => $shift->conductor_id,
            'commuter_id' => User::factory()->commuter()->create()->id,
            'rating' => $rating, 'conductor_rating' => $conductorRating,
        ]), fn (Feedback $feedback) => $createdAt && DB::table('feedback')->where('id', $feedback->id)->update(['created_at' => $createdAt]));
        $review(5, 4);
        $review(4, null); // conductor rating is optional
        $review(1, 1, now()->subDays(40)); // outside the window

        $sender = User::factory()->commuter()->create()->id;
        DB::table('sos_alerts')->insert([
            ['id' => (string) Str::uuid(), 'commuter_id' => $sender, 'lat' => 14.8, 'lng' => 120.8, 'status' => 'RESOLVED', 'created_at' => now(), 'updated_at' => now()],
            ['id' => (string) Str::uuid(), 'commuter_id' => $sender, 'lat' => 14.8, 'lng' => 120.8, 'status' => 'ACTIVE', 'created_at' => now(), 'updated_at' => now()],
            ['id' => (string) Str::uuid(), 'commuter_id' => $sender, 'lat' => 14.8, 'lng' => 120.8, 'status' => 'ACTIVE', 'created_at' => now()->subDays(40), 'updated_at' => now()],
        ]);
        foreach ([[62, now()], [71, now()], [99, now()->subDays(40)]] as [$speed, $day]) {
            DB::table('overspeed_events')->insert([
                'shift_id' => $this->shiftId, 'top_speed' => $speed, 'threshold' => 50,
                'date' => $day->toDateString(), 'last_logged_at' => $day, 'created_at' => $day, 'updated_at' => $day,
            ]);
        }

        $data = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk()->json('data');

        $this->assertSame(2, $data['service']['review_count']);
        $this->assertEquals(4.5, $data['service']['driver_rating']);
        $this->assertEquals(4.0, $data['service']['conductor_rating']);
        $this->assertSame(['sos_alerts' => 2, 'sos_open' => 1, 'overspeed_episodes' => 2, 'overspeed_top_speed' => 71], $data['safety']);
    }

    public function test_malformed_or_reversed_dates_are_rejected_not_a_server_error(): void
    {
        $admin = $this->makeAdmin();

        $this->actingAs($admin)->getJson('/api/v1/admin/analytics?date_from=abc')
            ->assertUnprocessable()->assertJsonValidationErrors('date_from');
        $this->actingAs($admin)->getJson('/api/v1/admin/analytics?date_from=2026-10-10&date_to=2026-10-01')
            ->assertUnprocessable()->assertJsonValidationErrors('date_to');
        $this->actingAs($admin)->getJson('/api/v1/admin/analytics?date_to='.now()->toDateString())
            ->assertOk();
    }

    public function test_shift_started_before_the_window_but_earning_in_it_counts_once(): void
    {
        $admin = $this->makeAdmin();
        $windowStart = now()->subDays(29)->startOfDay(); // default 30-day window
        ShiftLog::whereKey($this->shiftId)->update([
            'time_in' => $windowStart->copy()->subHours(2), // the night before the window
            'time_out' => $windowStart->copy()->addHours(4), // a 6h shift
        ]);
        $this->makeTransaction('PAID', 'CASH', 40.00, $windowStart->copy()->addHour(), ['total_passengers' => 1]);

        $data = $this->actingAs($admin)->getJson('/api/v1/admin/analytics')->assertOk()->json('data');

        $this->assertSame(1, $data['service']['shifts_run']);
        $this->assertSame(360, $data['service']['avg_shift_minutes']);
        $this->assertSame(1, $data['performance']['units'][0]['shifts']);
        $this->assertEquals(40.0, $data['performance']['units'][0]['revenue']);
    }

    public function test_analytics_forbidden_for_non_admin(): void
    {
        $conductor = User::create([
            'email' => 'c2@test.com', 'password' => Hash::make('x'), 'role' => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id' => $conductor->id, 'first_name' => 'C', 'last_name' => 'Two',
            'birthday' => '1990-01-01', 'generated_username' => 'c_two', 'generated_password' => Hash::make('x'),
        ]);

        $this->actingAs($conductor)->getJson('/api/v1/admin/analytics')->assertStatus(403);
    }
}
