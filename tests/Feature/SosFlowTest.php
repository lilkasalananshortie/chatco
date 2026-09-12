<?php

namespace Tests\Feature;

use App\Models\Announcement;
use App\Models\SosAlert;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Sprint 6 (T5) — SOS alert workflow.
 *
 * Covers commuter trigger (with rate limit) + admin acknowledge/resolve.
 *
 * Endpoints:
 *   Commuter:
 *     POST /api/v1/commuter/sos  (COMMUTER, throttle:sos = 1/min)
 *   Admin:
 *     GET   /api/v1/admin/sos                      — paginated feed (default ACTIVE)
 *     PATCH /api/v1/admin/sos/{id}/acknowledge     — ACTIVE → ACKNOWLEDGED
 *     PATCH /api/v1/admin/sos/{id}/resolve         — any → RESOLVED
 *
 * NOTE on rate-limit testing: the throttle:sos limiter (1/min) persists
 * across requests in the same test because the cache store is 'array' (per
 * phpunit.xml) and is NOT cleared by RefreshDatabase. To test the 429 path
 * we use a FRESH commuter for the 2nd request — different user_id = different
 * rate-limit bucket = the 2nd request succeeds, proving the limiter is
 * keyed per-user (not per-IP).
 */
class SosFlowTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $commuter;
    private User $conductor;

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()->admin()->create();
        $this->commuter = User::factory()->commuter()->create();
        $this->conductor = User::factory()->conductor()->create();
    }

    private function admin(): void
    {
        Sanctum::actingAs($this->admin);
    }

    private function commuter(): void
    {
        Sanctum::actingAs($this->commuter);
    }

    // ── POST /commuter/sos (trigger) ────────────────────────────

    public function test_commuter_can_trigger_sos(): void
    {
        $this->commuter();
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat'  => 14.5995,
            'lng'  => 120.9842,
            'note' => 'Feeling unsafe',
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.status', 'ACTIVE')
            ->assertJsonPath('data.note', 'Feeling unsafe');

        $this->assertDatabaseHas('sos_alerts', [
            'commuter_id' => $this->commuter->commuterProfile->id,
            'status'      => 'ACTIVE',
            'note'        => 'Feeling unsafe',
        ]);
    }

    public function test_commuter_sos_notifies_every_admin(): void
    {
        $otherAdmin = User::factory()->admin()->create();

        $this->commuter();
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat'  => 14.5995,
            'lng'  => 120.9842,
            'note' => 'Feeling unsafe',
        ]);
        $alertId = $response->json('data.id');

        foreach ([$this->admin, $otherAdmin] as $recipient) {
            $notification = Announcement::where('type', 'SOS_TRIGGERED')
                ->where('user_id', $recipient->id)
                ->first();
            $this->assertNotNull($notification, "Admin {$recipient->id} was not notified.");
            $this->assertStringContainsString('Commuter', $notification->message);
            // reference_id names the alert so the admin bell can deep-link
            // straight to it (scrolled + highlighted) on Live Monitoring.
            $this->assertSame($alertId, $notification->reference_id);
        }
        $this->assertSame(2, Announcement::where('type', 'SOS_TRIGGERED')->count());
    }

    public function test_sos_requires_lat_and_lng(): void
    {
        $this->commuter();
        $response = $this->postJson('/api/v1/commuter/sos', [
            'note' => 'Help',
        ]);

        $response->assertStatus(422);
    }

    public function test_sos_rejects_invalid_lat(): void
    {
        $this->commuter();
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat' => 999, // out of range
            'lng' => 120.9842,
        ]);

        $response->assertStatus(422);
    }

    public function test_sos_rejects_invalid_lng(): void
    {
        $this->commuter();
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 999, // out of range
        ]);

        $response->assertStatus(422);
    }

    public function test_admin_cannot_trigger_sos(): void
    {
        $this->admin();
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $response->assertStatus(403);
    }

    public function test_conductor_cannot_trigger_sos(): void
    {
        Sanctum::actingAs($this->conductor);
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $response->assertStatus(403);
    }

    public function test_unauthenticated_cannot_trigger_sos(): void
    {
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $response->assertStatus(401);
    }

    public function test_second_sos_from_same_commuter_within_minute_returns_429(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ])->assertStatus(201);

        // 2nd request from SAME commuter → 429 (rate limit)
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $response->assertStatus(429);
    }

    public function test_second_sos_from_different_commuter_succeeds(): void
    {
        // First commuter triggers
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ])->assertStatus(201);

        // Different commuter triggers → 201 (rate limiter is per-user, not per-IP)
        $otherCommuter = User::factory()->commuter()->create();
        Sanctum::actingAs($otherCommuter);
        $response = $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.6000,
            'lng' => 120.9850,
        ]);

        $response->assertStatus(201);
    }

    // ── GET /admin/sos (list) ───────────────────────────────────

    public function test_admin_can_list_sos_alerts(): void
    {
        // Create an alert as commuter
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $response = $this->getJson('/api/v1/admin/sos');

        $response->assertStatus(200)
            ->assertJsonPath('success', true);
        $items = $response->json('data.data');
        $this->assertNotEmpty($items);
    }

    public function test_admin_list_defaults_to_active_only(): void
    {
        // Create an alert + resolve it
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $this->patchJson("/api/v1/admin/sos/{$alert->id}/resolve");

        // List defaults to ACTIVE → should be empty now
        $response = $this->getJson('/api/v1/admin/sos');
        $items = $response->json('data.data');
        $this->assertEmpty($items);
    }

    public function test_admin_list_with_status_all_returns_everything(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $this->patchJson("/api/v1/admin/sos/{$alert->id}/resolve");

        // status=ALL → returns the resolved alert
        $response = $this->getJson('/api/v1/admin/sos?status=ALL');
        $items = $response->json('data.data');
        $this->assertNotEmpty($items);
    }

    public function test_commuter_cannot_list_admin_sos(): void
    {
        $this->commuter();
        $response = $this->getJson('/api/v1/admin/sos');
        $response->assertStatus(403);
    }

    // ── PATCH /admin/sos/{id}/acknowledge ───────────────────────

    public function test_admin_can_acknowledge_sos(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $response = $this->patchJson("/api/v1/admin/sos/{$alert->id}/acknowledge");

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'ACKNOWLEDGED');

        $this->assertDatabaseHas('sos_alerts', [
            'id'              => $alert->id,
            'status'          => 'ACKNOWLEDGED',
            'acknowledged_by' => $this->admin->id,
        ]);
        $this->assertNotNull(SosAlert::find($alert->id)->acknowledged_at);
    }

    public function test_acknowledge_is_idempotent(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $this->patchJson("/api/v1/admin/sos/{$alert->id}/acknowledge")->assertStatus(200);
        $response = $this->patchJson("/api/v1/admin/sos/{$alert->id}/acknowledge");
        $response->assertStatus(200); // still 200, no error
    }

    public function test_cannot_acknowledge_resolved_alert(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $this->patchJson("/api/v1/admin/sos/{$alert->id}/resolve");

        $response = $this->patchJson("/api/v1/admin/sos/{$alert->id}/acknowledge");
        $response->assertStatus(422);
    }

    public function test_commuter_cannot_acknowledge(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $alert = SosAlert::first();
        // Still acting as commuter
        $response = $this->patchJson("/api/v1/admin/sos/{$alert->id}/acknowledge");
        $response->assertStatus(403);
    }

    // ── PATCH /admin/sos/{id}/resolve ───────────────────────────

    public function test_admin_can_resolve_active_alert(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $response = $this->patchJson("/api/v1/admin/sos/{$alert->id}/resolve");

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'RESOLVED');

        $this->assertDatabaseHas('sos_alerts', [
            'id'          => $alert->id,
            'status'      => 'RESOLVED',
            'resolved_by' => $this->admin->id,
        ]);
        $this->assertNotNull(SosAlert::find($alert->id)->resolved_at);
    }

    public function test_admin_can_resolve_acknowledged_alert(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $this->patchJson("/api/v1/admin/sos/{$alert->id}/acknowledge");
        $response = $this->patchJson("/api/v1/admin/sos/{$alert->id}/resolve");

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'RESOLVED');
    }

    public function test_cannot_resolve_already_resolved(): void
    {
        $this->commuter();
        $this->postJson('/api/v1/commuter/sos', [
            'lat' => 14.5995,
            'lng' => 120.9842,
        ]);

        $this->admin();
        $alert = SosAlert::first();
        $this->patchJson("/api/v1/admin/sos/{$alert->id}/resolve");
        $response = $this->patchJson("/api/v1/admin/sos/{$alert->id}/resolve");

        $response->assertStatus(422);
    }

    public function test_acknowledge_nonexistent_returns_404(): void
    {
        $this->admin();
        $response = $this->patchJson('/api/v1/admin/sos/nonexistent-id/acknowledge');
        $response->assertStatus(404);
    }

    public function test_resolve_nonexistent_returns_404(): void
    {
        $this->admin();
        $response = $this->patchJson('/api/v1/admin/sos/nonexistent-id/resolve');
        $response->assertStatus(404);
    }
}
