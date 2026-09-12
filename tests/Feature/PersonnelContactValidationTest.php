<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Contact number must be exactly 11 digits starting with "09"
 * (AdminController::storeDriver/updateDriver/storeConductor/updateConductor).
 * Conductors previously had no contact field at all — this also covers that
 * the field now exists end-to-end (create → persist → show → update).
 */
class PersonnelContactValidationTest extends TestCase
{
    use RefreshDatabase;

    private function makeAdmin(): User
    {
        $admin = User::create([
            'email' => 'admin-contact@test.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create(['id' => $admin->id, 'first_name' => 'System', 'last_name' => 'Admin']);

        return $admin;
    }

    public static function invalidContactProvider(): array
    {
        return [
            'too short' => ['0917123456'],
            'too long' => ['091712345678'],
            'wrong prefix' => ['08171234567'],
            'contains letters' => ['0917123456a'],
            'international format' => ['+639171234567'],
            'empty' => [''],
        ];
    }

    // ─── Drivers ────────────────────────────────────────────────────

    /** @dataProvider invalidContactProvider */
    public function test_store_driver_rejects_invalid_contact(string $contact): void
    {
        $admin = $this->makeAdmin();

        $response = $this->actingAs($admin)->postJson('/api/v1/admin/drivers', [
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-01-01',
            'contact' => $contact,
            'license_number' => 'N01-23-045678',
        ]);

        $response->assertStatus(422)->assertJsonValidationErrors('contact');
    }

    public function test_store_driver_accepts_valid_contact(): void
    {
        $admin = $this->makeAdmin();

        $response = $this->actingAs($admin)->postJson('/api/v1/admin/drivers', [
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-01-01',
            'contact' => '09171234567',
            'address' => '123 Rizal St., Malolos, Bulacan',
            'emergency_contact_name' => 'Ana Dela Cruz',
            'emergency_contact_number' => '09189998888',
            'emergency_contact_relationship' => 'Spouse',
            'license_number' => 'N01-23-045678',
        ]);

        $response->assertCreated()->assertJsonPath('data.contact', '09171234567');
    }

    public function test_update_driver_rejects_invalid_contact(): void
    {
        $admin = $this->makeAdmin();
        $driver = Driver::create([
            'first_name' => 'Juan', 'last_name' => 'Dela Cruz', 'birthday' => '1990-01-01',
            'contact' => '09171234567', 'license_number' => 'N01-23-045678',
            'hire_date' => now()->toDateString(), 'status' => 'ACTIVE',
        ]);

        $response = $this->actingAs($admin)->putJson("/api/v1/admin/drivers/{$driver->id}", [
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-01-01',
            'contact' => '12345',
            'license_number' => 'N01-23-045678',
        ]);

        $response->assertStatus(422)->assertJsonValidationErrors('contact');
    }

    // ─── Conductors ─────────────────────────────────────────────────

    /** @dataProvider invalidContactProvider */
    public function test_store_conductor_rejects_invalid_contact(string $contact): void
    {
        $admin = $this->makeAdmin();

        $response = $this->actingAs($admin)->postJson('/api/v1/admin/conductors', [
            'first_name' => 'Maria',
            'last_name' => 'Santos',
            'birthday' => '1992-03-15',
            'contact' => $contact,
        ]);

        $response->assertStatus(422)->assertJsonValidationErrors('contact');
    }

    public function test_store_conductor_accepts_valid_contact_and_persists_it(): void
    {
        $admin = $this->makeAdmin();

        $response = $this->actingAs($admin)->postJson('/api/v1/admin/conductors', [
            'first_name' => 'Maria',
            'last_name' => 'Santos',
            'birthday' => '1992-03-15',
            'contact' => '09181234567',
            'address' => '123 Rizal St., Malolos, Bulacan',
            'emergency_contact_name' => 'Jose Santos',
            'emergency_contact_number' => '09189998888',
            'emergency_contact_relationship' => 'Parent',
        ]);

        $response->assertCreated();
        $conductorId = $response->json('data.id');

        $this->assertDatabaseHas('conductor_profiles', [
            'id' => $conductorId,
            'contact' => '09181234567',
        ]);

        // Round-trips through the show endpoint (used to prefill the edit modal).
        $this->actingAs($admin)->getJson("/api/v1/admin/conductors/{$conductorId}")
            ->assertOk()
            ->assertJsonPath('data.contact', '09181234567');
    }

    public function test_update_conductor_requires_valid_contact(): void
    {
        $admin = $this->makeAdmin();
        $user = User::create([
            'email' => 'conductor-contact@test.com', 'password' => Hash::make('password123'), 'role' => UserRole::CONDUCTOR,
        ]);
        $conductor = ConductorProfile::create([
            'id' => $user->id, 'first_name' => 'Maria', 'last_name' => 'Santos', 'birthday' => '1992-03-15',
            'generated_username' => 'm.santos', 'generated_password' => Hash::make('password123'),
        ]);

        $invalid = $this->actingAs($admin)->putJson("/api/v1/admin/conductors/{$conductor->id}", [
            'first_name' => 'Maria',
            'last_name' => 'Santos',
            'birthday' => '1992-03-15',
            'contact' => 'not-a-number',
        ]);
        $invalid->assertStatus(422)->assertJsonValidationErrors('contact');

        $valid = $this->actingAs($admin)->putJson("/api/v1/admin/conductors/{$conductor->id}", [
            'first_name' => 'Maria',
            'last_name' => 'Santos',
            'birthday' => '1992-03-15',
            'contact' => '09201234567',
        ]);
        $valid->assertOk();
        $this->assertDatabaseHas('conductor_profiles', [
            'id' => $conductor->id,
            'contact' => '09201234567',
        ]);
    }
}
