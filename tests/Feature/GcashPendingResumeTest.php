<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\FarePoint;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * GCash pending-payment lifecycle: resume, no-duplicates, 3-minute expiry.
 *
 *   POST /conductor/payments/gcash/initiate — reuses a fresh PENDING txn
 *   GET  /conductor/payments/gcash/pending  — resumable txn or null
 *   GET  /payments/{id}/status              — lazily expires stale PENDING
 *   POST /commuter/payments/claim           — flips stale txn to EXPIRED (410)
 *
 * Verifies:
 *   - initiate twice → SAME transaction (no duplicate pending QRs)
 *   - pending endpoint returns the resumable txn with the same qr_token
 *   - pending endpoint returns null when nothing is pending / after cancel
 *   - status poll flips a stale PENDING to EXPIRED (lazy, no cron)
 *   - initiate after expiry creates a NEW transaction; old one is EXPIRED
 *   - claiming an expired QR → 410 and the row is marked EXPIRED
 *   - a PAID transaction is never expired by the lazy check
 */
class GcashPendingResumeTest extends TestCase
{
    use RefreshDatabase;

    private User $conductor;

    private User $commuter;

    private ShiftLog $shift;

    private FarePoint $pickup;

    private FarePoint $dropoff;

    protected function setUp(): void
    {
        parent::setUp();

        $this->conductor = User::create([
            'email' => 'conductor@test.com', 'password' => bcrypt('password'), 'role' => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id' => $this->conductor->id, 'first_name' => 'Conductor', 'last_name' => 'One',
            'birthday' => '1990-01-01', 'generated_username' => 'conductor1', 'generated_password' => bcrypt('password'),
        ]);

        $this->commuter = User::create([
            'email' => 'commuter@test.com', 'password' => bcrypt('password'), 'role' => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id' => $this->commuter->id, 'first_name' => 'Commuter', 'surname' => 'One', 'birthdate' => '1990-01-01',
            'gender' => 'Male', 'email' => 'commuter@test.com', 'contact_number' => '+639171112222',
            'commuter_type' => 'Regular', 'username' => 'commuter1', 'language_preference' => 'en',
            'account_status' => 'ACTIVE', 'verified_at' => now(),
        ]);

        $driver = Driver::create([
            'first_name' => 'Test', 'last_name' => 'Driver', 'birthday' => '1990-01-01', 'contact' => '+639171112222',
            'license_number' => 'DL-TEST-001', 'hire_date' => '2023-01-01', 'status' => 'ACTIVE',
        ]);
        $route = Route::create(['name' => 'Test Route', 'status' => 'ACTIVE', 'waypoints' => []]);
        $this->pickup = FarePoint::create([
            'route_id' => $route->id,
            'point_number' => 1,
            'code' => 'MEY',
            'name' => 'Meycauayan',
            'regular_fare' => 0,
            'discounted_fare' => 0,
        ]);
        $this->dropoff = FarePoint::create([
            'route_id' => $route->id,
            'point_number' => 2,
            'code' => 'CAL',
            'name' => 'Calumpit',
            'regular_fare' => 25,
            'discounted_fare' => 20,
        ]);
        $vehicle = Vehicle::create([
            'unit_number' => 'TEST-001', 'plate_number' => 'TEST-1234', 'route_id' => $route->id,
            'driver_id' => $driver->id, 'conductor_id' => $this->conductor->id, 'status' => 'ACTIVE',
        ]);
        $this->shift = ShiftLog::forceCreate([
            'shift_id' => 'SFT-TEST-1', 'conductor_id' => $this->conductor->id, 'driver_id' => $driver->id,
            'vehicle_id' => $vehicle->id, 'route_id' => $route->id, 'conductor_name' => 'Conductor One',
            'driver_name' => 'Test Driver', 'unit_number' => 'TEST-001', 'plate_number' => 'TEST-1234',
            'time_in' => now(), 'time_out' => null, 'is_active' => true, 'status' => 'ACTIVE',
        ]);
    }

    private function initiate(): TestResponse
    {
        Sanctum::actingAs($this->conductor);

        return $this->postJson('/api/v1/conductor/payments/gcash/initiate', [
            'payment_method' => 'GCASH',
            'final_amount' => 25.00,
            'pickup_stop_id' => $this->pickup->id,
            'dropoff_stop_id' => $this->dropoff->id,
            'pickup_name' => 'Meycauayan',
            'dropoff_name' => 'Calumpit',
        ]);
    }

    // ── No duplicate pending transactions ───────────────────────

    public function test_initiate_twice_reuses_the_same_pending_transaction(): void
    {
        $first = $this->initiate()->assertStatus(201);
        $second = $this->initiate()->assertStatus(201);

        $this->assertEquals(
            $first->json('data.transaction_id'),
            $second->json('data.transaction_id'),
        );
        $this->assertEquals(
            $first->json('data.qr_token'),
            $second->json('data.qr_token'),
        );
        $this->assertEquals(1, Transaction::where('shift_id', $this->shift->shift_id)->count());
    }

    // ── Resume endpoint ─────────────────────────────────────────

