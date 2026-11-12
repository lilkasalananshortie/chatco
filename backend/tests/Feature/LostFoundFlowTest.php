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
 *   POST   /api/v1/admin/lost-items/{itemId}/photos/{photoId} (ADMIN)
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

    /** Pickup schedule the admin sets when approving an account claim. */
    private function pickup(): array
    {
        return [
            'pickup_location' => 'Calumpit Terminal Office',
            'pickup_at' => now()->addDay()->setTime(14, 0)->toDateTimeString(),
            'pickup_reminder' => 'Bring a valid ID.',
        ];
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

    public function test_commuter_browse_filters_by_posted_time_range(): void
    {
        // Pin to midday so "today" vs. "N days ago" never straddles midnight.
        $this->travelTo(now()->setTime(12, 0));

        $this->admin();
        $ages = ['Range Today' => 0, 'Range Week' => 5, 'Range Month' => 20, 'Range Year' => 200, 'Range Old' => 400];
        foreach (array_keys($ages) as $name) {
            $this->postJson('/api/v1/admin/lost-items', [
                'item_name' => $name,
                'description' => 'Item for time range filter test',
                'category' => 'OTHER',
                'vehicle_id' => $this->vehicle->id,
            ])->assertStatus(201);
        }
        foreach ($ages as $name => $days) {
            LostItem::where('item_name', $name)->update(['created_at' => now()->subDays($days)]);
        }

        $this->commuter();
        $expected = [
            'today' => ['Range Today'],
            'week' => ['Range Today', 'Range Week'],
            'month' => ['Range Today', 'Range Week', 'Range Month'],
            'year' => ['Range Today', 'Range Week', 'Range Month', 'Range Year'],
        ];
        foreach ($expected as $range => $names) {
            $response = $this->getJson("/api/v1/lost-found?range={$range}");
            $response->assertStatus(200);
            // Newest-first ordering is preserved inside the window.
            $this->assertSame($names, collect($response->json('data.data'))->pluck('item_name')->all(), "range={$range}");
        }

        // No range keeps the default: everything visible, newest first.
        $all = collect($this->getJson('/api/v1/lost-found')->json('data.data'))->pluck('item_name')->all();
        $this->assertSame(array_keys($ages), $all);
    }

    public function test_commuter_browse_filters_by_posted_date_window_and_categories(): void
    {
        $this->travelTo(now()->setTime(12, 0));

        $this->admin();
        $items = [
            'Window Wallet' => ['WALLET', 2],
            'Window Bag' => ['BAG', 5],
            'Window Gadget' => ['GADGET', 4],
            'Window Old Bag' => ['BAG', 12],
        ];
        foreach ($items as $name => [$category]) {
            $this->postJson('/api/v1/admin/lost-items', [
                'item_name' => $name,
                'description' => 'Item for posted window filter test',
                'category' => $category,
                'vehicle_id' => $this->vehicle->id,
            ])->assertStatus(201);
        }
        foreach ($items as $name => [, $days]) {
            LostItem::where('item_name', $name)->update(['created_at' => now()->subDays($days)]);
        }

        $this->commuter();
        $names = fn (string $query) => collect($this->getJson("/api/v1/lost-found?{$query}")->assertStatus(200)->json('data.data'))->pluck('item_name')->all();
        $from = now()->subDays(5)->toDateString();
        $to = now()->subDays(2)->toDateString();

        // Both ends are inclusive whole days.
        $this->assertSame(['Window Wallet', 'Window Gadget', 'Window Bag'], $names("date_from={$from}&date_to={$to}"));
        // Either end may be open.
        $this->assertSame(['Window Wallet', 'Window Gadget', 'Window Bag'], $names("date_from={$from}"));
        $this->assertSame(['Window Bag', 'Window Old Bag'], $names('date_to='.now()->subDays(5)->toDateString()));
        // Several categories at once, combined with the window.
        $this->assertSame(['Window Wallet', 'Window Bag', 'Window Old Bag'], $names('categories[]=WALLET&categories[]=BAG'));
        $this->assertSame(['Window Wallet', 'Window Bag'], $names("categories[]=WALLET&categories[]=BAG&date_from={$from}&date_to={$to}"));
    }

    public function test_watchlist_and_claims_filter_by_posted_date_window_and_categories(): void
    {
        $this->travelTo(now()->setTime(12, 0));

        $bag = $this->createItem();
        $this->admin();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Window Watch Wallet',
            'description' => 'Wallet for watchlist window test',
            'category' => 'WALLET',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);
        $wallet = LostItem::where('item_name', 'Window Watch Wallet')->first();
        $bag->forceFill(['created_at' => now()->subDays(10)])->save();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$bag->id}/watchlist");
        $this->postJson("/api/v1/lost-found/{$wallet->id}/watchlist");
        $this->postJson("/api/v1/lost-found/{$bag->id}/claim", ['proof' => 'It has my keychain']);
        $this->postJson("/api/v1/lost-found/{$wallet->id}/claim", ['proof' => 'My ID is inside it']);

        $from = now()->subDays(3)->toDateString();
        $this->getJson("/api/v1/commuter/watchlist?date_from={$from}")
            ->assertStatus(200)
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.item_id', $wallet->id);
        $this->getJson('/api/v1/commuter/claims?date_to='.now()->subDays(5)->toDateString())
            ->assertStatus(200)
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.item_id', $bag->id);
        $this->getJson('/api/v1/commuter/claims?categories[]=BAG&categories[]=WALLET')
            ->assertStatus(200)
            ->assertJsonPath('data.total', 2);
    }

    public function test_commuter_lists_reject_invalid_posted_date_window(): void
    {
        $this->commuter();
        foreach (['/api/v1/lost-found', '/api/v1/commuter/watchlist', '/api/v1/commuter/claims'] as $endpoint) {
            $this->getJson("{$endpoint}?date_from=2026-05-10&date_to=2026-05-01")->assertStatus(422);
            $this->getJson("{$endpoint}?date_from=05/10/2026")->assertStatus(422);
            $this->getJson("{$endpoint}?categories=BAG")->assertStatus(422);
        }
        // A single-day window is valid.
        $this->getJson('/api/v1/lost-found?date_from=2026-05-10&date_to=2026-05-10')->assertStatus(200);
    }

    public function test_commuter_browse_rejects_unknown_time_range(): void
    {
        $this->commuter();
        $this->getJson('/api/v1/lost-found?range=decade')->assertStatus(422);
        $this->getJson('/api/v1/commuter/watchlist?range=decade')->assertStatus(422);
        $this->getJson('/api/v1/commuter/claims?range=decade')->assertStatus(422);
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup())
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup())
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

    public function test_commuter_cannot_open_a_second_claim_on_the_same_item(): void
    {
        $item = $this->createItem();
        $this->commuter();

        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'My keychain is on the zipper'])->assertStatus(201);
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'My keychain is on the zipper'])
            ->assertStatus(422)
            ->assertJsonPath('message', 'You already have a claim on this item.');

        $this->assertSame(1, Claim::where('item_id', $item->id)->count());

        // Another commuter can still claim the same item.
        $this->otherCommuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'Mine has a red tag'])->assertStatus(201);
    }

    public function test_commuter_can_claim_again_after_cancelling_or_being_rejected(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claimId = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'My keychain is on the zipper'])->json('data.id');

        $this->deleteJson("/api/v1/lost-found/claims/{$claimId}")->assertSuccessful();
        $claimId = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'My keychain is on the zipper'])->assertStatus(201)->json('data.id');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claimId}/reject", ['reason' => 'Proof does not match'])->assertSuccessful();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'Navy, with a torn side pocket'])->assertStatus(201);
    }

    public function test_browse_and_saved_items_carry_the_commuters_own_claim_after_a_reload(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist")->assertSuccessful();
        $claimId = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'My keychain is on the zipper'])->json('data.id');

        // A fresh request stands in for the page refresh.
        $this->getJson('/api/v1/lost-found')->assertOk()
            ->assertJsonPath('data.data.0.my_claim', ['id' => $claimId, 'status' => 'PENDING']);
        $this->getJson('/api/v1/commuter/watchlist')->assertOk()
            ->assertJsonPath('data.data.0.item.my_claim', ['id' => $claimId, 'status' => 'PENDING']);

        // Other commuters only ever see their own (none) — no one else's claim leaks.
        $this->otherCommuter();
        $this->getJson('/api/v1/lost-found')->assertOk()->assertJsonPath('data.data.0.my_claim', null);
    }

    public function test_every_commuter_tab_returns_all_item_photos_for_the_carousel(): void
    {
        $item = $this->createItem();
        foreach (range(1, 3) as $n) {
            $this->post("/api/v1/admin/lost-items/{$item->id}/photos", ['image' => UploadedFile::fake()->image("photo{$n}.jpg")], ['Accept' => 'application/json'])
                ->assertSuccessful();
        }

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist")->assertSuccessful();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'My keychain is on the zipper'])->assertSuccessful();

        // Browse, Saved and My claims all open the same detail modal.
        $this->getJson('/api/v1/lost-found')->assertOk()->assertJsonCount(3, 'data.data.0.photos');
        $this->getJson('/api/v1/commuter/watchlist')->assertOk()->assertJsonCount(3, 'data.data.0.item.photos');
        $this->getJson('/api/v1/commuter/claims')->assertOk()
            ->assertJsonCount(3, 'data.data.0.item.photos')
            ->assertJsonPath('data.data.0.item.photos.0.position', 0);
    }

    public function test_commuter_can_claim_with_proof_photos(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $response = $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
            'images' => [
                UploadedFile::fake()->image('receipt.jpg'),
                UploadedFile::fake()->image('with-owner.png'),
            ],
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('data.status', 'PENDING')
            ->assertJsonCount(2, 'data.photos')
            ->assertJsonPath('data.photos.0.position', 0)
            ->assertJsonPath('data.photos.1.position', 1);

        $claim = Claim::where('item_id', $item->id)->firstOrFail();
        $this->assertSame(2, $claim->photos()->count());
        $this->assertCount(2, Storage::disk('public')->files("lost-and-found/{$item->id}/claims"));
    }

    public function test_claim_without_photos_still_works(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
        ])->assertStatus(201)->assertJsonCount(0, 'data.photos');
    }

    public function test_claim_rejects_more_than_three_photos(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
            'images' => array_map(fn ($i) => UploadedFile::fake()->image("p{$i}.jpg"), range(1, 4)),
        ])->assertStatus(422)->assertJsonValidationErrors('images');

        $this->assertDatabaseMissing('claims', ['item_id' => $item->id]);
        $this->assertSame([], Storage::disk('public')->allFiles("lost-and-found/{$item->id}/claims"));
    }

    public function test_claim_rejects_non_image_or_oversized_photo(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
            'images' => [UploadedFile::fake()->create('proof.pdf', 100, 'application/pdf')],
        ])->assertStatus(422)->assertJsonValidationErrors('images.0');

        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
            'images' => [UploadedFile::fake()->image('big.jpg')->size(6000)],
        ])->assertStatus(422)->assertJsonValidationErrors('images.0');

        $this->assertDatabaseMissing('claims', ['item_id' => $item->id]);
    }

    public function test_admin_sees_claim_proof_photos(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
            'images' => [UploadedFile::fake()->image('a.jpg'), UploadedFile::fake()->image('b.jpg')],
        ])->assertStatus(201);

        $this->admin();
        $this->getJson("/api/v1/admin/lost-items/{$item->id}/claims")
            ->assertStatus(200)
            ->assertJsonCount(2, 'data.0.photos');

        $this->getJson('/api/v1/admin/lost-items')
            ->assertStatus(200)
            ->assertJsonCount(2, 'data.data.0.claims.0.photos');
    }

    public function test_public_item_detail_never_exposes_claim_photos(): void
    {
        $item = $this->createItem();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", [
            'proof' => 'Has my student ID in the front pocket',
            'images' => [UploadedFile::fake()->image('a.jpg')],
        ])->assertStatus(201);

        $this->otherCommuter();
        $response = $this->getJson("/api/v1/lost-found/{$item->id}")->assertStatus(200);
        $this->assertArrayNotHasKey('claims', $response->json('data'));
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup())
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup())
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());
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
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());

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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());

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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$firstClaim->id}/approve", $this->pickup());

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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());

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
                $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup())
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());

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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());

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
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim->id}/approve", $this->pickup());
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
        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/nonexistent-claim/approve", $this->pickup());
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

    public function test_commuter_watchlist_filters_by_posted_time_range(): void
    {
        $this->travelTo(now()->setTime(12, 0));
        $recent = $this->createItem();
        $this->admin();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Older Watched Item',
            'description' => 'Posted two weeks ago',
            'category' => 'OTHER',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);
        $older = LostItem::where('item_name', 'Older Watched Item')->first();
        LostItem::where('id', $older->id)->update(['created_at' => now()->subDays(14)]);

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$recent->id}/watchlist");
        $this->postJson("/api/v1/lost-found/{$older->id}/watchlist");

        $this->getJson('/api/v1/commuter/watchlist?range=week')
            ->assertStatus(200)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.item_id', $recent->id);
        $this->getJson('/api/v1/commuter/watchlist?range=month')
            ->assertStatus(200)
            ->assertJsonCount(2, 'data.data');
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

    public function test_admin_can_replace_thumbnail_photo_in_place(): void
    {
        $item = $this->createItem();

        $this->admin();
        foreach (['a.jpg', 'b.jpg'] as $name) {
            $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
                'image' => UploadedFile::fake()->image($name, 400, 400),
            ]);
        }
        $photos = $item->photos()->orderBy('position')->get();
        $thumb = $photos[0];
        $oldThumbUrl = $thumb->url;
        $secondUrl = $photos[1]->url;

        $response = $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos/{$thumb->id}", [
            'image' => UploadedFile::fake()->image('replacement.jpg', 400, 400),
        ]);
        $response->assertStatus(200)->assertJsonPath('success', true);

        $item->refresh();
        $thumb->refresh();
        // Same row, same position, new file — and the thumbnail mirror follows it.
        $this->assertSame(0, $thumb->position);
        $this->assertNotSame($oldThumbUrl, $thumb->url);
        $this->assertSame($thumb->url, $item->image_url);
        $this->assertSame($secondUrl, $item->photos()->where('position', 1)->value('url'));
        $this->assertDatabaseCount('lost_item_photos', 2);
        Storage::disk('public')->assertExists($this->extractPathFromUrl($thumb->url));
        Storage::disk('public')->assertMissing($this->extractPathFromUrl($oldThumbUrl));
    }

    public function test_replacing_a_non_thumbnail_photo_keeps_the_thumbnail(): void
    {
        $item = $this->createItem();

        $this->admin();
        foreach (['a.jpg', 'b.jpg'] as $name) {
            $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
                'image' => UploadedFile::fake()->image($name, 400, 400),
            ]);
        }
        $item->refresh();
        $thumbUrl = $item->image_url;
        $second = $item->photos()->where('position', 1)->first();

        $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos/{$second->id}", [
            'image' => UploadedFile::fake()->image('replacement.jpg', 400, 400),
        ])->assertStatus(200);

        $item->refresh();
        $second->refresh();
        $this->assertSame($thumbUrl, $item->image_url);
        $this->assertSame(1, $second->position);
    }

    public function test_photo_replace_returns_404_for_photo_on_another_item(): void
    {
        $item = $this->createItem();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Black Umbrella',
            'description' => 'Folding umbrella left by the door',
            'category' => 'OTHER',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);
        $other = LostItem::where('item_name', 'Black Umbrella')->first();

        $this->postJson("/api/v1/admin/lost-items/{$other->id}/photos", [
            'image' => UploadedFile::fake()->image('a.jpg', 400, 400),
        ]);
        $otherPhotoId = $other->photos()->value('id');

        $response = $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos/{$otherPhotoId}", [
            'image' => UploadedFile::fake()->image('b.jpg', 400, 400),
        ]);

        $response->assertStatus(404);
        $this->assertSame(0, $item->photos()->count());
    }

    public function test_photo_replace_validates_file_and_role(): void
    {
        $item = $this->createItem();

        $this->admin();
        $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => UploadedFile::fake()->image('a.jpg', 400, 400),
        ]);
        $photo = $item->photos()->first();

        $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos/{$photo->id}", [
            'image' => UploadedFile::fake()->create('document.pdf', 100, 'application/pdf'),
        ])->assertStatus(422);

        $this->commuter();
        $this->postJson("/api/v1/admin/lost-items/{$item->id}/photos/{$photo->id}", [
            'image' => UploadedFile::fake()->image('b.jpg', 400, 400),
        ])->assertStatus(403);

        $this->assertSame($photo->url, $photo->fresh()->url);
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", $this->pickup());
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/release");
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/close");

        $response = $this->patchJson("/api/v1/admin/lost-items/{$item->id}", [
            'item_name' => 'Should not apply',
            'description' => $item->description,
        ]);

        $response->assertStatus(422);
    }

    public function test_cannot_edit_or_change_photos_of_released_item(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", $this->pickup());
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/release")->assertOk();

        // Releasing hands the item over and closes it in one step.
        $this->assertSame('CLOSED', $item->fresh()->status);
        $edit = fn () => $this->patchJson("/api/v1/admin/lost-items/{$item->id}", [
            'item_name' => 'Should not apply',
            'description' => $item->description,
        ]);
        $edit()->assertStatus(422)->assertJsonPath('message', 'Cannot edit a closed item');
        $this->post("/api/v1/admin/lost-items/{$item->id}/photos", [
            'image' => \Illuminate\Http\UploadedFile::fake()->image('extra.jpg'),
        ], ['Accept' => 'application/json'])->assertStatus(422)->assertJsonPath('message', 'Cannot edit a closed item');

        // A row still in the older RELEASED state is locked the same way.
        $item->update(['status' => 'RELEASED']);
        $edit()->assertStatus(422)->assertJsonPath('message', 'Cannot edit a released item');

        $this->assertNotSame('Should not apply', $item->fresh()->item_name);
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

    public function test_expire_command_writes_one_system_activity_entry_naming_the_items(): void
    {
        $item = $this->createItem();
        $item->forceFill(['created_at' => now()->subDays(31)])->save();

        $this->artisan('lost-items:expire')->assertExitCode(0);
        // A second run with nothing left to expire writes nothing.
        $this->artisan('lost-items:expire')->assertExitCode(0);

        $entries = \App\Models\ActivityLog::where('category', 'LOST_FOUND')->where('actor_role', 'SYSTEM')->get();
        $this->assertCount(1, $entries);
        $this->assertNull($entries[0]->actor_id);
        $this->assertStringContainsString('Archived 1 unclaimed lost item', $entries[0]->description);
        $this->assertStringContainsString('"Blue Backpack"', $entries[0]->description);
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

    public function test_admin_can_bulk_reactivate_expired_items_and_skip_the_rest(): void
    {
        $this->admin();
        // createItem() looks items up by a fixed name, so make distinct ones here.
        [$first, $second, $stillAvailable] = array_map(function (string $name) {
            $this->postJson('/api/v1/admin/lost-items', [
                'item_name' => $name,
                'description' => 'Item for the bulk reactivate test',
                'category' => 'BAG',
                'vehicle_id' => $this->vehicle->id,
            ])->assertStatus(201);

            return LostItem::where('item_name', $name)->firstOrFail();
        }, ['Bulk Umbrella', 'Bulk Tote', 'Bulk Charger']);
        $first->update(['status' => 'EXPIRED', 'expired_at' => now()]);
        $second->update(['status' => 'EXPIRED', 'expired_at' => now()]);

        $this->admin();
        $response = $this->patchJson('/api/v1/admin/lost-items/reactivate', [
            'item_ids' => [$first->id, $second->id, $stillAvailable->id, 'missing-item'],
        ]);

        $response->assertOk()->assertJsonPath('success', true);
        $this->assertEqualsCanonicalizing([$first->id, $second->id], $response->json('data.reactivated'));
        $this->assertEqualsCanonicalizing([$stillAvailable->id, 'missing-item'], $response->json('data.skipped'));
        foreach ([$first, $second] as $item) {
            $item->refresh();
            $this->assertSame('AVAILABLE', $item->status);
            $this->assertNull($item->expired_at);
            $this->assertNotNull($item->available_since);
        }
        $this->assertSame('AVAILABLE', $stillAvailable->refresh()->status);
        // One log entry for the batch; name order follows the DB, so don't pin it.
        $log = \App\Models\ActivityLog::where('description', 'like', 'Reactivated 2 lost items:%')->sole();
        $this->assertStringContainsString('"Bulk Umbrella"', $log->description);
        $this->assertStringContainsString('"Bulk Tote"', $log->description);

        // Running it again finds nothing left to reactivate.
        $this->patchJson('/api/v1/admin/lost-items/reactivate', ['item_ids' => [$first->id]])
            ->assertOk()
            ->assertJsonPath('data.reactivated', [])
            ->assertJsonPath('data.skipped', [$first->id]);
    }

    public function test_bulk_reactivate_validates_input_and_is_admin_only(): void
    {
        $this->admin();
        $this->patchJson('/api/v1/admin/lost-items/reactivate', [])->assertStatus(422);
        $this->patchJson('/api/v1/admin/lost-items/reactivate', ['item_ids' => []])->assertStatus(422);
        $this->patchJson('/api/v1/admin/lost-items/reactivate', ['item_ids' => 'abc'])->assertStatus(422);
        $this->patchJson('/api/v1/admin/lost-items/reactivate', ['item_ids' => array_map(fn ($i) => "id-{$i}", range(1, 101))])->assertStatus(422);

        $this->commuter();
        $this->patchJson('/api/v1/admin/lost-items/reactivate', ['item_ids' => ['abc']])->assertStatus(403);
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
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", $this->pickup());

        $this->assertDatabaseHas('announcements', [
            'user_id' => $this->commuter->id,
            'type' => 'claim_approved',
        ]);
        // The staff reminder sits on its own labelled line after the pickup details.
        $message = \App\Models\Announcement::where('user_id', $this->commuter->id)->where('type', 'claim_approved')->value('message');
        $this->assertStringContainsString('Pick it up at Calumpit Terminal Office on ', $message);
        $this->assertStringEndsWith(".\n\nReminder: Bring a valid ID.", $message);
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

        $this->assertSame(0, \App\Models\Announcement::where('type', 'claim_approved')->count());
        $this->assertSame(1, \App\Models\Announcement::where('type', 'NEW_CLAIM')->where('user_id', $this->admin->id)->count());
    }

    // ── Pickup schedule on approval ─────────────────────────────

    public function test_approving_account_claim_requires_pickup_schedule(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve")
            ->assertStatus(422);
        $this->assertDatabaseHas('claims', ['id' => $claim['id'], 'status' => 'PENDING']);
    }

    public function test_approval_rejects_pickup_date_in_the_past(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", [
            'pickup_location' => 'Calumpit Terminal Office',
            'pickup_at' => now()->subDays(2)->toDateTimeString(),
        ])->assertStatus(422)->assertJsonValidationErrors('pickup_at');
    }

    public function test_approval_stores_pickup_schedule_and_tells_claimant(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $pickupAt = now()->addDays(2)->setTime(15, 30);
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", [
            'pickup_location' => 'Meycauayan Terminal, Booth 2',
            'pickup_at' => $pickupAt->toDateTimeString(),
            'pickup_reminder' => '',
        ])->assertStatus(200)
            ->assertJsonPath('data.pickup_location', 'Meycauayan Terminal, Booth 2')
            ->assertJsonPath('data.pickup_reminder', \App\Services\LostItemService::DEFAULT_PICKUP_REMINDER);

        $notice = \App\Models\Announcement::where('user_id', $this->commuter->id)->where('type', 'claim_approved')->first();
        $this->assertNotNull($notice);
        $this->assertStringContainsString('Meycauayan Terminal, Booth 2', $notice->message);
        $this->assertStringContainsString($pickupAt->format('M j, Y'), $notice->message);

        // The commuter's own claim list carries the schedule.
        $this->commuter();
        $this->getJson('/api/v1/commuter/claims')
            ->assertJsonPath('data.data.0.pickup_location', 'Meycauayan Terminal, Booth 2');
    }

    public function test_walk_in_claim_can_be_approved_without_pickup_schedule(): void
    {
        $item = $this->createItem();
        $this->admin();
        $claim = $this->postJson("/api/v1/admin/lost-items/{$item->id}/claims/manual", [
            'claimant_name' => 'Walk-in Person',
            'claimant_contact' => '09171234567',
            'proof' => 'Described the item accurately',
        ])->json('data');

        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve")
            ->assertStatus(200)
            ->assertJsonPath('data.status', 'APPROVED')
            ->assertJsonPath('data.pickup_location', null);
    }

    public function test_release_returns_closed_item_with_releasing_admin(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", $this->pickup());
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/release")
            ->assertStatus(200)
            ->assertJsonPath('data.status', 'RELEASED')
            ->assertJsonPath('data.item.status', 'CLOSED')
            ->assertJsonPath('data.item.closed_by_name', $this->admin->getDisplayName());
    }

    // ── Claim-by date ───────────────────────────────────────────

    public function test_available_items_expose_claimable_until(): void
    {
        $item = $this->createItem();
        LostItem::where('id', $item->id)->update(['created_at' => now()->subDays(10)]);

        $this->commuter();
        $until = $this->getJson("/api/v1/lost-found/{$item->id}")->json('data.claimable_until');
        $this->assertNotNull($until);
        $this->assertSame(
            now()->subDays(10)->addDays(\App\Services\LostItemService::EXPIRY_DAYS)->toDateString(),
            \Illuminate\Support\Carbon::parse($until)->timezone(config('app.timezone'))->toDateString(),
        );

        // A pending claim stops the expiry clock.
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain']);
        $this->assertNull($this->getJson("/api/v1/lost-found/{$item->id}")->json('data.claimable_until'));
    }

    // ── Category filter on watchlist / claims ───────────────────

    public function test_watchlist_and_claims_filter_by_category_server_side(): void
    {
        $bag = $this->createItem();
        $this->admin();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Brown Wallet',
            'description' => 'Leather wallet found under seat',
            'category' => 'WALLET',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);
        $wallet = LostItem::where('item_name', 'Brown Wallet')->first();

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$bag->id}/watchlist");
        $this->postJson("/api/v1/lost-found/{$wallet->id}/watchlist");
        $this->postJson("/api/v1/lost-found/{$bag->id}/claim", ['proof' => 'It has my keychain']);
        $this->postJson("/api/v1/lost-found/{$wallet->id}/claim", ['proof' => 'My ID is inside it']);

        $this->getJson('/api/v1/commuter/watchlist?category=WALLET&per_page=1')
            ->assertStatus(200)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.item_id', $wallet->id);

        $this->getJson('/api/v1/commuter/claims?category=BAG')
            ->assertStatus(200)
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.item_id', $bag->id);
    }

    // ── Saved-item notifications ────────────────────────────────

    public function test_watchers_are_told_when_saved_item_is_matched_and_when_it_returns(): void
    {
        $item = $this->createItem();
        $this->otherCommuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", $this->pickup());

        $this->assertDatabaseHas('announcements', ['user_id' => $this->otherCommuter->id, 'type' => 'saved_item_taken', 'reference_id' => $item->id]);
        // The approved claimant gets claim_approved instead, not the watcher notice.
        $this->assertDatabaseMissing('announcements', ['user_id' => $this->commuter->id, 'type' => 'saved_item_taken']);

        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/reject", ['rejection_reason' => 'ID did not match']);
        $this->assertDatabaseHas('announcements', ['user_id' => $this->otherCommuter->id, 'type' => 'saved_item_back']);
        $this->assertDatabaseMissing('announcements', ['user_id' => $this->commuter->id, 'type' => 'saved_item_back']);
    }

    public function test_expiring_saved_items_remind_watchers_once_per_window(): void
    {
        $item = $this->createItem();
        $fresh = $this->createItem();
        LostItem::where('id', $item->id)->update(['created_at' => now()->subDays(28)]);

        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");
        $this->postJson("/api/v1/lost-found/{$fresh->id}/watchlist");

        $service = app(\App\Services\LostItemService::class);
        $this->assertSame(1, $service->remindExpiringWatchedItems());
        $this->assertDatabaseHas('announcements', ['user_id' => $this->commuter->id, 'type' => 'saved_item_expiring', 'reference_id' => $item->id]);

        // Running again the same window sends nothing new.
        $this->assertSame(0, $service->remindExpiringWatchedItems());
        $this->assertSame(1, \App\Models\Announcement::where('type', 'saved_item_expiring')->count());

        // After expiry + reactivation the window restarts, so it can remind again later.
        LostItem::where('id', $item->id)->update(['created_at' => now()->subDays(40)]);
        $service->expireStale();
        $this->travel(1)->minutes();
        $service->reactivate($item->id);
        $this->travel(28)->days();
        $service->remindExpiringWatchedItems();
        $this->assertSame(2, \App\Models\Announcement::where('type', 'saved_item_expiring')->where('reference_id', $item->id)->count());
    }

    // ── No-show: approved but never collected ───────────────────

    /** Commuter claims, admin approves with a pickup on $pickupDaysAhead. Returns the claim id. */
    private function approvedClaim(LostItem $item, int $pickupDaysAhead = 1): string
    {
        $this->commuter();
        $claimId = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data.id');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claimId}/approve", [
            'pickup_location' => 'Calumpit Terminal Office',
            'pickup_at' => now()->addDays($pickupDaysAhead)->setTime(14, 0)->toDateTimeString(),
        ])->assertStatus(200);

        return $claimId;
    }

    public function test_uncollected_approved_claim_is_auto_rejected_after_pickup_day(): void
    {
        $item = $this->createItem();
        $this->otherCommuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/watchlist");
        $claimId = $this->approvedClaim($item);

        $service = app(\App\Services\LostItemService::class);

        // Still the pickup day: nothing happens yet.
        $this->travel(1)->days();
        $this->assertSame(0, $service->rejectNoShows());
        $this->assertDatabaseHas('claims', ['id' => $claimId, 'status' => 'APPROVED']);

        // The day after the pickup: the claim is closed as "did not proceed".
        $this->travel(1)->days();
        $this->assertSame(1, $service->rejectNoShows());

        $claim = Claim::find($claimId);
        $this->assertSame('REJECTED', $claim->status);
        $this->assertNotNull($claim->no_show_at);
        $this->assertSame(\App\Services\LostItemService::NO_SHOW_REASON, $claim->rejection_reason);
        $this->assertSame($this->admin->id, $claim->reviewed_by, 'The approving admin stays on record.');

        $this->assertDatabaseHas('claim_rejection_audits', [
            'claim_id' => $claimId,
            'rejected_by' => null,
            'previous_status' => 'APPROVED',
            'resulting_status' => 'REJECTED',
        ]);

        // The item is back on the board with a fresh expiry window.
        $item->refresh();
        $this->assertSame('AVAILABLE', $item->status);
        $this->assertTrue($item->available_since->isToday());

        $notice = \App\Models\Announcement::where('user_id', $this->commuter->id)
            ->where('title', "Pickup missed: \"{$item->item_name}\"")->first();
        $this->assertNotNull($notice);
        $this->assertSame('claim_rejected', $notice->type);
        $this->assertDatabaseHas('announcements', ['user_id' => $this->otherCommuter->id, 'type' => 'saved_item_back']);

        // Running again does nothing more.
        $this->assertSame(0, $service->rejectNoShows());
    }

    public function test_no_show_claimant_must_claim_again_and_cannot_be_released(): void
    {
        $item = $this->createItem();
        $claimId = $this->approvedClaim($item);
        $this->travel(3)->days();
        app(\App\Services\LostItemService::class)->rejectNoShows();

        // No rescheduling: the old claim can't be released any more.
        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claimId}/release")
            ->assertStatus(422);

        // The commuter can file a fresh claim online.
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain, again'])
            ->assertStatus(201);

        // And the claims list exposes the no-show marker for the old one.
        $old = collect($this->getJson('/api/v1/commuter/claims')->json('data.data'))->firstWhere('id', $claimId);
        $this->assertNotNull($old['no_show_at']);
    }

    public function test_no_show_sweep_leaves_released_and_unscheduled_claims_alone(): void
    {
        $released = $this->createItem();
        $releasedClaimId = $this->approvedClaim($released);
        $this->patchJson("/api/v1/admin/lost-items/{$released->id}/claims/{$releasedClaimId}/release")->assertStatus(200);

        // Walk-in approved without a pickup schedule. (createItem() looks
        // items up by name, so this one needs its own name.)
        $this->admin();
        $this->postJson('/api/v1/admin/lost-items', [
            'item_name' => 'Walk-in Umbrella',
            'description' => 'Folding umbrella left by the door',
            'category' => 'OTHER',
            'vehicle_id' => $this->vehicle->id,
        ])->assertStatus(201);
        $walkInItem = LostItem::where('item_name', 'Walk-in Umbrella')->first();
        $walkIn = $this->postJson("/api/v1/admin/lost-items/{$walkInItem->id}/claims/manual", [
            'claimant_name' => 'Walk-in Person',
            'claimant_contact' => '09171234567',
            'proof' => 'Described the item accurately',
        ])->json('data');
        $this->patchJson("/api/v1/admin/lost-items/{$walkInItem->id}/claims/{$walkIn['id']}/approve")->assertStatus(200);

        $this->travel(5)->days();
        $this->assertSame(0, app(\App\Services\LostItemService::class)->rejectNoShows());
        $this->assertDatabaseHas('claims', ['id' => $releasedClaimId, 'status' => 'RELEASED']);
        $this->assertDatabaseHas('claims', ['id' => $walkIn['id'], 'status' => 'APPROVED']);
    }

    public function test_daily_job_reopens_old_no_show_item_instead_of_expiring_it(): void
    {
        $item = $this->createItem();
        LostItem::where('id', $item->id)->update(['created_at' => now()->subDays(40)]);
        $this->approvedClaim($item);

        $this->travel(2)->days();
        $this->artisan('lost-items:expire')->assertSuccessful();

        $this->assertSame('AVAILABLE', $item->fresh()->status);
    }

    public function test_targeted_announcement_only_visible_to_recipient(): void
    {
        $item = $this->createItem();
        $this->commuter();
        $claim = $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'It has a keychain'])->json('data');

        $this->admin();
        $this->patchJson("/api/v1/admin/lost-items/{$item->id}/claims/{$claim['id']}/approve", $this->pickup());

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

    public function test_new_claim_notifies_only_admins_with_claimant_and_item(): void
    {
        $otherAdmin = User::factory()->admin()->create();
        $item = $this->createItem();
        $this->commuter();
        $this->postJson("/api/v1/lost-found/{$item->id}/claim", ['proof' => 'My backpack has a keychain'])->assertCreated();
        $notices = \App\Models\Announcement::where('type', 'NEW_CLAIM')->get();
        $this->assertCount(2, $notices);
        $this->assertEqualsCanonicalizing([$this->admin->id, $otherAdmin->id], $notices->pluck('user_id')->all());
        $this->assertStringContainsString($this->commuter->getDisplayName(), $notices->first()->message);
        $this->assertStringContainsString($item->item_name, $notices->first()->message);
        $this->assertSame($item->id, $notices->first()->reference_id);
        $this->assertStringNotContainsString('keychain', $notices->first()->message);
        $this->getJson('/api/v1/announcements')->assertJsonCount(0, 'data.data');
    }

}
