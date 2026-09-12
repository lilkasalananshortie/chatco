<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Mail\EmailVerificationCodeMail;
use App\Models\CommuterProfile;
use App\Models\RegistrationRejection;
use App\Models\User;
use App\Services\EmailVerificationService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

/**
 * Sign-up email verification.
 *
 * Covers the two public endpoints the sign-up form's new third step uses:
 *   POST /auth/register/send-code    — mail a 6-digit code
 *   POST /auth/register/verify-code  — check it and stamp the address verified
 *
 * plus the gate they exist for: POST /auth/register refuses to create an
 * account for an address that hasn't been verified.
 */
class EmailVerificationTest extends TestCase
{
    use RefreshDatabase;

    private const EMAIL = 'maria.santos@example.com';

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
    }

    // ── Sending ──────────────────────────────────────────────────

    public function test_send_code_emails_a_code_and_stores_it_hashed(): void
    {
        $this->postJson('/api/v1/auth/register/send-code', ['email' => self::EMAIL])
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.expires_in_minutes', EmailVerificationService::CODE_TTL_MINUTES);

        Mail::assertSent(EmailVerificationCodeMail::class, fn ($mail) => $mail->hasTo(self::EMAIL));

        $row = DB::table('email_verification_codes')->where('email', self::EMAIL)->first();

        $this->assertNotNull($row);
        $this->assertNull($row->verified_at);
        $this->assertSame(0, (int) $row->attempts);

        // The code is stored as a hash, never in the clear.
        $sent = null;
        Mail::assertSent(EmailVerificationCodeMail::class, function ($mail) use (&$sent) {
            $sent = $mail->code;
            return true;
        });
        $this->assertNotSame($sent, $row->token);
        $this->assertTrue(Hash::check($sent, $row->token));
    }

    public function test_send_code_normalizes_the_email(): void
    {
        $this->postJson('/api/v1/auth/register/send-code', ['email' => '  Maria.Santos@Example.com '])
            ->assertOk();

        $this->assertDatabaseHas('email_verification_codes', ['email' => self::EMAIL]);
    }

    public function test_send_code_rejects_an_address_that_already_has_an_account(): void
    {
        $this->seedCommuter(self::EMAIL);

        $this->postJson('/api/v1/auth/register/send-code', ['email' => self::EMAIL])
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');

        Mail::assertNothingSent();
    }

    public function test_send_code_honours_the_rejection_cooldown(): void
    {
        RegistrationRejection::create([
            'email' => self::EMAIL,
            'contact_number' => '09171234567',
            'reason' => 'Blurry ID.',
            'attempt_number' => 3,
            'blocked_until' => now()->addDays(3),
        ]);

        $this->postJson('/api/v1/auth/register/send-code', ['email' => self::EMAIL])
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');

        Mail::assertNothingSent();
    }

    public function test_send_code_is_rate_limited_per_address(): void
    {
        $this->postJson('/api/v1/auth/register/send-code', ['email' => self::EMAIL])->assertOk();

        $this->postJson('/api/v1/auth/register/send-code', ['email' => self::EMAIL])
            ->assertStatus(429);

        Mail::assertSentCount(1);
    }

    public function test_a_new_code_replaces_the_previous_one(): void
    {
        $first = $this->issueCode();

        // Step past the resend cooldown.
        $this->travel(EmailVerificationService::RESEND_COOLDOWN_SECONDS + 1)->seconds();

        $this->postJson('/api/v1/auth/register/send-code', ['email' => self::EMAIL])->assertOk();

        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => $first,
        ])->assertStatus(400);
    }

    // ── Verifying ────────────────────────────────────────────────

    public function test_correct_code_marks_the_address_verified(): void
    {
        $code = $this->issueCode();

        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => $code,
        ])
            ->assertOk()
            ->assertJsonPath('success', true);

        $row = DB::table('email_verification_codes')->where('email', self::EMAIL)->first();
        $this->assertNotNull($row->verified_at);
    }

    public function test_wrong_code_is_rejected_and_counted(): void
    {
        $this->issueCode();

        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => '999999',
        ])->assertStatus(400);

        $row = DB::table('email_verification_codes')->where('email', self::EMAIL)->first();
        $this->assertSame(1, (int) $row->attempts);
        $this->assertNull($row->verified_at);
    }

    public function test_code_is_burned_after_too_many_wrong_attempts(): void
    {
        $code = $this->issueCode();

        for ($i = 1; $i < EmailVerificationService::MAX_ATTEMPTS; $i++) {
            $this->postJson('/api/v1/auth/register/verify-code', [
                'email' => self::EMAIL,
                'code'  => '000001',
            ])->assertStatus(400);
        }

        // The attempt that hits the cap reports 429 and deletes the code.
        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => '000001',
        ])->assertStatus(429);

        $this->assertDatabaseMissing('email_verification_codes', ['email' => self::EMAIL]);

        // Even the right code is worthless now.
        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => $code,
        ])->assertStatus(400);
    }

    public function test_expired_code_is_rejected(): void
    {
        $code = $this->issueCode();

        $this->travel(EmailVerificationService::CODE_TTL_MINUTES + 1)->minutes();

        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => $code,
        ])->assertStatus(400);

        $this->assertDatabaseMissing('email_verification_codes', ['email' => self::EMAIL]);
    }

    // ── The gate on registration ─────────────────────────────────

    public function test_register_is_refused_when_the_email_is_not_verified(): void
    {
        $this->registerWithFile()
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');

        $this->assertDatabaseMissing('users', ['email' => self::EMAIL]);
    }

    public function test_register_is_refused_when_only_a_code_was_requested(): void
    {
        $this->issueCode(); // sent, but never entered

        $this->registerWithFile()
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');
    }

    public function test_register_succeeds_once_the_code_is_verified(): void
    {
        $code = $this->issueCode();

        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => $code,
        ])->assertOk();

        $this->registerWithFile()->assertStatus(201);

        $this->assertDatabaseHas('users', ['email' => self::EMAIL]);
        // The verification is consumed, so it can't be replayed.
        $this->assertDatabaseMissing('email_verification_codes', ['email' => self::EMAIL]);
    }

    public function test_verification_expires_before_it_can_be_reused_much_later(): void
    {
        $code = $this->issueCode();

        $this->postJson('/api/v1/auth/register/verify-code', [
            'email' => self::EMAIL,
            'code'  => $code,
        ])->assertOk();

        $this->travel(EmailVerificationService::VERIFIED_TTL_MINUTES + 1)->minutes();

        $this->registerWithFile()
            ->assertStatus(422)
            ->assertJsonValidationErrors('email');
    }

    // ── Password policy ──────────────────────────────────────────

    #[DataProvider('weakPasswords')]
    public function test_register_rejects_passwords_that_miss_a_requirement(string $password): void
    {
        $this->markVerified();

        $this->registerWithFile([
            'password' => $password,
            'password_confirmation' => $password,
        ])
            ->assertStatus(422)
            ->assertJsonValidationErrors('password');
    }

    public static function weakPasswords(): array
    {
        return [
            'too short'      => ['Ab1!xy'],
            'no uppercase'   => ['secure123!'],
            'no number'      => ['SecurePass!'],
            'no symbol'      => ['SecurePass123'],
        ];
    }

    public function test_register_accepts_a_password_meeting_every_requirement(): void
    {
        $this->markVerified();

        $this->registerWithFile([
            'password' => 'SecurePass123!',
            'password_confirmation' => 'SecurePass123!',
        ])->assertStatus(201);
    }

    // ── Helpers ──────────────────────────────────────────────────

    /**
     * Request a code and return the plain 6-digit value, read back off the
     * mailable that was queued for delivery.
     */
    private function issueCode(): string
    {
        $this->postJson('/api/v1/auth/register/send-code', ['email' => self::EMAIL])->assertOk();

        $code = null;
        Mail::assertSent(EmailVerificationCodeMail::class, function ($mail) use (&$code) {
            $code = $mail->code;
            return true;
        });

        $this->assertNotNull($code);

        return $code;
    }

    /** Stamp the address verified without going through the endpoints. */
    private function markVerified(): void
    {
        DB::table('email_verification_codes')->updateOrInsert(
            ['email' => self::EMAIL],
            [
                'token' => Hash::make('000000'),
                'attempts' => 0,
                'verified_at' => now(),
                'created_at' => now(),
            ]
        );
    }

    private function registerWithFile(array $overrides = []): \Illuminate\Testing\TestResponse
    {
        $payload = array_merge([
            'first_name' => 'Maria',
            'surname' => 'Santos',
            'birthdate' => '1995-08-20',
            'gender' => 'Female',
            'email' => self::EMAIL,
            'contact_number' => '09171234567',
            'username' => 'maria.santos',
            'password' => 'SecurePass123!',
            'password_confirmation' => 'SecurePass123!',
            'applied_type' => 'STUDENT',
        ], $overrides, ['id_image' => UploadedFile::fake()->image('valid_id.jpg', 800, 600)]);

        return $this->post('/api/v1/auth/register', $payload, ['Accept' => 'application/json']);
    }

    private function seedCommuter(string $email): User
    {
        $user = User::create([
            'email' => $email,
            'password' => Hash::make('SecurePass123!'),
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
            'username' => 'existing.user',
            'language_preference' => 'English',
            'account_status' => 'APPROVED',
            'verified_at' => now(),
        ]);

        return $user;
    }
}
