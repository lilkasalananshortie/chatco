<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\Announcement;
use App\Models\CommuterProfile;
use App\Models\DiscountApplication;
use App\Models\Setting;
use App\Models\User;
use App\Models\UserSuspension;
use App\Services\AuthService;
use Database\Seeders\Commuter022Seeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class DiscountApplicationTest extends TestCase
{
    use RefreshDatabase;

    private User $commuter;
    private User $admin;
    private const URL = '/api/v1/commuter/discount-applications';

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow(Carbon::parse('2027-03-15 12:00:00', 'Asia/Manila'));
        Setting::where('key', Setting::STUDENT_RENEWAL_MONTH_KEY)->delete();
        \Illuminate\Support\Facades\Cache::forget(Setting::STUDENT_RENEWAL_MONTH_CACHE_KEY);
        config(['registration.student_renewal_first_year' => 2027, 'registration.student_renewal_month' => 9]);
        Storage::fake('r2_private');
        $this->seed(Commuter022Seeder::class);
        $this->commuter = User::where('email', 'commuter022@gmail.com')->firstOrFail();
        $this->admin = User::create(['email' => 'reviewer@test.com', 'password' => bcrypt('password123'), 'role' => UserRole::ADMIN]);
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function proof(string $type = 'STUDENT', array $overrides = []): array
    {
        return $overrides + [
            'requested_type' => $type, 'document' => UploadedFile::fake()->image('proof.png'),
            'school_name' => 'Test University', 'education_level' => 'COLLEGE',
            'school_year' => '2027-2028', 'enrollment_term' => '1st Semester',
        ];
    }

    private function submit(string $type = 'STUDENT'): DiscountApplication
    {
        Sanctum::actingAs($this->commuter->fresh());
        $id = $this->post(self::URL, $this->proof($type), ['Accept' => 'application/json'])
            ->assertCreated()->assertJsonPath('data.commuter_type', 'REGULAR')->assertJsonPath('data.status', 'PENDING')
            ->json('data.application.id');

        return DiscountApplication::findOrFail($id);
    }

    private function review(DiscountApplication $application, string $decision, ?string $reason = null)
    {
        Sanctum::actingAs($this->admin);
        return $this->postJson('/api/v1/admin/discount-applications/'.$application->id.'/review', [
            'decision' => $decision, 'reason' => $reason, 'revision' => $application->revision,
        ]);
    }

    public static function categories(): array
    {
        return [['STUDENT'], ['PWD'], ['SENIOR']];
    }

    #[DataProvider('categories')]
    public function test_seeded_account_full_approval_lifecycle(string $type): void
    {
        $this->assertNotEmpty(app(AuthService::class)->login('commuter022', 'password123'));
        $this->commuter->commuterProfile->update(['id_image_url' => 'registration-id.png']);
        $application = $this->submit($type);
        $this->assertSame($type, $application->requested_type);
        $this->assertNull($application->cycle_year);
        if ($type !== 'STUDENT') {
            $this->assertNull($application->school_name);
            $this->assertNull($application->education_level);
        }
        Storage::disk('r2_private')->assertExists($application->document_path);
        $this->assertDatabaseHas('announcements', ['user_id' => $this->admin->id, 'type' => 'DISCOUNT_APPLICATION_NEW', 'reference_id' => $application->id]);
        $this->review($application, 'APPROVED')->assertOk()->assertJsonPath('data.status', 'APPROVED');
        $profile = $this->commuter->fresh()->commuterProfile;
        $this->assertSame($type, $profile->commuter_type);
        $this->assertSame($type, $profile->effectiveFareType());
        $this->assertSame('APPROVED', $profile->account_status);
        $this->assertSame('registration-id.png', $profile->id_image_url);
        $this->assertSame($type === 'STUDENT' ? '2027-10-01' : null, $profile->student_discount_expires_at?->toDateString());
        $this->assertDatabaseHas('announcements', [
            'user_id' => $profile->id, 'type' => 'DISCOUNT_APPLICATION_DONE',
            'title' => ['STUDENT' => 'Student', 'SENIOR' => 'Senior Citizen', 'PWD' => 'PWD'][$type].' discount approved',
        ]);
        Sanctum::actingAs($this->commuter->fresh());
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.status', 'APPROVED')->assertJsonPath('data.can_submit', false)
            ->assertJsonMissingPath('data.application.document_url')->assertJsonMissingPath('data.application.document_path');
        $this->post(self::URL, $this->proof($type), ['Accept' => 'application/json'])->assertForbidden();
        $this->review($application, 'APPROVED')->assertConflict();
        $this->seed(Commuter022Seeder::class);
        $this->assertSame($type, $profile->fresh()->commuter_type);
        $this->assertSame(1, CommuterProfile::where('username', 'commuter022')->count());
    }

    public function test_local_application_can_run_without_a_document_and_be_reviewed(): void
    {
        $this->app->detectEnvironment(fn () => 'local');
        Sanctum::actingAs($this->commuter->fresh());
        $proof = $this->proof('PWD');
        unset($proof['document']);

        $id = $this->post(self::URL, $proof, ['Accept' => 'application/json'])
            ->assertCreated()->assertJsonPath('data.document_required', false)
            ->assertJsonPath('data.status', 'PENDING')->json('data.application.id');
        $application = DiscountApplication::findOrFail($id);
        $this->assertNull($application->document_path);
        $this->assertNull($application->document_mime);

        $this->review($application, 'APPROVED')->assertOk();
        $this->assertSame('PWD', $this->commuter->fresh()->commuterProfile->effectiveFareType());
        $this->getJson('/api/v1/admin/discount-applications?id='.$application->id)
            ->assertOk()->assertJsonMissingPath('data.data.0.document_url');
    }

    public function test_local_application_discards_any_selected_document_instead_of_uploading_it(): void
    {
        $this->app->detectEnvironment(fn () => 'local');
        Sanctum::actingAs($this->commuter->fresh());

        $this->post(self::URL, $this->proof('PWD'), ['Accept' => 'application/json'])
            ->assertCreated()->assertJsonPath('data.document_required', false);

        $application = DiscountApplication::firstOrFail();
        $this->assertNull($application->document_path);
        $this->assertNull($application->document_mime);
        $this->assertCount(0, Storage::disk('r2_private')->allFiles());
    }

    public function test_application_documents_remain_required_outside_local_environment(): void
    {
        $this->assertFalse(app()->environment('local'));
        Sanctum::actingAs($this->commuter->fresh());
        $proof = $this->proof('PWD');
        unset($proof['document']);

        $this->post(self::URL, $proof, ['Accept' => 'application/json'])
            ->assertUnprocessable()->assertJsonValidationErrors('document');
    }

    public function test_correction_revision_category_ownership_and_duplicate_guards(): void
    {
        $application = $this->submit('PWD');
        $this->post(self::URL, $this->proof('SENIOR'), ['Accept' => 'application/json'])->assertConflict();
        $this->review($application, 'NEEDS_CORRECTION', '   ')->assertUnprocessable();
        $this->review($application, 'NEEDS_CORRECTION', 'Upload the complete card.')->assertOk();
        Sanctum::actingAs($this->commuter->fresh());
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.can_submit', true)->assertJsonPath('data.status', 'NEEDS_CORRECTION');
        $correction = ['application_id' => $application->id, 'revision' => 1];
        $this->post(self::URL, $this->proof('SENIOR', $correction), ['Accept' => 'application/json'])->assertUnprocessable();
        $this->post(self::URL, $this->proof('PWD', ['revision' => 9] + $correction), ['Accept' => 'application/json'])->assertConflict();
        $this->post(self::URL, $this->proof('PWD', $correction), ['Accept' => 'application/json'])->assertCreated()->assertJsonPath('data.application.revision', 2);
        $this->assertCount(1, $application->fresh()->submission_history);
        $this->assertCount(2, Storage::disk('r2_private')->allFiles());
        $this->review($application, 'APPROVED')->assertConflict();
        $this->review($application->fresh(), 'APPROVED')->assertOk();
    }

    public function test_rejection_preserves_account_and_reapplication_history(): void
    {
        $first = $this->submit('SENIOR');
        $this->review($first, 'REJECTED', 'Document does not match the commuter.')->assertOk();
        $this->assertDatabaseHas('announcements', ['user_id' => $this->commuter->id, 'type' => 'DISCOUNT_APPLICATION_DONE', 'title' => 'Senior Citizen discount rejected']);
        $profile = $this->commuter->fresh()->commuterProfile;
        $this->assertSame('REGULAR', $profile->commuter_type);
        $this->assertSame('REGULAR', $profile->applied_type);
        $this->assertSame('APPROVED', $profile->account_status);
        $this->assertSame('commuter022', $profile->username);
        $this->assertNull($this->commuter->fresh()->deleted_at);
        $second = $this->submit('PWD');
        $this->assertNotSame($first->id, $second->id);
        $this->assertSame('REJECTED', $first->fresh()->status);
        $this->assertNotEmpty(app(AuthService::class)->login('commuter022@gmail.com', 'password123'));
    }

    public function test_decision_messages_use_the_admin_templates_or_the_defaults(): void
    {
        $rejected = $this->submit('SENIOR');
        $this->review($rejected, 'REJECTED', 'Document does not match the commuter.')->assertOk();
        $this->assertSame(
            'Your discount application was not approved. Your account remains Regular. Document does not match the commuter.',
            Announcement::where('type', 'DISCOUNT_APPLICATION_DONE')->where('reference_id', $rejected->id)->value('message'),
        );

        Setting::create(['key' => 'discount_approved_template', 'value' => "Hi {name},\n\nYour {discount_type} fare is active.", 'category' => 'safety']);
        $approved = $this->submit('PWD');
        $this->review($approved, 'APPROVED')->assertOk();
        $profile = $this->commuter->fresh()->commuterProfile;
        $this->assertSame(
            "Hi {$profile->first_name} {$profile->surname},\n\nYour PWD fare is active.",
            Announcement::where('type', 'DISCOUNT_APPLICATION_DONE')->where('reference_id', $approved->id)->value('message'),
        );
    }

    public function test_application_corrections_have_no_deadline(): void
    {
        $application = $this->submit('PWD');
        $firstSubmittedAt = $application->first_submitted_at->toIso8601String();
        $this->review($application, 'NEEDS_CORRECTION', 'Unreadable card.')->assertOk()->assertJsonPath('data.correction_due_at', null);
        $this->assertDatabaseHas('announcements', ['user_id' => $this->commuter->id, 'type' => 'DISCOUNT_APPLICATION_DONE', 'title' => 'PWD discount needs correction']);
        $this->assertStringNotContainsString('seven days', Announcement::where('type', 'DISCOUNT_APPLICATION_DONE')->value('message'));

        Carbon::setTestNow(now()->addDays(90));
        Sanctum::actingAs($this->commuter->fresh());
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.status', 'NEEDS_CORRECTION')->assertJsonPath('data.can_submit', true);
        // The open correction is still the commuter's one active request.
        $this->post(self::URL, $this->proof('SENIOR'), ['Accept' => 'application/json'])->assertConflict();
        Sanctum::actingAs($this->admin);
        $this->getJson('/api/v1/admin/discount-applications?status=NEEDS_CORRECTION')->assertOk()->assertJsonPath('data.total', 1);
        $this->getJson('/api/v1/admin/discount-applications?status=EXPIRED')->assertOk()->assertJsonPath('data.total', 0);

        Sanctum::actingAs($this->commuter->fresh());
        $this->post(self::URL, $this->proof('PWD', ['application_id' => $application->id, 'revision' => 1]), ['Accept' => 'application/json'])
            ->assertCreated()->assertJsonPath('data.status', 'PENDING');
        $application->refresh();
        $this->assertSame($firstSubmittedAt, $application->first_submitted_at->toIso8601String());
        $this->assertSame(2, Announcement::where('user_id', $this->admin->id)->where('type', 'DISCOUNT_APPLICATION_NEW')->count());
        $this->assertStringContainsString('sent corrected documents', Announcement::where('user_id', $this->admin->id)->where('type', 'DISCOUNT_APPLICATION_NEW')->latest('created_at')->value('message'));
    }

    public function test_commuter_can_cancel_pending_or_correction_and_apply_again(): void
    {
        $pending = $this->submit('STUDENT');
        $this->postJson(self::URL.'/cancel', ['application_id' => $pending->id])
            ->assertOk()->assertJsonPath('data.status', 'CANCELLED')->assertJsonPath('data.can_submit', true);
        $this->review($pending, 'APPROVED')->assertConflict();
        $this->assertSame('REGULAR', $this->commuter->fresh()->commuterProfile->commuter_type);

        // A correction can be withdrawn to switch category, which a resubmission cannot do.
        $correction = $this->submit('PWD');
        $this->review($correction, 'NEEDS_CORRECTION', 'Wrong category.')->assertOk();
        Sanctum::actingAs($this->commuter->fresh());
        $this->postJson(self::URL.'/cancel', ['application_id' => $correction->id])->assertOk()->assertJsonPath('data.status', 'CANCELLED');
        $senior = $this->submit('SENIOR');
        $this->assertNotSame($correction->id, $senior->id);

        $this->review($senior, 'APPROVED')->assertOk();
        Sanctum::actingAs($this->commuter->fresh());
        $this->postJson(self::URL.'/cancel', ['application_id' => $senior->id])->assertConflict();
        $this->assertSame('SENIOR', $this->commuter->fresh()->commuterProfile->commuter_type);
        $this->postJson('/api/v1/mobile/commuter/discount-applications/cancel', ['application_id' => $senior->id])->assertConflict();
    }

    public function test_cancel_is_owner_only_and_never_touches_renewals(): void
    {
        $application = $this->submit('PWD');
        $other = User::create(['email' => 'other@test.com', 'password' => bcrypt('password123'), 'role' => UserRole::COMMUTER]);
        CommuterProfile::create(['id' => $other->id, 'first_name' => 'Other', 'surname' => 'Commuter', 'birthdate' => '1990-01-01', 'gender' => 'Male', 'email' => $other->email, 'contact_number' => '09171111111', 'commuter_type' => 'REGULAR', 'username' => 'other', 'account_status' => 'APPROVED', 'language_preference' => 'en']);
        Sanctum::actingAs($other);
        $this->postJson(self::URL.'/cancel', ['application_id' => $application->id])->assertNotFound();
        $this->assertSame('PENDING', $application->fresh()->status);

        $renewal = DiscountApplication::create(['commuter_id' => $other->id, 'request_type' => 'RENEWAL', 'requested_type' => 'STUDENT', 'cycle_year' => 2027,
            'status' => 'PENDING', 'school_name' => 'Test University', 'education_level' => 'COLLEGE', 'school_year' => '2027-2028', 'submitted_at' => now(), 'first_submitted_at' => now()]);
        $this->postJson(self::URL.'/cancel', ['application_id' => $renewal->id])->assertNotFound();
        $this->postJson(self::URL.'/cancel', ['application_id' => 'not-a-uuid'])->assertUnprocessable();
        $this->assertSame('PENDING', $renewal->fresh()->status);

        // Suspension blocks applying, not withdrawing.
        UserSuspension::create(['user_id' => $this->commuter->id, 'reason_code' => 'OTHER', 'reason' => 'Test suspension', 'starts_at' => now(), 'is_permanent' => true, 'suspended_by' => $this->admin->id]);
        Sanctum::actingAs($this->commuter->fresh());
        $this->postJson(self::URL.'/cancel', ['application_id' => $application->id])->assertOk()->assertJsonPath('data.status', 'CANCELLED');
    }

    public function test_suspended_commuter_application_can_still_be_rejected_or_sent_back(): void
    {
        $rejected = $this->submit('PWD');
        $suspension = UserSuspension::create(['user_id' => $this->commuter->id, 'reason_code' => 'OTHER', 'reason' => 'Test suspension', 'starts_at' => now(), 'is_permanent' => true, 'suspended_by' => $this->admin->id]);
        $this->review($rejected, 'REJECTED', 'Account suspended.')->assertOk()->assertJsonPath('data.status', 'REJECTED');
        $this->assertSame('REGULAR', $this->commuter->fresh()->commuterProfile->commuter_type);

        $suspension->delete();
        $corrected = $this->submit('SENIOR');
        UserSuspension::create(['user_id' => $this->commuter->id, 'reason_code' => 'OTHER', 'reason' => 'Test suspension', 'starts_at' => now(), 'is_permanent' => true, 'suspended_by' => $this->admin->id]);
        $this->review($corrected, 'NEEDS_CORRECTION', 'Upload the complete card.')->assertOk();
        $this->assertSame('REGULAR', $this->commuter->fresh()->commuterProfile->commuter_type);
    }

    public function test_former_student_can_apply_and_conflicting_renewals_are_blocked_both_ways(): void
    {
        Carbon::setTestNow(Carbon::parse('2027-10-02 12:00:00', 'Asia/Manila'));
        $this->commuter->commuterProfile->update(['commuter_type' => 'STUDENT', 'applied_type' => 'STUDENT', 'student_discount_expires_at' => '2027-10-01']);
        $this->artisan('students:process-renewals')->assertSuccessful();
        $this->assertSame('REGULAR', $this->commuter->fresh()->commuterProfile->commuter_type);
        $new = $this->submit('PWD');
        $this->post('/api/v1/commuter/student-renewal', $this->proof(), ['Accept' => 'application/json'])->assertConflict();
        $this->review($new, 'REJECTED', 'Incorrect ID.')->assertOk();
        Sanctum::actingAs($this->commuter->fresh());
        $this->post('/api/v1/commuter/student-renewal', $this->proof(), ['Accept' => 'application/json'])->assertCreated();
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.can_submit', false)->assertJsonPath('data.application.request_type', 'RENEWAL');
        $this->post(self::URL, $this->proof('SENIOR'), ['Accept' => 'application/json'])->assertConflict();
    }

    public function test_new_student_approval_enters_normal_annual_renewal(): void
    {
        $application = $this->submit();
        $this->review($application, 'APPROVED')->assertOk();
        Carbon::setTestNow(Carbon::parse('2027-09-15 12:00:00', 'Asia/Manila'));
        Sanctum::actingAs($this->commuter->fresh());
        $this->getJson('/api/v1/commuter/student-renewal')->assertOk()->assertJsonPath('data.can_submit', true)->assertJsonPath('data.status', 'NOT_RENEWED');
        $this->post('/api/v1/commuter/student-renewal', $this->proof(), ['Accept' => 'application/json'])->assertCreated();
        $this->assertDatabaseCount('discount_applications', 2);
        $renewal = DiscountApplication::where('request_type', 'RENEWAL')->firstOrFail();
        $this->review($renewal, 'APPROVED')->assertOk();
        $this->assertDatabaseHas('announcements', ['user_id' => $this->commuter->id, 'type' => 'STUDENT_RENEWAL_DONE', 'title' => 'Student status renewed']);
        $this->assertSame('2028-10-01', $this->commuter->fresh()->commuterProfile->student_discount_expires_at->toDateString());
    }

    public function test_approved_student_who_reverts_to_regular_can_apply_fresh(): void
    {
        $application = $this->submit('STUDENT');
        $this->review($application, 'APPROVED')->assertOk();
        Sanctum::actingAs($this->commuter->fresh());
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.status', 'APPROVED')->assertJsonPath('data.commuter_type', 'STUDENT');

        // No renewal by the October 1 deadline: the account becomes Regular again.
        Carbon::setTestNow(Carbon::parse('2027-10-02 12:00:00', 'Asia/Manila'));
        $this->artisan('students:process-renewals')->assertSuccessful();
        Sanctum::actingAs($this->commuter->fresh());
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.commuter_type', 'REGULAR')
            ->assertJsonPath('data.status', 'NOT_APPLIED')->assertJsonPath('data.application', null)->assertJsonPath('data.can_submit', true);
        $this->assertNotSame($application->id, $this->submit('PWD')->id);
    }

    public function test_authorization_validation_and_profile_tampering(): void
    {
        $this->getJson(self::URL)->assertUnauthorized();
        Sanctum::actingAs($this->admin);
        $this->post(self::URL, $this->proof(), ['Accept' => 'application/json'])->assertForbidden();
        Sanctum::actingAs($this->commuter);
        $this->getJson('/api/v1/admin/discount-applications')->assertForbidden();
        foreach ([['requested_type' => 'REGULAR'], ['document' => UploadedFile::fake()->create('evil.html', 1, 'text/html')],
            ['document' => UploadedFile::fake()->image('big.jpg')->size(5121)], ['school_name' => '   '], ['education_level' => 'OTHER']] as $invalid) {
            $this->post(self::URL, $this->proof('STUDENT', $invalid), ['Accept' => 'application/json'])->assertUnprocessable();
        }
        $this->post(self::URL, $this->proof('PWD', ['commuter_id' => $this->admin->id, 'status' => 'APPROVED', 'commuter_type' => 'PWD']), ['Accept' => 'application/json'])
            ->assertCreated()->assertJsonPath('data.commuter_type', 'REGULAR');
        $this->assertSame($this->commuter->id, DiscountApplication::firstOrFail()->commuter_id);
        $other = User::create(['email' => 'other@test.com', 'password' => bcrypt('password123'), 'role' => UserRole::COMMUTER]);
        CommuterProfile::create(['id' => $other->id, 'first_name' => 'Other', 'surname' => 'Commuter', 'birthdate' => '1990-01-01', 'gender' => 'Male', 'email' => $other->email, 'contact_number' => '09171111111', 'commuter_type' => 'REGULAR', 'username' => 'other', 'account_status' => 'APPROVED', 'language_preference' => 'en']);
        Sanctum::actingAs($other);
        $this->getJson(self::URL.'?commuter_id='.$this->commuter->id)->assertOk()->assertJsonPath('data.application', null);
        $this->post(self::URL, $this->proof('PWD', ['application_id' => DiscountApplication::firstOrFail()->id, 'revision' => 1]), ['Accept' => 'application/json'])->assertConflict();
    }

    public function test_suspension_and_account_changes_block_submission_and_review(): void
    {
        $application = $this->submit('PWD');
        UserSuspension::create(['user_id' => $this->commuter->id, 'reason_code' => 'OTHER', 'reason' => 'Test suspension', 'starts_at' => now(), 'is_permanent' => true, 'suspended_by' => $this->admin->id]);
        $this->review($application, 'APPROVED')->assertForbidden();
        Sanctum::actingAs($this->commuter->fresh());
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.can_submit', false);
        $this->post(self::URL, $this->proof('PWD'), ['Accept' => 'application/json'])->assertForbidden();
        $this->assertSame('PENDING', $application->fresh()->status);
    }

    public function test_admin_filters_and_document_privacy(): void
    {
        $application = $this->submit('SENIOR');
        Sanctum::actingAs($this->admin);
        $this->getJson('/api/v1/admin/discount-applications?request_type=APPLICATION&requested_type=SENIOR&search=commuter022@gmail.com')
            ->assertOk()->assertJsonPath('data.total', 1)->assertJsonMissingPath('data.data.0.document_url')->assertJsonMissingPath('data.data.0.document_path');
        // Full-name search: each word may hit a different name column, in any order.
        CommuterProfile::whereKey($this->commuter->id)->update(['first_name' => 'Juan', 'surname' => 'Dela Cruz']);
        foreach (['juan dela' => 1, 'cruz juan' => 1, 'Juan Dela Cruz' => 1, 'juan zzz' => 0] as $search => $total) {
            $this->getJson('/api/v1/admin/discount-applications?search='.urlencode($search))->assertOk()->assertJsonPath('data.total', $total);
        }
        $this->getJson('/api/v1/admin/discount-applications?request_type=RENEWAL')->assertOk()->assertJsonPath('data.total', 0);
        $this->getJson('/api/v1/admin/discount-applications?requested_type=PWD')->assertOk()->assertJsonPath('data.total', 0);
        $this->getJson('/api/v1/admin/discount-applications?id='.$application->id)->assertOk()->assertJsonStructure(['data' => ['data' => [['document_url']]]]);
    }

    public function test_mobile_routes_use_same_workflow(): void
    {
        Sanctum::actingAs($this->commuter);
        $this->post('/api/v1/mobile/commuter/discount-applications', $this->proof('PWD'), ['Accept' => 'application/json'])->assertCreated();
        $this->getJson(self::URL)->assertOk()->assertJsonPath('data.application.requested_type', 'PWD');
        $this->getJson('/api/v1/mobile/commuter/discount-applications')->assertOk()->assertJsonPath('data.status', 'PENDING');
    }
}
