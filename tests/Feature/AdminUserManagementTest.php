<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * S5-T3 — Admin User Management CRUD (list, view, update, soft-delete).
 */
class AdminUserManagementTest extends TestCase
{
    use RefreshDatabase;

    private int $seq = 0;

    private function makeAdmin(string $email = 'admin@gmail.com'): User
    {
        $admin = User::create([
            'email'    => $email,
            'password' => Hash::make('password123'),
            'role'     => UserRole::ADMIN,
        ]);
        AdminProfile::create([
            'id'         => $admin->id,
            'first_name' => 'System',
            'last_name'  => 'Admin',
        ]);

        return $admin;
    }

    private function makeCommuter(string $email = 'commuter1@gmail.com', string $status = 'ACTIVE'): User
    {
        $this->seq++;
        $commuter = User::create([
            'email'    => $email,
            'password' => Hash::make('password123'),
            'role'     => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id'                  => $commuter->id,
            'first_name'          => 'Jose',
            'surname'             => 'Mendoza',
            'birthdate'           => '1998-05-12',
            'gender'              => 'Male',
            'email'               => $email,
            'contact_number'      => '09171234567',
            'commuter_type'       => 'REGULAR',
            'username'            => 'commuter' . $this->seq,
            'language_preference' => 'English',
            'account_status'      => $status,
            'verified_at'         => now(),
        ]);

        return $commuter;
    }

    private function makeConductor(string $email = 'conductor1@gmail.com'): User
    {
        $this->seq++;
        $conductor = User::create([
            'email'    => $email,
            'password' => Hash::make('password123'),
            'role'     => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id'                 => $conductor->id,
            'first_name'         => 'Juan',
            'last_name'          => 'Dela Cruz',
            'birthday'           => '1990-03-15',
            'generated_username' => 'conductor' . $this->seq,
            'generated_password' => Hash::make('password123'),
        ]);

        return $conductor;
    }

    private function tokenFor(User $user): string
    {
        return $user->createToken('test')->plainTextToken;
    }

    private function asAdmin(): array
    {
        $admin = $this->makeAdmin();

        return [$admin, ['Authorization' => "Bearer {$this->tokenFor($admin)}"]];
    }

    // ── List ─────────────────────────────────────────────────────

    public function test_list_returns_paginated_users_without_secrets(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $this->makeConductor();
        $this->makeCommuter();

        $response = $this->withHeaders($headers)->getJson('/api/v1/admin/users');

        $response->assertStatus(200);
        $response->assertJsonStructure([
            'data' => ['current_page', 'data' => [['id', 'email', 'role', 'name']], 'total'],
        ]);
        $this->assertEquals(3, $response->json('data.total')); // admin + conductor + commuter
        $this->assertStringNotContainsStringIgnoringCase('password', $response->getContent());
    }

    public function test_list_filters_by_role(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $this->makeConductor();
        $this->makeCommuter('a@gmail.com');
        $this->makeCommuter('b@gmail.com');

        $response = $this->withHeaders($headers)->getJson('/api/v1/admin/users?role=COMMUTER');

        $response->assertStatus(200);
        $this->assertEquals(2, $response->json('data.total'));
        foreach ($response->json('data.data') as $user) {
            $this->assertEquals('COMMUTER', $user['role']);
        }
    }

    public function test_list_searches_by_email_and_name(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $this->makeCommuter('findme@gmail.com');
        $this->makeCommuter('other@gmail.com');

        $response = $this->withHeaders($headers)->getJson('/api/v1/admin/users?search=findme');

        $response->assertStatus(200);
        $this->assertEquals(1, $response->json('data.total'));
        $this->assertEquals('findme@gmail.com', $response->json('data.data.0.email'));
    }

    public function test_list_forbidden_for_non_admin(): void
    {
        $commuter = $this->makeCommuter();

        $this->withHeader('Authorization', "Bearer {$this->tokenFor($commuter)}")
            ->getJson('/api/v1/admin/users')
            ->assertStatus(403);
    }

    // ── Show ─────────────────────────────────────────────────────

