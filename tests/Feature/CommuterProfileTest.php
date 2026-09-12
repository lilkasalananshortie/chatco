<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * S5-T1 — Commuter Profile API & Password Change.
 *
 * Covers GET/PUT /commuter/profile and POST /commuter/change-password:
 * happy paths, validation failures, ownership/role isolation, immutable
 * fields, password verification, and session-token revocation.
 */
class CommuterProfileTest extends TestCase
{
    use RefreshDatabase;

    private function seedCommuter(string $password = 'password123'): User
    {
        $commuter = User::create([
            'email'    => 'commuter1@gmail.com',
            'password' => Hash::make($password),
            'role'     => UserRole::COMMUTER,
        ]);

        CommuterProfile::create([
            'id'                  => $commuter->id,
            'first_name'          => 'Jose',
            'middle_name'         => 'P',
            'surname'             => 'Mendoza',
            'birthdate'           => '1998-05-12',
            'gender'              => 'Male',
            'email'               => 'commuter1@gmail.com',
            'contact_number'      => '09171234567',
            'commuter_type'       => 'REGULAR',
            'applied_type'        => 'STUDENT',
            'username'            => 'commuter001',
            'language_preference' => 'English',
            'account_status'      => 'ACTIVE',
            'verified_at'         => now(),
        ]);

        return $commuter;
    }

    private function seedConductor(): User
    {
        $conductor = User::create([
            'email'    => 'conductor1@gmail.com',
            'password' => Hash::make('password123'),
            'role'     => UserRole::CONDUCTOR,
        ]);

        ConductorProfile::create([
            'id'                 => $conductor->id,
            'first_name'         => 'Juan',
            'last_name'          => 'Dela Cruz',
            'birthday'           => '1990-03-15',
            'generated_username' => 'conductor001',
            'generated_password' => Hash::make('password123'),
        ]);

        return $conductor;
    }

    private function tokenFor(User $user): string
    {
        return $user->createToken('test')->plainTextToken;
    }

    // ── GET /commuter/profile ────────────────────────────────────

    public function test_get_profile_returns_user_and_profile_without_secrets(): void
    {
        $commuter = $this->seedCommuter();
        $token = $this->tokenFor($commuter);

        $response = $this->withHeader('Authorization', "Bearer {$token}")
            ->getJson('/api/v1/commuter/profile');

        $response->assertStatus(200);
        $this->assertTrue($response->json('success'));
        $response->assertJsonStructure([
            'data' => [
                'user'    => ['id', 'email', 'role', 'name'],
                'profile' => [
                    'first_name', 'surname', 'contact_number', 'commuter_type',
                    'applied_type', 'language_preference', 'account_status',
                    'id_image_url', 'verified_at',
                ],
            ],
        ]);

        $this->assertEquals('COMMUTER', $response->json('data.user.role'));
        $this->assertEquals('Jose', $response->json('data.profile.first_name'));

        // No password/token must ever leak.
        $this->assertStringNotContainsStringIgnoringCase('password', $response->getContent());
    }

    public function test_get_profile_requires_authentication(): void
    {
        $this->getJson('/api/v1/commuter/profile')->assertStatus(401);
    }

    public function test_get_profile_forbidden_for_non_commuter(): void
    {
        $conductor = $this->seedConductor();
        $token = $this->tokenFor($conductor);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->getJson('/api/v1/commuter/profile')
            ->assertStatus(403);
    }

    // ── PUT /commuter/profile ────────────────────────────────────

    public function test_update_profile_persists_editable_fields(): void
    {
        $commuter = $this->seedCommuter();
        $token = $this->tokenFor($commuter);

        $response = $this->withHeader('Authorization', "Bearer {$token}")
            ->putJson('/api/v1/commuter/profile', [
                'contact_number'      => '09998887777',
                'language_preference' => 'Filipino',
            ]);

        $response->assertStatus(200);
        $this->assertEquals('09998887777', $response->json('data.profile.contact_number'));
        $this->assertEquals('Filipino', $response->json('data.profile.language_preference'));

        $this->assertDatabaseHas('commuter_profiles', [
            'id'                  => $commuter->id,
            'contact_number'      => '09998887777',
            'language_preference' => 'Filipino',
        ]);
    }

