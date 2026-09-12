<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\Announcement;
use App\Models\CommuterProfile;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * S5-T8 Additional Coverage — Commuter self-registration.
 *
 * Covers POST /api/v1/auth/register (public). Every test asserts real DB
 * state, not just status codes — matching the S5-T8 acceptance criteria:
 *   - register creates a PENDING commuter + stores applied_type + id_image
 *   - missing/invalid ID or bad applied_type -> 422
 *   - no token issued (response has no token field)
 *   - an email belonging only to a soft-deleted (rejected) account is reusable
 *   - an active email -> 422
 *
 * The id_image is sent as a real file upload (UploadedFile::fake) because
 * RegisterRequest validates it as file|image|mimes:jpeg,jpg,png,webp|max:5120.
 * Tests use $this->post() (multipart) instead of $this->postJson() when a
 * file is included.
 */
class AuthRegisterTest extends TestCase
{
    use RefreshDatabase;

    /**
     * Returns the valid payload WITHOUT id_image — callers add the fake
     * file separately so they can control its presence/type.
     */
    private function validPayload(array $overrides = []): array
    {
        return array_merge([
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
        ], $overrides);
    }

    /**
     * Send a multipart POST with a fake ID image — mirrors what the real
     * signup form does, including the email verification it completes first.
     */
    private function registerWithFile(array $overrides = []): TestResponse
    {
        $payload = array_merge(
            $this->validPayload($overrides),
            ['id_image' => UploadedFile::fake()->image('valid_id.jpg', 800, 600)]
        );

        // The form can't reach /register until the address is verified, so
        // stand in for that step. The gate itself is covered by
        // EmailVerificationTest.
        if (is_string($payload['email'] ?? null)) {
            $this->markEmailVerified($payload['email']);
        }

        return $this->post('/api/v1/auth/register', $payload, ['Accept' => 'application/json']);
    }

    /** Stamp an address as verified, as POST /auth/register/verify-code would. */
    private function markEmailVerified(string $email): void
    {
        DB::table('email_verification_codes')->updateOrInsert(
            ['email' => Str::lower(trim($email))],
            [
                'token' => Hash::make('000000'),
                'attempts' => 0,
                'verified_at' => now(),
                'created_at' => now(),
            ]
        );
    }

    // ── Happy path ───────────────────────────────────────────────

    public function test_register_creates_pending_commuter_with_applied_type_and_id_image(): void
    {
        $response = $this->registerWithFile();

        $response->assertStatus(201)
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.account_status', 'PENDING')
            ->assertJsonPath('data.applied_type', 'STUDENT')
            ->assertJsonMissingPath('data.token');

        $this->assertDatabaseHas('users', [
            'email' => 'maria.santos@example.com',
            'role' => UserRole::COMMUTER->value,
        ]);

        $user = User::where('email', 'maria.santos@example.com')->first();

        $this->assertDatabaseHas('commuter_profiles', [
            'id' => $user->id,
            'first_name' => 'Maria',
            'surname' => 'Santos',
            'applied_type' => 'STUDENT',
            'account_status' => 'PENDING',
            'verified_at' => null,
        ]);

        // The id_image_url column is populated (non-null, non-empty) — the
        // uploaded file was stored to disk and its path persisted.
        $this->assertNotEmpty($user->commuterProfile->id_image_url);
        $this->assertStringContainsString('ids/commuters/', $user->commuterProfile->id_image_url);

        // The uploaded filename is built from the same UUID that ends up as
        // the row's actual id — 'id' is intentionally excluded from
        // User::$fillable, so this only holds if AuthService::register()
        // assigns it directly ($user->id = $userId) rather than through
        // User::create()'s mass assignment, which would silently drop it and
        // let the `creating` hook mint a different, mismatched UUID.
        $this->assertStringContainsString($user->id, $user->commuterProfile->id_image_url);
    }

    public function test_register_notifies_every_admin_with_a_deep_link_to_the_new_registration(): void
    {
        $admin = User::factory()->admin()->create();
        $otherAdmin = User::factory()->admin()->create();

        $response = $this->registerWithFile();
        $newUserId = $response->json('data.id');

        foreach ([$admin, $otherAdmin] as $recipient) {
            $notification = Announcement::where('type', 'NEW_REGISTRATION')
                ->where('user_id', $recipient->id)
                ->first();
            $this->assertNotNull($notification, "Admin {$recipient->id} was not notified.");
            $this->assertSame($newUserId, $notification->reference_id);
            $this->assertStringContainsString('Maria', $notification->message);
        }
        // Never broadcast to everyone — only the two admin accounts above.
        $this->assertSame(2, Announcement::where('type', 'NEW_REGISTRATION')->count());
    }