    public function test_show_returns_user_with_profile(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter();

        $response = $this->withHeaders($headers)->getJson("/api/v1/admin/users/{$commuter->id}");

        $response->assertStatus(200);
        $response->assertJsonPath('data.role', 'COMMUTER');
        $response->assertJsonPath('data.account_status', 'ACTIVE');
        $response->assertJsonPath('data.commuter_type', 'REGULAR');
    }

    public function test_show_returns_404_for_missing_user(): void
    {
        [$admin, $headers] = $this->asAdmin();

        $this->withHeaders($headers)
            ->getJson('/api/v1/admin/users/non-existent-id')
            ->assertStatus(404)
            ->assertJsonPath('success', false);
    }

    // ── Update ───────────────────────────────────────────────────

    public function test_update_can_suspend_commuter_and_blocks_their_login(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter('suspendme@gmail.com');

        $this->withHeaders($headers)
            ->putJson("/api/v1/admin/users/{$commuter->id}", ['account_status' => 'SUSPENDED'])
            ->assertStatus(200)
            ->assertJsonPath('data.account_status', 'SUSPENDED');

        $this->assertDatabaseHas('commuter_profiles', [
            'id'             => $commuter->id,
            'account_status' => 'SUSPENDED',
        ]);

        // A suspended commuter can no longer log in (403, after creds verified).
        $this->postJson('/api/v1/auth/login', [
            'login'    => 'suspendme@gmail.com',
            'password' => 'password123',
        ])->assertStatus(403);
    }

    public function test_update_persists_name_change_to_surname_for_commuter(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter();

        $this->withHeaders($headers)
            ->putJson("/api/v1/admin/users/{$commuter->id}", [
                'first_name' => 'Updated',
                'last_name'  => 'Name',
            ])
            ->assertStatus(200);

        $this->assertDatabaseHas('commuter_profiles', [
            'id'         => $commuter->id,
            'first_name' => 'Updated',
            'surname'    => 'Name', // last_name maps to surname for commuters
        ]);
    }

    public function test_update_rejects_account_status_on_non_commuter(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $conductor = $this->makeConductor();

        $this->withHeaders($headers)
            ->putJson("/api/v1/admin/users/{$conductor->id}", ['account_status' => 'SUSPENDED'])
            ->assertStatus(422);
    }

    public function test_update_rejects_invalid_account_status_value(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter();

        $this->withHeaders($headers)
            ->putJson("/api/v1/admin/users/{$commuter->id}", ['account_status' => 'BANNED'])
            ->assertStatus(422)
            ->assertJsonStructure(['errors' => ['account_status']]);
    }

    public function test_update_cannot_suspend_self(): void
    {
        [$admin, $headers] = $this->asAdmin();

        $this->withHeaders($headers)
            ->putJson("/api/v1/admin/users/{$admin->id}", ['account_status' => 'SUSPENDED'])
            ->assertStatus(422);
    }

    public function test_update_returns_404_for_missing_user(): void
    {
        [$admin, $headers] = $this->asAdmin();

        $this->withHeaders($headers)
            ->putJson('/api/v1/admin/users/non-existent-id', ['first_name' => 'X'])
            ->assertStatus(404);
    }

    public function test_update_forbidden_for_non_admin(): void
    {
        $commuter = $this->makeCommuter();
        $target = $this->makeCommuter('target@gmail.com');

        $this->withHeader('Authorization', "Bearer {$this->tokenFor($commuter)}")
            ->putJson("/api/v1/admin/users/{$target->id}", ['first_name' => 'X'])
            ->assertStatus(403);
    }

    // ── Delete ───────────────────────────────────────────────────

    public function test_delete_soft_deletes_user_and_blocks_login(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter('deleteme@gmail.com');

        $this->withHeaders($headers)
            ->deleteJson("/api/v1/admin/users/{$commuter->id}")
            ->assertStatus(200);

        $this->assertSoftDeleted('users', ['id' => $commuter->id]);

        // Soft-deleted users are excluded from auth → login is rejected.
        $this->postJson('/api/v1/auth/login', [
            'login'    => 'deleteme@gmail.com',
            'password' => 'password123',
        ])->assertStatus(401);
    }