    public function test_update_profile_ignores_immutable_fields(): void
    {
        $commuter = $this->seedCommuter();
        $token = $this->tokenFor($commuter);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->putJson('/api/v1/commuter/profile', [
                'email'         => 'hacker@evil.com',
                'role'          => 'ADMIN',
                'commuter_type' => 'PWD',
                'first_name'    => 'Changed',
            ])
            ->assertStatus(200);

        // Login email + role on the User are untouched.
        $this->assertDatabaseHas('users', [
            'id'    => $commuter->id,
            'email' => 'commuter1@gmail.com',
            'role'  => 'COMMUTER',
        ]);

        // Identity fields tied to the verified ID are untouched.
        $this->assertDatabaseHas('commuter_profiles', [
            'id'            => $commuter->id,
            'first_name'    => 'Jose',
            'commuter_type' => 'REGULAR',
        ]);
    }

    public function test_update_profile_rejects_invalid_contact_number(): void
    {
        $commuter = $this->seedCommuter();
        $token = $this->tokenFor($commuter);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->putJson('/api/v1/commuter/profile', [
                'contact_number' => 'not-a-phone!!',
            ])
            ->assertStatus(422)
            ->assertJsonPath('success', false)
            ->assertJsonStructure(['errors' => ['contact_number']]);
    }

    public function test_update_profile_forbidden_for_non_commuter(): void
    {
        $conductor = $this->seedConductor();
        $token = $this->tokenFor($conductor);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->putJson('/api/v1/commuter/profile', ['language_preference' => 'Filipino'])
            ->assertStatus(403);
    }

    // ── POST /commuter/change-password ───────────────────────────

    public function test_change_password_with_correct_current_password(): void
    {
        $commuter = $this->seedCommuter('password123');
        $token = $this->tokenFor($commuter);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/v1/commuter/change-password', [
                'current_password'      => 'password123',
                'password'              => 'NewSecret123',
                'password_confirmation' => 'NewSecret123',
            ])
            ->assertStatus(200)
            ->assertJsonPath('success', true);

        $commuter->refresh();
        $this->assertTrue(Hash::check('NewSecret123', $commuter->password));
        $this->assertFalse(Hash::check('password123', $commuter->password));
    }

    public function test_change_password_with_wrong_current_password_returns_422(): void
    {
        $commuter = $this->seedCommuter('password123');
        $token = $this->tokenFor($commuter);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/v1/commuter/change-password', [
                'current_password'      => 'wrong-password',
                'password'              => 'NewSecret123',
                'password_confirmation' => 'NewSecret123',
            ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['current_password']]);

        // Password is unchanged.
        $commuter->refresh();
        $this->assertTrue(Hash::check('password123', $commuter->password));
    }

    public function test_change_password_rejects_same_password(): void
    {
        $commuter = $this->seedCommuter('password123');
        $token = $this->tokenFor($commuter);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/v1/commuter/change-password', [
                'current_password'      => 'password123',
                'password'              => 'password123',
                'password_confirmation' => 'password123',
            ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['password']]);
    }

    public function test_change_password_requires_strong_new_password(): void
    {
        $commuter = $this->seedCommuter('password123');
        $token = $this->tokenFor($commuter);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/v1/commuter/change-password', [
                'current_password'      => 'password123',
                'password'              => 'short',
                'password_confirmation' => 'short',
            ])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['password']]);
    }

    public function test_change_password_revokes_other_sessions_but_keeps_current(): void
    {
        $commuter = $this->seedCommuter('password123');

        // Capture the token rows so we can assert revocation at the data layer.
        // (HTTP-level assertions are unreliable here: Sanctum's stateful
        // middleware sets a session cookie that the test client reuses on the
        // next request, masking token deletion.)
        $current = $commuter->createToken('current');
        $other   = $commuter->createToken('other');

        $this->assertDatabaseCount('personal_access_tokens', 2);

        $this->withHeader('Authorization', "Bearer {$current->plainTextToken}")
            ->postJson('/api/v1/commuter/change-password', [
                'current_password'      => 'password123',
                'password'              => 'NewSecret123',
                'password_confirmation' => 'NewSecret123',
            ])
            ->assertStatus(200);

        // The current request's token survives; every other token is revoked.
        $this->assertDatabaseCount('personal_access_tokens', 1);
        $this->assertDatabaseHas('personal_access_tokens', [
            'id' => $current->accessToken->getKey(),
        ]);
        $this->assertDatabaseMissing('personal_access_tokens', [
            'id' => $other->accessToken->getKey(),
        ]);
    }

    public function test_change_password_forbidden_for_non_commuter(): void
    {
        $conductor = $this->seedConductor();
        $token = $this->tokenFor($conductor);

        $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/v1/commuter/change-password', [
                'current_password'      => 'password123',
                'password'              => 'NewSecret123',
                'password_confirmation' => 'NewSecret123',
            ])
            ->assertStatus(403);
    }
}
