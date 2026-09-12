<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\ShiftLog;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    private function seedAdmin(): User
    {
        $admin = User::create([
            'email' => 'admin@gmail.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);

        AdminProfile::create([
            'id' => $admin->id,
            'first_name' => 'System',
            'last_name' => 'Admin',
        ]);

        return $admin;
    }

    private function seedCommuter(): User
    {
        $commuter = User::create([
            'email' => 'commuter1@gmail.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::COMMUTER,
        ]);

        CommuterProfile::create([
            'id' => $commuter->id,
            'first_name' => 'Jose',
            'surname' => 'Mendoza',
            'birthdate' => '1998-05-12',
            'gender' => 'Male',
            'email' => 'commuter1@gmail.com',
            'contact_number' => '+639171234567',
            'commuter_type' => 'Regular',
            'username' => 'commuter001',
            'language_preference' => 'en',
            'account_status' => 'ACTIVE',
            'verified_at' => now(),
        ]);

        return $commuter;
    }

    private function seedConductor(): User
    {
        $conductor = User::create([
            'email' => 'conductor1@gmail.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::CONDUCTOR,
        ]);

        ConductorProfile::create([
            'id' => $conductor->id,
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-03-15',
            'generated_username' => 'conductor001',
            'generated_password' => Hash::make('password123'),
        ]);

        return $conductor;
    }

    // ── Login Tests ──────────────────────────────────────────────

    public function test_login_with_valid_admin_credentials_returns_200(): void
    {
        $this->seedAdmin();

        $response = $this->postJson('/api/v1/auth/login', [
            'login' => 'admin@gmail.com',
            'password' => 'password123',
        ]);

        $response->assertStatus(200);
        $response->assertJsonStructure([
            'success',
            'data' => ['id', 'email', 'role', 'name', 'token'],
            'message',
            'errors',
            'meta',
        ]);
        $this->assertTrue($response->json('success'));
        $this->assertEquals('ADMIN', $response->json('data.role'));
        $this->assertNotEmpty($response->json('data.token'));
    }

    public function test_login_with_wrong_password_returns_401(): void
    {
        $this->seedAdmin();

        $response = $this->postJson('/api/v1/auth/login', [
            'login' => 'admin@gmail.com',
            'password' => 'wrong-password',
        ]);

        $response->assertStatus(401);
        $this->assertFalse($response->json('success'));
        $this->assertEquals('Invalid credentials', $response->json('message'));
    }

    public function test_login_with_nonexistent_email_returns_401(): void
    {
        $response = $this->postJson('/api/v1/auth/login', [
            'login' => 'nobody@gmail.com',
            'password' => 'password123',
        ]);

        $response->assertStatus(401);
        $this->assertFalse($response->json('success'));
    }

    public function test_login_with_missing_fields_returns_422(): void
    {
        $response = $this->postJson('/api/v1/auth/login', []);

        $response->assertStatus(422);
        $this->assertFalse($response->json('success'));
        $this->assertEquals('Validation failed', $response->json('message'));
        $response->assertJsonStructure(['errors']);
    }

    public function test_login_with_conductor_username(): void
    {
        $this->seedConductor();

        $response = $this->postJson('/api/v1/auth/login', [
            'login' => 'conductor001',
            'password' => 'password123',
        ]);

        $response->assertStatus(200);
        $this->assertEquals('CONDUCTOR', $response->json('data.role'));
    }

    // ── Single-Device Session Enforcement ────────────────────────

    public function test_admin_login_revokes_the_previous_device_token(): void
    {
        $admin = $this->seedAdmin();
        $firstDeviceToken = $admin->createToken('device-one');
        $firstDevice = $firstDeviceToken->plainTextToken;

        // The first device holds a live token going in. Asserted against the
        // token table rather than by making an authenticated request first —
        // resolving the guard mid-test keeps the user cached for subsequent
        // requests, which masks the revocation we are checking for.
        $this->assertDatabaseHas('personal_access_tokens', [
            'id' => $firstDeviceToken->accessToken->id,
        ]);

        $response = $this->postJson('/api/v1/auth/login', [
            'login' => 'admin@gmail.com',
            'password' => 'password123',
        ]);
        $response->assertStatus(200);

        // The revocation itself: the old device's token row is gone.
        $this->assertDatabaseMissing('personal_access_tokens', [
            'id' => $firstDeviceToken->accessToken->id,
        ]);

        // Old device is now rejected...
        $this->withHeader('Authorization', "Bearer {$firstDevice}")
            ->getJson('/api/v1/user')
            ->assertStatus(401);

        // ...and exactly one token survives: the new device's.
        $this->assertSame(1, $admin->tokens()->count());

        $this->withHeader('Authorization', "Bearer {$response->json('data.token')}")
            ->getJson('/api/v1/user')
            ->assertStatus(200);
    }

    public function test_conductor_login_revokes_the_previous_device_token(): void
    {
        $conductor = $this->seedConductor();
        $firstDevice = $conductor->createToken('device-one')->plainTextToken;

        $this->postJson('/api/v1/auth/login', [
            'login' => 'conductor001',
            'password' => 'password123',
        ])->assertStatus(200);

        $this->withHeader('Authorization', "Bearer {$firstDevice}")
            ->getJson('/api/v1/user')
            ->assertStatus(401);

        $this->assertSame(1, $conductor->tokens()->count());
    }

    public function test_different_device_login_revokes_the_old_token_and_moves_the_active_shift(): void
    {
        $conductor = $this->seedConductor();
        // Simulate an already-logged-in WEB session (auth-token:WEB)
        $webToken  = $conductor->createToken('auth-token:WEB');
        $webPlainText = $webToken->plainTextToken;

        ShiftLog::factory()->create([
            'shift_id'                  => 'SFT-AUTH-DEVICE-1',
            'conductor_id'              => $conductor->id,
            'operating_device_id'       => 'web-device-aaaaaaaa',
            'operating_device_type'     => 'WEB',
            'operating_device_claimed_at' => now(),
        ]);

        $response = $this->postJson('/api/v1/auth/login', [
            'login'       => 'conductor001',
            'password'    => 'password123',
            'device_id'   => 'mobile-device-bbbbbbbb',
            'device_type' => 'MOBILE',
        ])->assertOk();

        // Phase 3: WEB token must be preserved — only auth-token:MOBILE was wiped
        $this->assertDatabaseHas('personal_access_tokens', [
            'id' => $webToken->accessToken->id,
        ]);

        // Conductor now holds 2 tokens: auth-token:WEB (unchanged) + auth-token:MOBILE (new)
        $this->assertSame(2, $conductor->tokens()->count());

        // Shift device handoff happened as usual
        $this->assertDatabaseHas('shift_logs', [
            'shift_id'              => 'SFT-AUTH-DEVICE-1',
            'operating_device_id'   => 'mobile-device-bbbbbbbb',
            'operating_device_type' => 'MOBILE',
        ]);

        // WEB token is still valid (no 401)
        $this->withHeader('Authorization', "Bearer {$webPlainText}")
            ->getJson('/api/v1/user')
            ->assertOk();

        // MOBILE token works for device-locked operations
        $this->withHeader('Authorization', "Bearer {$response->json('data.token')}")
            ->postJson('/api/v1/conductor/break-status', [
                'is_on_break' => true,
                'device_id'   => 'mobile-device-bbbbbbbb',
                'device_type' => 'MOBILE',
            ])
            ->assertOk();
    }

    public function test_unidentified_legacy_client_cannot_displace_an_active_shift_device(): void
    {
        $conductor = $this->seedConductor();
        $ownerToken = $conductor->createToken('device-one');

        ShiftLog::factory()->create([
            'shift_id' => 'SFT-AUTH-DEVICE-LEGACY',
            'conductor_id' => $conductor->id,
            'operating_device_id' => 'web-device-aaaaaaaa',
            'operating_device_type' => 'WEB',
            'operating_device_claimed_at' => now(),
        ]);

        $this->postJson('/api/v1/auth/login', [
            'login' => 'conductor001',
            'password' => 'password123',
        ])->assertStatus(409);

        $this->assertDatabaseHas('personal_access_tokens', [
            'id' => $ownerToken->accessToken->id,
        ]);
        $this->assertDatabaseHas('shift_logs', [
            'shift_id' => 'SFT-AUTH-DEVICE-LEGACY',
            'operating_device_id' => 'web-device-aaaaaaaa',
        ]);
    }

    public function test_active_shift_owner_can_log_in_again_on_the_same_device(): void
    {
        $conductor = $this->seedConductor();
        // Use the real platform token name so Phase 3 scoping applies correctly
        $previousToken = $conductor->createToken('auth-token:WEB');

        ShiftLog::factory()->create([
            'shift_id'                  => 'SFT-AUTH-DEVICE-2',
            'conductor_id'              => $conductor->id,
            'operating_device_id'       => 'web-device-aaaaaaaa',
            'operating_device_type'     => 'WEB',
            'operating_device_claimed_at' => now(),
        ]);

        $response = $this->postJson('/api/v1/auth/login', [
            'login'       => 'conductor001',
            'password'    => 'password123',
            'device_id'   => 'web-device-aaaaaaaa',
            'device_type' => 'WEB',
        ])->assertOk();

        // Old auth-token:WEB must be gone (same-platform rotation)
        $this->assertDatabaseMissing('personal_access_tokens', [
            'id' => $previousToken->accessToken->id,
        ]);
        // Only the new WEB token remains — total count is 1
        $this->assertSame(1, $conductor->tokens()->count());

        $this->withHeader('Authorization', "Bearer {$response->json('data.token')}")
            ->getJson('/api/v1/user')
            ->assertOk();
    }

    public function test_commuter_login_revokes_the_previous_device_token(): void
    {
        $commuter = $this->seedCommuter();
        $firstDeviceToken = $commuter->createToken('device-one');
        $firstDevice = $firstDeviceToken->plainTextToken;

        $this->assertDatabaseHas('personal_access_tokens', [
            'id' => $firstDeviceToken->accessToken->id,
        ]);

        $response = $this->postJson('/api/v1/auth/login', [
            'login' => 'commuter1@gmail.com',
            'password' => 'password123',
        ]);
        $response->assertStatus(200);

        // The revocation itself: the old device's token row is gone.
        $this->assertDatabaseMissing('personal_access_tokens', [
            'id' => $firstDeviceToken->accessToken->id,
        ]);

        // Old device is now rejected...
        $this->withHeader('Authorization', "Bearer {$firstDevice}")
            ->getJson('/api/v1/user')
            ->assertStatus(401);

        // ...and exactly one token survives: the new device's.
        $this->assertSame(1, $commuter->tokens()->count());

        $this->withHeader('Authorization', "Bearer {$response->json('data.token')}")
            ->getJson('/api/v1/user')
            ->assertStatus(200);
    }

    public function test_failed_login_does_not_revoke_an_existing_session(): void
    {
        $admin = $this->seedAdmin();
        $firstDevice = $admin->createToken('device-one')->plainTextToken;

        $this->postJson('/api/v1/auth/login', [
            'login' => 'admin@gmail.com',
            'password' => 'wrong-password',
        ])->assertStatus(401);

        // A wrong password must not be usable to kick someone off their device.
        $this->withHeader('Authorization', "Bearer {$firstDevice}")
            ->getJson('/api/v1/user')
            ->assertStatus(200);
    }

    // ── Logout Tests ─────────────────────────────────────────────

    public function test_logout_with_valid_token_returns_200(): void
    {
        $admin = $this->seedAdmin();
        $token = $admin->createToken('test')->plainTextToken;

        $response = $this->withHeader('Authorization', "Bearer {$token}")
            ->postJson('/api/v1/auth/logout');

        $response->assertStatus(200);
        $this->assertTrue($response->json('success'));
        $this->assertEquals('Logged out successfully', $response->json('message'));
    }

    public function test_logout_without_token_returns_401(): void
    {
        $response = $this->postJson('/api/v1/auth/logout');

        $response->assertStatus(401);
    }

    // ── User Endpoint Tests ──────────────────────────────────────

    public function test_get_user_with_valid_token_returns_200(): void
    {
        $admin = $this->seedAdmin();
        $token = $admin->createToken('test')->plainTextToken;

        $response = $this->withHeader('Authorization', "Bearer {$token}")
            ->getJson('/api/v1/user');

        $response->assertStatus(200);
        $this->assertTrue($response->json('success'));
        $response->assertJsonStructure([
            'data' => ['user', 'profile'],
        ]);
    }

    public function test_get_user_without_token_returns_401(): void
    {
        $response = $this->getJson('/api/v1/user');

        $response->assertStatus(401);
    }

    public function test_get_user_commuter_returns_profile_data(): void
    {
        $commuter = $this->seedCommuter();
        $token = $commuter->createToken('test')->plainTextToken;

        $response = $this->withHeader('Authorization', "Bearer {$token}")
            ->getJson('/api/v1/user');

        $response->assertStatus(200);
        $this->assertEquals('COMMUTER', $response->json('data.user.role'));
        $this->assertEquals('Jose', $response->json('data.profile.first_name'));
    }
}
