<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\User;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class RoleMiddlewareTest extends TestCase
{
    use RefreshDatabase;

    private function createUserWithProfile(string $email, UserRole $role): User
    {
        $user = User::create([
            'email'    => $email,
            'password' => Hash::make('password123'),
            'role'     => $role,
        ]);

        match ($role) {
            UserRole::ADMIN => AdminProfile::create([
                'id'         => $user->id,
                'first_name' => 'Admin',
                'last_name'  => 'User',
            ]),
            UserRole::CONDUCTOR => ConductorProfile::create([
                'id'                 => $user->id,
                'first_name'         => 'Conductor',
                'last_name'          => 'User',
                'birthday'           => '1990-01-01',
                'generated_username' => 'conductor_test',
                'generated_password' => Hash::make('password123'),
            ]),
            UserRole::COMMUTER => CommuterProfile::create([
                'id'                  => $user->id,
                'first_name'          => 'Commuter',
                'surname'             => 'User',
                'birthdate'           => '1995-01-01',
                'gender'              => 'Male',
                'email'               => $email,
                'contact_number'      => '+639170000000',
                'commuter_type'       => 'Regular',
                'username'            => 'commuter_test',
                'language_preference' => 'en',
                'account_status'      => 'ACTIVE',
                'verified_at'         => now(),
            ]),
        };

        return $user;
    }

    private function authToken(User $user): string
    {
        return $user->createToken('test')->plainTextToken;
    }

    // ── Admin Role Tests ─────────────────────────────────────────

    public function test_admin_can_access_admin_dashboard_and_gets_200(): void
    {
        $admin = $this->createUserWithProfile('admin@test.com', UserRole::ADMIN);

        $response = $this->withHeader('Authorization', "Bearer {$this->authToken($admin)}")
            ->getJson('/api/v1/admin/dashboard');

        $response->assertOk()->assertJsonPath('success', true);
    }

    public function test_admin_cannot_access_commuter_profile_and_gets_403(): void
    {
        $admin = $this->createUserWithProfile('admin@test.com', UserRole::ADMIN);

        $response = $this->withHeader('Authorization', "Bearer {$this->authToken($admin)}")
            ->getJson('/api/v1/commuter/profile');

        $response->assertStatus(403);
    }

    // ── Commuter Role Tests ──────────────────────────────────────

    public function test_commuter_can_access_own_profile(): void
    {
        $commuter = $this->createUserWithProfile('commuter@test.com', UserRole::COMMUTER);

        $response = $this->withHeader('Authorization', "Bearer {$this->authToken($commuter)}")
            ->getJson('/api/v1/commuter/profile');

        // Profile is implemented (S5-T1): a commuter reaching their own
        // profile route should get 200 with role-scoped data.
        $response->assertStatus(200);
        $response->assertJsonPath('success', true);
        $response->assertJsonPath('data.user.role', 'COMMUTER');
    }

    public function test_commuter_cannot_access_admin_dashboard_and_gets_403(): void
    {
        $commuter = $this->createUserWithProfile('commuter@test.com', UserRole::COMMUTER);

        $response = $this->withHeader('Authorization', "Bearer {$this->authToken($commuter)}")
            ->getJson('/api/v1/admin/dashboard');

        $response->assertStatus(403);
    }

    // ── Conductor Role Tests ─────────────────────────────────────

    public function test_conductor_can_access_shift_and_gets_200(): void
    {
        // Sprint 2 implemented GET /api/conductor/shift — it now returns
        // 200 with null data when the conductor has no active shift,
        // instead of the Sprint 1 501 stub.
        $conductor = $this->createUserWithProfile('conductor@test.com', UserRole::CONDUCTOR);

        $response = $this->withHeader('Authorization', "Bearer {$this->authToken($conductor)}")
            ->getJson('/api/v1/conductor/shift');

        $response->assertStatus(200);
    }

    public function test_conductor_cannot_access_admin_dashboard_and_gets_403(): void
    {
        $conductor = $this->createUserWithProfile('conductor@test.com', UserRole::CONDUCTOR);

        $response = $this->withHeader('Authorization', "Bearer {$this->authToken($conductor)}")
            ->getJson('/api/v1/admin/dashboard');

        $response->assertStatus(403);
    }

    // ── Unauthenticated Tests ────────────────────────────────────

    public function test_unauthenticated_request_to_protected_route_returns_401(): void
    {
        $response = $this->getJson('/api/v1/admin/dashboard');

        $response->assertStatus(401);
    }

    public function test_unauthenticated_request_to_commuter_route_returns_401(): void
    {
        $response = $this->getJson('/api/v1/commuter/profile');

        $response->assertStatus(401);
    }

    public function test_unauthenticated_request_to_conductor_route_returns_401(): void
    {
        $response = $this->getJson('/api/v1/conductor/shift');

        $response->assertStatus(401);
    }
}
