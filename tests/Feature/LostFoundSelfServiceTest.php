<?php

namespace Tests\Feature;

use App\Models\Claim;
use App\Models\LostItem;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Lost & Found commuter self-service — DB-backed claim state.
 *
 *   GET    /api/v1/commuter/claims              — the commuter's own claims
 *   DELETE /api/v1/lost-found/claims/{claimId}  — withdraw own PENDING claim
 *
 * These endpoints let the commuter UI persist claim state (badges, the
 * "My Claims" tab, the 3-pending cap, cancel) in the DB instead of React
 * state. Verifies:
 *   - my-claims returns only the auth commuter's claims, item eager-loaded
 *   - cancel deletes the PENDING claim and reverts the item to AVAILABLE
 *     when it was the last pending claim
 *   - item stays CLAIMED when another commuter's pending claim remains
 *   - cannot cancel another commuter's claim (404)
 *   - cannot cancel an APPROVED claim (422)
 *   - role enforcement: admin cannot cancel; unauthenticated → 401
 */
class LostFoundSelfServiceTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;
    private User $commuter;
    private User $otherCommuter;

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()->admin()->create();
        $this->commuter = User::factory()->commuter()->create();
        $this->otherCommuter = User::factory()->commuter()->create();
    }

    private function createItem(string $name = 'Blue Backpack'): LostItem
    {
        return LostItem::create([
            'item_name'        => $name,
            'description'      => 'Test item',
            'category'         => 'BAG',
            'reported_by_id'   => $this->admin->id,
            'reported_by_role' => 'ADMIN',
            'reporter_name'    => 'Admin',
            'status'           => 'AVAILABLE',
        ]);
    }

    private function claimAs(User $commuter, LostItem $item): Claim
    {
        Sanctum::actingAs($commuter);
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'It has my initials on the strap.',
        ]);
        $response->assertStatus(201);
        return Claim::findOrFail($response->json('data.id'));
    }

    // ── GET /commuter/claims ────────────────────────────────────

    public function test_commuter_sees_only_their_own_claims_with_item(): void
    {
        $itemA = $this->createItem('Item A');
        $itemB = $this->createItem('Item B');
        $mine = $this->claimAs($this->commuter, $itemA);
        $this->claimAs($this->otherCommuter, $itemB);

        Sanctum::actingAs($this->commuter);
        $response = $this->getJson('/api/v1/commuter/claims');

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.id', $mine->id)
            ->assertJsonPath('data.data.0.status', 'PENDING')
            ->assertJsonPath('data.data.0.item.id', $itemA->id)
            ->assertJsonPath('data.data.0.item.item_name', 'Item A')
            ->assertJsonPath('data.per_page', 10)
            ->assertJsonPath('data.total', 1);
    }

    public function test_my_claims_are_paginated_and_status_filterable(): void
    {
        $this->claimAs($this->commuter, $this->createItem('Item A'));
        $second = $this->claimAs($this->commuter, $this->createItem('Item B'));
        $this->claimAs($this->commuter, $this->createItem('Item C'));

        Sanctum::actingAs($this->admin);
        $this->patchJson("/api/v1/admin/lost-items/{$second->item_id}/claims/{$second->id}/approve")
            ->assertStatus(200);

        Sanctum::actingAs($this->commuter);
        $this->getJson('/api/v1/commuter/claims?per_page=2')
            ->assertStatus(200)
            ->assertJsonCount(2, 'data.data')
            ->assertJsonPath('data.per_page', 2)
            ->assertJsonPath('data.total', 3);

        $this->getJson('/api/v1/commuter/claims?status=APPROVED&per_page=10')
            ->assertStatus(200)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.id', $second->id)
            ->assertJsonPath('data.data.0.status', 'APPROVED');
    }

    public function test_my_claims_filter_by_item_posted_date(): void
    {
        $targetDate = now()->subDays(4);
        $oldItem = $this->createItem('Old Posted Item');
        $newItem = $this->createItem('New Posted Item');

        $oldClaim = $this->claimAs($this->commuter, $oldItem);
        $this->claimAs($this->commuter, $newItem);
        LostItem::where('id', $oldItem->id)->update(['created_at' => $targetDate]);
        LostItem::where('id', $newItem->id)->update(['created_at' => now()]);

        Sanctum::actingAs($this->commuter);
        $this->getJson('/api/v1/commuter/claims?date='.$targetDate->toDateString())
            ->assertStatus(200)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.id', $oldClaim->id)
            ->assertJsonPath('data.data.0.item.item_name', 'Old Posted Item');
    }

    public function test_my_claims_search_item_transport_details(): void
    {
        $matchingItem = $this->createItem('Claim Search Match');
        $otherItem = $this->createItem('Claim Search Other');
        $matchingItem->update([
            'plate_number' => 'CLAIM 777',
            'driver_name' => 'Rafael Reyes',
            'conductor_name' => 'Mina Lopez',
        ]);
        $otherItem->update([
            'plate_number' => 'OTHER 888',
            'driver_name' => 'Other Driver',
            'conductor_name' => 'Other Conductor',
        ]);

        $matchingClaim = $this->claimAs($this->commuter, $matchingItem);
        $this->claimAs($this->commuter, $otherItem);

        Sanctum::actingAs($this->commuter);
        foreach (['CLAIM 777', 'Rafael', 'Mina'] as $term) {
            $this->getJson('/api/v1/commuter/claims?search='.urlencode($term))
                ->assertStatus(200)
                ->assertJsonCount(1, 'data.data')
                ->assertJsonPath('data.data.0.id', $matchingClaim->id)
                ->assertJsonPath('data.data.0.item.item_name', 'Claim Search Match');
        }
    }

    public function test_my_claims_requires_commuter_role(): void
    {
        Sanctum::actingAs($this->admin);
        $this->getJson('/api/v1/commuter/claims')->assertStatus(403);
    }

    // ── DELETE /lost-found/claims/{claimId} ─────────────────────

    public function test_commuter_can_cancel_pending_claim_and_item_reverts(): void
    {
        $item = $this->createItem();
        $claim = $this->claimAs($this->commuter, $item);
        $this->assertEquals('CLAIMED', $item->fresh()->status);

        Sanctum::actingAs($this->commuter);
        $response = $this->deleteJson("/api/v1/lost-found/claims/{$claim->id}");

        $response->assertStatus(200)->assertJsonPath('success', true);
        $this->assertDatabaseMissing('claims', ['id' => $claim->id]);
        // Last pending claim gone → item claimable again.
        $this->assertEquals('AVAILABLE', $item->fresh()->status);
    }

    public function test_item_stays_claimed_when_other_pending_claims_remain(): void
    {
        $item = $this->createItem();
        $mine = $this->claimAs($this->commuter, $item);
        $this->claimAs($this->otherCommuter, $item);

        Sanctum::actingAs($this->commuter);
        $this->deleteJson("/api/v1/lost-found/claims/{$mine->id}")->assertStatus(200);

        $this->assertEquals('CLAIMED', $item->fresh()->status);
    }

    public function test_cannot_cancel_another_commuters_claim(): void
    {
        $item = $this->createItem();
        $theirs = $this->claimAs($this->otherCommuter, $item);

        Sanctum::actingAs($this->commuter);
        $this->deleteJson("/api/v1/lost-found/claims/{$theirs->id}")->assertStatus(404);

        $this->assertDatabaseHas('claims', ['id' => $theirs->id]);
    }

    public function test_cannot_cancel_approved_claim(): void
    {
        $item = $this->createItem();
        $claim = $this->claimAs($this->commuter, $item);

        Sanctum::actingAs($this->admin);
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve")
            ->assertStatus(200);

        Sanctum::actingAs($this->commuter);
        $this->deleteJson("/api/v1/lost-found/claims/{$claim->id}")->assertStatus(422);

        $this->assertDatabaseHas('claims', ['id' => $claim->id, 'status' => 'APPROVED']);
    }

    public function test_released_closed_items_are_excluded_from_commuter_watchlist(): void
    {
        $item = $this->createItem();

        Sanctum::actingAs($this->commuter);
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist")->assertStatus(201);
        $claim = $this->claimAs($this->commuter, $item);

        Sanctum::actingAs($this->admin);
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve")
            ->assertStatus(200);
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/release")
            ->assertStatus(200);

        Sanctum::actingAs($this->commuter);
        $this->getJson('/api/v1/commuter/watchlist')
            ->assertStatus(200)
            ->assertJsonCount(0, 'data.data');
    }

    public function test_commuter_watchlist_filters_by_item_posted_date(): void
    {
        $targetDate = now()->subDays(5);
        $oldItem = $this->createItem('Old Watchlist Item');
        $newItem = $this->createItem('New Watchlist Item');

        Sanctum::actingAs($this->commuter);
        $this->postJson("/api/v1/lost-found/{$oldItem->id}/watchlist")->assertStatus(201);
        $this->postJson("/api/v1/lost-found/{$newItem->id}/watchlist")->assertStatus(201);
        LostItem::where('id', $oldItem->id)->update(['created_at' => $targetDate]);
        LostItem::where('id', $newItem->id)->update(['created_at' => now()]);

        $this->getJson('/api/v1/commuter/watchlist?date='.$targetDate->toDateString())
            ->assertStatus(200)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.item.item_name', 'Old Watchlist Item');
    }

    public function test_commuter_watchlist_searches_item_transport_details(): void
    {
        $matchingItem = $this->createItem('Watchlist Search Match');
        $otherItem = $this->createItem('Watchlist Search Other');
        $matchingItem->update([
            'plate_number' => 'WATCH 123',
            'driver_name' => 'Nico Ramos',
            'conductor_name' => 'Ana Flores',
        ]);
        $otherItem->update([
            'plate_number' => 'OTHER 999',
            'driver_name' => 'Other Driver',
            'conductor_name' => 'Other Conductor',
        ]);

        Sanctum::actingAs($this->commuter);
        $this->postJson("/api/v1/lost-found/{$matchingItem->id}/watchlist")->assertStatus(201);
        $this->postJson("/api/v1/lost-found/{$otherItem->id}/watchlist")->assertStatus(201);

        foreach (['WATCH 123', 'Nico', 'Ana'] as $term) {
            $this->getJson('/api/v1/commuter/watchlist?search='.urlencode($term))
                ->assertStatus(200)
                ->assertJsonCount(1, 'data.data')
                ->assertJsonPath('data.data.0.item.item_name', 'Watchlist Search Match');
        }
    }

    public function test_admin_cannot_cancel_claims(): void
    {
        $item = $this->createItem();
        $claim = $this->claimAs($this->commuter, $item);

        Sanctum::actingAs($this->admin);
        $this->deleteJson("/api/v1/lost-found/claims/{$claim->id}")->assertStatus(403);
    }

    public function test_unauthenticated_cannot_cancel(): void
    {
        $item = $this->createItem();
        $claim = $this->claimAs($this->commuter, $item);

        // Fresh app instance so the Sanctum user from claimAs isn't cached.
        $this->refreshApplication();

        $this->deleteJson("/api/v1/lost-found/claims/{$claim->id}")->assertStatus(401);
    }
}
