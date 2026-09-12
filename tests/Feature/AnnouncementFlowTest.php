<?php

namespace Tests\Feature;

use App\Models\Announcement;
use App\Models\AnnouncementRead;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Sprint 6 (T4) — Announcements workflow.
 *
 * Covers admin CRUD (create/list/show/update/archive) + user-facing reads
 * (feed with is_read, mark-as-read idempotent, unread-count for bell badge).
 *
 * Endpoints:
 *   Admin:
 *     GET    /api/v1/admin/announcements
 *     POST   /api/v1/admin/announcements
 *     GET    /api/v1/admin/announcements/{id}
 *     PUT    /api/v1/admin/announcements/{id}
 *     PATCH  /api/v1/admin/announcements/{id}/archive
 *   User (any auth role):
 *     GET    /api/v1/announcements
 *     GET    /api/v1/announcements/unread-count
 *     POST   /api/v1/announcements/{id}/read
 */
class AnnouncementFlowTest extends TestCase
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

    private function createAnnouncement(string $title = 'Holiday Schedule', string $status = 'ACTIVE'): Announcement
    {
        $this->admin();
        $response = $this->postJson('/api/v1/admin/announcements', [
            'title'   => $title,
            'message' => 'No operations on July 4.',
            'type'    => 'holiday',
            'status'  => $status,
        ]);
        $response->assertStatus(201);
        return Announcement::where('title', $title)->first();
    }

    // ── Admin: create + list + show ─────────────────────────────

    public function test_admin_can_create_announcement(): void
    {
        $this->admin();
        $response = $this->postJson('/api/v1/admin/announcements', [
            'title'   => 'Route Suspension',
            'message' => 'Route 5 suspended due to road work.',
            'type'    => 'route',
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.status', 'ACTIVE')
            ->assertJsonPath('data.title', 'Route Suspension');

        $this->assertDatabaseHas('announcements', [
            'title'   => 'Route Suspension',
            'status'  => 'ACTIVE',
            'created_by' => $this->admin->id,
        ]);
    }

    public function test_commuter_cannot_create_announcement(): void
    {
        $this->commuter();
        $response = $this->postJson('/api/v1/admin/announcements', [
            'title'   => 'Test',
            'message' => 'Test',
        ]);

        $response->assertStatus(403);
    }

    public function test_create_requires_title_and_message(): void
    {
        $this->admin();
        $response = $this->postJson('/api/v1/admin/announcements', []);

        $response->assertStatus(422);
    }

    public function test_admin_list_includes_archived(): void
    {
        $this->createAnnouncement('Active One', 'ACTIVE');
        $this->createAnnouncement('Archived One', 'ARCHIVED');

        $this->admin();
        $response = $this->getJson('/api/v1/admin/announcements');

        $response->assertStatus(200);
        $items = $response->json('data.data');
        $this->assertCount(2, $items);
    }

    public function test_admin_list_filters_by_status(): void
    {
        $this->createAnnouncement('Active One', 'ACTIVE');
        $this->createAnnouncement('Archived One', 'ARCHIVED');

        $this->admin();
        $response = $this->getJson('/api/v1/admin/announcements?status=ARCHIVED');

        $response->assertStatus(200);
        $items = $response->json('data.data');
        $this->assertCount(1, $items);
        $this->assertEquals('Archived One', $items[0]['title']);
    }

    public function test_admin_count_only_returns_total_without_page_rows(): void
    {
        $this->createAnnouncement('Active One', 'ACTIVE');
        $this->createAnnouncement('Active Two', 'ACTIVE');
        $this->createAnnouncement('Archived One', 'ARCHIVED');

        $this->admin();

        $response = $this->getJson('/api/v1/admin/announcements?status=ACTIVE&count_only=1');

        $response->assertStatus(200)
            ->assertJsonPath('data.total', 2)
            ->assertJsonMissingPath('data.data');
    }

    public function test_admin_list_filters_by_date_range(): void
    {
        $recent = $this->createAnnouncement('Recent One');
        $old = $this->createAnnouncement('Old One');
        // created_at isn't fillable (mass-assignment guarded), so force it directly.
        $old->forceFill(['created_at' => now()->subMonths(2)])->save();

        $this->admin();

        $today = $this->getJson('/api/v1/admin/announcements?date_range=this_month');
        $today->assertStatus(200);
        $titles = collect($today->json('data.data'))->pluck('title');
        $this->assertTrue($titles->contains('Recent One'));
        $this->assertFalse($titles->contains('Old One'));

        $all = $this->getJson('/api/v1/admin/announcements?date_range=all');
        $all->assertStatus(200);
        $allTitles = collect($all->json('data.data'))->pluck('title');
        $this->assertTrue($allTitles->contains('Recent One'));
        $this->assertTrue($allTitles->contains('Old One'));
    }

    public function test_admin_list_filters_by_exact_date(): void
    {
        $onDay = $this->createAnnouncement('On The Day');
        $otherDay = $this->createAnnouncement('Other Day');
        $onDay->forceFill(['created_at' => '2026-01-15 10:00:00'])->save();
        $otherDay->forceFill(['created_at' => '2026-01-16 10:00:00'])->save();

        $this->admin();

        // An exact ?date= should win even if a ?date_range= is also present.
        $response = $this->getJson('/api/v1/admin/announcements?date=2026-01-15&date_range=this_month');

        $response->assertStatus(200);
        $titles = collect($response->json('data.data'))->pluck('title');
        $this->assertTrue($titles->contains('On The Day'));
        $this->assertFalse($titles->contains('Other Day'));
    }

    public function test_admin_show_returns_announcement(): void
    {
        $announcement = $this->createAnnouncement();

        $this->admin();
        $response = $this->getJson("/api/v1/admin/announcements/{$announcement->id}");

        $response->assertStatus(200)
            ->assertJsonPath('data.id', $announcement->id)
            ->assertJsonPath('data.title', 'Holiday Schedule');
    }

    public function test_admin_show_returns_404_for_missing(): void
    {
        $this->admin();
        $response = $this->getJson('/api/v1/admin/announcements/nonexistent-id');

        $response->assertStatus(404);
    }

    // ── Admin: update + archive ─────────────────────────────────

    public function test_admin_can_update_announcement(): void
    {
        $announcement = $this->createAnnouncement();

        $this->admin();
        $response = $this->putJson("/api/v1/admin/announcements/{$announcement->id}", [
            'title'   => 'Updated Title',
            'message' => 'Updated message.',
        ]);

        $response->assertStatus(200)
            ->assertJsonPath('data.title', 'Updated Title')
            ->assertJsonPath('data.message', 'Updated message.');
    }

    public function test_admin_can_archive_announcement(): void
    {
        $announcement = $this->createAnnouncement();

        $this->admin();
        $response = $this->patchJson("/api/v1/admin/announcements/{$announcement->id}/archive");

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'ARCHIVED');

        $this->assertDatabaseHas('announcements', [
            'id'     => $announcement->id,
            'status' => 'ARCHIVED',
        ]);
    }

    public function test_archive_is_idempotent(): void
    {
        $announcement = $this->createAnnouncement('Test', 'ARCHIVED');

        $this->admin();
        $response = $this->patchJson("/api/v1/admin/announcements/{$announcement->id}/archive");

        $response->assertStatus(200)
            ->assertJsonPath('data.status', 'ARCHIVED');
    }

    public function test_commuter_cannot_archive(): void
    {
        $announcement = $this->createAnnouncement();

        $this->commuter();
        $response = $this->patchJson("/api/v1/admin/announcements/{$announcement->id}/archive");

        $response->assertStatus(403);
    }

    public function test_archiving_stamps_archived_at(): void
    {
        $announcement = $this->createAnnouncement();

        $this->admin();
        $this->patchJson("/api/v1/admin/announcements/{$announcement->id}/archive")->assertOk();

        $announcement->refresh();
        $this->assertNotNull($announcement->archived_at);
    }

    public function test_re_archiving_does_not_reset_archived_at(): void
    {
        $announcement = $this->createAnnouncement();
        $this->admin();
        $this->patchJson("/api/v1/admin/announcements/{$announcement->id}/archive")->assertOk();
        $announcement->refresh();
        $originalArchivedAt = $announcement->archived_at;

        $this->travel(1)->days();
        $this->patchJson("/api/v1/admin/announcements/{$announcement->id}/archive")->assertOk();

        $announcement->refresh();
        $this->assertTrue($originalArchivedAt->equalTo($announcement->archived_at));
    }

    // ── Prune: archived announcements past the 30-day retention window ──

    public function test_prune_command_soft_deletes_stale_archived_announcements(): void
    {
        $announcement = $this->createAnnouncement('Old Notice', 'ARCHIVED');
        $announcement->forceFill(['archived_at' => now()->subDays(31)])->save();

        $this->artisan('announcements:prune-archived')->assertExitCode(0);

        $this->assertSoftDeleted('announcements', ['id' => $announcement->id]);
    }

    public function test_prune_command_ignores_recently_archived_announcements(): void
    {
        $announcement = $this->createAnnouncement('Recent Notice', 'ARCHIVED');
        $announcement->forceFill(['archived_at' => now()->subDays(10)])->save();

        $this->artisan('announcements:prune-archived')->assertExitCode(0);

        $this->assertDatabaseHas('announcements', ['id' => $announcement->id, 'deleted_at' => null]);
    }

    public function test_prune_command_ignores_active_announcements(): void
    {
        $announcement = $this->createAnnouncement('Still Active', 'ACTIVE');
        $announcement->forceFill(['created_at' => now()->subDays(60)])->save();

        $this->artisan('announcements:prune-archived')->assertExitCode(0);

        $this->assertDatabaseHas('announcements', ['id' => $announcement->id, 'deleted_at' => null]);
    }

    public function test_pruned_announcement_disappears_from_admin_list(): void
    {
        $announcement = $this->createAnnouncement('Long Gone', 'ARCHIVED');
        $announcement->forceFill(['archived_at' => now()->subDays(31)])->save();

        $this->artisan('announcements:prune-archived')->assertExitCode(0);

        $this->admin();
        $response = $this->getJson('/api/v1/admin/announcements?status=ARCHIVED');
        $titles = collect($response->json('data.data'))->pluck('title');
        $this->assertFalse($titles->contains('Long Gone'));
    }

    // ── User-facing: feed + is_read ─────────────────────────────

    public function test_any_auth_role_can_view_announcements(): void
    {
        $this->createAnnouncement('Active One', 'ACTIVE');
        $this->createAnnouncement('Archived One', 'ARCHIVED');

        $this->commuter();
        $response = $this->getJson('/api/v1/announcements');

        $response->assertStatus(200);
        $items = $response->json('data.data');
        // Only ACTIVE announcements show in the user feed
        $this->assertCount(1, $items);
        $this->assertEquals('Active One', $items[0]['title']);
        // is_read should be false (commuter hasn't read it)
        $this->assertFalse($items[0]['is_read']);
    }

    public function test_unauthenticated_cannot_view_announcements(): void
    {
        $response = $this->getJson('/api/v1/announcements');
        $response->assertStatus(401);
    }

    public function test_conductor_can_view_announcements(): void
    {
        $this->createAnnouncement();

        Sanctum::actingAs($this->conductor);
        $response = $this->getJson('/api/v1/announcements');

        $response->assertStatus(200);
        $this->assertNotEmpty($response->json('data.data'));
    }

    // ── Mark-as-read ────────────────────────────────────────────

    public function test_commuter_can_mark_announcement_read(): void
    {
        $announcement = $this->createAnnouncement();

        $this->commuter();
        $response = $this->postJson("/api/v1/announcements/{$announcement->id}/read");

        $response->assertStatus(200)
            ->assertJsonPath('success', true);

        $this->assertDatabaseHas('announcement_reads', [
            'announcement_id' => $announcement->id,
            'user_id'         => $this->commuter->id,
        ]);

        // Subsequent GET shows is_read=true
        $response = $this->getJson('/api/v1/announcements');
        $items = $response->json('data.data');
        $this->assertTrue($items[0]['is_read']);
    }

    public function test_mark_read_is_idempotent(): void
    {
        $announcement = $this->createAnnouncement();

        $this->commuter();
        $this->postJson("/api/v1/announcements/{$announcement->id}/read")->assertStatus(200);
        $this->postJson("/api/v1/announcements/{$announcement->id}/read")->assertStatus(200);

        // Only one read record exists
        $this->assertEquals(
            1,
            AnnouncementRead::where('announcement_id', $announcement->id)
                ->where('user_id', $this->commuter->id)
                ->count()
        );
    }

    public function test_mark_read_nonexistent_returns_404(): void
    {
        $this->commuter();
        $response = $this->postJson('/api/v1/announcements/nonexistent-id/read');
        $response->assertStatus(404);
    }

    public function test_read_state_is_per_user(): void
    {
        $announcement = $this->createAnnouncement();

        // Commuter 1 reads it
        $this->commuter();
        $this->postJson("/api/v1/announcements/{$announcement->id}/read");

        // Commuter 2 has NOT read it
        $otherCommuter = User::factory()->commuter()->create();
        Sanctum::actingAs($otherCommuter);
        $response = $this->getJson('/api/v1/announcements');
        $items = $response->json('data.data');
        $this->assertFalse($items[0]['is_read']);
    }

    // ── Unread count ────────────────────────────────────────────

    public function test_unread_count_returns_correct_count(): void
    {
        $this->createAnnouncement('First');
        $this->createAnnouncement('Second');
        $read = $this->createAnnouncement('Read One');

        // Mark one as read
        $this->commuter();
        $this->postJson("/api/v1/announcements/{$read->id}/read");

        $response = $this->getJson('/api/v1/announcements/unread-count');

        $response->assertStatus(200)
            ->assertJsonPath('data.count', 2);
    }

    public function test_unread_count_excludes_archived(): void
    {
        $this->createAnnouncement('Active', 'ACTIVE');
        $this->createAnnouncement('Archived', 'ARCHIVED');

        $this->commuter();
        $response = $this->getJson('/api/v1/announcements/unread-count');

        $response->assertStatus(200)
            ->assertJsonPath('data.count', 1);
    }

    // ── Filter: unread_only ─────────────────────────────────────

    public function test_unread_only_filter(): void
    {
        $unread = $this->createAnnouncement('Unread');
        $read = $this->createAnnouncement('Read');

        $this->commuter();
        $this->postJson("/api/v1/announcements/{$read->id}/read");

        $response = $this->getJson('/api/v1/announcements?unread_only=1');

        $response->assertStatus(200);
        $items = $response->json('data.data');
        $this->assertCount(1, $items);
        $this->assertEquals('Unread', $items[0]['title']);
    }

    // ── Unread count scoped by type (Lost & Found claim-update badge) ──

    /** Directly creates a targeted announcement, mirroring AnnouncementService::notifyUser(). */
    private function createTargetedAnnouncement(string $userId, string $type, string $title = 'Update'): Announcement
    {
        return Announcement::create([
            'user_id' => $userId,
            'type'    => $type,
            'title'   => $title,
            'message' => 'Details.',
            'status'  => 'ACTIVE',
        ]);
    }

    public function test_unread_count_filters_by_types(): void
    {
        $this->createTargetedAnnouncement($this->commuter->id, 'claim_approved', 'Claim Approved');
        $this->createTargetedAnnouncement($this->commuter->id, 'claim_rejected', 'Claim Rejected');
        $this->createAnnouncement('Holiday Notice'); // broadcast, type=holiday

        $this->commuter();
        $response = $this->getJson('/api/v1/announcements/unread-count?types=claim_approved,claim_rejected');

        $response->assertStatus(200)->assertJsonPath('data.count', 2);

        // No types filter still counts everything (existing behaviour unchanged).
        $response = $this->getJson('/api/v1/announcements/unread-count');
        $response->assertStatus(200)->assertJsonPath('data.count', 3);
    }

    public function test_unread_count_by_types_is_scoped_to_the_requesting_user(): void
    {
        $otherCommuter = User::factory()->commuter()->create();
        $this->createTargetedAnnouncement($otherCommuter->id, 'claim_approved', 'Not Mine');
        $this->createTargetedAnnouncement($this->commuter->id, 'claim_approved', 'Mine');

        $this->commuter();
        $response = $this->getJson('/api/v1/announcements/unread-count?types=claim_approved');

        $response->assertStatus(200)->assertJsonPath('data.count', 1);
    }

    // ── Bulk mark-as-read ────────────────────────────────────────

    public function test_mark_all_read_scoped_to_types_only_marks_matching_rows(): void
    {
        $approved = $this->createTargetedAnnouncement($this->commuter->id, 'claim_approved', 'Claim Approved');
        $released = $this->createTargetedAnnouncement($this->commuter->id, 'claim_released', 'Claim Released');
        $holiday = $this->createAnnouncement('Holiday Notice'); // broadcast, type=holiday

        $this->commuter();
        $response = $this->postJson('/api/v1/announcements/mark-all-read?types=claim_approved,claim_released');

        $response->assertStatus(200)->assertJsonPath('data.count', 2);

        $this->assertDatabaseHas('announcement_reads', ['announcement_id' => $approved->id, 'user_id' => $this->commuter->id]);
        $this->assertDatabaseHas('announcement_reads', ['announcement_id' => $released->id, 'user_id' => $this->commuter->id]);
        $this->assertDatabaseMissing('announcement_reads', ['announcement_id' => $holiday->id, 'user_id' => $this->commuter->id]);

        // The unscoped unread-count now excludes the two just-read rows.
        $response = $this->getJson('/api/v1/announcements/unread-count');
        $response->assertStatus(200)->assertJsonPath('data.count', 1);
    }

    public function test_mark_all_read_without_types_marks_everything(): void
    {
        $this->createAnnouncement('First');
        $this->createAnnouncement('Second');

        $this->commuter();
        $response = $this->postJson('/api/v1/announcements/mark-all-read');
        $response->assertStatus(200)->assertJsonPath('data.count', 2);

        $response = $this->getJson('/api/v1/announcements/unread-count');
        $response->assertStatus(200)->assertJsonPath('data.count', 0);
    }

    public function test_mark_all_read_is_idempotent(): void
    {
        $this->createTargetedAnnouncement($this->commuter->id, 'claim_approved', 'Claim Approved');

        $this->commuter();
        $this->postJson('/api/v1/announcements/mark-all-read?types=claim_approved')
            ->assertStatus(200)->assertJsonPath('data.count', 1);

        // Nothing left unread for that type — a second call marks 0.
        $this->postJson('/api/v1/announcements/mark-all-read?types=claim_approved')
            ->assertStatus(200)->assertJsonPath('data.count', 0);
    }
}
