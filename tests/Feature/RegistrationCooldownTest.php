<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * Registration rejection safety net.
 *
 * A rejected commuter may re-register (email/username are freed), but every
 * rejection is logged as a strike against their identity (email OR contact
 * number). Once the threshold is reached, re-registration is paused for a
 * cooldown window. See App\Services\RegistrationGuard + config/registration.php.
 *
 * Threshold and cooldown are pinned in setUp so the tests don't depend on env.
 */
class RegistrationCooldownTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();
        config()->set('registration.rejection_threshold', 3);
        config()->set('registration.cooldown_days', 3);
        $this->admin = $this->seedAdmin();
    }

    public function test_each_rejection_logs_an_incrementing_strike(): void
    {
        $first = $this->seedPendingCommuter(['email' => 'repeat@example.com', 'username' => 'r1']);
        $this->rejectPending($first)
            ->assertOk()
            ->assertJsonPath('data.attempt_number', 1)
            ->assertJsonPath('data.blocked_until', null);

        $second = $this->seedPendingCommuter(['email' => 'repeat@example.com', 'username' => 'r2']);
        $this->rejectPending($second)
            ->assertJsonPath('data.attempt_number', 2)
            ->assertJsonPath('data.blocked_until', null);

        $this->assertDatabaseCount('registration_rejections', 2);
    }

    public function test_third_rejection_triggers_a_cooldown(): void
    {
        $this->rejectThreeTimes('repeat@example.com');

        // The third strike stamped a future blocked_until.
        $this->assertDatabaseHas('registration_rejections', [
            'email' => 'repeat@example.com',
            'attempt_number' => 3,
        ]);
        $latest = \App\Models\RegistrationRejection::orderByDesc('attempt_number')->first();
        $this->assertNotNull($latest->blocked_until);
        $this->assertTrue($latest->blocked_until->isFuture());
    }

    public function test_below_threshold_reregistration_is_allowed(): void
    {
        // Two rejections — still under the threshold of 3.
        $a = $this->seedPendingCommuter(['email' => 'repeat@example.com', 'username' => 'r1']);
        $this->rejectPending($a);
        $b = $this->seedPendingCommuter(['email' => 'repeat@example.com', 'username' => 'r2']);
        $this->rejectPending($b);

        $this->registerWithFile(['email' => 'repeat@example.com', 'username' => 'r3'])
            ->assertCreated();
    }

    public function test_reregistration_is_blocked_during_cooldown(): void
    {
        $this->rejectThreeTimes('repeat@example.com');

        $this->registerWithFile(['email' => 'repeat@example.com', 'username' => 'r4'])
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');
    }

    public function test_cooldown_blocks_by_contact_number_even_with_a_new_email(): void
    {
        // All three rejections share the same contact number 09171234567
        // (the seedPendingCommuter default).
        $this->rejectThreeTimes('repeat@example.com');

        // A fresh email but the SAME contact number is still blocked — the
        // strike count is matched on email OR contact.
        $this->registerWithFile([
            'email' => 'totally-new@example.com',
            'username' => 'brandnew',
            'contact_number' => '09171234567',
        ])
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');
    }

    public function test_onsite_admin_registration_is_also_blocked_during_cooldown(): void
    {
        $this->rejectThreeTimes('repeat@example.com');

        $this->actingAs($this->admin)->post('/api/v1/admin/registrations', [
            'first_name' => 'Kiosk',
            'surname' => 'Applicant',
            'birthdate' => '1990-01-01',
            'email' => 'repeat@example.com',
            'contact_number' => '09171234567',
            'username' => 'kioskuser',
            'password' => 'SecurePass123',
            'applied_type' => 'REGULAR',
            'id_image' => UploadedFile::fake()->image('id.jpg', 800, 600),
        ], ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');
    }

    public function test_pending_list_exposes_rejection_count(): void
    {
        // One prior rejection for this identity.
        $rejected = $this->seedPendingCommuter(['email' => 'repeat@example.com', 'username' => 'r1']);
        $this->rejectPending($rejected);

        // A fresh pending re-registration for the same identity.
        $this->registerWithFile(['email' => 'repeat@example.com', 'username' => 'r2']);

        $response = $this->actingAs($this->admin)
            ->getJson('/api/v1/admin/registrations')
            ->assertOk();

        $row = collect($response->json('data.data'))
            ->firstWhere('email', 'repeat@example.com');

        $this->assertNotNull($row);
        $this->assertSame(1, $row['rejection_count']);
    }

    // ── Helpers ──────────────────────────────────────────────────

    private function rejectThreeTimes(string $email): void
    {
        foreach (range(1, 3) as $i) {
            $user = $this->seedPendingCommuter(['email' => $email, 'username' => "strike{$i}"]);
            $this->rejectPending($user)->assertOk();
        }
    }

    private function rejectPending(User $user, string $reason = 'ID image is blurry and unreadable.'): \Illuminate\Testing\TestResponse
    {
        return $this->actingAs($this->admin)
            ->postJson("/api/v1/admin/registrations/{$user->id}/reject", [
                'rejection_reason' => $reason,
            ]);
    }

    private function registerWithFile(array $overrides = []): \Illuminate\Testing\TestResponse
    {
        $payload = array_merge([
            'first_name' => 'Maria',
            'middle_name' => 'Cruz',
            'surname' => 'Santos',
            'birthdate' => '1995-08-20',
            'gender' => 'Female',
            'email' => 'maria.santos@example.com',
            'contact_number' => '09171234567',
            'username' => 'maria.santos',
            'password' => 'SecurePass123!',
            'password_confirmation' => 'SecurePass123!',
            'language_preference' => 'English',
            'applied_type' => 'STUDENT',
        ], $overrides, ['id_image' => UploadedFile::fake()->image('valid_id.jpg', 800, 600)]);

        // Stand in for the sign-up form's email verification step so these
        // tests exercise the cooldown, not the verification gate.
        DB::table('email_verification_codes')->updateOrInsert(
            ['email' => Str::lower(trim($payload['email']))],
            [
                'token' => Hash::make('000000'),
                'attempts' => 0,
                'verified_at' => now(),
                'created_at' => now(),
            ]
        );

        return $this->post('/api/v1/auth/register', $payload, ['Accept' => 'application/json']);
    }

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

    private function seedPendingCommuter(array $overrides = []): User
    {
        $email = $overrides['email'] ?? 'pending@example.com';
        $username = $overrides['username'] ?? 'pending.user';
        $contact = $overrides['contact_number'] ?? '09171234567';

        $user = User::create([
            'email' => $email,
            'password' => Hash::make('SecretPass123'),
            'role' => UserRole::COMMUTER,
        ]);

        CommuterProfile::create([
            'id' => $user->id,
            'first_name' => 'Pending',
            'surname' => 'Applicant',
            'birthdate' => '1995-05-05',
            'gender' => 'Female',
            'email' => $email,
            'contact_number' => $contact,
            'commuter_type' => 'STUDENT',
            'applied_type' => 'STUDENT',
            'username' => $username,
            'language_preference' => 'English',
            'account_status' => 'PENDING',
            'id_image_url' => 'id-images/'.$user->id.'-sample',
            'verified_at' => null,
            'rejection_reason' => null,
        ]);

        return $user;
    }
}
