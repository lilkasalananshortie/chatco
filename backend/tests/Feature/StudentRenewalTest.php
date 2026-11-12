<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\Announcement;
use App\Models\CommuterProfile;
use App\Models\DiscountApplication;
use App\Models\Setting;
use App\Models\User;
use App\Services\AnnouncementService;
use App\Services\StudentRenewalService;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class StudentRenewalTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        // Most scenarios exercise the original September cycle explicitly.
        Setting::where('key', Setting::STUDENT_RENEWAL_MONTH_KEY)->delete();
        \Illuminate\Support\Facades\Cache::forget(Setting::STUDENT_RENEWAL_MONTH_CACHE_KEY);
        config(['registration.student_renewal_first_year' => 2027, 'registration.student_renewal_month' => 9]);
        Storage::fake('public');
        Storage::fake('r2_private');
        $this->at('2027-09-15 12:00:00');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function at(string $time): void
    {
        Carbon::setTestNow(Carbon::parse($time, 'Asia/Manila'));
    }

    /** Storage::disk() is typed as the Filesystem contract; the faked disks are adapters with assert helpers. */
    private function disk(string $name): FilesystemAdapter
    {
        return Storage::disk($name);
    }

    private function commuter(string $type = 'STUDENT'): User
    {
        $user = User::create(['email' => Str::uuid().'@test.com', 'password' => 'Password1!', 'role' => UserRole::COMMUTER]);
        CommuterProfile::create([
            'id' => $user->id, 'first_name' => 'Student', 'surname' => 'Commuter', 'birthdate' => '2004-01-01',
            'gender' => 'Female', 'email' => $user->email, 'contact_number' => '09171234567',
            'commuter_type' => $type, 'applied_type' => $type, 'username' => (string) Str::uuid(),
            'language_preference' => 'English', 'account_status' => 'APPROVED', 'verified_at' => now(),
            'student_discount_expires_at' => $type === 'STUDENT' ? '2027-10-01 00:00:00' : null,
            'id_image_url' => 'original-id.jpg',
        ]);

        return $user;
    }

    private function proof(string $file = 'school-id.jpg', array $overrides = []): array
    {
        return $overrides + [
            'school_name' => 'Test University', 'education_level' => 'COLLEGE',
            'school_year' => '2027-2028', 'enrollment_term' => 'First semester',
            'document' => UploadedFile::fake()->image($file),
        ];
    }

    private function submit(User $user): DiscountApplication
    {
        Sanctum::actingAs($user);
        $this->post('/api/v1/commuter/student-renewal', $this->proof(), ['Accept' => 'application/json'])
            ->assertCreated()->assertJsonPath('data.status', 'PENDING');

        return DiscountApplication::where('commuter_id', $user->id)->firstOrFail();
    }

    private function review(DiscountApplication $application, string $decision, ?string $reason = null)
    {
        $admin = User::create(['email' => Str::uuid().'@test.com', 'password' => 'Password1!', 'role' => UserRole::ADMIN]);
        Sanctum::actingAs($admin);

        return $this->postJson('/api/v1/admin/discount-applications/'.$application->id.'/review', compact('decision', 'reason') + ['revision' => $application->revision]);
    }

    public function test_deploy_opens_november_2026_renewal_for_existing_students(): void
    {
        $student = $this->commuter();
        $this->at('2026-11-13 12:00:00');
        config(['registration.student_renewal_first_year' => 2026]);

        $migration = require database_path('migrations/2026_11_13_000001_open_november_student_renewal.php');
        $migration->up();

        $this->assertSame(11, Setting::studentRenewalMonth());
        $this->assertSame('2026-12-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $state = app(StudentRenewalService::class)->state($student->fresh());
        $this->assertSame('November 1-30, 2026', $state['renewal_period']);
        $this->assertTrue($state['can_submit']);
        $this->assertTrue($state['discount_eligible']);
    }

    public function test_september_grace_and_student_only_expiration(): void
    {
        $student = $this->commuter();
        $others = collect(['REGULAR', 'PWD', 'SENIOR'])->map(fn ($type) => $this->commuter($type));
        $this->at('2027-09-30 23:59:59');
        Sanctum::actingAs($student);
        $this->getJson('/api/v1/commuter/student-renewal')->assertOk()->assertJsonPath('data.discount_eligible', true)->assertJsonPath('data.status', 'NOT_RENEWED');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $this->at('2027-10-01 00:00:00');
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->effectiveFareType());
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->commuter_type);
        $this->assertSame('APPROVED', $student->fresh()->commuterProfile->account_status);
        $this->assertNull($student->fresh()->deleted_at);
        foreach ($others as $other) {
            $this->assertSame($other->commuterProfile->commuter_type, $other->fresh()->commuterProfile->commuter_type);
        }
    }

    public function test_timely_pending_submission_is_protected_and_approval_restores_discount(): void
    {
        $student = $this->commuter();
        $this->at('2027-09-30 23:59:59');
        $application = $this->submit($student);
        $this->at('2027-10-01 00:00:00');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $profile = $student->fresh()->commuterProfile;
        $this->assertSame('STUDENT', $profile->commuter_type);
        $this->assertSame('REGULAR', $profile->effectiveFareType());
        Sanctum::actingAs($student->fresh());
        $this->getJson('/api/v1/commuter/profile')->assertOk();
        $this->review($application, 'APPROVED')->assertOk();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->effectiveFareType());
        $this->assertSame('2028-10-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertSame('original-id.jpg', $student->fresh()->commuterProfile->id_image_url);
        $this->review($application, 'APPROVED')->assertConflict();
    }

    public function test_duplicate_submission_is_rejected_and_queue_has_renewal_label(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->post('/api/v1/commuter/student-renewal', $this->proof('duplicate.jpg'), ['Accept' => 'application/json'])->assertConflict();
        $this->assertDatabaseCount('discount_applications', 1);
        $this->disk('r2_private')->assertExists($application->document_path);
        $this->assertCount(1, Storage::disk('r2_private')->allFiles());
        Sanctum::actingAs(User::create(['email' => 'admin@test.com', 'password' => 'Password1!', 'role' => UserRole::ADMIN]));
        $this->getJson('/api/v1/admin/discount-applications?status=PENDING')->assertOk()->assertJsonPath('data.total', 1)->assertJsonPath('data.data.0.request_type', 'RENEWAL')->assertJsonPath('data.data.0.commuter.email', $student->email);
    }

    public function test_correction_grace_protects_timely_submission_then_expires(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->at('2027-10-02 12:00:00');
        $this->review($application, 'NEEDS_CORRECTION', 'School year is missing.')->assertOk();
        $this->assertDatabaseHas('announcements', ['user_id' => $student->id, 'type' => 'STUDENT_RENEWAL_DONE', 'title' => 'Renewal needs correction']);
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $this->at('2027-10-09 12:00:00');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->commuter_type);
        $this->assertSame('EXPIRED', $application->fresh()->status);
        $new = $this->submit($student->fresh());
        $this->assertTrue($new->first_submitted_at->gte(app(StudentRenewalService::class)->cutoff(2027)));
        $this->assertCount(1, $new->submission_history);
    }

    public function test_corrected_proof_within_window_preserves_original_deadline_protection(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $first = $application->first_submitted_at->toIso8601String();
        $this->at('2027-10-02 12:00:00');
        $this->review($application, 'NEEDS_CORRECTION', 'Blurry photo.')->assertOk();
        $this->at('2027-10-03 12:00:00');
        $corrected = $this->submit($student->fresh());
        $this->assertSame($first, $corrected->first_submitted_at->toIso8601String());
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->effectiveFareType());
    }

    public function test_opt_out_cancels_pending_and_prevents_stale_approval(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->postJson('/api/v1/commuter/student-renewal/regular', ['confirmed' => true])->assertOk()->assertJsonPath('data.commuter_type', 'REGULAR');
        $this->assertSame('CANCELLED', $application->fresh()->status);
        $this->review($application, 'APPROVED')->assertConflict();
        $this->assertNotNull($student->fresh());
        $this->assertSame('APPROVED', $student->fresh()->commuterProfile->account_status);
    }

    public function test_final_rejection_keeps_account_and_late_reapplication_needs_approval(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->review($application, 'REJECTED', 'No current enrollment.')->assertOk();
        $this->assertDatabaseHas('announcements', ['user_id' => $student->id, 'type' => 'STUDENT_RENEWAL_DONE', 'title' => 'Student renewal rejected']);
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->commuter_type);
        $this->assertNotNull($student->fresh());
        $this->at('2027-10-05 12:00:00');
        $this->submit($student->fresh());
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->effectiveFareType());
        $this->review($application, 'APPROVED')->assertConflict();
        $this->review($application->fresh(), 'APPROVED')->assertOk();
    }

    public function test_opting_out_after_approval_does_not_display_active_renewal(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->review($application, 'APPROVED')->assertOk();
        Sanctum::actingAs($student->fresh());
        $this->postJson('/api/v1/commuter/student-renewal/regular', ['confirmed' => true])->assertOk()
            ->assertJsonPath('data.status', 'CANCELLED')->assertJsonPath('data.discount_eligible', false)
            ->assertJsonPath('data.can_submit', false);
        $this->assertSame('APPROVED', $application->fresh()->status);
    }

    public function test_reminder_schedule_deduplicates_read_notices_and_stops_after_submission(): void
    {
        $student = $this->commuter();
        $this->commuter('PWD');
        foreach (['08-25', '08-29', '08-31', '09-01', '09-08', '09-15', '09-22', '09-29'] as $index => $date) {
            $this->at('2027-'.$date.' 08:00:00');
            $this->artisan('students:process-renewals')->assertSuccessful();
            $this->artisan('students:process-renewals')->assertSuccessful();
            $this->assertSame($index + 1, Announcement::where('type', 'STUDENT_RENEWAL')->where('user_id', $student->id)->count());
        }
        $this->submit($student);
        $this->at('2027-09-30 12:00:00');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame(8, Announcement::where('type', 'STUDENT_RENEWAL')->count());
    }

    public function test_auth_role_upload_and_window_guards(): void
    {
        $this->getJson('/api/v1/commuter/student-renewal')->assertUnauthorized();
        $regular = $this->commuter('REGULAR');
        Sanctum::actingAs($regular);
        $this->getJson('/api/v1/commuter/student-renewal')->assertForbidden();
        $this->post('/api/v1/commuter/student-renewal', $this->proof('id.jpg'), ['Accept' => 'application/json'])->assertForbidden();
        $this->getJson('/api/v1/admin/discount-applications')->assertForbidden();
        $student = $this->commuter();
        Sanctum::actingAs($student);
        $this->post('/api/v1/commuter/student-renewal', $this->proof(overrides: ['document' => UploadedFile::fake()->create('script.html', 1, 'text/html')]), ['Accept' => 'application/json'])->assertUnprocessable();
        $this->at('2027-08-31 23:59:59');
        $this->post('/api/v1/commuter/student-renewal', $this->proof('id.jpg'), ['Accept' => 'application/json'])->assertConflict();
    }

    public function test_enrollment_details_are_validated_and_stored_by_education_level(): void
    {
        $url = '/api/v1/commuter/student-renewal';
        $headers = ['Accept' => 'application/json'];
        Sanctum::actingAs($this->commuter());
        $this->post($url, $this->proof(overrides: ['school_name' => '   ']), $headers)->assertJsonValidationErrors('school_name');
        $this->post($url, $this->proof(overrides: ['education_level' => 'GRADUATE']), $headers)->assertJsonValidationErrors('education_level');
        $this->post($url, $this->proof(overrides: ['education_level' => 'HIGH_SCHOOL']), $headers)->assertJsonValidationErrors('grade_level');
        $this->post($url, $this->proof(overrides: ['education_level' => 'HIGH_SCHOOL', 'grade_level' => 6]), $headers)->assertJsonValidationErrors('grade_level');
        $this->post($url, $this->proof(overrides: ['enrollment_term' => '']), $headers)->assertJsonValidationErrors('enrollment_term');
        $this->assertDatabaseCount('discount_applications', 0);
        $this->assertCount(0, Storage::disk('r2_private')->allFiles());

        // College ignores a stray grade; high school may leave the term blank.
        $this->post($url, $this->proof(overrides: ['grade_level' => 9]), $headers)->assertCreated()
            ->assertJsonPath('data.application.school_name', 'Test University')
            ->assertJsonPath('data.application.education_level', 'COLLEGE')
            ->assertJsonPath('data.application.grade_level', null)
            ->assertJsonPath('data.application.school_year', '2027-2028')
            ->assertJsonPath('data.application.enrollment_term', 'First semester');
        Sanctum::actingAs($this->commuter());
        $this->post($url, $this->proof(overrides: ['education_level' => 'HIGH_SCHOOL', 'grade_level' => 12, 'enrollment_term' => '']), $headers)->assertCreated()
            ->assertJsonPath('data.application.education_level', 'HIGH_SCHOOL')
            ->assertJsonPath('data.application.grade_level', 12)
            ->assertJsonPath('data.application.enrollment_term', null);
    }

    public function test_reminder_is_due_until_snoozed_dismissed_or_submitted_and_survives_new_sessions(): void
    {
        $url = '/api/v1/commuter/student-renewal';
        $student = $this->commuter();
        Sanctum::actingAs($student);
        $this->getJson($url)->assertOk()->assertJsonPath('data.reminder_due', true);
        $this->postJson($url.'/reminder', ['action' => 'later'])->assertJsonValidationErrors('action');

        // Snoozing hides it for a day, including for a fresh login.
        $this->postJson($url.'/reminder', ['action' => 'snooze'])->assertOk()->assertJsonPath('data.reminder_due', false);
        $this->at('2027-09-16 11:59:59');
        Sanctum::actingAs($student->fresh());
        $this->getJson($url)->assertOk()->assertJsonPath('data.reminder_due', false);
        $this->at('2027-09-16 12:00:00');
        $this->getJson($url)->assertOk()->assertJsonPath('data.reminder_due', true);

        // Dismissing silences this cycle only.
        $this->postJson($url.'/reminder', ['action' => 'dismiss'])->assertOk()->assertJsonPath('data.reminder_due', false);
        $this->at('2027-09-29 12:00:00');
        Sanctum::actingAs($student->fresh());
        $this->getJson($url)->assertOk()->assertJsonPath('data.reminder_due', false)->assertJsonPath('data.notice_active', true);
        $student->commuterProfile->update(['renewal_reminder_dismissed_cycle' => 2026]);
        Sanctum::actingAs($student->fresh());
        $this->getJson($url)->assertOk()->assertJsonPath('data.reminder_due', true);

        // Nothing left to do once proof is waiting for review.
        $this->submit($student->fresh());
        $this->getJson($url)->assertOk()->assertJsonPath('data.reminder_due', false);

        Sanctum::actingAs($this->commuter('REGULAR'));
        $this->postJson($url.'/reminder', ['action' => 'snooze'])->assertForbidden();
        $this->getJson($url)->assertForbidden();
    }

    public function test_initial_approval_during_renewal_period_counts_for_new_cycle(): void
    {
        $student = $this->commuter();
        $student->commuterProfile->update(['student_discount_expires_at' => CommuterProfile::initialStudentExpiry()]);
        Sanctum::actingAs($student->fresh());
        $this->getJson('/api/v1/commuter/student-renewal')->assertOk()->assertJsonPath('data.status', 'APPROVED')->assertJsonPath('data.can_submit', false);
    }

    public function test_first_cycle_does_not_retroactively_expire_existing_students(): void
    {
        $student = $this->commuter();
        $this->at('2026-10-13 12:00:00');
        $student->commuterProfile->update(['student_discount_expires_at' => null]);
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->effectiveFareType());
    }

    public function test_october_debug_window_uses_matching_notices_deadlines_and_approval_expiry(): void
    {
        config(['registration.student_renewal_first_year' => 2026, 'registration.student_renewal_month' => 10]);
        $student = $this->commuter();
        $unsubmitted = $this->commuter();
        foreach ([$student, $unsubmitted] as $user) {
            $user->commuterProfile->update(['student_discount_expires_at' => '2026-11-01 00:00:00']);
        }
        $service = app(StudentRenewalService::class);
        $this->at('2026-09-25 12:00:00');
        $this->assertFalse($service->state($student->fresh())['can_submit']);
        $this->assertTrue($service->isForRenewal($student->fresh()->commuterProfile));
        $this->artisan('students:process-renewals')->assertSuccessful();
        $notice = Announcement::where('user_id', $student->id)->where('type', 'STUDENT_RENEWAL')->firstOrFail();
        $this->assertStringContainsString('October 1-31, 2026', $notice->message);
        $this->assertStringContainsString('November 1', $notice->message);

        $this->at('2026-10-14 12:00:00');
        $state = $service->state($student->fresh());
        $this->assertTrue($state['can_submit']);
        $this->assertTrue($state['notice_active']);
        $this->assertTrue($state['discount_eligible']);
        $this->assertSame('October 1-31, 2026', $state['renewal_period']);
        $this->assertSame('2026-11-01T00:00:00+08:00', $state['deadline']);
        $this->assertSame('2027-11-01', CommuterProfile::initialStudentExpiry()->toDateString());
        $this->at('2026-10-31 23:59:59');
        $application = $this->submit($student->fresh());
        $this->at('2026-11-01 00:00:00');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $this->assertSame('REGULAR', $unsubmitted->fresh()->commuterProfile->commuter_type);
        $this->review($application, 'APPROVED')->assertOk();
        $this->assertSame('2027-11-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertFalse($service->isForRenewal($student->fresh()->commuterProfile));
    }

    public function test_admin_users_flag_students_due_for_renewal_without_changing_account_status(): void
    {
        $student = $this->commuter();
        $regular = $this->commuter('REGULAR');
        $admin = User::create(['email' => 'renewal-admin@test.com', 'password' => 'Password1!', 'role' => UserRole::ADMIN]);
        Sanctum::actingAs($admin);
        $url = '/api/v1/admin/users?role=COMMUTER&account_status=ACTIVE&search='.$student->email;

        $this->at('2027-08-24 23:59:59');
        $this->getJson($url)->assertOk()->assertJsonPath('data.data.0.student_renewal_required', false);
        $this->at('2027-08-25 00:00:00');
        $this->getJson($url)->assertOk()->assertJsonPath('data.data.0.student_renewal_required', true)
            ->assertJsonPath('data.data.0.account_status', 'APPROVED');
        $this->getJson('/api/v1/admin/users?search='.$regular->email)->assertOk()
            ->assertJsonPath('data.data.0.student_renewal_required', false);

        $student->commuterProfile->update(['student_discount_expires_at' => '2028-10-01 00:00:00']);
        $this->getJson($url)->assertOk()->assertJsonPath('data.data.0.student_renewal_required', false);
        $student->commuterProfile->update(['student_discount_expires_at' => '2027-10-01 00:00:00']);
        $this->at('2028-08-01 00:00:00');
        $this->getJson($url)->assertOk()->assertJsonPath('data.data.0.student_renewal_required', true);
        $student->commuterProfile->update(['account_status' => 'SUSPENDED']);
        $this->getJson('/api/v1/admin/users?search='.$student->email)->assertOk()
            ->assertJsonPath('data.data.0.student_renewal_required', false)
            ->assertJsonPath('data.data.0.account_status', 'SUSPENDED');
    }

    public function test_pending_application_keeps_its_cycle_protection_and_review_after_august_rollover(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->at('2028-08-01 00:00:00');
        $this->assertSame(2028, app(StudentRenewalService::class)->cycleYear());
        $this->getJson('/api/v1/commuter/student-renewal')->assertOk()
            ->assertJsonPath('data.cycle_year', 2027)->assertJsonPath('data.application.id', $application->id)
            ->assertJsonPath('data.status', 'PENDING')->assertJsonPath('data.can_submit', false);
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->effectiveFareType());

        $this->at('2028-09-01 12:00:00');
        $this->post('/api/v1/commuter/student-renewal', $this->proof('duplicate.jpg', ['school_year' => '2028-2029']), ['Accept' => 'application/json'])->assertConflict();
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertDatabaseMissing('announcements', ['type' => 'STUDENT_RENEWAL', 'user_id' => $student->id]);
        $this->review($application, 'APPROVED')->assertOk();
        $this->assertSame('2028-10-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->effectiveFareType());
        $this->assertTrue(app(StudentRenewalService::class)->state($student->fresh())['can_submit']);
    }

    public function test_correction_window_survives_august_rollover_and_resubmits_the_original_application(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $first = $application->first_submitted_at->toIso8601String();
        $this->at('2028-07-31 12:00:00');
        $this->review($application, 'NEEDS_CORRECTION', 'Blurry photo.')->assertOk();
        $this->at('2028-08-01 00:00:00');
        Sanctum::actingAs($student->fresh());
        $this->getJson('/api/v1/commuter/student-renewal')->assertOk()
            ->assertJsonPath('data.cycle_year', 2027)->assertJsonPath('data.can_submit', true)
            ->assertJsonPath('data.status', 'NEEDS_CORRECTION');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $corrected = $this->submit($student->fresh());
        $this->assertSame($application->id, $corrected->id);
        $this->assertSame(2027, $corrected->cycle_year);
        $this->assertSame(2, $corrected->revision);
        $this->assertSame($first, $corrected->first_submitted_at->toIso8601String());
        $this->assertDatabaseCount('discount_applications', 1);
        $this->assertCount(1, $corrected->submission_history);
        $this->review($application, 'APPROVED')->assertConflict();
        $this->review($corrected, 'APPROVED')->assertOk();
    }

    public function test_prior_cycle_correction_expires_at_its_own_deadline(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->at('2028-07-31 12:00:00');
        $this->review($application, 'NEEDS_CORRECTION', 'Blurry photo.')->assertOk();
        $this->at('2028-08-07 11:59:59');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('STUDENT', $student->fresh()->commuterProfile->commuter_type);
        $this->at('2028-08-07 12:00:00');
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('EXPIRED', $application->fresh()->status);
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->commuter_type);
        $state = app(StudentRenewalService::class)->state($student->fresh());
        $this->assertSame(2028, $state['cycle_year']);
        $this->assertFalse($state['can_submit']);
    }

    public function test_upload_crossing_correction_deadline_cannot_silently_create_a_new_cycle_request(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->at('2028-09-01 12:00:00');
        $this->review($application, 'NEEDS_CORRECTION', 'Blurry photo.')->assertOk();
        $this->at('2028-09-08 11:59:59');
        $storage = $this->disk('r2_private');
        $disk = \Mockery::mock(FilesystemAdapter::class);
        $disk->shouldReceive('putFileAs')->once()->andReturnUsing(function (...$args) use ($storage) {
            $this->at('2028-09-08 12:00:00');

            return $storage->putFileAs(...$args);
        });
        $disk->shouldReceive('delete')->once()->andReturnUsing(fn ($path) => $storage->delete($path));
        Storage::set('r2_private', $disk);
        Sanctum::actingAs($student->fresh());
        $this->post('/api/v1/commuter/student-renewal', $this->proof('correction.jpg'), ['Accept' => 'application/json'])->assertConflict();
        $this->assertDatabaseCount('discount_applications', 1);
        $this->assertSame(1, $application->fresh()->revision);
        $this->assertCount(1, $storage->allFiles());
        $storage->assertExists($application->document_path);
    }

    public function test_late_prior_cycle_request_does_not_gain_protection_from_the_new_cutoff(): void
    {
        $student = $this->commuter();
        $this->at('2027-10-02 12:00:00');
        $application = $this->submit($student);
        $this->at('2028-08-01 00:00:00');
        $this->review($application, 'NEEDS_CORRECTION', 'Blurry photo.')->assertOk();
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('REGULAR', $student->fresh()->commuterProfile->commuter_type);
        $this->assertSame('NEEDS_CORRECTION', $application->fresh()->status);
        $corrected = $this->submit($student->fresh());
        $this->review($corrected, 'APPROVED')->assertOk();
        $this->assertSame('2028-10-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
    }

    public function test_expiration_failure_rolls_back_continues_and_can_be_retried(): void
    {
        $this->commuter();
        $this->commuter();
        [$failed, $other] = User::orderBy('id')->get()->all();
        $this->at('2027-10-01 00:00:00');
        Log::spy();
        $this->partialMock(AnnouncementService::class, function ($mock) use ($failed) {
            $mock->shouldReceive('notifyUser')->withArgs(fn ($id) => $id === $failed->id)
                ->once()->andThrow(new \RuntimeException('Notification failed'));
        });
        $this->artisan('students:process-renewals')
            ->expectsOutput("Retry required: expiration for commuter {$failed->id}.")->assertFailed();
        $this->assertSame('STUDENT', $failed->fresh()->commuterProfile->commuter_type);
        $this->assertSame('REGULAR', $other->fresh()->commuterProfile->commuter_type);
        $this->assertDatabaseMissing('announcements', ['user_id' => $failed->id, 'type' => 'STUDENT_RENEWAL_DONE']);
        Log::shouldHaveReceived('error')->once()->withArgs(fn ($message, $context) => $context['commuter_id'] === $failed->id && $context['phase'] === 'expiration' && $context['exception'] instanceof \RuntimeException);

        $this->app->instance(AnnouncementService::class, new AnnouncementService);
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('REGULAR', $failed->fresh()->commuterProfile->commuter_type);
        $this->assertSame(2, Announcement::where('type', 'STUDENT_RENEWAL_DONE')->count());
    }

    public function test_reminder_failure_continues_reports_failed_account_and_retries_without_duplicates(): void
    {
        $this->commuter();
        $this->commuter();
        [$failed, $other] = User::orderBy('id')->get()->all();
        Log::spy();
        $this->partialMock(AnnouncementService::class, function ($mock) use ($failed) {
            $mock->shouldReceive('notifyUser')->withArgs(fn ($id) => $id === $failed->id)
                ->once()->andThrow(new \RuntimeException('Notification failed'));
        });
        $this->assertSame([['commuter_id' => $failed->id, 'phase' => 'reminder']], app(StudentRenewalService::class)->process());
        $this->assertDatabaseHas('announcements', ['user_id' => $other->id, 'type' => 'STUDENT_RENEWAL']);
        $this->assertDatabaseMissing('announcements', ['user_id' => $failed->id, 'type' => 'STUDENT_RENEWAL']);
        Log::shouldHaveReceived('error')->once()->withArgs(fn ($message, $context) => $context['commuter_id'] === $failed->id && $context['phase'] === 'reminder');

        $this->app->instance(AnnouncementService::class, new AnnouncementService);
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame(2, Announcement::where('type', 'STUDENT_RENEWAL')->count());
    }

    public function test_renewal_documents_use_private_storage_and_expiring_links_even_with_public_registration_disk(): void
    {
        config(['filesystems.uploads.private_id_disk' => 'public']);
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->disk('public')->assertMissing($application->document_path);
        $this->disk('r2_private')->assertExists($application->document_path);
        $expires = null;
        $this->disk('r2_private')->buildTemporaryUrlsUsing(function ($path, $expiration) use (&$expires) {
            $expires = $expiration;

            return 'https://private.test/'.$path.'?signed=temporary';
        });
        $this->review($application, 'APPROVED')->assertOk()
            ->assertJsonPath('data.document_url', 'https://private.test/'.$application->document_path.'?signed=temporary');
        /** @var \Carbon\CarbonInterface $expires Set by the temporary-URL callback above. */
        $this->assertTrue($expires->equalTo(now()->addMinutes(10)));
        // Only the single-application fetch behind the review dialog carries a link.
        $this->getJson('/api/v1/admin/discount-applications?id='.$application->id)->assertOk()
            ->assertJsonPath('data.data.0.document_url', 'https://private.test/'.$application->document_path.'?signed=temporary');
        $this->getJson('/api/v1/admin/discount-applications?per_page=1')->assertOk()
            ->assertJsonPath('data.data.0.id', $application->id)->assertJsonMissingPath('data.data.0.document_url');
    }

    public function test_private_storage_failure_does_not_fall_back_to_public_storage(): void
    {
        $student = $this->commuter();
        Sanctum::actingAs($student);
        $disk = \Mockery::mock(FilesystemAdapter::class);
        $disk->shouldReceive('putFileAs')->once()->withArgs(fn ($path, $file, $name, $options) => $options['visibility'] === 'private')->andReturn(false);
        Storage::set('r2_private', $disk);
        $this->post('/api/v1/commuter/student-renewal', $this->proof(), ['Accept' => 'application/json'])->assertStatus(502);
        $this->assertDatabaseCount('discount_applications', 0);
        $this->assertCount(0, Storage::disk('public')->allFiles());
    }

    public function test_private_storage_exception_returns_retryable_error_without_an_application(): void
    {
        $student = $this->commuter();
        Sanctum::actingAs($student);
        $disk = \Mockery::mock(FilesystemAdapter::class);
        $disk->shouldReceive('putFileAs')->once()->andThrow(new \RuntimeException('Unable to write file: cURL error 60.'));
        Storage::set('r2_private', $disk);
        $this->post('/api/v1/commuter/student-renewal', $this->proof(), ['Accept' => 'application/json'])
            ->assertStatus(502)->assertJsonPath('message', 'The document could not be stored. Please try again.');
        $this->assertDatabaseCount('discount_applications', 0);
        $this->assertCount(0, Storage::disk('public')->allFiles());
    }

    public function test_admin_list_fetches_only_summary_columns_and_preserves_pagination_and_search(): void
    {
        $student = $this->commuter();
        $application = $this->submit($student);
        $this->submit($this->commuter());
        $application->update(['submission_history' => [['document_path' => 'old-proof.jpg']]]);
        DB::enableQueryLog();
        try {
            $page = app(StudentRenewalService::class)->list(['status' => 'PENDING', 'per_page' => 1]);
            $queries = collect(DB::getQueryLog())->pluck('query')->implode("\n");
        } finally {
            DB::disableQueryLog();
            DB::flushQueryLog();
        }
        $this->assertSame(2, $page->total());
        $this->assertCount(1, $page->items());
        $this->assertStringNotContainsString('submission_history', $queries);
        $this->assertStringNotContainsString('id_image_url', $queries);
        $this->assertStringNotContainsString('password', $queries);
        // EXISTS subqueries may use *, but fetched rows must use explicit columns.
        $this->assertDoesNotMatchRegularExpression('/^select\s+(?:["`\w]+\.)?\*/im', $queries);

        $filtered = app(StudentRenewalService::class)->list(['search' => $student->email]);
        $this->assertSame(1, $filtered->total());
        $this->assertSame($application->id, $filtered->items()[0]['id']);
        $this->assertSame($student->email, $filtered->items()[0]['commuter']['email']);
        $this->assertSame('Student', $filtered->items()[0]['commuter']['first_name']);
        $this->assertArrayNotHasKey('document_url', $filtered->items()[0]);
        $this->assertArrayHasKey('document_url', app(StudentRenewalService::class)->list(['id' => $application->id])->items()[0]);
    }

    private function saveRenewalMonth(int $month)
    {
        $admin = User::firstOrCreate(['email' => 'month-admin@test.com'], ['password' => 'Password1!', 'role' => UserRole::ADMIN]);

        return $this->actingAs($admin)->putJson('/api/v1/admin/settings/student_renewal_month', ['value' => $month, 'category' => 'financial']);
    }

    public function test_renewal_month_change_puts_every_student_on_the_same_next_deadline(): void
    {
        $lateJoiner = $this->commuter();
        $noDate = $this->commuter();
        $expired = $this->commuter();
        $lateJoiner->commuterProfile->update(['student_discount_expires_at' => '2028-10-01 00:00:00']);
        $noDate->commuterProfile->update(['student_discount_expires_at' => null]);
        $this->at('2027-11-10 12:00:00');
        $expired->commuterProfile->update(['student_discount_expires_at' => '2027-10-01 00:00:00']);

        // June 2027 has passed, so everyone renews in June 2028 (deadline Jul 1).
        $this->saveRenewalMonth(6)->assertOk()->assertJsonPath('data.value', '6');

        $this->assertSame('2028-07-01', $lateJoiner->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertSame('2028-07-01', $noDate->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertSame('2027-10-01', $expired->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertDatabaseHas('activity_logs', ['description' => 'Changed Student renewal month from September to June']);

        // Before June's period starts, moving to November: everyone renews in November 2028.
        $this->at('2028-04-10 12:00:00');
        $this->saveRenewalMonth(11)->assertOk();
        $this->assertSame('2028-12-01', $lateJoiner->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertSame('2028-12-01', $noDate->fresh()->commuterProfile->student_discount_expires_at->toDateString());

        // The renewal cycle and its deadline follow November.
        $this->at('2028-11-05 12:00:00');
        $state = app(StudentRenewalService::class)->state($lateJoiner->fresh());
        $this->assertSame('November 1-30, 2028', $state['renewal_period']);
        $this->assertTrue($state['can_submit']);
    }

    public function test_students_already_renewed_for_the_cycle_get_the_following_deadline(): void
    {
        $renewed = $this->commuter();
        $other = $this->commuter();
        $this->review($this->submit($renewed), 'APPROVED')->assertOk();
        $this->assertSame('2028-10-01', $renewed->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $other->commuterProfile->update(['student_discount_expires_at' => '2028-10-01 00:00:00']);

        // December 2027 is cycle 2027, which $renewed already renewed for in September.
        $this->at('2027-10-10 12:00:00');
        $this->saveRenewalMonth(12)->assertOk();
        $this->assertSame('2029-01-01', $renewed->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertSame('2028-01-01', $other->fresh()->commuterProfile->student_discount_expires_at->toDateString());

        $this->at('2027-12-05 12:00:00');
        $this->assertTrue(app(StudentRenewalService::class)->state($other->fresh())['can_submit']);
        $this->assertFalse(app(StudentRenewalService::class)->isForRenewal($renewed->fresh()->commuterProfile));
    }

    public function test_renewal_month_is_locked_while_a_renewal_period_runs(): void
    {
        $student = $this->commuter();
        // Sept 15, 2027 (setUp): the September period is running.
        $this->saveRenewalMonth(6)->assertStatus(409);
        $this->assertSame('2027-10-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->assertSame(9, Setting::studentRenewalMonth());

        // Re-saving the same month (Financial Rules saves every field) still works and logs nothing.
        $this->saveRenewalMonth(9)->assertOk();
        $this->assertSame(0, DB::table('activity_logs')->where('description', 'like', '%renewal month%')->count());

        $this->saveRenewalMonth(13)->assertStatus(422);
    }

    public function test_renewal_month_cannot_be_this_month_or_next(): void
    {
        $student = $this->commuter();
        $student->commuterProfile->update(['student_discount_expires_at' => '2028-10-01 00:00:00']);
        $this->at('2028-01-10 12:00:00');
        $this->saveRenewalMonth(1)->assertStatus(422);
        $this->saveRenewalMonth(2)->assertStatus(422);
        $this->assertSame('2028-10-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        $this->saveRenewalMonth(3)->assertOk();
        $this->assertSame('2028-04-01', $student->fresh()->commuterProfile->student_discount_expires_at->toDateString());
        // The saved month stays saveable even once it is "next month" (Financial Rules re-saves every field).
        $this->at('2028-02-10 12:00:00');
        $this->saveRenewalMonth(3)->assertOk();

        // December wraps to January.
        $this->at('2028-12-10 12:00:00');
        $this->saveRenewalMonth(1)->assertStatus(422);
    }

    public function test_january_and_december_renewal_months_roll_over_correctly(): void
    {
        config(['registration.student_renewal_month' => 12]);
        $this->at('2027-10-31 12:00:00');
        $this->assertSame(2026, StudentRenewalService::rawCycleYear());
        $this->at('2027-11-01 00:00:00');
        $this->assertSame(2027, app(StudentRenewalService::class)->cycleYear());
        $this->assertSame('2028-01-01', StudentRenewalService::cutoff(2027)->toDateString());
        $this->assertSame('2029-01-01', CommuterProfile::initialStudentExpiry()->toDateString());

        config(['registration.student_renewal_month' => 1]);
        $this->at('2027-11-30 12:00:00');
        $this->assertSame(2027, app(StudentRenewalService::class)->cycleYear());
        $this->at('2027-12-01 00:00:00');
        $this->assertSame(2028, app(StudentRenewalService::class)->cycleYear());
        $this->assertSame('2028-02-01', StudentRenewalService::cutoff(2028)->toDateString());
        $this->assertSame('January 1-31, 2028', app(StudentRenewalService::class)->state($this->commuter())['renewal_period']);
    }
}
