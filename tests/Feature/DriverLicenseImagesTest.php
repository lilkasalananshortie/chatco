<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\Driver;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class DriverLicenseImagesTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    private Driver $driver;

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('filesystems.uploads.private_id_disk', 'public');
        Storage::fake('public');

        $this->admin = User::create([
            'email' => 'license-admin@test.local',
            'password' => Hash::make('password123'),
            'role' => UserRole::ADMIN,
        ]);
        $this->driver = Driver::factory()->create();
    }

    public function test_admin_can_upload_view_and_remove_both_license_sides(): void
    {
        $response = $this->actingAs($this->admin)->post(
            "/api/v1/admin/drivers/{$this->driver->id}/license-images",
            [
                'front' => UploadedFile::fake()->image('license-front.jpg'),
                'back' => UploadedFile::fake()->image('license-back.jpg'),
            ],
        );

        $response->assertOk()
            ->assertJsonPath('data.id', $this->driver->id)
            ->assertJsonPath('data.license_front_image_url', fn ($value) => is_string($value))
            ->assertJsonPath('data.license_back_image_url', fn ($value) => is_string($value));

        $this->driver->refresh();
        $frontPath = $this->driver->license_front_image_url;
        Storage::disk('public')->assertExists($this->driver->license_front_image_url);
        Storage::disk('public')->assertExists($this->driver->license_back_image_url);

        $this->actingAs($this->admin)
            ->get("/api/v1/admin/drivers/{$this->driver->id}/license-images/front")
            ->assertOk()
            ->assertHeader('Content-Disposition', 'inline');

        $this->actingAs($this->admin)
            ->deleteJson("/api/v1/admin/drivers/{$this->driver->id}/license-images/front")
            ->assertOk();

        $this->driver->refresh();
        $this->assertNull($this->driver->license_front_image_url);
        Storage::disk('public')->assertMissing($frontPath);
    }

    public function test_non_admin_cannot_upload_driver_license_images(): void
    {
        $commuter = User::create([
            'email' => 'license-commuter@test.local',
            'password' => Hash::make('password123'),
            'role' => UserRole::COMMUTER,
        ]);

        $this->actingAs($commuter)
            ->post("/api/v1/admin/drivers/{$this->driver->id}/license-images", [
                'front' => UploadedFile::fake()->image('license-front.jpg'),
            ])
            ->assertForbidden();
    }
}
