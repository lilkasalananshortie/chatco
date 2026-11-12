<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\DiscountApplication;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

/**
 * S5-T8 Additional Coverage — Admin registration review & verification.
 *
 * Covers the admin side of the commuter self-registration flow:
 *   GET   /admin/registrations
 *   POST  /admin/registrations/{id}/approve
 *   POST  /admin/registrations/{id}/reject
 *
 * Every test asserts real DB state, not just status codes — matching the
 * S5-T8 acceptance criteria:
 *   - pending list returns only PENDING accounts
 *   - approve sets account_status=APPROVED + commuter_type=applied_type +
 *     verified_at and enables login
 *   - reject soft-deletes the account, records rejection_reason, and frees
 *     the email
 *   - PENDING/REJECTED accounts cannot log in
 *   - non-admin -> 403
 */
class AdminRegistrationTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    public function test_false_storage_result_does_not_create_an_onsite_account(): void
    {
        config(['filesystems.uploads.private_id_disk' => 'r2_private']);
        $disk = \Mockery::mock(\Illuminate\Contracts\Filesystem\Filesystem::class);
        $disk->shouldReceive('putFileAs')->once()->andReturn(false);
        Storage::shouldReceive('disk')->with('r2_private')->once()->andReturn($disk);
        $payload = $this->onsitePayload();
        $this->actingAs($this->admin)->post('/api/v1/admin/registrations', $payload, ['Accept' => 'application/json'])
            ->assertStatus(503)->assertJsonPath('message', 'The ID image could not be stored. Please try again.');
        $this->assertDatabaseMissing('commuter_profiles', ['username' => $payload['username']]);
    }

    public function test_onsite_storage_failure_does_not_create_an_account(): void
    {
        $this->mock(\App\Services\MediaStorageService::class, fn ($mock) => $mock->shouldReceive('storeCommuterId')->once()->andThrow(new \RuntimeException('Storage unavailable')));
        $this->actingAs($this->admin)->post('/api/v1/admin/registrations', $this->onsitePayload(), ['Accept' => 'application/json'])
            ->assertStatus(503)->assertJsonPath('message', 'The ID image could not be stored. Please try again.');
        $this->assertDatabaseMissing('commuter_profiles', ['username' => $this->onsitePayload()['username']]);
    }

    public function test_onsite_rejects_files_above_safe_web_upload_limit(): void
    {
        Storage::fake('public');
        $this->actingAs($this->admin)->post('/api/v1/admin/registrations', $this->onsitePayload([
            'id_image' => UploadedFile::fake()->image('large.jpg')->size(3073),
        ]), ['Accept' => 'application/json'])->assertStatus(422)->assertJsonValidationErrors('id_image');
        $this->assertEmpty(Storage::disk('public')->allFiles());
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = $this->seedAdmin();
    }

    // ── GET /admin/registrations ─────────────────────────

    public function test_pending_list_returns_only_pending_commuters(): void
    {
        $pending1 = $this->seedPendingCommuter(['email' => 'pending1@example.com', 'username' => 'pending1']);
        $pending2 = $this->seedPendingCommuter(['email' => 'pending2@example.com', 'username' => 'pending2']);
        $approved = $this->seedApprovedCommuter(['email' => 'approved@example.com', 'username' => 'approved']);
        $suspended = $this->seedSuspendedCommuter(['email' => 'suspended@example.com', 'username' => 'suspended']);

        $response = $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations');

        $response->assertStatus(200)
            ->assertJsonPath('success', true);

        $emails = array_column($response->json('data.data'), 'email');
        $this->assertContains('pending1@example.com', $emails);
        $this->assertContains('pending2@example.com', $emails);
        $this->assertNotContains('approved@example.com', $emails);
        $this->assertNotContains('suspended@example.com', $emails);

        // Only the 2 PENDING commuters — not the approved/suspended ones.
        $this->assertCount(2, $response->json('data.data'));
    }

    public function test_pending_list_returns_empty_when_none_pending(): void
    {
        $this->seedApprovedCommuter(['email' => 'a@example.com', 'username' => 'a']);

        $response = $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations');

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.data', []);
    }

    public function test_pending_list_includes_full_registration_details(): void
    {
        $this->seedPendingCommuter([
            'email' => 'detail@example.com',
            'username' => 'detail.user',
            'applied_type' => 'SENIOR',
        ]);

        $response = $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations');

        $response->assertStatus(200)
            ->assertJsonStructure([
                'data' => [
                    'data' => [
                        '*' => [
                            'id', 'email', 'first_name', 'middle_name',
                            'surname', 'birthdate', 'gender', 'contact_number',
                            'applied_type', 'username',
                            'language_preference', 'account_status', 'id_image_url',
                        ],
                    ],
                ],
            ]);

        $first = $response->json('data.data.0');
        $this->assertEquals('SENIOR', $first['applied_type']);
        $this->assertEquals('PENDING', $first['account_status']);
        $this->assertNull($first['verified_at']);
        $this->assertNull($first['rejection_reason']);
        $this->assertNotEmpty($first['id_image_url']);
        $this->assertStringContainsString('ids/commuters/', $first['id_image_url']);
    }

    public function test_pending_list_is_ordered_oldest_first(): void
    {
        // Seed two pending commuters with explicit created_at timestamps
        // to assert FIFO ordering (oldest submission reviewed first).
        $older = $this->seedPendingCommuter(['email' => 'older@example.com', 'username' => 'older']);
        $older->forceFill(['created_at' => now()->subHours(2)])->save();
        $newer = $this->seedPendingCommuter(['email' => 'newer@example.com', 'username' => 'newer']);
        $newer->forceFill(['created_at' => now()->subHour()])->save();

        $response = $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations');

        $emails = array_column($response->json('data.data'), 'email');
        $this->assertEquals(['older@example.com', 'newer@example.com'], $emails);
    }

    public function test_pending_list_sorts_most_recent_first_when_requested(): void
    {
        $older = $this->seedPendingCommuter(['email' => 'older@example.com', 'username' => 'older']);
        $older->forceFill(['created_at' => now()->subHours(2)])->save();
        $newer = $this->seedPendingCommuter(['email' => 'newer@example.com', 'username' => 'newer']);
        $newer->forceFill(['created_at' => now()->subHour()])->save();

        $recent = $this->actingAs($this->admin)->getJson('/api/v1/admin/registrations?sort=recent');
        $this->assertEquals(['newer@example.com', 'older@example.com'], array_column($recent->json('data.data'), 'email'));

        $oldest = $this->actingAs($this->admin)->getJson('/api/v1/admin/registrations?sort=oldest');
        $this->assertEquals(['older@example.com', 'newer@example.com'], array_column($oldest->json('data.data'), 'email'));

        $this->actingAs($this->admin)->getJson('/api/v1/admin/registrations?sort=alphabetical')
            ->assertStatus(422)
            ->assertJsonValidationErrors('sort');
    }

    public function test_pending_list_pages_same_second_sign_ups_without_repeats_in_either_order(): void
    {
        $at = now()->subHour()->startOfSecond();
        foreach (['a', 'b', 'c'] as $name) {
            $this->seedPendingCommuter(['email' => "{$name}@example.com", 'username' => $name])
                ->forceFill(['created_at' => $at])->save();
        }

        $pages = fn (string $sort) => collect([1, 2, 3])->flatMap(fn (int $page) => array_column(
            $this->actingAs($this->admin)
                ->getJson("/api/v1/admin/registrations?sort={$sort}&per_page=1&page={$page}")
                ->json('data.data'),
            'email'
        ))->all();

        $oldest = $pages('oldest');
        $this->assertCount(3, array_unique($oldest));
        $this->assertEquals(array_reverse($oldest), $pages('recent'));
    }

    public function test_pending_list_filters_by_id(): void
    {
        $target = $this->seedPendingCommuter(['email' => 'target@example.com', 'username' => 'target']);
        $this->seedPendingCommuter(['email' => 'other@example.com', 'username' => 'other']);

        $response = $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations?id='.$target->id);

        $response->assertStatus(200)
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.email', 'target@example.com');
    }

    public function test_pending_and_rejected_lists_search_by_full_name(): void
    {
        $pending = $this->seedPendingCommuter(['email' => 'vice@example.com', 'username' => 'vice']);
        $pending->commuterProfile->update(['first_name' => 'Vice', 'surname' => 'Ganda']);
        $this->seedPendingCommuter(['email' => 'other@example.com', 'username' => 'other']);

        $this->actingAs($this->admin)->getJson('/api/v1/admin/registrations?search='.urlencode('vice ganda'))
            ->assertOk()
            ->assertJsonCount(1, 'data.data')
            ->assertJsonPath('data.data.0.email', 'vice@example.com');

        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", ['rejection_reason' => 'ID image is unreadable.'])
            ->assertOk();

        $this->actingAs($this->admin)->getJson('/api/v1/admin/registrations/rejected?search='.urlencode('Ganda Vice'))
            ->assertOk()
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.surname', 'Ganda');

        $this->actingAs($this->admin)->getJson('/api/v1/admin/registrations/rejected?search='.urlencode('vice applicant'))
            ->assertOk()
            ->assertJsonPath('data.total', 0);
    }

    public function test_pending_list_forbidden_for_non_admin(): void
    {
        $conductor = $this->seedConductor();

        $this->actingAs($conductor)
            ->getJson('/api/v1/admin/registrations')
            ->assertStatus(403);
    }

    public function test_pending_list_requires_authentication(): void
    {
        $this->getJson('/api/v1/admin/registrations')
            ->assertStatus(401);
    }

    // ── POST  /admin/registrations (onsite) ───────────────────────
    // AdminRegistrationController::store() uploads id_image to the private
    // disk BEFORE opening the DB transaction (line ~157), same reasoning as
    // AuthService::register().

    public function test_store_assigns_the_generated_uuid_to_the_created_user(): void
    {
        Storage::fake('public');

        $response = $this->actingAs($this->admin)->post('/api/v1/admin/registrations', [
            'first_name' => '  jUAN  cARLOS ',
            'surname' => ' dELA  cRUZ  ',
            'birthdate' => '1995-01-01',
            'gender' => 'Male',
            'email' => 'onsite.success@example.com',
            'middle_name' => ' dELA  cRUZ ',
            'contact_number' => '09171112223',
            'username' => 'onsite.success',
            'applied_type' => 'REGULAR',
            'id_image' => UploadedFile::fake()->image('id.jpg', 800, 600),
        ], ['Accept' => 'application/json']);

        $response->assertStatus(201)
            ->assertJsonPath('data.account_status', 'APPROVED')
            ->assertJsonPath('data.must_change_password', true)
            ->assertJsonMissingPath('data.password');

        $user = User::where('email', 'onsite.success@example.com')->first();
        $this->assertNotSame('unknown', password_get_info($user->password)['algoName']);

        // 'id' is intentionally excluded from User::$fillable, so this only
        // holds if store() assigns it directly ($user->id = $userId) rather
        // than through User::create()'s mass assignment, which would
        // silently drop it and let the `creating` hook mint a different,
        // mismatched UUID than the one baked into the uploaded filename.
        $this->assertStringContainsString($user->id, $user->commuterProfile->id_image_url);
        $this->assertSame('Juan Carlos', $user->commuterProfile->first_name);
        $this->assertSame('Dela Cruz', $user->commuterProfile->middle_name);
        $this->assertSame('Dela Cruz', $user->commuterProfile->surname);
    }

    public function test_onsite_registration_requires_gender(): void
    {
        Storage::fake('public');

        $payload = $this->onsitePayload();
        unset($payload['gender']);

        $this->actingAs($this->admin)
            ->post('/api/v1/admin/registrations', $payload, ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonValidationErrors('gender');

        $this->assertDatabaseMissing('users', ['email' => 'onsite.student@example.com']);
    }

    // ── Onsite Student: the school details renewal asks for ──────

    public function test_onsite_student_requires_the_school_details(): void
    {
        Storage::fake('public');

        $this->actingAs($this->admin)
            ->post('/api/v1/admin/registrations', $this->onsitePayload(['applied_type' => 'STUDENT']), ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['school_name', 'education_level', 'school_year']);

        $this->assertDatabaseMissing('users', ['email' => 'onsite.student@example.com']);
    }

    public function test_onsite_high_school_student_saves_an_approved_application_with_grade_level(): void
    {
        Storage::fake('public');

        $this->actingAs($this->admin)->post('/api/v1/admin/registrations', $this->onsitePayload([
            'applied_type' => 'STUDENT',
            'school_name' => '  Calumpit National High School ',
            'education_level' => 'HIGH_SCHOOL',
            'grade_level' => '11',
            'school_year' => '2026-2027',
        ]), ['Accept' => 'application/json'])->assertStatus(201);

        $user = User::where('email', 'onsite.student@example.com')->firstOrFail();
        $this->assertDatabaseHas('discount_applications', [
            'commuter_id' => $user->id,
            'request_type' => 'APPLICATION',
            'requested_type' => 'STUDENT',
            'status' => 'APPROVED',
            'school_name' => 'Calumpit National High School',
            'education_level' => 'HIGH_SCHOOL',
            'grade_level' => 11,
            'school_year' => '2026-2027',
            'enrollment_term' => null,
            'reviewed_by' => $this->admin->id,
        ]);
        $this->assertNotNull($user->commuterProfile->student_discount_expires_at);
    }

    public function test_onsite_college_student_requires_the_enrollment_term(): void
    {
        Storage::fake('public');
        $payload = $this->onsitePayload([
            'applied_type' => 'STUDENT',
            'school_name' => 'Bulacan State University',
            'education_level' => 'COLLEGE',
            'grade_level' => '11', // ignored for college
            'school_year' => '2026-2027',
        ]);

        $this->actingAs($this->admin)
            ->post('/api/v1/admin/registrations', $payload, ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['enrollment_term']);

        $payload['enrollment_term'] = '1st Semester';
        $payload['id_image'] = UploadedFile::fake()->image('id.jpg', 800, 600);
        $this->actingAs($this->admin)
            ->post('/api/v1/admin/registrations', $payload, ['Accept' => 'application/json'])
            ->assertStatus(201);

        $this->assertDatabaseHas('discount_applications', [
            'education_level' => 'COLLEGE',
            'grade_level' => null,
            'enrollment_term' => '1st Semester',
            'status' => 'APPROVED',
        ]);
    }

    public function test_onsite_non_student_ignores_school_details(): void
    {
        Storage::fake('public');

        $this->actingAs($this->admin)->post('/api/v1/admin/registrations', $this->onsitePayload([
            'applied_type' => 'SENIOR',
            'school_name' => 'Should not be saved',
        ]), ['Accept' => 'application/json'])->assertStatus(201);

        $this->assertDatabaseCount('discount_applications', 0);
    }

    private function onsitePayload(array $overrides = []): array
    {
        return array_merge([
            'first_name' => 'Onsite',
            'surname' => 'Student',
            'birthdate' => '2008-04-02',
            'gender' => 'Female',
            'email' => 'onsite.student@example.com',
            'contact_number' => '09171112299',
            'username' => 'onsite.student',
            'applied_type' => 'REGULAR',
            'id_image' => UploadedFile::fake()->image('id.jpg', 800, 600),
        ], $overrides);
    }

    // Failure-path cleanup: any failure inside the transaction must delete
    // the already-uploaded ID image — otherwise a failed onsite registration
    // leaves an orphaned government ID behind.

    public function test_store_cleans_up_uploaded_id_image_on_profile_creation_failure(): void
    {
        Storage::fake('public');
        $this->withoutExceptionHandling();

        // Stands in for any transaction failure (uniqueness race, DB blip,
        // etc.) — the catch(\Throwable) added to store() must clean up the
        // already-uploaded ID image and rethrow, not leave it orphaned.
        CommuterProfile::creating(function () {
            throw new \RuntimeException('Simulated database failure.');
        });

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('Simulated database failure.');

        try {
            $this->actingAs($this->admin)->post('/api/v1/admin/registrations', [
                'first_name' => 'Onsite',
                'surname' => 'Applicant',
                'birthdate' => '1995-01-01',
                'gender' => 'Male',
                'email' => 'onsite.fail@example.com',
                'contact_number' => '09171112222',
                'username' => 'onsite.fail',
                'password' => 'SecurePass123!',
                'applied_type' => 'REGULAR',
                'id_image' => UploadedFile::fake()->image('id.jpg', 800, 600),
            ], ['Accept' => 'application/json']);
        } finally {
            $this->assertDatabaseMissing('users', ['email' => 'onsite.fail@example.com']);
            $this->assertEmpty(Storage::disk('public')->allFiles('ids'));
        }
    }

    // ── POST  /admin/registrations/{id}/approve ──────────────────

    public function test_approve_sets_status_approved_and_commuter_type_and_verified_at(): void
    {
        $pending = $this->seedPendingCommuter([
            'email' => 'approve@example.com',
            'username' => 'approve.me',
            'applied_type' => 'PWD',
        ]);

        $response = $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/approve");

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.account_status', 'APPROVED')
            ->assertJsonPath('data.commuter_type', 'PWD')
            ->assertJsonPath('data.applied_type', 'PWD')
            ->assertJsonPath('data.rejection_reason', null);

        // verified_at is now set (ISO 8601 string).
        $this->assertNotNull($response->json('data.verified_at'));

        // Real DB state assertions.
        $this->assertDatabaseHas('commuter_profiles', [
            'id' => $pending->id,
            'account_status' => 'APPROVED',
            'commuter_type' => 'PWD',
            'rejection_reason' => null,
        ]);

        // verified_at is a real timestamp, not null.
        $profile = CommuterProfile::find($pending->id);
        $this->assertNotNull($profile->verified_at);
    }

    public function test_approve_enables_login_for_the_commuter(): void
    {
        $pending = $this->seedPendingCommuter([
            'email' => 'can.login@example.com',
            'username' => 'can.login',
            'password' => 'SecretPass123',
        ]);

        // Before approval — cannot log in (PENDING).
        $this->postJson('/api/v1/auth/login', [
            'login' => 'can.login@example.com',
            'password' => 'SecretPass123',
        ])->assertStatus(403);

        // Approve.
        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/approve")
            ->assertStatus(200);

        // After approval — can log in and gets a token.
        $response = $this->postJson('/api/v1/auth/login', [
            'login' => 'can.login@example.com',
            'password' => 'SecretPass123',
        ]);

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.role', 'COMMUTER')
            ->assertJsonStructure(['data' => ['token']]);
    }

    public function test_approve_returns_404_for_missing_registration(): void
    {
        $this->actingAs($this->admin)
            ->postJson('/api/v1/admin/registrations/'.fake()->uuid.'/approve')
            ->assertStatus(404);
    }

    public function test_approve_rejects_already_approved_account_with_422(): void
    {
        $approved = $this->seedApprovedCommuter([
            'email' => 'already@example.com',
            'username' => 'already',
        ]);

        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$approved->id}/approve")
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['account_status']]);
    }

    public function test_approve_forbidden_for_non_admin(): void
    {
        $pending = $this->seedPendingCommuter(['email' => 'a@b.com', 'username' => 'a']);
        $conductor = $this->seedConductor();

        $this->actingAs($conductor)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/approve")
            ->assertStatus(403);

        // The account is still PENDING — no side effects.
        $this->assertDatabaseHas('commuter_profiles', [
            'id' => $pending->id,
            'account_status' => 'PENDING',
        ]);
    }

    // ── POST  /admin/registrations/{id}/reject ───────────────────

    public function test_rejected_list_filters_by_applied_type(): void
    {
        foreach (['STUDENT' => 'rej.student', 'PWD' => 'rej.pwd'] as $type => $username) {
            $pending = $this->seedPendingCommuter([
                'email' => "{$username}@example.com",
                'username' => $username,
                'applied_type' => $type,
            ]);
            $this->actingAs($this->admin)
                ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", ['rejection_reason' => 'ID image is unreadable.'])
                ->assertOk();
        }

        $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations/rejected?applied_type=PWD')
            ->assertOk()
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.data.0.applied_type', 'PWD');

        $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations/rejected')
            ->assertOk()
            ->assertJsonPath('data.total', 2);
    }

    public function test_signup_school_details_are_shown_and_decided_with_the_registration(): void
    {
        $approved = $this->seedPendingCommuter(['email' => 'student.a@example.com', 'username' => 'student.a']);
        $rejected = $this->seedPendingCommuter(['email' => 'student.b@example.com', 'username' => 'student.b']);
        foreach ([$approved, $rejected] as $user) {
            DiscountApplication::create([
                'commuter_id' => $user->id, 'request_type' => 'APPLICATION', 'requested_type' => 'STUDENT', 'status' => 'PENDING',
                'school_name' => 'Calumpit National High School', 'education_level' => 'HIGH_SCHOOL', 'grade_level' => 11,
                'school_year' => '2026-2027', 'submitted_at' => now(), 'first_submitted_at' => now(),
            ]);
        }

        // The reviewer sees the school details next to the ID…
        $this->actingAs($this->admin)->getJson("/api/v1/admin/registrations?id={$approved->id}")->assertOk()
            ->assertJsonPath('data.data.0.student_details.school_name', 'Calumpit National High School')
            ->assertJsonPath('data.data.0.student_details.grade_level', 11);

        // …and not again in the Discount applications queue.
        $this->actingAs($this->admin)->getJson('/api/v1/admin/discount-applications')->assertOk()->assertJsonPath('data.total', 0);
        $pendingId = DiscountApplication::where('commuter_id', $approved->id)->value('id');
        $this->actingAs($this->admin)->postJson("/api/v1/admin/discount-applications/{$pendingId}/review", ['decision' => 'APPROVED', 'revision' => 1])
            ->assertStatus(409);

        $this->actingAs($this->admin)->postJson("/api/v1/admin/registrations/{$approved->id}/approve")->assertOk();
        $this->actingAs($this->admin)->postJson("/api/v1/admin/registrations/{$rejected->id}/reject", ['rejection_reason' => 'School ID does not match the name given.'])->assertOk();

        $this->assertDatabaseHas('discount_applications', ['commuter_id' => $approved->id, 'status' => 'APPROVED', 'reviewed_by' => $this->admin->id]);
        $this->assertDatabaseHas('discount_applications', ['commuter_id' => $rejected->id, 'status' => 'REJECTED', 'reason' => 'School ID does not match the name given.']);
    }

    public function test_reject_sets_status_rejected_and_records_reason(): void
    {
        $pending = $this->seedPendingCommuter([
            'email' => 'reject@example.com',
            'username' => 'reject.me',
        ]);

        $response = $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", [
                'rejection_reason' => 'ID image is blurry and unreadable.',
            ]);

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.account_status', 'REJECTED')
            ->assertJsonPath('data.rejection_reason', 'ID image is blurry and unreadable.');

        // The profile row survives (audit trail) with REJECTED status.
        $this->assertDatabaseHas('commuter_profiles', [
            'id' => $pending->id,
            'account_status' => 'REJECTED',
            'rejection_reason' => 'ID image is blurry and unreadable.',
        ]);
    }

    public function test_reject_soft_deletes_user_and_blocks_login(): void
    {
        $pending = $this->seedPendingCommuter([
            'email' => 'nologin@example.com',
            'username' => 'nologin',
            'password' => 'SecretPass123',
        ]);

        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", [
                'rejection_reason' => 'Invalid ID document.',
            ])
            ->assertStatus(200);

        // The user is soft-deleted.
        $this->assertSoftDeleted('users', ['id' => $pending->id]);

        // Login now fails with 401 (user not found) — the rejected commuter
        // cannot authenticate.
        $this->postJson('/api/v1/auth/login', [
            'login' => 'nologin@example.com',
            'password' => 'SecretPass123',
        ])->assertStatus(401);
    }

    public function test_reject_frees_email_for_reuse(): void
    {
        $pending = $this->seedPendingCommuter([
            'email' => 'reusable@example.com',
            'username' => 'reusable',
        ]);

        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", [
                'rejection_reason' => 'Blurry ID.',
            ])
            ->assertStatus(200);

        // Sign-up verifies the address before /register accepts it — stand in
        // for that step (covered end-to-end by EmailVerificationTest).
        DB::table('email_verification_codes')->updateOrInsert(
            ['email' => 'reusable@example.com'],
            [
                'token' => Hash::make('000000'),
                'attempts' => 0,
                'verified_at' => now(),
                'created_at' => now(),
            ]
        );

        // The same email, username and contact number can now be re-registered
        // (end-to-end: register -> reject -> register again with all three).
        $response = $this->post('/api/v1/auth/register', [
            'first_name' => 'New',
            'surname' => 'Applicant',
            'birthdate' => '1995-01-01',
            'gender' => 'Male',
            'email' => 'reusable@example.com',
            'contact_number' => '09171234567',
            'username' => 'reusable',
            'password' => 'SecurePass123!',
            'password_confirmation' => 'SecurePass123!',
            'applied_type' => 'REGULAR',
            'terms_accepted' => true,
            'privacy_acknowledged' => true,
            'registration_confirmed' => true,
            'terms_version' => config('registration.terms_version'),
            'privacy_version' => config('registration.privacy_version'),
            'id_image' => UploadedFile::fake()->image('id.jpg', 800, 600),
        ], ['Accept' => 'application/json']);

        $response->assertStatus(201)
            ->assertJsonPath('data.account_status', 'PENDING');

        // The original rejected user row is still there (soft-deleted), and
        // a new live user row holds the canonical email.
        $this->assertDatabaseHas('users', [
            'email' => 'reusable@example.com',
            'role' => 'COMMUTER',
        ]);

        // Two profile rows exist — the rejected one + the new PENDING one.
        $this->assertDatabaseCount('commuter_profiles', 2);
        $this->assertDatabaseHas('commuter_profiles', [
            'account_status' => 'REJECTED',
            'rejection_reason' => 'Blurry ID.',
        ]);
        $this->assertDatabaseHas('commuter_profiles', [
            'account_status' => 'PENDING',
            'username' => 'reusable',
            'contact_number' => '09171234567',
        ]);
    }

    public function test_reject_requires_reason_field(): void
    {
        $pending = $this->seedPendingCommuter(['email' => 'noreason@example.com', 'username' => 'noreason']);

        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", [])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['rejection_reason']]);

        // No side effects — account is still PENDING.
        $this->assertDatabaseHas('commuter_profiles', [
            'id' => $pending->id,
            'account_status' => 'PENDING',
        ]);
    }

    public function test_reject_rejects_too_short_reason_with_422(): void
    {
        $pending = $this->seedPendingCommuter(['email' => 'short@example.com', 'username' => 'short']);

        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", [
                'rejection_reason' => 'ok',
            ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['rejection_reason']]);
    }

    public function test_reject_returns_404_for_missing_registration(): void
    {
        $this->actingAs($this->admin)
            ->postJson('/api/v1/admin/registrations/'.fake()->uuid.'/reject', [
                'rejection_reason' => 'Not found test.',
            ])
            ->assertStatus(404);
    }

    public function test_reject_rejects_already_approved_account_with_422(): void
    {
        $approved = $this->seedApprovedCommuter([
            'email' => 'cannotreject@example.com',
            'username' => 'cannotreject',
        ]);

        $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$approved->id}/reject", [
                'rejection_reason' => 'Too late, already approved.',
            ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['account_status']]);
    }

    public function test_reject_forbidden_for_non_admin(): void
    {
        $pending = $this->seedPendingCommuter(['email' => 'forbidden@example.com', 'username' => 'forbidden']);
        $conductor = $this->seedConductor();

        $this->actingAs($conductor)
            ->postJson("/api/v1/admin/registrations/{$pending->id}/reject", [
                'rejection_reason' => 'Should not work.',
            ])
            ->assertStatus(403);

        // No side effects.
        $this->assertDatabaseHas('commuter_profiles', [
            'id' => $pending->id,
            'account_status' => 'PENDING',
        ]);
    }

    // ── Helpers ──────────────────────────────────────────────────

    private function seedAdmin(): User
    {
        $admin = User::create([
            'email' => 'admin@chatco.test',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);

        AdminProfile::create([
            'id' => $admin->id,
            'first_name' => 'Site',
            'last_name' => 'Admin',
        ]);

        return $admin;
    }

    private function seedConductor(): User
    {
        $conductor = User::create([
            'email' => 'conductor@chatco.test',
            'password' => Hash::make('password123'),
            'role' => UserRole::CONDUCTOR,
        ]);

        ConductorProfile::create([
            'id' => $conductor->id,
            'first_name' => 'Cond',
            'last_name' => 'Uctor',
            'birthday' => '1990-01-01',
            'generated_username' => 'conductor001',
            'generated_password' => Hash::make('password123'),
        ]);

        return $conductor;
    }

    private function seedPendingCommuter(array $overrides = []): User
    {
        $email = $overrides['email'] ?? 'pending@example.com';
        $username = $overrides['username'] ?? 'pending.user';
        $applied = $overrides['applied_type'] ?? 'STUDENT';
        $password = $overrides['password'] ?? 'SecretPass123';

        $user = User::create([
            'email' => $email,
            'password' => Hash::make($password),
            'role' => UserRole::COMMUTER,
        ]);

        CommuterProfile::create([
            'id' => $user->id,
            'first_name' => 'Pending',
            'surname' => 'Applicant',
            'birthdate' => '1995-05-05',
            'gender' => 'Female',
            'email' => $email,
            'contact_number' => '09171234567',
            'commuter_type' => $applied,
            'applied_type' => $applied,
            'username' => $username,
            'language_preference' => 'English',
            'account_status' => 'PENDING',
            'id_image_url' => 'ids/commuters/'.$user->id.'/sample',
            'verified_at' => null,
            'rejection_reason' => null,
        ]);

        return $user;
    }

    private function seedApprovedCommuter(array $overrides = []): User
    {
        $user = $this->seedPendingCommuter($overrides);
        $user->commuterProfile->update([
            'account_status' => 'APPROVED',
            'verified_at' => now(),
        ]);

        return $user;
    }

    private function seedSuspendedCommuter(array $overrides = []): User
    {
        $user = $this->seedApprovedCommuter($overrides);
        $user->commuterProfile->update([
            'account_status' => 'SUSPENDED',
        ]);

        return $user;
    }
}
