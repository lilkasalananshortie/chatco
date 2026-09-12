<?php

namespace Tests\Feature;

use App\Models\Driver;
use App\Models\Feedback;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Sprint 6 (T6 revised) — Admin staff-feedback listing.
 *
 * Covers the endpoint that powers the "double-click a conductor/driver row
 * in User Management → see their feedback/ratings" flow. The standalone
 * "Feedback QR" admin module was removed; this consolidates feedback review
 * into User Management.
 *
 *   GET /api/v1/admin/feedback?conductor_id={uuid}
 *   GET /api/v1/admin/feedback?driver_id={uuid}
 *
 * Verified:
 *   - Admin can list feedback for a conductor (paginated + summary)
 *   - Admin can list feedback for a driver
 *   - Summary: average_rating, total_count, 5→1 distribution
 *   - Empty feedback → 200 with zeroed stats
 *   - Pagination: per_page respected, page 2 returns the next slice
 *   - Each feedback row includes vehicle + commuter relations
 *   - 422 when neither conductor_id nor driver_id supplied
 *   - 404 when conductor_id doesn't exist
 *   - 404 when driver_id doesn't exist
 *   - 403 when commuter tries to access (role enforcement)
 *   - 401 when unauthenticated
 */
class FeedbackAdminListTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private User $conductor;

    private Driver $driver;

    private Vehicle $vehicle;

    private User $commuter1;

    private User $commuter2;

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()->admin()->create();
        $this->conductor = User::factory()->conductor()->create();
        $this->driver = Driver::factory()->create();
        $this->vehicle = Vehicle::factory()->create();
        $this->commuter1 = User::factory()->commuter()->create();
        $this->commuter2 = User::factory()->commuter()->create();
    }

    private function admin(): void
    {
        Sanctum::actingAs($this->admin);
    }

    private function commuter(): void
    {
        Sanctum::actingAs($this->commuter1);
    }

    /**
     * Seed N feedback rows for the conductor, each from a fresh commuter so
     * the unique(commuter_id, shift_id) constraint isn't violated. Each
     * feedback gets its own shift_id + distinct rating so distribution is
     * deterministic.
     */
    private function seedConductorFeedback(int $count, array $ratings): void
    {
        for ($i = 0; $i < $count; $i++) {
            $commuter = User::factory()->commuter()->create();
            $shiftId = 'SFT-C-'.$i.'-'.now()->format('YmdHis');

            ShiftLog::create([
                'shift_id' => $shiftId,
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
                'status' => 'ACTIVE',
            ]);

            Feedback::create([
                'id' => Str::uuid()->toString(),
                'shift_id' => $shiftId,
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'conductor_id' => $this->conductor->id,
                'commuter_id' => $commuter->commuterProfile->id,
                'rating' => $ratings[$i] ?? 5,
                'category' => 'Cleanliness',
                'comment' => 'Test comment '.$i,
                // The conductor listing aggregates over the conductor_*
                // columns (rows without a conductor_rating are filtered out),
                // so the conductor's score/category/comment must be stamped.
                'conductor_rating' => $ratings[$i] ?? 5,
                'conductor_category' => 'Cleanliness',
                'conductor_comment' => 'Test comment '.$i,
            ]);

            // Distinct created_at per row — the whole loop runs within one
            // second, so without this the "newest first" ordering would tie
            // and the returned order would be nondeterministic.
            Feedback::where('shift_id', $shiftId)->update([
                'created_at' => now()->addSeconds($i),
            ]);
        }
    }

    /**
     * Seed feedback for the DRIVER specifically (the conductor on those
     * shifts is a different conductor so conductor stats stay clean).
     */
    private function seedDriverFeedback(int $count, array $ratings): void
    {
        $otherConductor = User::factory()->conductor()->create();
        for ($i = 0; $i < $count; $i++) {
            $commuter = User::factory()->commuter()->create();
            $shiftId = 'SFT-D-'.$i.'-'.now()->format('YmdHis');

            ShiftLog::create([
                'shift_id' => $shiftId,
                'conductor_id' => $otherConductor->id,
                'driver_id' => $this->driver->id,
                'vehicle_id' => $this->vehicle->id,
                'route_id' => null,
                'conductor_name' => 'Other Conductor',
                'driver_name' => 'Test Driver',
                'unit_number' => $this->vehicle->unit_number,
                'plate_number' => $this->vehicle->plate_number,
                'time_in' => now(),
                'time_out' => null,
                'is_active' => true,
                'status' => 'ACTIVE',
            ]);

            Feedback::create([
                'id' => Str::uuid()->toString(),
                'shift_id' => $shiftId,
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $this->driver->id,
                'conductor_id' => $otherConductor->id,
                'commuter_id' => $commuter->commuterProfile->id,
                'rating' => $ratings[$i] ?? 5,
                'category' => 'Driving',
                'comment' => 'Driver test '.$i,
            ]);
        }
    }

    // ── Happy path: conductor ───────────────────────────────────

    public function test_admin_can_list_conductor_feedback(): void
    {
        $this->seedConductorFeedback(3, [5, 4, 3]);
        $this->admin();

        $response = $this->getJson("/api/v1/admin/feedback?conductor_id={$this->conductor->id}");

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.staff.id', $this->conductor->id)
            ->assertJsonPath('data.staff.role', 'CONDUCTOR')
            ->assertJsonPath('data.summary.total_count', 3)
            ->assertJsonPath('data.summary.average_rating', 4)
            ->assertJsonPath('data.summary.distribution.5', 1)
            ->assertJsonPath('data.summary.distribution.4', 1)
            ->assertJsonPath('data.summary.distribution.3', 1)
            ->assertJsonPath('data.summary.distribution.2', 0)
            ->assertJsonPath('data.summary.distribution.1', 0)
            ->assertJsonCount(3, 'data.feedback')
            ->assertJsonPath('data.pagination.total', 3);
    }

    public function test_conductor_feedback_includes_vehicle_and_commuter_relations(): void
    {
        $this->seedConductorFeedback(1, [5]);
        $this->admin();

        $response = $this->getJson("/api/v1/admin/feedback?conductor_id={$this->conductor->id}");

        $response->assertStatus(200)
            ->assertJsonPath('data.feedback.0.vehicle.unit_number', $this->vehicle->unit_number)
            ->assertJsonPath('data.feedback.0.vehicle.plate_number', $this->vehicle->plate_number)
            ->assertJsonStructure([
                'data' => [
                    'feedback' => [
                        '*' => ['id', 'shift_id', 'rating', 'category', 'comment', 'vehicle', 'commuter'],
                    ],
                ],
            ]);
    }

    public function test_conductor_feedback_ordered_newest_first(): void
    {
        $this->seedConductorFeedback(2, [5, 4]);
        $this->admin();

        $response = $this->getJson("/api/v1/admin/feedback?conductor_id={$this->conductor->id}");

        $rows = $response->json('data.feedback');
        $this->assertCount(2, $rows);
        // The 2nd seeded row was created after the 1st, so it should come first.
        $this->assertStringContainsString('Test comment 1', $rows[0]['comment']);
        $this->assertStringContainsString('Test comment 0', $rows[1]['comment']);
    }

    // ── Happy path: driver ──────────────────────────────────────

    public function test_admin_can_list_driver_feedback(): void
    {
        $this->seedDriverFeedback(2, [5, 5]);
        $this->admin();

        $response = $this->getJson("/api/v1/admin/feedback?driver_id={$this->driver->id}");

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.staff.id', $this->driver->id)
            ->assertJsonPath('data.staff.role', 'DRIVER')
            ->assertJsonPath('data.summary.total_count', 2)
            ->assertJsonPath('data.summary.average_rating', 5)
            ->assertJsonPath('data.summary.distribution.5', 2);
    }

    public function test_driver_feedback_isolated_from_conductor_feedback(): void
    {
        // Seed 3 feedback where THIS conductor + a DIFFERENT driver are on
        // the shift — the driver we query for should see ZERO feedback.
        $otherDriver = Driver::factory()->create();
        for ($i = 0; $i < 3; $i++) {
            $commuter = User::factory()->commuter()->create();
            $shiftId = 'SFT-ISO-'.$i.'-'.now()->format('YmdHis');

            ShiftLog::create([
                'shift_id' => $shiftId,
                'conductor_id' => $this->conductor->id,
                'driver_id' => $otherDriver->id,
                'vehicle_id' => $this->vehicle->id,
                'route_id' => null,
                'conductor_name' => 'Test Conductor',
                'driver_name' => 'Other Driver',
                'unit_number' => $this->vehicle->unit_number,
                'plate_number' => $this->vehicle->plate_number,
                'time_in' => now(),
                'time_out' => null,
                'is_active' => true,
                'status' => 'ACTIVE',
            ]);

            Feedback::create([
                'id' => Str::uuid()->toString(),
                'shift_id' => $shiftId,
                'vehicle_id' => $this->vehicle->id,
                'driver_id' => $otherDriver->id,
                'conductor_id' => $this->conductor->id,
                'commuter_id' => $commuter->commuterProfile->id,
                'rating' => 5,
                'category' => 'Cleanliness',
                'comment' => 'Iso test '.$i,
                // Required so the conductor listing (which filters on
                // whereNotNull(conductor_rating)) counts these rows.
                'conductor_rating' => 5,
                'conductor_category' => 'Cleanliness',
                'conductor_comment' => 'Iso test '.$i,
            ]);
        }
        $this->admin();

        // The conductor has 3 feedback, the OTHER driver has 3, but the
        // driver we query for ($this->driver) has 0.
        $conductorResponse = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}"
        );
        $conductorResponse->assertStatus(200)
            ->assertJsonPath('data.summary.total_count', 3);

        $driverResponse = $this->getJson(
            "/api/v1/admin/feedback?driver_id={$this->driver->id}"
        );
        $driverResponse->assertStatus(200)
            ->assertJsonPath('data.summary.total_count', 0);
    }

    // ── Empty state ─────────────────────────────────────────────

    public function test_conductor_with_no_feedback_returns_zeroed_summary(): void
    {
        $this->admin();

        $response = $this->getJson("/api/v1/admin/feedback?conductor_id={$this->conductor->id}");

        $response->assertStatus(200)
            ->assertJsonPath('data.summary.total_count', 0)
            ->assertJsonPath('data.summary.average_rating', 0)
            ->assertJsonPath('data.summary.distribution.5', 0)
            ->assertJsonPath('data.summary.distribution.4', 0)
            ->assertJsonPath('data.summary.distribution.3', 0)
            ->assertJsonPath('data.summary.distribution.2', 0)
            ->assertJsonPath('data.summary.distribution.1', 0)
            ->assertJsonCount(0, 'data.feedback');
    }

    // ── Pagination ──────────────────────────────────────────────

    public function test_pagination_respects_per_page(): void
    {
        $this->seedConductorFeedback(5, [5, 4, 3, 2, 1]);
        $this->admin();

        $response = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}&per_page=2"
        );

        $response->assertStatus(200)
            ->assertJsonCount(2, 'data.feedback')
            ->assertJsonPath('data.pagination.per_page', 2)
            ->assertJsonPath('data.pagination.total', 5)
            ->assertJsonPath('data.pagination.last_page', 3)
            // Summary reflects ALL feedback, not just the current page.
            ->assertJsonPath('data.summary.total_count', 5);
    }

    public function test_summary_values_cover_all_pages_and_keep_fractional_average(): void
    {
        $this->seedDriverFeedback(4, [5, 4, 4, 1]);
        $this->admin();

        $this->getJson("/api/v1/admin/feedback?driver_id={$this->driver->id}&per_page=1")
            ->assertOk()
            ->assertJsonCount(1, 'data.feedback')
            ->assertJsonPath('data.summary.total_count', 4)
            ->assertJsonPath('data.summary.average_rating', 3.5)
            ->assertJsonPath('data.summary.distribution.5', 1)
            ->assertJsonPath('data.summary.distribution.4', 2)
            ->assertJsonPath('data.summary.distribution.3', 0)
            ->assertJsonPath('data.summary.distribution.2', 0)
            ->assertJsonPath('data.summary.distribution.1', 1);
    }

    public function test_pagination_page_2_returns_next_slice(): void
    {
        $this->seedConductorFeedback(4, [5, 4, 3, 2]);
        $this->admin();

        $page1 = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}&per_page=2&page=1"
        )->json('data.feedback');
        $page2 = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}&per_page=2&page=2"
        )->json('data.feedback');

        $this->assertCount(2, $page1);
        $this->assertCount(2, $page2);
        // No overlap between pages.
        $page1Ids = array_column($page1, 'id');
        $page2Ids = array_column($page2, 'id');
        $this->assertEmpty(array_intersect($page1Ids, $page2Ids));
    }

    public function test_per_page_capped_at_50(): void
    {
        $this->seedConductorFeedback(3, [5, 4, 3]);
        $this->admin();

        // per_page=999 should be silently capped to 50 — all 3 returned.
        $response = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}&per_page=999"
        );

        $response->assertStatus(200)
            ->assertJsonPath('data.pagination.per_page', 50)
            ->assertJsonCount(3, 'data.feedback');
    }

    // ── Validation: missing params ──────────────────────────────

    public function test_returns_422_when_neither_conductor_nor_driver_id_supplied(): void
    {
        $this->admin();

        $response = $this->getJson('/api/v1/admin/feedback');

        $response->assertStatus(422)
            ->assertJsonPath('success', false)
            ->assertJsonStructure(['errors' => ['conductor_id']]);
    }

    // ── 404: staff not found ────────────────────────────────────

    public function test_returns_404_when_conductor_id_does_not_exist(): void
    {
        $this->admin();

        $response = $this->getJson('/api/v1/admin/feedback?conductor_id=nonexistent-uuid');

        $response->assertStatus(404)
            ->assertJsonPath('success', false)
            ->assertJsonPath('message', 'Conductor not found');
    }

    public function test_returns_404_when_driver_id_does_not_exist(): void
    {
        $this->admin();

        $response = $this->getJson('/api/v1/admin/feedback?driver_id=nonexistent-uuid');

        $response->assertStatus(404)
            ->assertJsonPath('success', false)
            ->assertJsonPath('message', 'Driver not found');
    }

    // ── Role enforcement ────────────────────────────────────────

    public function test_commuter_cannot_access_admin_feedback_endpoint(): void
    {
        $this->commuter();

        $response = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}"
        );

        $response->assertStatus(403);
    }

    public function test_conductor_cannot_access_admin_feedback_endpoint(): void
    {
        Sanctum::actingAs($this->conductor);

        $response = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}"
        );

        $response->assertStatus(403);
    }

    public function test_unauthenticated_request_returns_401(): void
    {
        $response = $this->getJson(
            "/api/v1/admin/feedback?conductor_id={$this->conductor->id}"
        );

        $response->assertStatus(401);
    }
}
