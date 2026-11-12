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
        [, $headers] = $this->asAdmin();
        $admin = $this->makeAdmin('other.admin@gmail.com');
        $this->makeConductor();
        $commuter = $this->makeCommuter();
        $commuter->commuterProfile->update([
            'id_image_url' => 'ids/commuters/'.$commuter->id.'/valid-id.png',
            'middle_name' => 'Dela Cruz', 'suffix' => 'Jr.', 'applied_type' => 'STUDENT',
        ]);

        $response = $this->withHeaders($headers)->getJson('/api/v1/admin/users');

        $response->assertStatus(200);
        $response->assertJsonStructure([
            'data' => ['current_page', 'data' => [['id', 'email', 'role', 'name']], 'total'],
        ]);
        $this->assertEquals(3, $response->json('data.total')); // other admin + conductor + commuter, not the requester
        $this->assertStringNotContainsStringIgnoringCase('password', $response->getContent());
        $commuterRow = collect($response->json('data.data'))->firstWhere('id', $commuter->id);
        $this->assertStringContainsString('ids/commuters/'.$commuter->id.'/valid-id.png', $commuterRow['id_image_url']);
        $this->assertSame('Jose', $commuterRow['first_name']);
        $this->assertSame('Dela Cruz', $commuterRow['middle_name']);
        $this->assertSame('Mendoza', $commuterRow['last_name']);
        $this->assertSame('Jr.', $commuterRow['suffix']);
        $this->assertSame('1998-05-12', $commuterRow['birthdate']);
        $this->assertSame('Male', $commuterRow['gender']);
        $this->assertSame('STUDENT', $commuterRow['applied_type']);
        $this->assertNull(collect($response->json('data.data'))->firstWhere('id', $admin->id)['id_image_url']);
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

    public function test_list_filters_commuters_by_type(): void
    {
        [, $headers] = $this->asAdmin();
        $this->makeConductor();
        $this->makeCommuter('regular@gmail.com');
        $student = $this->makeCommuter('student@gmail.com');
        $student->commuterProfile->update(['commuter_type' => 'STUDENT']);

        $response = $this->withHeaders($headers)->getJson('/api/v1/admin/users?role=COMMUTER&commuter_type=STUDENT');
        $response->assertOk();
        $this->assertSame([$student->id], array_column($response->json('data.data'), 'id'));

        // An unknown type is ignored rather than emptying the list.
        $this->withHeaders($headers)->getJson('/api/v1/admin/users?role=COMMUTER&commuter_type=BOGUS')
            ->assertOk()->assertJsonPath('data.total', 2);
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

    public function test_list_searches_by_full_name_across_name_columns(): void
    {
        [, $headers] = $this->asAdmin();
        $vice = $this->makeCommuter('vice@gmail.com');
        $vice->commuterProfile->update(['first_name' => 'Vice', 'middle_name' => 'Jose', 'surname' => 'Ganda']);
        $this->makeCommuter('other@gmail.com');
        $conductor = $this->makeConductor();

        $ids = fn (string $search) => collect(
            $this->withHeaders($headers)->getJson('/api/v1/admin/users?search='.urlencode($search))->assertOk()->json('data.data')
        )->pluck('id')->all();

        $this->assertSame([$vice->id], $ids('Vice'));
        $this->assertSame([$vice->id], $ids('vice ganda'));
        $this->assertSame([$vice->id], $ids('  Ganda   Vice '));
        $this->assertSame([$vice->id], $ids('Vice Jose Ganda'));
        $this->assertSame([], $ids('vice mendoza'));
        // A multi-word surname still matches as typed.
        $this->assertSame([$conductor->id], $ids('Juan Dela Cruz'));
    }

    public function test_list_leaves_out_the_signed_in_admin(): void
    {
        [$self, $headers] = $this->asAdmin();
        $other = $this->makeAdmin('other.admin@gmail.com');

        $response = $this->withHeaders($headers)->getJson('/api/v1/admin/users?role=ADMIN');

        $response->assertStatus(200);
        $this->assertEquals(1, $response->json('data.total'));
        $ids = collect($response->json('data.data'))->pluck('id');
        $this->assertTrue($ids->contains($other->id));
        $this->assertFalse($ids->contains($self->id));

        // The other admin's own view leaves them out and includes the first one.
        $otherHeaders = ['Authorization' => "Bearer {$this->tokenFor($other)}"];
        $this->app['auth']->forgetGuards();
        $otherIds = collect($this->withHeaders($otherHeaders)->getJson('/api/v1/admin/users?role=ADMIN')->json('data.data'))->pluck('id');
        $this->assertEquals([$self->id], $otherIds->all());
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
                'first_name' => ' mARÍA  jOSE ',
                'middle_name' => ' dELA  cRUZ ',
                'last_name'  => ' DE  lA  PEÑA ',
            ])
            ->assertStatus(200);

        $this->assertDatabaseHas('commuter_profiles', [
            'id'         => $commuter->id,
            'first_name' => 'María Jose',
            'middle_name' => 'Dela Cruz',
            'surname'    => 'De La Peña', // last_name maps to surname for commuters
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

    public function test_delete_self_is_refused_when_other_admins_exist(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $this->makeAdmin('admin2@gmail.com');

        $this->withHeaders($headers)
            ->deleteJson("/api/v1/admin/users/{$admin->id}")
            ->assertStatus(422)
            ->assertJsonPath('errors.user.0', 'You cannot delete your own account.');

        $this->assertNotSoftDeleted('users', ['id' => $admin->id]);
    }

    public function test_delete_last_admin_is_refused(): void
    {
        [$admin, $headers] = $this->asAdmin();

        $this->withHeaders($headers)
            ->deleteJson("/api/v1/admin/users/{$admin->id}")
            ->assertStatus(422)
            ->assertJsonPath('errors.user.0', 'Cannot delete the last administrator account.');

        $this->assertNotSoftDeleted('users', ['id' => $admin->id]);
    }

    public function test_suspend_self_is_refused(): void
    {
        [$admin, $headers] = $this->asAdmin();

        $this->withHeaders($headers)
            ->postJson("/api/v1/admin/users/{$admin->id}/suspend", [
                'reason_code' => 'POLICY_VIOLATION',
                'reason' => 'Testing self suspension',
                'is_permanent' => true,
            ])
            ->assertStatus(422)
            ->assertJsonPath('errors.user.0', 'You cannot suspend your own account.');
    }

    public function test_suspend_reason_shorter_than_five_characters_is_refused(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $commuter = $this->makeCommuter('short-reason@gmail.com');

        $this->withHeaders($headers)
            ->postJson("/api/v1/admin/users/{$commuter->id}/suspend", [
                'reason_code' => 'POLICY_VIOLATION',
                'reason' => 'bad',
                'is_permanent' => true,
            ])
            ->assertStatus(422)
            ->assertJsonValidationErrors(['reason']);

        $this->assertDatabaseHas('commuter_profiles', ['id' => $commuter->id, 'account_status' => 'ACTIVE']);
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

    // ── Conductors: Disable only, never suspended ──────────────────

    public function test_suspend_is_refused_for_a_conductor(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $conductor = $this->makeConductor();
        $this->tokenFor($conductor);

        $this->withHeaders($headers)
            ->postJson("/api/v1/admin/users/{$conductor->id}/suspend", [
                'reason_code' => 'POLICY_VIOLATION',
                'reason' => 'Should go through Disable Account instead.',
                'is_permanent' => true,
            ])
            ->assertStatus(422)
            ->assertJsonPath('errors.user.0', 'Conductors cannot be suspended. Use Disable Account instead.');

        $this->assertDatabaseMissing('user_suspensions', ['user_id' => $conductor->id]);
        $this->assertDatabaseHas('personal_access_tokens', ['tokenable_id' => $conductor->id]);
    }

    public function test_unsuspend_is_refused_for_a_conductor(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $conductor = $this->makeConductor();

        $this->withHeaders($headers)
            ->postJson("/api/v1/admin/users/{$conductor->id}/unsuspend")
            ->assertStatus(422)
            ->assertJsonPath('errors.user.0', 'A disabled conductor is re-enabled by resetting their credentials in Fleet Management.');
    }

    public function test_conductor_status_in_user_list_follows_disable_account(): void
    {
        [$admin, $headers] = $this->asAdmin();
        $active = $this->makeConductor('active-conductor@gmail.com');
        $disabled = $this->makeConductor('disabled-conductor@gmail.com');
        ConductorProfile::whereKey($disabled->id)->update(['status' => 'DISABLED']);

        $this->withHeaders($headers)->getJson("/api/v1/admin/users/{$active->id}")
            ->assertOk()->assertJsonPath('data.account_status', 'ACTIVE');
        $this->withHeaders($headers)->getJson("/api/v1/admin/users/{$disabled->id}")
            ->assertOk()->assertJsonPath('data.account_status', 'DISABLED')
            ->assertJsonPath('data.suspension', null);

        $blocked = $this->withHeaders($headers)
            ->getJson('/api/v1/admin/users?role=CONDUCTOR&account_status=SUSPENDED')
            ->assertOk();
        $this->assertSame([$disabled->id], array_column($blocked->json('data.data'), 'id'));

        $activeList = $this->withHeaders($headers)
            ->getJson('/api/v1/admin/users?role=CONDUCTOR&account_status=ACTIVE')
            ->assertOk();
        $this->assertSame([$active->id], array_column($activeList->json('data.data'), 'id'));
    }

    public function test_migration_converts_active_conductor_suspensions_to_disabled(): void
    {
        [$admin] = $this->asAdmin();
        $suspendedConductor = $this->makeConductor('legacy-suspended@gmail.com');
        $expiredConductor = $this->makeConductor('legacy-expired@gmail.com');
        $commuter = $this->makeCommuter('still-suspended@gmail.com');

        $suspend = fn (User $user, array $extra) => \App\Models\UserSuspension::create(array_merge([
            'user_id' => $user->id,
            'reason_code' => 'OTHER',
            'reason' => 'Legacy suspension',
            'starts_at' => now()->subDay(),
            'suspended_by' => $admin->id,
        ], $extra));
        $suspend($suspendedConductor, ['is_permanent' => true]);
        $suspend($expiredConductor, ['is_permanent' => false, 'ends_at' => now()->subHour()]);
        $suspend($commuter, ['is_permanent' => true]);

        (require database_path('migrations/2026_09_28_000001_convert_conductor_suspensions_to_disabled.php'))->up();

        $this->assertDatabaseHas('conductor_profiles', ['id' => $suspendedConductor->id, 'status' => 'DISABLED']);
        $this->assertDatabaseMissing('user_suspensions', ['user_id' => $suspendedConductor->id, 'lifted_at' => null]);
        // An already-expired suspension no longer blocks, so nothing to carry over.
        $this->assertDatabaseMissing('conductor_profiles', ['id' => $expiredConductor->id, 'status' => 'DISABLED']);
        // Commuter suspensions are untouched.
        $this->assertDatabaseHas('user_suspensions', ['user_id' => $commuter->id, 'lifted_at' => null]);
    }
}
