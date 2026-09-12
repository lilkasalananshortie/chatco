<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\AdminProfile;
use App\Models\ConductorProfile;
use App\Models\Driver;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class PersonnelImageUploadTest extends TestCase
{
    use RefreshDatabase;

    private function admin(): User
    {
        $admin = User::create([
            'email' => 'media-admin@example.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);
        AdminProfile::create([
            'id' => $admin->id,
            'first_name' => 'Media',
            'last_name' => 'Admin',
        ]);

        return $admin;
    }

    public function test_driver_photo_is_stored_in_the_profile_prefix(): void
    {
        Storage::fake('public');
        $admin = $this->admin();

        $response = $this->actingAs($admin)->withHeaders(['Accept' => 'application/json'])->post('/api/v1/admin/drivers', [
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-01-01',
            'contact' => '09171234567',
            'address' => '123 Rizal St., Malolos, Bulacan',
            'emergency_contact_name' => 'Ana Dela Cruz',
            'emergency_contact_number' => '09189998888',
            'emergency_contact_relationship' => 'Spouse',
            'license_number' => 'N01-23-045678',
            'profile_picture' => UploadedFile::fake()->image('driver.jpg'),
        ]);

        $response->assertCreated();
        $driver = Driver::firstOrFail();
        $this->assertStringContainsString("profiles/drivers/{$driver->id}/", $driver->profile_picture_url);
        Storage::disk('public')->assertExists($this->pathFromUrl($driver->profile_picture_url));
    }

    public function test_conductor_photo_is_stored_in_the_profile_prefix(): void
    {
        Storage::fake('public');
        $admin = $this->admin();

        $response = $this->actingAs($admin)->post('/api/v1/admin/conductors', [
            'first_name' => 'Maria',
            'last_name' => 'Santos',
            'birthday' => '1992-03-15',
            'contact' => '09181234567',
            'address' => '123 Rizal St., Malolos, Bulacan',
            'emergency_contact_name' => 'Jose Santos',
            'emergency_contact_number' => '09189998888',
            'emergency_contact_relationship' => 'Parent',
            'profile_picture' => UploadedFile::fake()->image('conductor.jpg'),
        ]);

        $response->assertCreated();
        $conductor = ConductorProfile::firstOrFail();
        $this->assertStringContainsString("profiles/conductors/{$conductor->id}/", $conductor->profile_picture_url);
        Storage::disk('public')->assertExists($this->pathFromUrl($conductor->profile_picture_url));
    }

    public function test_replacing_a_personnel_photo_removes_the_old_object(): void
    {
        Storage::fake('public');
        $admin = $this->admin();
        $driver = Driver::create([
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-01-01',
            'contact' => '09171234567',
            'license_number' => 'N01-23-045678',
            'hire_date' => now()->toDateString(),
            'status' => 'ACTIVE',
            'profile_picture_url' => Storage::disk('public')->url('profiles/drivers/old.jpg'),
        ]);
        Storage::disk('public')->put('profiles/drivers/old.jpg', 'old');

        $response = $this->actingAs($admin)->put("/api/v1/admin/drivers/{$driver->id}", [
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-01-01',
            'contact' => '09171234567',
            'license_number' => 'N01-23-045678',
            'profile_picture' => UploadedFile::fake()->image('new.jpg'),
        ]);

        $response->assertOk();
        $driver->refresh();
        Storage::disk('public')->assertMissing('profiles/drivers/old.jpg');
        Storage::disk('public')->assertExists($this->pathFromUrl($driver->profile_picture_url));
    }

    public function test_profile_photo_rejects_non_image_files(): void
    {
        Storage::fake('public');
        $admin = $this->admin();

        $response = $this->actingAs($admin)->withHeaders(['Accept' => 'application/json'])->post('/api/v1/admin/drivers', [
            'first_name' => 'Juan',
            'last_name' => 'Dela Cruz',
            'birthday' => '1990-01-01',
            'contact' => '09171234567',
            'license_number' => 'N01-23-045678',
            'profile_picture' => UploadedFile::fake()->create('document.pdf', 100, 'application/pdf'),
        ]);

        $response->assertStatus(422)->assertJsonValidationErrors('profile_picture');
    }

    private function pathFromUrl(?string $url): string
    {
        $path = ltrim((string) parse_url((string) $url, PHP_URL_PATH), '/');

        return str_starts_with($path, 'storage/') ? substr($path, 8) : $path;
    }
}