    public function test_register_hashes_the_password(): void
    {
        $this->registerWithFile();

        $user = User::where('email', 'maria.santos@example.com')->first();

        // Password is hashed, not stored in plaintext.
        $this->assertNotEquals('SecurePass123!', $user->password);
        $this->assertTrue(Hash::check('SecurePass123!', $user->password));
    }

    public function test_register_uses_applied_type_for_commuter_type(): void
    {
        foreach (['REGULAR', 'STUDENT', 'SENIOR', 'PWD'] as $type) {
            $this->registerWithFile([
                'email' => "applicant.{$type}@example.com",
                'username' => "applicant.{$type}",
                'applied_type' => $type,
            ]);

            // Addresses are normalised to lower case on the way in, so the
            // stored value is compared in that form.
            $this->assertDatabaseHas('commuter_profiles', [
                'email' => Str::lower("applicant.{$type}@example.com"),
                'commuter_type' => $type,
                'applied_type' => $type,
            ]);
        }
    }

    // ── Validation failures -> 422 ───────────────────────────────

    public function test_register_rejects_missing_id_image_with_422(): void
    {
        $payload = $this->validPayload();
        unset($payload['id_image']);

        $this->post('/api/v1/auth/register', $payload, ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonPath('success', false)
            ->assertJsonStructure(['errors' => ['id_image']]);
    }

    public function test_register_rejects_invalid_applied_type_with_422(): void
    {
        $this->registerWithFile([
            'applied_type' => 'VIP',
        ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['applied_type']]);
    }

    public function test_register_rejects_missing_applied_type_with_422(): void
    {
        $payload = $this->validPayload();
        unset($payload['applied_type']);
        $payload['id_image'] = UploadedFile::fake()->image('id.jpg');

        $this->post('/api/v1/auth/register', $payload, ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['applied_type']]);
    }