    public function test_pending_endpoint_returns_the_resumable_transaction(): void
    {
        $initiated = $this->initiate()->assertStatus(201);

        $response = $this->getJson('/api/v1/conductor/payments/gcash/pending');

        $response->assertStatus(200)
            ->assertJsonPath('data.transaction_id', $initiated->json('data.transaction_id'))
            ->assertJsonPath('data.qr_token', $initiated->json('data.qr_token'))
            ->assertJsonPath('data.pickup_name', 'Meycauayan')
            ->assertJsonPath('data.dropoff_name', 'Calumpit')
            ->assertJsonStructure(['data' => ['amount', 'expires_at']]);
    }

    public function test_pending_endpoint_returns_null_when_nothing_pending(): void
    {
        Sanctum::actingAs($this->conductor);

        $this->getJson('/api/v1/conductor/payments/gcash/pending')
            ->assertStatus(200)
            ->assertJsonPath('data', null);
    }

    public function test_pending_endpoint_returns_null_after_cancel(): void
    {
        $initiated = $this->initiate()->assertStatus(201);
        $id = $initiated->json('data.transaction_id');

        $this->postJson("/api/v1/payments/{$id}/cancel")->assertStatus(200);

        $this->getJson('/api/v1/conductor/payments/gcash/pending')
            ->assertStatus(200)
            ->assertJsonPath('data', null);
    }

    // ── Automatic (lazy) expiration ─────────────────────────────

    public function test_status_poll_expires_a_stale_pending_transaction(): void
    {
        $initiated = $this->initiate()->assertStatus(201);
        $id = $initiated->json('data.transaction_id');

        // Past the 3-minute TTL…
        $this->travel(4)->minutes();

        $this->getJson("/api/v1/payments/{$id}/status")
            ->assertStatus(200)
            ->assertJsonPath('data.status', 'EXPIRED');

        $this->assertDatabaseHas('transactions', [
            'transaction_id' => $id,
            'status' => 'EXPIRED',
        ]);
    }

    public function test_initiate_after_expiry_creates_a_new_transaction(): void
    {
        $first = $this->initiate()->assertStatus(201);

        $this->travel(4)->minutes();

        $second = $this->initiate()->assertStatus(201);

        $this->assertNotEquals(
            $first->json('data.transaction_id'),
            $second->json('data.transaction_id'),
        );
        // The stale one was lazily expired by the reuse check.
        $this->assertDatabaseHas('transactions', [
            'transaction_id' => $first->json('data.transaction_id'),
            'status' => 'EXPIRED',
        ]);
    }

    public function test_pending_endpoint_hides_and_expires_a_stale_transaction(): void
    {
        $initiated = $this->initiate()->assertStatus(201);

        $this->travel(4)->minutes();

        $this->getJson('/api/v1/conductor/payments/gcash/pending')
            ->assertStatus(200)
            ->assertJsonPath('data', null);

        $this->assertDatabaseHas('transactions', [
            'transaction_id' => $initiated->json('data.transaction_id'),
            'status' => 'EXPIRED',
        ]);
    }

    public function test_claiming_an_expired_qr_returns_410_and_marks_expired(): void
    {
        $initiated = $this->initiate()->assertStatus(201);
        $qrToken = $initiated->json('data.qr_token');

        $this->travel(4)->minutes();

        Sanctum::actingAs($this->commuter);
        $this->postJson('/api/v1/commuter/payments/claim', ['qr_token' => $qrToken])
            ->assertStatus(410);

        $this->assertDatabaseHas('transactions', [
            'transaction_id' => $initiated->json('data.transaction_id'),
            'status' => 'EXPIRED',
        ]);
    }

    public function test_late_provider_settlement_still_marks_an_expired_payment_paid(): void
    {
        // A commuter can claim the QR just before the TTL and finish the
        // provider checkout right after it — money moves, so the webhook
        // must still record the fare (EXPIRED → PAID is allowed).
        config(['payments.allow_simulation' => true]);

        $initiated = $this->initiate()->assertStatus(201);
        $id = $initiated->json('data.transaction_id');

        $this->travel(4)->minutes();

        // Poll flips the stale row to EXPIRED first.
        $this->getJson("/api/v1/payments/{$id}/status")
            ->assertStatus(200)
            ->assertJsonPath('data.status', 'EXPIRED');

        // The (simulated) provider webhook then reports the payment settled.
        $this->postJson("/api/v1/payments/{$id}/simulate", ['status' => 'PAID'])
            ->assertStatus(200);

        $this->assertDatabaseHas('transactions', [
            'transaction_id' => $id,
            'status' => 'PAID',
        ]);
    }

    public function test_paid_transaction_is_never_lazily_expired(): void
    {
        $initiated = $this->initiate()->assertStatus(201);
        $id = $initiated->json('data.transaction_id');

        Transaction::where('transaction_id', $id)->update(['status' => 'PAID', 'paid_at' => now()]);

        $this->travel(10)->minutes();

        $this->getJson("/api/v1/payments/{$id}/status")
            ->assertStatus(200)
            ->assertJsonPath('data.status', 'PAID');
    }
}
