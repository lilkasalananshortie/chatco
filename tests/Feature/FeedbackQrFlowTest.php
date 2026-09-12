<?php

namespace Tests\Feature;

use App\Enums\PaymentMethod;
use App\Enums\PaymentStatus;
use App\Enums\ShiftStatus;
use App\Models\Driver;
use App\Models\Feedback;
use App\Models\ShiftLog;
use App\Models\Transaction;
use App\Models\User;
use App\Models\Vehicle;
use App\Services\QrTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Sprint 6 — Feedback Unit-QR flow.
 *
 * Covers the 3 repurposed QR endpoints + the new feedback submission route:
 *   POST /api/v1/qr/generate        (ADMIN)
 *   POST /api/v1/qr/validate        (COMMUTER)
 *   POST /api/v1/qr/scan            (COMMUTER)
 *   POST /api/v1/commuter/feedback  (COMMUTER)
 *
 * Acceptance criteria verified:
 *   - Admin can issue a signed unit-QR for a vehicle
 *   - Commuter can validate a valid token (signature + expiry OK)
 *   - Tampered payload → signature mismatch → 422
 *   - Expired token → 422
 *   - Scan resolves today's driver + conductor from shift_logs
 *   - Scan returns 404 when no shift exists for the unit today
 *   - Commuter can submit feedback (201, DB record with correct crew)
 *   - Duplicate feedback (same commuter + shift) → 409
 *   - Role enforcement: commuter can't generate, admin can't validate/scan
 *   - Unauthenticated → 401
 */
class FeedbackQrFlowTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private User $commuter;

    private User $conductor;

    private Vehicle $vehicle;

    private Driver $driver;

    private ShiftLog $shift;

    private QrTokenService $qrTokens;

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()->admin()->create();
        $this->commuter = User::factory()->commuter()->create();
        $this->conductor = User::factory()->conductor()->create();
        $this->vehicle = Vehicle::factory()->create();
        $this->driver = Driver::factory()->create();

        // Today's active shift for the vehicle — the "crew on duty" the QR
        // scan should resolve.
        $this->shift = ShiftLog::create([
            'shift_id' => 'SFT-TEST-'.now()->format('YmdHis'),
            'conductor_id' => $this->conductor->id,
            'driver_id' => $this->driver->id,
            'vehicle_id' => $this->vehicle->id,
            'route_id' => null,
            'conductor_name' => 'Test Conductor',
            'driver_name' => 'Test Driver',
            'unit_number' => $this->vehicle->unit_number,
            'plate_number' => $this->vehicle->plate_number,
            'time_in' => now(),
            'time_out' => null,
            'is_active' => true,
            'status' => ShiftStatus::ACTIVE->value,
        ]);

        $this->qrTokens = QrTokenService::fromConfig();
        $this->createRideFor($this->commuter);
    }

    private function adminToken(): string
    {
        return $this->admin->createToken('test')->plainTextToken;
    }

    private function commuterToken(): string
    {
        return $this->commuter->createToken('test')->plainTextToken;
    }

    private function generateTokenForVehicle(): string
    {
        $issued = $this->qrTokens->issue($this->vehicle->id);

        return $issued['token'];
    }

    private function createRideFor(User $commuter, array $overrides = []): Transaction
    {
        return Transaction::forceCreate(array_merge([
            'transaction_id' => 'TXN-FB-'.strtoupper(Str::random(12)),
            'shift_id' => $this->shift->shift_id,
            'payment_method' => PaymentMethod::CASH->value,
            'status' => PaymentStatus::PAID->value,
            'final_amount' => 15,
            'passenger_id' => $commuter->commuterProfile->id,
            'payer_id' => $commuter->commuterProfile->id,
            'pickup_name' => 'Test Pickup',
            'dropoff_name' => 'Test Dropoff',
            'conductor_name' => 'Test Conductor',
            'driver_name' => 'Test Driver',
            'unit_number' => $this->vehicle->unit_number,
            'paid_at' => now(),
            'reward_eligible' => true,
        ], $overrides));
    }

    // ── POST /qr/generate (ADMIN) ──────────────────────────────

    public function test_admin_can_generate_qr_for_vehicle(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->adminToken())
            ->postJson('/api/v1/qr/generate', [
                'vehicle_id' => $this->vehicle->id,
            ]);

        $response->assertStatus(201)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.payload.vehicle_id', $this->vehicle->id)
            ->assertJsonStructure([
                'data' => ['token', 'payload', 'signature', 'expires_at'],
            ]);

        // Token format: base64url(json) . '.' . hex_sig
        $token = $response->json('data.token');
        $this->assertStringContainsString('.', $token);
        [$b64, $sig] = explode('.', $token);
        $this->assertEquals(64, strlen($sig), 'HMAC-SHA256 signature must be 64 hex chars');
    }

    public function test_generate_rejects_nonexistent_vehicle(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->adminToken())
            ->postJson('/api/v1/qr/generate', [
                'vehicle_id' => 'nonexistent-uuid',
            ]);

        $response->assertStatus(422);
    }

    public function test_commuter_cannot_generate_qr(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/generate', [
                'vehicle_id' => $this->vehicle->id,
            ]);

        $response->assertStatus(403);
    }

    public function test_unauthenticated_cannot_generate_qr(): void
    {
        $response = $this->postJson('/api/v1/qr/generate', [
            'vehicle_id' => $this->vehicle->id,
        ]);

        $response->assertStatus(401);
    }

    // ── POST /qr/validate (COMMUTER) ───────────────────────────

    public function test_commuter_can_validate_valid_token(): void
    {
        $token = $this->generateTokenForVehicle();

        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/validate', ['token' => $token]);

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.valid', true)
            ->assertJsonPath('data.vehicle_id', $this->vehicle->id);
    }

    public function test_validate_rejects_tampered_signature(): void
    {
        $token = $this->generateTokenForVehicle();
        [$b64, $sig] = explode('.', $token);

        // Flip the last char of the signature — breaks HMAC comparison.
        $lastChar = substr($sig, -1);
        $flipped = $lastChar === 'a' ? 'b' : 'a';
        $tamperedSig = substr($sig, 0, -1).$flipped;
        $tamperedToken = $b64.'.'.$tamperedSig;

        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/validate', ['token' => $tamperedToken]);

        $response->assertStatus(422)
            ->assertJsonPath('success', false)
            ->assertJsonPath('message', 'Invalid signature');
    }

    public function test_validate_rejects_tampered_payload(): void
    {
        $token = $this->generateTokenForVehicle();
        [$b64, $sig] = explode('.', $token);

        // Decode the payload, change the vehicle_id, re-encode WITHOUT
        // re-signing. The signature won't match the new payload.
        $json = base64_decode(strtr($b64, '-_', '+/'));
        $payload = json_decode($json, true);
        $payload['vehicle_id'] = 'tampered-vehicle-id';
        $newJson = json_encode($payload, JSON_UNESCAPED_SLASHES);
        $newB64 = rtrim(strtr(base64_encode($newJson), '+/', '-_'), '=');
        $tamperedToken = $newB64.'.'.$sig;

        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/validate', ['token' => $tamperedToken]);

        $response->assertStatus(422)
            ->assertJsonPath('message', 'Invalid signature');
    }

    public function test_validate_rejects_expired_token(): void
    {
        // Issue a token, then decode + set expires_at to the past + re-sign
        // with the known secret so the signature check passes but the expiry
        // check fails.
        $issued = $this->qrTokens->issue($this->vehicle->id);
        $payload = $issued['payload'];
        $payload['expires_at'] = now()->subMinute()->toIso8601String();

        $secret = (string) config('qr.feedback_secret');
        if ($secret === '') {
            $secret = (string) config('app.key');
        }

        $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $sig = hash_hmac('sha256', $json, $secret);
        $b64 = rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
        $expiredToken = $b64.'.'.$sig;

        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/validate', ['token' => $expiredToken]);

        $response->assertStatus(422)
            ->assertJsonPath('message', 'Token expired');
    }

    public function test_validate_rejects_malformed_token(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/validate', ['token' => 'not-a-valid-token-format']);

        $response->assertStatus(422)
            ->assertJsonPath('message', 'Malformed token');
    }

    public function test_admin_cannot_validate_qr(): void
    {
        $token = $this->generateTokenForVehicle();

        $response = $this->withHeader('Authorization', 'Bearer '.$this->adminToken())
            ->postJson('/api/v1/qr/validate', ['token' => $token]);

        $response->assertStatus(403);
    }

    // ── POST /qr/scan (COMMUTER) ───────────────────────────────

    public function test_scan_returns_today_crew(): void
    {
        $token = $this->generateTokenForVehicle();

        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/scan', ['token' => $token]);

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.shift_id', $this->shift->shift_id)
            ->assertJsonPath('data.vehicle_id', $this->vehicle->id)
            ->assertJsonPath('data.driver_id', $this->driver->id)
            ->assertJsonPath('data.driver_name', 'Test Driver')
            ->assertJsonPath('data.conductor_id', $this->conductor->id)
            ->assertJsonPath('data.conductor_name', 'Test Conductor')
            ->assertJsonPath('data.unit_number', $this->vehicle->unit_number)
            ->assertJsonPath('data.plate_number', $this->vehicle->plate_number);
    }

    public function test_scan_returns_404_when_no_shift_today(): void
    {
        // Generate a token for a different vehicle that has no shift today.
        $otherVehicle = Vehicle::factory()->create();
        $issued = $this->qrTokens->issue($otherVehicle->id);

        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/scan', ['token' => $issued['token']]);

        $response->assertStatus(404)
            ->assertJsonPath('success', false)
            ->assertJsonPath('message', 'No active crew for this unit today');
    }

    public function test_scan_rejects_invalid_token(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/scan', ['token' => 'garbage.payload']);

        $response->assertStatus(422);
    }

    // ── POST /commuter/feedback (COMMUTER) ─────────────────────

    public function test_commuter_can_submit_feedback(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 5,
                'category' => 'driving',
                'comment' => 'Smooth ride, very professional.',
                'conductor_rating' => 4,
                'conductor_category' => 'courtesy',
                'conductor_comment' => 'Polite and helpful.',
            ]);

        $response->assertStatus(201)
            ->assertJsonPath('success', true)
            ->assertJsonPath('message', 'Feedback submitted');

        // DB record has the correct crew derived from the shift — NOT from
        // client input (which never included vehicle/driver/conductor IDs).
        $this->assertDatabaseHas('feedback', [
            'shift_id' => $this->shift->shift_id,
            'vehicle_id' => $this->vehicle->id,
            'driver_id' => $this->driver->id,
            'conductor_id' => $this->conductor->id,
            'commuter_id' => $this->commuter->id,
            'rating' => 5,
            'category' => 'driving',
            'comment' => 'Smooth ride, very professional.',
            'conductor_rating' => 4,
            'conductor_category' => 'courtesy',
            'conductor_comment' => 'Polite and helpful.',
        ]);
    }

    public function test_feedback_rejects_commuter_with_no_transaction_for_shift(): void
    {
        Transaction::query()->delete();

        $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 5,
                'conductor_rating' => 5,
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Feedback is only available after your completed ride on this shift');

        $this->assertDatabaseCount('feedback', 0);
    }

    public function test_feedback_rejects_transaction_belonging_to_another_commuter(): void
    {
        Transaction::query()->delete();
        $otherCommuter = User::factory()->commuter()->create();
        $this->createRideFor($otherCommuter);

        $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 4,
                'conductor_rating' => 4,
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Feedback is only available after your completed ride on this shift');

        $this->assertDatabaseCount('feedback', 0);
    }

    public function test_feedback_rejects_every_non_paid_transaction_status(): void
    {
        Transaction::query()->delete();

        foreach ([
            PaymentStatus::PENDING,
            PaymentStatus::PROCESSING,
            PaymentStatus::FAILED,
            PaymentStatus::CANCELLED,
            PaymentStatus::REFUNDED,
            PaymentStatus::EXPIRED,
        ] as $status) {
            $this->createRideFor($this->commuter, [
                'status' => $status->value,
                'paid_at' => $status === PaymentStatus::REFUNDED ? now() : null,
            ]);
        }

        $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 3,
                'conductor_rating' => 3,
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Feedback is only available after your completed ride on this shift');

        $this->assertDatabaseCount('feedback', 0);
    }

    public function test_feedback_rejects_paid_transaction_pending_reconciliation(): void
    {
        Transaction::query()->update([
            'payment_reconciliation_status' => 'REFUND_REQUIRED',
            'reward_eligible' => false,
        ]);

        $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 3,
                'conductor_rating' => 3,
            ])
            ->assertStatus(422)
            ->assertJsonPath('message', 'Feedback is only available after your completed ride on this shift');

        $this->assertDatabaseCount('feedback', 0);
    }

    public function test_feedback_min_rating_accepted(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 1,
                'conductor_rating' => 1,
            ]);

        $response->assertStatus(201);
    }

    public function test_feedback_rejects_missing_conductor_rating(): void
    {
        // Since the driver/conductor rating split, the conductor rating is
        // required alongside the driver rating.
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 5,
            ]);

        $response->assertStatus(422)
            ->assertJsonStructure(['errors' => ['conductor_rating']]);
    }

    public function test_feedback_rejects_rating_out_of_range(): void
    {
        // conductor_rating is valid so the 422 is attributable to `rating`.
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 6,
                'conductor_rating' => 3,
            ]);

        $response->assertStatus(422)
            ->assertJsonStructure(['errors' => ['rating']]);
    }

    public function test_feedback_rejects_rating_zero(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 0,
                'conductor_rating' => 3,
            ]);

        $response->assertStatus(422)
            ->assertJsonStructure(['errors' => ['rating']]);
    }

    public function test_duplicate_feedback_returns_409(): void
    {
        // First submission succeeds.
        $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 4,
                'conductor_rating' => 4,
            ]);

        // Second submission for the same shift → 409 (unique constraint).
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 2,
                'conductor_rating' => 2,
            ]);

        $response->assertStatus(409)
            ->assertJsonPath('success', false)
            ->assertJsonPath('message', 'You have already submitted feedback for this shift');

        // Only one feedback row exists.
        $this->assertEquals(1, Feedback::where('shift_id', $this->shift->shift_id)->count());
    }

    public function test_feedback_rejects_nonexistent_shift(): void
    {
        // conductor_rating is valid so the 422 is attributable to the shift.
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => 'SFT-DOES-NOT-EXIST',
                'rating' => 3,
                'conductor_rating' => 3,
            ]);

        $response->assertStatus(422);
    }

    public function test_different_commuters_can_submit_feedback_for_same_shift(): void
    {
        $otherCommuter = User::factory()->commuter()->create();
        $this->createRideFor($otherCommuter);

        // Use Sanctum::actingAs() instead of Bearer tokens for multi-user
        // tests: the sanctum guard caches the resolved user on the (reused)
        // app instance across requests in the same test, so a Bearer token
        // on the 2nd request would be ignored in favour of the cached 1st
        // user. actingAs() calls setUser() which overwrites the cache.
        Sanctum::actingAs($this->commuter);
        $this->postJson('/api/v1/commuter/feedback', [
            'shift_id' => $this->shift->shift_id,
            'rating' => 5,
            'conductor_rating' => 5,
        ]);

        Sanctum::actingAs($otherCommuter);
        $response = $this->postJson('/api/v1/commuter/feedback', [
            'shift_id' => $this->shift->shift_id,
            'rating' => 3,
            'conductor_rating' => 3,
        ]);

        $response->assertStatus(201);
        $this->assertEquals(2, Feedback::where('shift_id', $this->shift->shift_id)->count());
    }

    public function test_admin_cannot_submit_feedback(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->adminToken())
            ->postJson('/api/v1/commuter/feedback', [
                'shift_id' => $this->shift->shift_id,
                'rating' => 5,
            ]);

        $response->assertStatus(403);
    }

    public function test_unauthenticated_cannot_submit_feedback(): void
    {
        $response = $this->postJson('/api/v1/commuter/feedback', [
            'shift_id' => $this->shift->shift_id,
            'rating' => 5,
        ]);

        $response->assertStatus(401);
    }

    // ── POST /qr/scan-public (COMMUTER) — permanent unit-QR ──────

    /**
     * The permanent unit-QR flow: the commuter scans the QR printed inside
     * the jeepney, the frontend extracts the vehicle_id, and this endpoint
     * resolves TODAY's driver + conductor from shift_logs — the daily
     * assignment recorded when the conductor logged in for the day.
     */
    public function test_scan_public_resolves_today_crew(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/scan-public', [
                'vehicle_id' => $this->vehicle->id,
            ]);

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.shift_id', $this->shift->shift_id)
            ->assertJsonPath('data.vehicle_id', $this->vehicle->id)
            ->assertJsonPath('data.driver_id', $this->driver->id)
            ->assertJsonPath('data.driver_name', 'Test Driver')
            ->assertJsonPath('data.conductor_id', $this->conductor->id)
            ->assertJsonPath('data.conductor_name', 'Test Conductor')
            ->assertJsonPath('data.unit_number', $this->vehicle->unit_number)
            ->assertJsonPath('data.plate_number', $this->vehicle->plate_number);
    }

    public function test_scan_public_returns_404_when_no_shift_today(): void
    {
        // A vehicle with no shift_logs row for today.
        $otherVehicle = Vehicle::factory()->create();

        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/scan-public', [
                'vehicle_id' => $otherVehicle->id,
            ]);

        $response->assertStatus(404)
            ->assertJsonPath('success', false)
            ->assertJsonPath('message', 'No active crew for this unit today');
    }

    public function test_scan_public_rejects_missing_vehicle_id(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/scan-public', []);

        $response->assertStatus(422);
    }

    public function test_scan_public_rejects_nonexistent_vehicle(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->commuterToken())
            ->postJson('/api/v1/qr/scan-public', [
                'vehicle_id' => '00000000-0000-0000-0000-000000000000',
            ]);

        $response->assertStatus(422);
    }

    public function test_admin_cannot_scan_public(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer '.$this->adminToken())
            ->postJson('/api/v1/qr/scan-public', [
                'vehicle_id' => $this->vehicle->id,
            ]);

        $response->assertStatus(403);
    }

    public function test_scan_public_requires_authentication(): void
    {
        $response = $this->postJson('/api/v1/qr/scan-public', [
            'vehicle_id' => $this->vehicle->id,
        ]);

        $response->assertStatus(401);
    }
}