    public function test_register_rejects_missing_required_fields_with_422(): void
    {
        $this->post('/api/v1/auth/register', [], ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => [
                'first_name', 'surname', 'birthdate', 'gender',
                'email', 'contact_number', 'username', 'password',
                'applied_type', 'id_image',
            ]]);
    }

    public function test_register_rejects_password_mismatch_with_422(): void
    {
        $this->registerWithFile([
            'password' => 'SecurePass123!',
            'password_confirmation' => 'DifferentPass999!',
        ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['password']]);
    }

    public function test_register_rejects_weak_password_with_422(): void
    {
        $this->registerWithFile([
            'password' => 'short',
            'password_confirmation' => 'short',
        ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['password']]);
    }

    public function test_register_rejects_invalid_email_format_with_422(): void
    {
        $this->registerWithFile([
            'email' => 'not-an-email',
        ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['email']]);
    }

    public function test_register_rejects_duplicate_username_with_422(): void
    {
        $existing = $this->seedApprovedCommuter(['username' => 'maria.santos']);

        $this->registerWithFile([
            'email' => 'different@example.com',
        ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['username']]);

        $this->assertDatabaseHas('commuter_profiles', [
            'id' => $existing->id,
            'username' => 'maria.santos',
        ]);
    }

    public function test_register_rejects_future_birthdate_with_422(): void
    {
        $this->registerWithFile([
            'birthdate' => now()->addDay()->toDateString(),
        ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['birthdate']]);
    }

    // ── Email reuse rules ────────────────────────────────────────

    public function test_register_rejects_active_email_with_422(): void
    {
        $this->seedApprovedCommuter(['email' => 'maria.santos@example.com']);

        $this->registerWithFile([
            'username' => 'different.username',
        ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['email']]);
    }

    public function test_register_allows_reuse_of_soft_deleted_rejected_email(): void
    {
        $rejected = $this->seedApprovedCommuter(['email' => 'maria.santos@example.com']);
        $rejected->commuterProfile->update([
            'account_status' => 'REJECTED',
            'rejection_reason' => 'Blurry ID image.',
        ]);
        $rejected->email = 'maria.santos+rejected+'.time().'@example.com';
        $rejected->save();
        $rejected->delete();

        $response = $this->registerWithFile([
            'username' => 'maria.santos.v2',
        ]);

        $response->assertStatus(201)
            ->assertJsonPath('data.account_status', 'PENDING');

        $this->assertDatabaseHas('users', [
            'email' => 'maria.santos@example.com',
            'role' => UserRole::COMMUTER->value,
        ]);

        $this->assertDatabaseCount('commuter_profiles', 2);
        $this->assertDatabaseHas('commuter_profiles', [
            'account_status' => 'REJECTED',
            'rejection_reason' => 'Blurry ID image.',
        ]);
        $this->assertDatabaseHas('commuter_profiles', [
            'account_status' => 'PENDING',
            'username' => 'maria.santos.v2',
        ]);
    }

    // ── Failure-path R2 cleanup ─────────────────────────────────
    // AuthService::register() uploads id_image to the private disk BEFORE
    // opening the DB transaction (backend/app/Services/AuthService.php:246-247),
    // so any failure inside the transaction must delete that upload — otherwise
    // a rejected/failed registration leaves an orphaned government ID behind.

    public function test_register_cleans_up_uploaded_id_image_on_duplicate_username_race(): void
    {
        Storage::fake('public');

        // RegisterRequest's 'unique:commuter_profiles,username' rule only
        // catches a conflict that exists AT VALIDATION TIME. Simulate the
        // TOCTOU race the DB's unique index — and translateUniqueViolation()
        // — are the last line of defence against: a second registration for
        // the same username commits its row after this request's validation
        // already passed, but before this request's own CommuterProfile
        // insert — so it fires from inside the transaction, after the ID
        // image is already uploaded, and must both (a) come back as the same
        // friendly 422 the pre-check produces and (b) clean up the upload.
        //
        // Guards against the listener re-triggering itself when it creates
        // the racing User row below (User::creating fires for every User
        // creation, including this one).
        $isRacing = false;
        User::creating(function () use (&$isRacing) {
            if ($isRacing) {
                return;
            }
            $isRacing = true;

            $racingUser = User::create([
                'email' => 'racing.applicant@example.com',
                'password' => 'password123',
                'role' => UserRole::COMMUTER,
            ]);

            CommuterProfile::create([
                'id' => $racingUser->id,
                'first_name' => 'Racing',
                'surname' => 'Applicant',
                'birthdate' => '1990-01-01',
                'gender' => 'Male',
                'email' => 'racing.applicant@example.com',
                'contact_number' => '09170000001',
                'commuter_type' => 'REGULAR',
                'applied_type' => 'REGULAR',
                'username' => 'maria.santos', // collides with validPayload()'s username
                'language_preference' => 'English',
                'account_status' => 'PENDING',
            ]);

            $isRacing = false;
        });

        $this->registerWithFile()
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['username']]);

        $this->assertDatabaseMissing('users', ['email' => 'maria.santos@example.com']);
        $this->assertEmpty(Storage::disk('public')->allFiles('ids'));
    }

    public function test_register_cleans_up_uploaded_id_image_on_profile_creation_failure(): void
    {
        Storage::fake('public');
        $this->withoutExceptionHandling();

        // Stands in for any non-uniqueness transaction failure (e.g. a DB
        // connection blip) — the catch(\Throwable) in AuthService::register()
        // must clean up and rethrow it as-is, not just QueryExceptions.
        CommuterProfile::creating(function () {
            throw new \RuntimeException('Simulated database failure.');
        });

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('Simulated database failure.');

        try {
            $this->registerWithFile();
        } finally {
            $this->assertDatabaseMissing('users', ['email' => 'maria.santos@example.com']);
            $this->assertEmpty(Storage::disk('public')->allFiles('ids'));
        }
    }

    // ── No token + login gating ──────────────────────────────────

    public function test_register_does_not_issue_a_token(): void
    {
        $response = $this->registerWithFile();

        $response->assertStatus(201);
        $response->assertJsonMissingPath('data.token');
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_pending_commuter_cannot_log_in(): void
    {
        $this->registerWithFile();

        $this->postJson('/api/v1/auth/login', [
            'login' => 'maria.santos@example.com',
            'password' => 'SecurePass123!',
        ])
            ->assertStatus(403)
            ->assertJsonPath('success', false);

        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    // ── Helpers ──────────────────────────────────────────────────

    private function seedApprovedCommuter(array $overrides = []): User
    {
        $email = $overrides['email'] ?? 'existing@example.com';
        $username = $overrides['username'] ?? 'existing.user';

        $user = User::create([
            'email' => $email,
            'password' => Hash::make('password123'),
            'role' => UserRole::COMMUTER,
        ]);

        CommuterProfile::create([
            'id' => $user->id,
            'first_name' => 'Existing',
            'surname' => 'User',
            'birthdate' => '1990-01-01',
            'gender' => 'Male',
            'email' => $email,
            'contact_number' => '09170000000',
            'commuter_type' => 'REGULAR',
            'applied_type' => 'REGULAR',
            'username' => $username,
            'language_preference' => 'English',
            'account_status' => 'APPROVED',
            'verified_at' => now(),
        ]);

        return $user;
    }
}