    public function test_delete_cannot_delete_self(): void
    {
        [$admin, $headers] = $this->asAdmin();

        $this->withHeaders($headers)
            ->deleteJson("/api/v1/admin/users/{$admin->id}")
            ->assertStatus(422);

        $this->assertDatabaseHas('users', ['id' => $admin->id, 'deleted_at' => null]);
    }

    public function test_delete_other_admin_allowed_when_multiple_admins(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $otherAdmin = $this->makeAdmin('admin2@gmail.com');

        $this->withHeaders($headers)
            ->deleteJson("/api/v1/admin/users/{$otherAdmin->id}")
            ->assertStatus(200);

        $this->assertSoftDeleted('users', ['id' => $otherAdmin->id]);
    }

    public function test_delete_returns_404_for_missing_user(): void
    {
        [$admin, $headers] = $this->asAdmin();

        $this->withHeaders($headers)
            ->deleteJson('/api/v1/admin/users/non-existent-id')
            ->assertStatus(404);
    }

    public function test_delete_forbidden_for_non_admin(): void
    {
        $commuter = $this->makeCommuter();
        $target = $this->makeCommuter('target@gmail.com');

        $this->withHeader('Authorization', "Bearer {$this->tokenFor($commuter)}")
            ->deleteJson("/api/v1/admin/users/{$target->id}")
            ->assertStatus(403);
    }

    public function test_suspend_records_reason_revokes_tokens_and_blocks_login(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter('suspend-flow@gmail.com');
        $this->tokenFor($commuter);

        $this->withHeaders($headers)
            ->postJson("/api/v1/admin/users/{$commuter->id}/suspend", [
                'reason_code' => 'POLICY_VIOLATION',
                'reason' => 'Repeated violation of the commuter conduct policy.',
                'is_permanent' => false,
                'duration_days' => 7,
            ])
            ->assertOk()
            ->assertJsonPath('data.account_status', 'SUSPENDED')
            ->assertJsonPath('data.suspension.reason_code', 'POLICY_VIOLATION')
            ->assertJsonPath('data.suspension.is_permanent', false);

        $this->assertDatabaseHas('user_suspensions', [
            'user_id' => $commuter->id,
            'reason_code' => 'POLICY_VIOLATION',
            'is_permanent' => false,
        ]);
        $this->assertDatabaseMissing('personal_access_tokens', [
            'tokenable_id' => $commuter->id,
        ]);

        $this->postJson('/api/v1/auth/login', [
            'login' => 'suspend-flow@gmail.com',
            'password' => 'password123',
        ])->assertStatus(403)
            ->assertJsonPath('message', fn (string $message) =>
                str_contains($message, 'This account is suspended until')
                && str_contains($message, 'Reason: Repeated violation of the commuter conduct policy.')
            );

        $this->travel(8)->days();

        $this->postJson('/api/v1/auth/login', [
            'login' => 'suspend-flow@gmail.com',
            'password' => 'password123',
        ])->assertOk();
    }

    public function test_unsuspend_lifts_history_and_allows_login_again(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter('unsuspend-flow@gmail.com');

        $this->withHeaders($headers)
            ->postJson("/api/v1/admin/users/{$commuter->id}/suspend", [
                'reason_code' => 'SAFETY_CONCERN',
                'reason' => 'Temporary review required for a safety report.',
                'is_permanent' => true,
            ])
            ->assertOk();

        $this->withHeaders($headers)
            ->postJson("/api/v1/admin/users/{$commuter->id}/unsuspend")
            ->assertOk()
            ->assertJsonPath('data.account_status', 'ACTIVE')
            ->assertJsonPath('data.suspension', null);

        $this->assertDatabaseMissing('user_suspensions', [
            'user_id' => $commuter->id,
            'lifted_at' => null,
        ]);

        $this->postJson('/api/v1/auth/login', [
            'login' => 'unsuspend-flow@gmail.com',
            'password' => 'password123',
        ])->assertOk();
    }
}
