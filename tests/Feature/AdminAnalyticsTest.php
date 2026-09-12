<?php

namespace Tests\Feature;

use App\Enums\ShiftStatus;
use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
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
    private function makeTransaction(string $status, string $method, float $amount, ?\DateTimeInterface $createdAt = null): void
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
        ]);

        if ($createdAt !== null) {
            DB::table('transactions')->where('transaction_id', $tx->transaction_id)
                ->update(['created_at' => $createdAt]);
        }
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
