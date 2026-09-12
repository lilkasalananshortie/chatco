<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\CommuterLocation;
use App\Models\CommuterProfile;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class CommuterLocationTest extends TestCase
{
    use RefreshDatabase;

    public function test_commuter_can_update_latest_location(): void
    {
        $commuter = $this->createCommuter('commuter@test.com');

        $this->actingAs($commuter)
            ->postJson('/api/v1/commuter/location', [
                'latitude' => 14.8521,
                'longitude' => 120.8160,
                'accuracy' => 12.5,
            ])
            ->assertOk()
            ->assertJsonPath('success', true);

        $this->assertDatabaseHas('commuter_locations', [
            'commuter_id' => $commuter->id,
            'latitude' => 14.8521,
            'longitude' => 120.8160,
        ]);
    }

    public function test_admin_receives_recent_locations_as_aggregated_demand_zones(): void
    {
        $commuter = $this->createCommuter('zone@test.com');
        CommuterLocation::create([
            'commuter_id' => $commuter->id,
            'latitude' => 14.8521,
            'longitude' => 120.8160,
        ]);

        $admin = User::create([
            'email' => 'admin@test.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create([
            'id' => $admin->id,
            'first_name' => 'Admin',
            'last_name' => 'Test',
        ]);

        $this->actingAs($admin)
            ->getJson('/api/v1/admin/monitoring/demand-zones')
            ->assertOk()
            ->assertJsonPath('data.0.commuter_count', 1)
            ->assertJsonPath('data.0.intensity', 'LOW');
    }

    private function createCommuter(string $email): User
    {
        $user = User::create([
            'email' => $email,
            'password' => Hash::make('password123'),
            'role' => UserRole::COMMUTER,
        ]);
        CommuterProfile::create([
            'id' => $user->id,
            'first_name' => 'Test',
            'surname' => 'Commuter',
            'birthdate' => '1995-01-01',
            'gender' => 'Male',
            'email' => $email,
            'contact_number' => '+639170000001',
            'commuter_type' => 'Regular',
            'username' => 'commuter_'.substr(md5($email), 0, 8),
            'language_preference' => 'en',
            'account_status' => 'ACTIVE',
            'verified_at' => now(),
        ]);

        return $user;
    }
}
