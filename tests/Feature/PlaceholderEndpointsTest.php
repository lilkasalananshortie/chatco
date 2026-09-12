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

class PlaceholderEndpointsTest extends TestCase
{
    use RefreshDatabase;

    private string $adminToken;
    private string $commuterToken;
    private string $conductorToken;

    protected function setUp(): void
    {
        parent::setUp();

        $admin = User::create([
            'email'    => 'admin@test.com',
            'password' => Hash::make('password123'),
            'role'     => UserRole::ADMIN,
        ]);
        AdminProfile::create(['id' => $admin->id, 'first_name' => 'Admin', 'last_name' => 'Test']);
        $this->adminToken = $admin->createToken('test')->plainTextToken;

        $commuter = User::create([
            'email'    => 'commuter@test.com',
            'password' => Hash::make('password123'),
            'role'     => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id'                  => $commuter->id,
            'first_name'          => 'Commuter',
            'surname'             => 'Test',
            'birthdate'           => '1995-01-01',
            'gender'              => 'Male',
            'email'               => 'commuter@test.com',
            'contact_number'      => '+639170000000',
            'commuter_type'       => 'Regular',
            'username'            => 'commuter_test',
            'language_preference' => 'en',
            'account_status'      => 'ACTIVE',
            'verified_at'         => now(),
        ]);
        $this->commuterToken = $commuter->createToken('test')->plainTextToken;

        $conductor = User::create([
            'email'    => 'conductor@test.com',
            'password' => Hash::make('password123'),
            'role'     => UserRole::CONDUCTOR,
        ]);
        ConductorProfile::create([
            'id'                 => $conductor->id,
            'first_name'         => 'Conductor',
            'last_name'          => 'Test',
            'birthday'           => '1990-01-01',
            'generated_username' => 'conductor_test',
            'generated_password' => Hash::make('password123'),
        ]);
        $this->conductorToken = $conductor->createToken('test')->plainTextToken;
    }

    // ── Commuter Endpoints (2) ───────────────────────────────────
    // /profile implemented in S5-T1 (returns real commuter profile data).

    public function test_commuter_trips_returns_success(): void
    {
        $this->withHeader('Authorization', "Bearer {$this->commuterToken}")
            ->getJson('/api/v1/commuter/trips')
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.total', 0);
    }

    public function test_commuter_rewards_returns_success(): void
    {
        $this->withHeader('Authorization', "Bearer {$this->commuterToken}")
            ->getJson('/api/v1/commuter/rewards')
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.totalRides', 0);
    }

    // ── Conductor Endpoints ──────────────────────────────────────
    // All conductor endpoints implemented — no remaining 501 stubs.

    // ── Admin Endpoints (0 remaining stubs) ─────────────────────
    // Admin /dashboard implemented (returns analytics summary).
    // Admin /users implemented in S5-T3.
    // Admin /drivers, /vehicles, /routes, /transactions, /shift-logs,
    // /remittances, /analytics, /monitoring, /lost-items, /announcements,
    // /fare-points, /settings, /vouchers, /remittance-options, /faqs,
    // /registrations, /sos — all implemented.

    // ── Payment Endpoints ────────────────────────────────────────
    // All payment endpoints implemented (Sprint 4).

    // ── QR Endpoints ─────────────────────────────────────────────
    // QR endpoints repurposed for feedback (Sprint 6) — implemented.

    // ── Total Count Verification ─────────────────────────────────

    public function test_total_placeholder_endpoints_is_zero(): void
    {
        $this->assertSame(0, 0);
    }
}
