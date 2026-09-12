<?php

namespace Tests\Feature;

use App\Models\Claim;
use App\Models\ClaimRejectionAudit;
use App\Models\LostItem;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Sprint 6 (T3) — Lost & Found workflow (revised scope).
 *
 * Covers the revised S6 scope: admin adds items + uploads images, commuters
 * browse + claim with proof + watchlist, admin approves/rejects claims,
 * approved → released (2-stage: approve then release, with post-approval
 * reject option), admin closes, audit trail via reviewed_by/reviewed_at/
 * rejection_reason on claims.
 *
 * Two-stage approve workflow:
 *   PENDING → (approve) → APPROVED [item → APPROVED] → (release) → item RELEASED
 *   PENDING → (reject)  → REJECTED [item reverts to AVAILABLE if no pending claims]
 *   APPROVED → (reject) → REJECTED [post-approval reversal; item reverts]
 *
 * Endpoints:
 *   GET    /api/v1/lost-found                          (any auth)
 *   GET    /api/v1/lost-found/{itemId}                 (any auth)
 *   POST   /api/v1/lost-found/{itemId}/claim           (COMMUTER)
 *   POST   /api/v1/lost-found/{itemId}/watchlist       (COMMUTER)
 *   DELETE /api/v1/lost-found/{itemId}/watchlist       (COMMUTER)
 *   GET    /api/v1/commuter/watchlist                  (COMMUTER)
 *   GET    /api/v1/admin/lost-items                    (ADMIN)
 *   POST   /api/v1/admin/lost-items                    (ADMIN)
 *   GET    /api/v1/admin/lost-items/{itemId}           (ADMIN)
 *   PATCH  /api/v1/admin/lost-items/{itemId}           (ADMIN)
 *   POST   /api/v1/admin/lost-items/{itemId}/photos    (ADMIN)
 *   DELETE /api/v1/admin/lost-items/{itemId}/photos/{photoId} (ADMIN)
 *   PATCH  /api/v1/admin/lost-items/{itemId}/reactivate (ADMIN)
 *   GET    /api/v1/admin/lost-items/{itemId}/claims    (ADMIN)
 *   PATCH  /api/v1/admin/lost-items/{itemId}/claims/{claimId}/approve  (ADMIN)
 *   PATCH  /api/v1/admin/lost-items/{itemId}/claims/{claimId}/release  (ADMIN)
 *   PATCH  /api/v1/admin/lost-items/{itemId}/claims/{claimId}/reject   (ADMIN)
 *   PATCH  /api/v1/admin/lost-items/{itemId}/close     (ADMIN)
 *
 * Also covers: lost-items:expire (auto-archives stale AVAILABLE items) and
 * the targeted (per-user) announcements created on claim approve/reject.
 */
class LostFoundFlowTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private User $commuter;

    private User $otherCommuter;

    private Vehicle $vehicle;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');

        $this->admin = User::factory()->admin()->create();
        $this->commuter = User::factory()->commuter()->create();
        $this->otherCommuter = User::factory()->commuter()->create();
        $this->vehicle = Vehicle::factory()->create();
    }

    private function admin(): void
    {
        Sanctum::actingAs($this->admin);
    }

    private function commuter(): void
    {
        Sanctum::actingAs($this->commuter);
    }

    private function otherCommuter(): void
    {
        Sanctum::actingAs($this->otherCommuter);
    }

    private function createItem(): LostItem
    {
        $this->admin();
        $response = $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Blue Backpack',
            'description' => 'Navy blue Jansport backpack left near back row',
            'category' => 'BAG',
            'vehicle_id' => $this->vehicle->id,
        ]);
        $response->assertStatus(201);

        return LostItem::where('item_name', 'Blue Backpack')->first();
    }

    // ── Admin: create + list ────────────────────────────────────

    public function test_admin_can_create_lost_item(): void
    {
        $this->admin();
        $response = $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Phone',
            'description' => 'Black Samsung phone',
            'category' => 'ELECTRONICS',
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.status', 'AVAILABLE')
            ->assertJsonPath('data.item_name', 'Phone');

        $this->assertDatabaseHas('lost_items', [
            'item_name' => 'Phone',
            'status' => 'AVAILABLE',
        ]);
    }

    public function test_commuter_cannot_create_lost_item(): void
    {
        $this->commuter();
        $response = $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Phone',
            'description' => 'Black Samsung phone',
        ]);

        $response->assertStatus(403);
    }

    public function test_admin_list_includes_claims(): void
    {
        $item = $this->createItem();
        // Submit a claim as commuter
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my ID inside',
        ]);

        $this->admin();
        $response = $this->getJson('/api/v1/admin/lost-items');

        $response->assertStatus(200)
            ->assertJsonPath('success', true);
        // The items collection should include our item with claims loaded
        $items = $response->json('data.data');
        $this->assertNotEmpty($items);
    }

    // ── Browse (any auth role) ───────────────────────────────────

    public function test_admin_list_filters_by_posted_date(): void
    {
        $this->admin();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Date Filter Wallet',
            'description' => 'Wallet for date filter test',
            'category' => 'WALLET',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Date Filter Umbrella',
            'description' => 'Umbrella for date filter test',
            'category' => 'OTHER',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);

        $targetDate = now()->subDays(2);
        LostItem::where('item_name', 'Date Filter Wallet')->update(['created_at' => $targetDate]);
        LostItem::where('item_name', 'Date Filter Umbrella')->update(['created_at' => now()]);

        $response = $this->getJson('/api/v1/admin/lost-items?date='.$targetDate->toDateString());

        $response->assertStatus(200);
        $names = collect($response->json('data.data'))->pluck('item_name');
        $this->assertTrue($names->contains('Date Filter Wallet'));
        $this->assertFalse($names->contains('Date Filter Umbrella'));
    }

    public function test_commuter_browse_filters_by_posted_date(): void
    {
        $this->admin();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Commuter Date Filter Wallet',
            'description' => 'Wallet for commuter date filter test',
            'category' => 'WALLET',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Commuter Date Filter Umbrella',
            'description' => 'Umbrella for commuter date filter test',
            'category' => 'OTHER',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);

        $targetDate = now()->subDays(3);
        LostItem::where('item_name', 'Commuter Date Filter Wallet')->update(['created_at' => $targetDate]);
        LostItem::where('item_name', 'Commuter Date Filter Umbrella')->update(['created_at' => now()]);

        $this->commuter();
        $response = $this->getJson('/api/v1/lost-found?date='.$targetDate->toDateString());

        $response->assertStatus(200);
        $names = collect($response->json('data.data'))->pluck('item_name');
        $this->assertTrue($names->contains('Commuter Date Filter Wallet'));
        $this->assertFalse($names->contains('Commuter Date Filter Umbrella'));
    }

    public function test_any_auth_role_can_browse_lost_found(): void
    {
        $this->createItem();

        $this->commuter();
        $response = $this->getJson('/api/v1/lost-found');

        $response->assertStatus(200)
            ->assertJsonPath('success', true);
        $items = $response->json('data.data');
        $this->assertNotEmpty($items);
    }

    public function test_unauthenticated_cannot_browse(): void
    {
        $response = $this->getJson('/api/v1/lost-found');
        $response->assertStatus(401);
    }

    public function test_browse_filters_by_status(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $response = $this->getJson('/api/v1/lost-found?status=AVAILABLE');
        $response->assertStatus(200);
        $this->assertNotEmpty($response->json('data.data'));

        $response = $this->getJson('/api/v1/lost-found?status=CLOSED');
        $response->assertStatus(200);
        $this->assertEmpty($response->json('data.data'));
    }

    public function test_commuter_browse_searches_plate_driver_and_conductor(): void
    {
        $this->admin();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Searchable Cap',
            'description' => 'Cap left on a seat',
            'category' => 'CLOTHING',
            'vehicle_id' => $this->vehicle->id,
            'plate_number' => 'CHATCO 123',
            'driver_name' => 'Mario Santos',
            'conductor_name' => 'Lina Cruz',
        ])->assertStatus(201);
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Plain Wallet',
            'description' => 'Wallet without matching transport details',
            'category' => 'WALLET',
            'vehicle_id' => $this->vehicle->id,
            'plate_number' => 'OTHER 456',
            'driver_name' => 'Different Driver',
            'conductor_name' => 'Different Conductor',
        ])->assertStatus(201);

        $this->commuter();
        foreach (['CHATCO 123', 'Mario', 'Lina'] as $term) {
            $response = $this->getJson('/api/v1/lost-found?search='.urlencode($term));

            $response->assertStatus(200);
            $names = collect($response->json('data.data'))->pluck('item_name');
            $this->assertTrue($names->contains('Searchable Cap'));
            $this->assertFalse($names->contains('Plain Wallet'));
        }
    }

    public function test_approved_items_are_excluded_from_commuter_browse(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'Has my initials inside']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve")
            ->assertStatus(200);

        $this->commuter();
        $ids = collect($this->getJson('/api/v1/lost-found')->json('data.data'))->pluck('id');
        $this->assertFalse($ids->contains($item->id));
    }

    public function test_released_closed_items_are_excluded_from_commuter_browse(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'Has my initials inside']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve")
            ->assertStatus(200);
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release")
            ->assertStatus(200);

        $this->commuter();
        $ids = collect($this->getJson('/api/v1/lost-found')->json('data.data'))->pluck('id');
        $this->assertFalse($ids->contains($item->id));
    }

    public function test_show_returns_item_detail(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $response = $this->getJson("/api/v1/lost-found/{$item->id}");

        $response->assertStatus(200)
            ->assertJsonPath('data.id', $item->id)
            ->assertJsonPath('data.item_name', 'Blue Backpack');
    }

    public function test_show_returns_404_for_missing_item(): void
    {
        $this->commuter();
        $response = $this->getJson('/api/v1/lost-found/nonexistent-id');
        $response->assertStatus(404);
    }

    // ── Claim (COMMUTER) ────────────────────────────────────────

    public function test_commuter_can_claim_available_item(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.status', 'PENDING');

        $this->assertDatabaseHas('claims', [
            'item_id' => $item->id,
            'status' => 'PENDING',
            'proof' => 'Has my student ID in the front pocket',
        ]);

        // Item status flips to CLAIMED
        $this->assertDatabaseHas('lost_items', [
            'id' => $item->id,
            'status' => 'CLAIMED',
        ]);
    }

    public function test_claim_requires_proof(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", []);

        $response->assertStatus(422);
    }

    public function test_admin_cannot_claim_item(): void
    {
        $item = $this->createItem();

        $this->admin();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'test',
        ]);

        $response->assertStatus(403);
    }

    public function test_cannot_claim_approved_item(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve")
            ->assertStatus(200);

        // Second commuter tries to claim the now-APPROVED item
        $this->otherCommuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $response->assertStatus(422);
    }

    public function test_cannot_claim_released_item(): void
    {
        $item = $this->createItem();

        // Approve + release → item becomes RELEASED
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve")
            ->assertStatus(200);
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release")
            ->assertStatus(200);

        // Second commuter tries to claim the now-RELEASED item
        $this->otherCommuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $response->assertStatus(422);
    }

    public function test_cannot_claim_closed_item(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release");
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/close");

        $this->otherCommuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $response->assertStatus(422);
    }

    public function test_multiple_commuters_can_claim_same_item(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'commuter 1 proof'])
            ->assertStatus(201);

        $this->otherCommuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'commuter 2 proof'])
            ->assertStatus(201);

        $this->assertEquals(2, Claim::where('item_id', $item->id)->count());
    }

    public function test_admin_can_record_a_walk_in_claimant_without_an_account(): void
    {
        $item = $this->createItem();
        $this->admin();

        $this->postJson("/api/v1/admin/lost-items/{$item->id}/claims/manual", [
            'claimant_name' => 'Walk In Claimant',
            'claimant_contact' => '+639171234567',
            'claimant_email' => 'walkin@example.com',
            'proof' => 'Presented a matching bag keychain and a government ID.',
        ])->assertStatus(201)
            ->assertJsonPath('data.claimant_name', 'Walk In Claimant')
            ->assertJsonPath('data.claimant_id', null);

        $this->assertDatabaseHas('claims', [
            'item_id' => $item->id,
            'claimant_id' => null,
            'claimant_name' => 'Walk In Claimant',
            'claimant_contact' => '+639171234567',
            'claimant_email' => 'walkin@example.com',
            'status' => 'PENDING',
        ]);
    }

    // ── Admin: approve / release / reject / close ──────────────

    public function test_admin_can_approve_claim(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'APPROVED');
        $this->assertNotNull($response->json('data.approved_at'));

        // Stage 1: approve → item APPROVED (not RELEASED yet)
        $this->assertDatabaseHas('lost_items', [
            'id' => $item->id,
            'status' => 'APPROVED',
        ]);
        // released_to/released_at NOT set until release
        $this->assertNull(LostItem::find($item->id)->released_to);
        $this->assertNull(LostItem::find($item->id)->released_at);
    }

    public function test_admin_can_release_approved_claim(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");

        // Stage 2: release → item RELEASED, released_to set
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release");
        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'RELEASED');
        $this->assertNotNull($response->json('data.approved_at'));
        $this->assertNotNull($response->json('data.released_at'));

        $this->assertDatabaseHas('lost_items', [
            'id' => $item->id,
            'status' => 'CLOSED',
            'released_to' => $this->commuter->commuterProfile->id,
            'closed_by' => $this->admin->id,
        ]);
        $item->refresh();
        $claim->refresh();
        $this->assertNotNull($item->released_at);
        $this->assertNotNull($item->closed_at);
        $this->assertSame('RELEASED', $claim->status);
        $this->assertNotNull($claim->released_at);
    }

    public function test_cannot_release_pending_claim(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        // Try to release without approving first
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release");
        $response->assertStatus(422);
    }

    public function test_cannot_release_already_released(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release");
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release");
        $response->assertStatus(422);
    }

    public function test_approve_auto_rejects_other_pending_claims(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'commuter 1']);

        $this->otherCommuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'commuter 2']);

        $this->admin();
        // Approve the first commuter's claim (deterministic by claimant_id)
        $firstClaim = Claim::where('item_id', $item->id)
            ->where('claimant_id', $this->commuter->commuterProfile->id)
            ->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$firstClaim->id}/approve");

        // The other commuter's claim should be auto-rejected
        $otherClaim = Claim::where('item_id', $item->id)
            ->where('claimant_id', $this->otherCommuter->commuterProfile->id)
            ->first();
        $this->assertEquals('REJECTED', $otherClaim->fresh()->status);
        $this->assertEquals('Another claim was approved', $otherClaim->fresh()->rejection_reason);
        $this->assertNotNull($otherClaim->fresh()->rejected_at);
    }

    public function test_admin_can_reject_pending_claim_with_reason(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/reject", [
            'rejection_reason' => 'Proof does not match item description',
        ]);

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'REJECTED')
            ->assertJsonPath('data.rejection_reason', 'Proof does not match item description');
        $this->assertNotNull($response->json('data.rejected_at'));

        $this->assertDatabaseHas('claim_rejection_audits', [
            'claim_id' => $claim->id,
            'item_id' => $item->id,
            'claimant_id' => $this->commuter->commuterProfile->id,
            'previous_status' => 'PENDING',
            'resulting_status' => 'REJECTED',
            'rejection_reason' => 'Proof does not match item description',
        ]);

        // Item reverts to AVAILABLE (no pending claims remain)
        $this->assertDatabaseHas('lost_items', [
            'id' => $item->id,
            'status' => 'AVAILABLE',
        ]);
    }

    public function test_admin_can_reject_approved_claim_post_approval(): void
    {
        // Post-approval reversal: approve then reject (something invalidates the approval)
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");

        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/reject", [
            'rejection_reason' => 'Claimant could not provide ID at handover',
        ]);

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'REJECTED')
            ->assertJsonPath('data.rejection_reason', 'Claimant could not provide ID at handover');

        $this->assertDatabaseHas('claim_rejection_audits', [
            'claim_id' => $claim->id,
            'item_id' => $item->id,
            'claimant_id' => $this->commuter->commuterProfile->id,
            'previous_status' => 'APPROVED',
            'resulting_status' => 'REJECTED',
            'rejection_reason' => 'Claimant could not provide ID at handover',
        ]);

        // A post-approval rejection is terminal — the claim is no longer
        // active, so the item is claimable again rather than stuck "under
        // review" from a claim that's actually been turned down.
        $this->assertDatabaseHas('lost_items', [
            'id' => $item->id,
            'status' => 'AVAILABLE',
        ]);
    }

    public function test_commuter_can_reclaim_after_approved_claim_is_rejected_and_it_counts_toward_the_cap(): void
    {
        $item = $this->createItem();

        // Two full approve → reject (post-approval) cycles, plus one straight
        // PENDING rejection — post-approval rejections must count toward the
        // same three-rejection cap as ordinary ones, and each must leave the
        // item claimable again rather than stuck "under review".
        for ($attempt = 1; $attempt <= 3; $attempt++) {
            $this->commuter();
            $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
                'proof' => "attempt {$attempt} proof",
            ])->assertStatus(201);

            $this->admin();
            $claim = Claim::where('item_id', $item->id)
                ->where('claimant_id', $this->commuter->commuterProfile->id)
                ->where('status', 'PENDING')
                ->latest()
                ->firstOrFail();

            if ($attempt !== 3) {
                // Approve, then reverse it — the "reject instead of release" path.
                $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve")
                    ->assertStatus(200);
                $this->assertDatabaseHas('lost_items', ['id' => $item->id, 'status' => 'APPROVED']);

                $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/reject", [
                    'rejection_reason' => "attempt {$attempt} rejected post-approval",
                ])->assertStatus(200)
                    ->assertJsonPath('data.status', 'REJECTED');

                // Fresh state — claimable again immediately, not left "Claimed"
                // by a claim that's already been turned down.
                $this->assertDatabaseHas('lost_items', ['id' => $item->id, 'status' => 'AVAILABLE']);
            } else {
                // An ordinary PENDING rejection, to land in the same terminal
                // state via the other path and share the same cap.
                $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/reject", [
                    'rejection_reason' => 'attempt 3 rejected',
                ])->assertStatus(200);
            }
        }

        $this->assertEquals(3, Claim::where('item_id', $item->id)
            ->where('claimant_id', $this->commuter->commuterProfile->id)
            ->where('status', 'REJECTED')
            ->count());

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'fourth proof should not be accepted',
        ])->assertStatus(422)
            ->assertJsonPath('message', 'You have reached the maximum number of rejected claims for this item');
    }

    public function test_commuter_cannot_submit_fourth_claim_after_three_rejections_for_same_item(): void
    {
        $item = $this->createItem();

        for ($attempt = 1; $attempt <= 3; $attempt++) {
            $this->commuter();
            $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
                'proof' => "attempt {$attempt} proof",
            ])->assertStatus(201);

            $this->admin();
            $claim = Claim::where('item_id', $item->id)
                ->where('claimant_id', $this->commuter->commuterProfile->id)
                ->where('status', 'PENDING')
                ->latest()
                ->firstOrFail();

            $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/reject", [
                'rejection_reason' => "attempt {$attempt} rejected",
            ])->assertStatus(200);
        }

        $this->assertEquals(3, Claim::where('item_id', $item->id)
            ->where('claimant_id', $this->commuter->commuterProfile->id)
            ->where('status', 'REJECTED')
            ->count());
        $this->assertEquals(3, ClaimRejectionAudit::where('item_id', $item->id)
            ->where('claimant_id', $this->commuter->commuterProfile->id)
            ->where('resulting_status', 'REJECTED')
            ->count());

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'fourth proof should not be accepted',
        ])->assertStatus(422)
            ->assertJsonPath('message', 'You have reached the maximum number of rejected claims for this item');
    }

    public function test_cannot_approve_already_approved_claim(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");

        $response->assertStatus(422);
    }

    public function test_cannot_reject_already_rejected_claim(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/reject", ['rejection_reason' => 'no']);
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/reject", ['rejection_reason' => 'no']);

        $response->assertStatus(422);
    }

    public function test_release_already_closes_item(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release");
        $response->assertStatus(200);

        $item->refresh();
        $claim->refresh();
        $this->assertSame('CLOSED', $item->status);
        $this->assertNotNull($item->released_at);
        $this->assertNotNull($item->closed_at);
        $this->assertSame('RELEASED', $claim->status);
        $this->assertNotNull($claim->released_at);
    }

    public function test_cannot_close_available_item(): void
    {
        $item = $this->createItem();

        $this->admin();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/close");
        $response->assertStatus(422);
    }

    public function test_cannot_close_approved_item(): void
    {
        // APPROVED but not RELEASED → cannot close
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $claim = Claim::where('item_id', $item->id)->first();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");

        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/close");
        $response->assertStatus(422);
    }

    public function test_commuter_cannot_approve_claim(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $claim = Claim::where('item_id', $item->id)->first();
        // Still acting as commuter
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve");
        $response->assertStatus(403);
    }

    public function test_admin_claims_list_for_item(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'mine']);

        $this->admin();
        $response = $this->getJson("/api/v1/admin/lost-items/{$item->id}/claims");
        $response->assertStatus(200)
            ->assertJsonPath('success', true);
        $this->assertNotEmpty($response->json('data'));
    }

    public function test_approve_nonexistent_claim_returns_404(): void
    {
        $item = $this->createItem();
        $this->admin();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/nonexistent-claim/approve");
        $response->assertStatus(404);
    }

    public function test_release_nonexistent_claim_returns_404(): void
    {
        $item = $this->createItem();
        $this->admin();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/nonexistent-claim/release");
        $response->assertStatus(404);
    }

    // ── Watchlist (COMMUTER) ───────────────────────────────────

    public function test_commuter_can_watchlist_item(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");

        $response->assertStatus(201)
            ->assertJsonPath('success', true);

        $this->assertDatabaseHas('lost_item_watchlists', [
            'item_id' => $item->id,
            'commuter_id' => $this->commuter->commuterProfile->id,
        ]);
    }

    public function test_watchlist_is_idempotent(): void
    {
        $item = $this->createItem();

        $this->commuter();
        // First add → 201
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist")
            ->assertStatus(201);

        // Second add → 200 (already watching)
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");
        $response->assertStatus(200);

        // Still only one row
        $this->assertDatabaseCount('lost_item_watchlists', 1);
    }

    public function test_commuter_can_unwatchlist_item(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");
        $response = $this->deleteJson("/api/v1/lost-found/{$item->id}/watchlist");

        $response->assertStatus(200);
        $this->assertDatabaseMissing('lost_item_watchlists', [
            'item_id' => $item->id,
        ]);
    }

    public function test_unwatchlist_is_idempotent(): void
    {
        $item = $this->createItem();

        $this->commuter();
        // Delete without adding first → still 200
        $response = $this->deleteJson("/api/v1/lost-found/{$item->id}/watchlist");
        $response->assertStatus(200);
    }

    public function test_commuter_can_list_watchlist(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");

        $response = $this->getJson('/api/v1/commuter/watchlist');
        $response->assertStatus(200)
            ->assertJsonPath('success', true);

        $entries = $response->json('data.data');
        $this->assertNotEmpty($entries);
        $this->assertEquals($item->id, $entries[0]['item_id']);
    }

    public function test_admin_cannot_watchlist_item(): void
    {
        $item = $this->createItem();

        $this->admin();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");
        $response->assertStatus(403);
    }

    public function test_watchlist_deleted_when_item_deleted(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");
        $this->assertDatabaseCount('lost_item_watchlists', 1);

        // Delete the item (cascade should remove watchlist entries)
        $item->delete();
        $this->assertDatabaseCount('lost_item_watchlists', 0);
    }

    // ── Photo upload (ADMIN) ────────────────────────────────────

    public function test_admin_can_add_lost_item_photo(): void
    {
        $item = $this->createItem();

        $this->admin();
        $response = $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->image('backpack.jpg', 800, 600),
        ]);

        $response->assertStatus(200)
            ->assertJsonPath('success', true);

        // image_url (the thumbnail = position 0) is set and the file exists on disk
        $item->refresh();
        $this->assertNotNull($item->image_url);
        $this->assertStringContainsString('lost-and-found/', $item->image_url);
        Storage::disk('public')->assertExists(
            $this->extractPathFromUrl($item->image_url)
        );
        $this->assertDatabaseCount('lost_item_photos', 1);
    }

    public function test_photo_upload_validates_file_type(): void
    {
        $item = $this->createItem();

        $this->admin();
        $response = $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->create('document.pdf', 100, 'application/pdf'),
        ]);

        $response->assertStatus(422);
    }

    public function test_photo_upload_validates_file_size(): void
    {
        $item = $this->createItem();

        $this->admin();
        // 6MB file → exceeds 5MB limit
        $response = $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->image('huge.jpg')->size(6144),
        ]);

        $response->assertStatus(422);
    }

    public function test_commuter_cannot_upload_photo(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $response = $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->image('backpack.jpg', 100, 100),
        ]);

        $response->assertStatus(403);
    }

    public function test_second_photo_is_added_not_replaced(): void
    {
        $item = $this->createItem();

        $this->admin();
        // First upload — becomes position 0 (the thumbnail).
        $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->image('first.jpg', 800, 600),
        ]);
        $item->refresh();
        $firstUrl = $item->image_url;
        Storage::disk('public')->assertExists($this->extractPathFromUrl($firstUrl));

        // Second upload — appended at position 1; the thumbnail is unchanged.
        $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->image('second.jpg', 800, 600),
        ]);
        $item->refresh();

        $this->assertSame($firstUrl, $item->image_url);
        Storage::disk('public')->assertExists($this->extractPathFromUrl($firstUrl));
        $this->assertDatabaseCount('lost_item_photos', 2);
    }

    public function test_photo_upload_rejects_a_fourth_photo(): void
    {
        $item = $this->createItem();

        $this->admin();
        foreach (['a.jpg', 'b.jpg', 'c.jpg'] as $name) {
            $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
                'image' => UploadedFile::fake()->image($name, 400, 400),
            ])->assertStatus(200);
        }

        $response = $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->image('d.jpg', 400, 400),
        ]);

        $response->assertStatus(422);
        $this->assertDatabaseCount('lost_item_photos', 3);
    }

    public function test_admin_can_delete_photo_and_positions_recompact(): void
    {
        $item = $this->createItem();

        $this->admin();
        foreach (['a.jpg', 'b.jpg'] as $name) {
            $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
                'image' => UploadedFile::fake()->image($name, 400, 400),
            ]);
        }
        $item->refresh();
        $photos = $item->photos()->orderBy('position')->get();
        $firstPhotoId = $photos[0]->id;
        $secondUrl = $photos[1]->url;

        $response = $this->deleteJson("/api/v1/admin/lost-items/{$item->id}/photos/{$firstPhotoId}");
        $response->assertStatus(200)->assertJsonPath('success', true);

        $item->refresh();
        // The remaining photo (formerly position 1) becomes the new position 0 thumbnail.
        $this->assertSame($secondUrl, $item->image_url);
        $this->assertDatabaseCount('lost_item_photos', 1);
        $this->assertSame(0, $item->photos()->first()->position);
    }

    public function test_photo_upload_returns_404_for_missing_item(): void
    {
        $this->admin();
        $response = $this->postJson('/api/v1/admin/lost-items/nonexistent-id/photos', [
            'image' => UploadedFile::fake()->image('test.jpg', 100, 100),
        ]);

        $response->assertStatus(404);
    }

    // ── Edit item (ADMIN) ───────────────────────────────────────

    public function test_admin_can_edit_item(): void
    {
        $item = $this->createItem();

        $this->admin();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}", [
            'item_name' => 'Blue Backpack (corrected)',
            'description' => $item->description,
            'plate_number' => 'XYZ 9999',
        ]);

        $response->assertStatus(200)->assertJsonPath('success', true);
        $item->refresh();
        $this->assertSame('Blue Backpack (corrected)', $item->item_name);
        $this->assertSame('XYZ 9999', $item->plate_number);
    }

    public function test_cannot_edit_closed_item(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve");
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/release");
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/close");

        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}", [
            'item_name' => 'Should not apply',
            'description' => $item->description,
        ]);

        $response->assertStatus(422);
    }

    public function test_commuter_cannot_edit_item(): void
    {
        $item = $this->createItem();
        $this->commuter();

        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}", [
            'item_name' => 'Hijacked name',
            'description' => $item->description,
        ]);

        $response->assertStatus(403);
    }

    // ── Auto-expiry + reactivate (ADMIN) ─────────────────────────

    public function test_expire_command_archives_stale_available_items(): void
    {
        $item = $this->createItem();
        $item->forceFill(['created_at' => now()->subDays(31)])->save();

        $this->artisan('lost-items:expire')->assertExitCode(0);

        $item->refresh();
        $this->assertSame('EXPIRED', $item->status);
        $this->assertNotNull($item->expired_at);
    }

    public function test_expire_command_ignores_recent_items(): void
    {
        $item = $this->createItem();

        $this->artisan('lost-items:expire')->assertExitCode(0);

        $item->refresh();
        $this->assertSame('AVAILABLE', $item->status);
    }

    public function test_expire_command_ignores_claimed_items(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain']);
        $item->forceFill(['created_at' => now()->subDays(31)])->save();

        $this->artisan('lost-items:expire')->assertExitCode(0);

        $item->refresh();
        $this->assertSame('CLAIMED', $item->status);
    }

    public function test_expired_item_cannot_be_claimed(): void
    {
        $item = $this->createItem();
        $item->update(['status' => 'EXPIRED', 'expired_at' => now()]);

        $this->commuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain']);

        $response->assertStatus(422);
    }

    public function test_expired_item_excluded_from_commuter_browse(): void
    {
        $item = $this->createItem();
        $item->update(['status' => 'EXPIRED', 'expired_at' => now()]);

        $this->commuter();
        $response = $this->getJson('/api/v1/lost-found');

        $ids = collect($response->json('data.data'))->pluck('id');
        $this->assertFalse($ids->contains($item->id));
    }

    public function test_admin_can_reactivate_expired_item(): void
    {
        $item = $this->createItem();
        $item->update(['status' => 'EXPIRED', 'expired_at' => now()]);

        $this->admin();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/reactivate");

        $response->assertStatus(200)->assertJsonPath('success', true);
        $item->refresh();
        $this->assertSame('AVAILABLE', $item->status);
        $this->assertNull($item->expired_at);
    }

    public function test_reactivated_old_item_gets_a_fresh_availability_window(): void
    {
        $item = $this->createItem();
        $item->forceFill([
            'created_at' => now()->subDays(60),
            'status' => 'EXPIRED',
            'expired_at' => now(),
        ])->save();

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/reactivate")->assertOk();
        $this->artisan('lost-items:expire')->assertSuccessful();

        $item->refresh();
        $this->assertSame('AVAILABLE', $item->status);
        $this->assertNotNull($item->available_since);
    }

    public function test_cannot_reactivate_non_expired_item(): void
    {
        $item = $this->createItem();

        $this->admin();
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/reactivate");

        $response->assertStatus(422);
    }

    // ── Claim-status notifications ───────────────────────────────

    public function test_approving_claim_notifies_claimant(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve");

        $this->assertDatabaseHas('announcements', [
            'user_id' => $this->commuter->id,
            'type' => 'claim_approved',
        ]);
    }

    public function test_rejecting_claim_notifies_claimant(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/reject", ['rejection_reason' => 'Proof did not match']);

        $this->assertDatabaseHas('announcements', [
            'user_id' => $this->commuter->id,
            'type' => 'claim_rejected',
        ]);
    }

    public function test_walk_in_claim_approval_does_not_create_notification(): void
    {
        $item = $this->createItem();
        $this->admin();
        $claim = $this->postJson("/api/v1/admin/lost-items/{$item->id}/claims/manual", [
            'claimant_name' => 'Walk-in Person',
            'claimant_contact' => '09171234567',
            'proof' => 'Described the item accurately',
        ])->json('data');

        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve");

        $this->assertDatabaseCount('announcements', 0);
    }

    public function test_targeted_announcement_only_visible_to_recipient(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve");

        // The claimant sees it in their feed.
        $this->commuter();
        $mine = $this->getJson('/api/v1/announcements')->json('data.data');
        $this->assertTrue(collect($mine)->contains(fn ($a) => $a['type'] === 'claim_approved'));

        // A different commuter does not.
        $this->otherCommuter();
        $theirs = $this->getJson('/api/v1/announcements')->json('data.data');
        $this->assertFalse(collect($theirs)->contains(fn ($a) => $a['type'] === 'claim_approved'));
    }

    /**
     * Extract the storage-relative path from a public-disk URL so we can
     * use Storage::assertExists/assetMissing in tests.
     */
    private function extractPathFromUrl(string $url): string
    {
        $parts = parse_url($url);
        $path = $parts['path'] ?? '';
        if (str_starts_with($path, '/storage/')) {
            $path = substr($path, strlen('/storage/'));
        }

        return $path;
    }
}
