<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Models\CommuterProfile;
use App\Models\Hail;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class MobileCommuterIsolationTest extends TestCase
{
    use RefreshDatabase;

    private User $commuter;
    private User $conductor;

    public function test_mobile_share_uses_frontend_url_and_updates_the_same_link(): void
    {
        config(['app.frontend_url' => 'https://viewer.chatco.test']);
        Sanctum::actingAs($this->commuter);
        $created = $this->postJson('/api/v1/mobile/commuter/share-ride', ['lat' => 14.8, 'lng' => 120.9])->assertCreated();
        $token = $created->json('data.token');
        $this->assertSame('https://viewer.chatco.test/share/'.$token, $created->json('data.share_url'));
        $this->postJson('/api/v1/mobile/commuter/share-ride', ['token' => $token, 'lat' => 14.81, 'lng' => 120.91])
            ->assertOk()->assertJsonPath('data.token', $token);
        $this->assertSame(1, \App\Models\SharedRideLink::count());
        $this->assertEquals(14.81, \App\Models\SharedRideLink::first()->lat);
    }

    public function test_public_share_returns_profile_photo_only_while_link_is_live(): void
    {
        Sanctum::actingAs($this->commuter);
        $token = $this->postJson('/api/v1/mobile/commuter/share-ride')->assertCreated()->json('data.token');

        $this->getJson('/api/v1/share/'.$token)->assertOk()
            ->assertJsonPath('data.commuter_profile_image_url', null);

        CommuterProfile::query()->update(['profile_image_url' => 'https://r2.example.test/profiles/a.webp']);
        $this->getJson('/api/v1/share/'.$token)->assertOk()
            ->assertJsonPath('data.commuter_profile_image_url', 'https://r2.example.test/profiles/a.webp');

        \App\Models\SharedRideLink::query()->update(['expires_at' => now()->subMinute()]);
        $this->getJson('/api/v1/share/'.$token)->assertOk()
            ->assertJsonMissingPath('data.commuter_profile_image_url');
    }

    public function test_public_share_hides_location_for_invalid_revoked_and_expired_links(): void
    {
        Sanctum::actingAs($this->commuter);
        $token = $this->postJson('/api/v1/mobile/commuter/share-ride', ['lat' => 14.8, 'lng' => 120.9])
            ->assertCreated()->json('data.token');

        $live = $this->getJson('/api/v1/share/'.$token)->assertOk()
            ->assertJsonPath('data.active', true)
            ->assertJsonPath('data.lat', 14.8)
            ->assertJsonPath('data.seconds_since_update', 0);
        $this->assertStringContainsString('no-store', $live->headers->get('Cache-Control'));

        $this->getJson('/api/v1/share/trk_doesnotexist')->assertNotFound()->assertJsonMissingPath('data.lat');

        $this->deleteJson('/api/v1/mobile/commuter/share-ride')->assertOk();
        $this->getJson('/api/v1/share/'.$token)->assertOk()
            ->assertJsonPath('data.active', false)
            ->assertJsonMissingPath('data.lat')
            ->assertJsonMissingPath('data.lng');

        \App\Models\SharedRideLink::query()->update(['is_active' => true, 'expires_at' => now()->subMinute()]);
        $this->getJson('/api/v1/share/'.$token)->assertOk()
            ->assertJsonPath('data.expired', true)
            ->assertJsonMissingPath('data.lat');
    }

    public function test_public_share_reports_position_age_from_server_clock(): void
    {
        Sanctum::actingAs($this->commuter);
        $token = $this->postJson('/api/v1/mobile/commuter/share-ride', ['lat' => 14.8, 'lng' => 120.9])
            ->assertCreated()->json('data.token');
        \App\Models\SharedRideLink::query()->update(['last_updated_at' => now()->subSeconds(95)]);

        $age = $this->getJson('/api/v1/share/'.$token)->assertOk()->json('data.seconds_since_update');
        $this->assertGreaterThanOrEqual(95, $age);
        $this->assertLessThan(100, $age);
    }

    public function test_share_position_pushes_have_their_own_rate_limit(): void
    {
        Sanctum::actingAs($this->commuter);
        $token = $this->postJson('/api/v1/mobile/commuter/share-ride')->assertCreated()->json('data.token');

        // 15 pushes in a minute (a moving commuter on the 4s cadence) all land;
        // they used to share commuter-hail's 10/min and get rejected.
        for ($i = 0; $i < 15; $i++) {
            $this->postJson('/api/v1/mobile/commuter/share-ride', ['token' => $token, 'lat' => 14.8, 'lng' => 120.9 + $i / 10000])
                ->assertOk();
        }

        // ...and they count against the share bucket, leaving the hail bucket untouched.
        $this->assertSame(16, \Illuminate\Support\Facades\RateLimiter::attempts(
            md5('share-ride-update'.$this->commuter->id)
        ));
        $this->assertSame(0, \Illuminate\Support\Facades\RateLimiter::attempts(
            md5('commuter-hail'.$this->commuter->id)
        ));
    }

    public function test_logout_expires_the_commuters_share_link(): void
    {
        $session = $this->commuter->createToken('auth-token')->plainTextToken;
        $token = $this->withToken($session)->postJson('/api/v1/commuter/share-ride', ['lat' => 14.8, 'lng' => 120.9])
            ->assertCreated()->json('data.token');

        $this->withToken($session)->postJson('/api/v1/auth/logout')->assertOk();
        $this->app['auth']->forgetGuards();

        $this->getJson('/api/v1/share/'.$token)->assertOk()
            ->assertJsonPath('data.expired', true)
            ->assertJsonMissingPath('data.lat');
    }

    public function test_inflight_mobile_share_update_cannot_resurrect_stopped_or_expired_link(): void
    {
        Sanctum::actingAs($this->commuter);
        $token = $this->postJson('/api/v1/mobile/commuter/share-ride')->assertCreated()->json('data.token');
        $this->deleteJson('/api/v1/mobile/commuter/share-ride')->assertOk();
        $this->postJson('/api/v1/mobile/commuter/share-ride', ['token' => $token, 'lat' => 14.8, 'lng' => 120.9])->assertStatus(409);
        $this->assertSame(0, \App\Models\SharedRideLink::where('is_active', true)->count());
        $this->assertSame(1, \App\Models\SharedRideLink::count());
        \App\Models\SharedRideLink::query()->update(['is_active' => true, 'expires_at' => now()->subMinute()]);
        $this->postJson('/api/v1/mobile/commuter/share-ride', ['token' => $token, 'lat' => 14.8, 'lng' => 120.9])->assertStatus(409);
        $this->assertSame(1, \App\Models\SharedRideLink::count());
    }

    public function test_mobile_email_change_rejects_conductor_role(): void
    {
        Sanctum::actingAs($this->conductor);
        $this->postJson('/api/v1/mobile/commuter/change-email/start')->assertForbidden();
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->commuter = User::create([
            'email' => 'commuter_mobile@example.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::COMMUTER,
        ]);

        CommuterProfile::create([
            'id' => $this->commuter->id,
            'first_name' => 'Maria',
            'surname' => 'Santos',
            'birthdate' => '1995-03-15',
            'gender' => 'Female',
            'email' => 'commuter_mobile@example.com',
            'contact_number' => '+639181234567',
            'commuter_type' => 'Regular',
            'username' => 'mariasantos',
            'language_preference' => 'en',
            'account_status' => 'ACTIVE',
            'verified_at' => now(),
        ]);

        $this->conductor = User::create([
            'email' => 'conductor_mobile@example.com',
            'password' => Hash::make('password123'),
            'role' => UserRole::CONDUCTOR,
        ]);
    }

    public function test_mobile_and_web_commuter_login_share_account_without_revoking_other_platform(): void
    {
        $web = $this->postJson('/api/v1/auth/login', [
            'login' => $this->commuter->email, 'password' => 'password123',
            'device_id' => 'commuter-web-device-12345', 'device_type' => 'WEB',
        ])->assertOk();
        $mobile = $this->postJson('/api/v1/mobile/auth/login', [
            'login' => $this->commuter->email, 'password' => 'password123',
            'device_id' => 'commuter-mobile-device-12345',
        ])->assertOk();
        $this->assertSame($web->json('data.id'), $mobile->json('data.id'));
        $this->assertSame(2, $this->commuter->tokens()->count());
        $this->assertSame(1, $this->commuter->tokens()->where('name', 'auth-token:WEB')->count());
        $this->assertSame(1, $this->commuter->tokens()->where('name', 'auth-token:MOBILE')->count());

        Sanctum::actingAs($this->commuter);
        $webProfile = $this->getJson('/api/v1/commuter/profile')->assertOk()->json('data');
        $mobileProfile = $this->getJson('/api/v1/mobile/commuter/profile')->assertOk()->json('data');
        $this->assertSame($webProfile, $mobileProfile);
        $this->assertSame(
            $this->getJson('/api/v1/commuter/rewards')->assertOk()->json('data'),
            $this->getJson('/api/v1/mobile/commuter/rewards')->assertOk()->json('data'),
        );
    }

    public function test_mobile_hail_reads_are_owned_and_report_expiration(): void
    {
        $vehicle = Vehicle::create(['unit_number' => 'MOBILE-1', 'plate_number' => 'MOB-001', 'status' => 'ACTIVE']);
        $hail = Hail::create([
            'commuter_id' => $this->commuter->id, 'vehicle_id' => $vehicle->id,
            'commuter_lat' => 14.8, 'commuter_lng' => 120.9, 'distance_m' => 10,
            'status' => 'PENDING', 'expires_at' => now()->addMinutes(3),
        ]);
        Sanctum::actingAs($this->commuter);
        $this->getJson("/api/v1/mobile/commuter/hail/{$hail->id}")
            ->assertOk()->assertJsonPath('data.status', 'PENDING')->assertJsonPath('data.vehicle.unit_number', 'MOBILE-1');
        $this->getJson('/api/v1/mobile/commuter/hails/active')->assertOk()->assertJsonPath('data.id', $hail->id);

        $this->travel(4)->minutes();
        $this->getJson("/api/v1/mobile/commuter/hail/{$hail->id}")->assertOk()->assertJsonPath('data.status', 'EXPIRED');
        $this->getJson('/api/v1/mobile/commuter/hails/active')->assertOk()->assertJsonPath('data', null);
        $this->travelBack();

        $other = User::create(['email' => 'other-commuter-mobile@example.com', 'password' => bcrypt('password'), 'role' => UserRole::COMMUTER]);
        Sanctum::actingAs($other);
        $this->getJson("/api/v1/mobile/commuter/hail/{$hail->id}")->assertNotFound();
        $this->getJson('/api/v1/mobile/commuter/hails/active')->assertOk()->assertJsonPath('data', null);
    }

    public function test_mobile_commuter_routes_require_authentication(): void
    {
        $this->getJson('/api/v1/mobile/commuter/vouchers?status=available')->assertUnauthorized();
        $this->getJson('/api/v1/mobile/commuter/profile')->assertUnauthorized();
        $this->getJson('/api/v1/mobile/commuter/trips')->assertUnauthorized();
        $this->getJson('/api/v1/mobile/commuter/rewards')->assertUnauthorized();
    }

    public function test_mobile_commuter_routes_reject_non_commuter_roles(): void
    {
        Sanctum::actingAs($this->conductor);

        $this->getJson('/api/v1/mobile/commuter/vouchers?status=available')->assertForbidden();
        $this->getJson('/api/v1/mobile/commuter/profile')->assertForbidden();
        $this->getJson('/api/v1/mobile/commuter/trips')->assertForbidden();
        $this->getJson('/api/v1/mobile/commuter/rewards')->assertForbidden();
    }

    public function test_mobile_commuter_routes_allow_authenticated_commuter(): void
    {
        Sanctum::actingAs($this->commuter);

        $res = $this->getJson('/api/v1/mobile/commuter/profile')->assertOk();
        $this->assertSame('Maria', $res->json('data.profile.first_name'));

        $this->getJson('/api/v1/mobile/commuter/trips')->assertOk();
        $this->getJson('/api/v1/mobile/commuter/rewards')->assertOk();
        $this->getJson('/api/v1/mobile/commuter/watchlist')->assertOk();
        $this->getJson('/api/v1/mobile/commuter/claims')->assertOk();
        $this->getJson('/api/v1/mobile/commuter/announcements')->assertOk();
    }

    public function test_legacy_web_commuter_routes_remain_intact(): void
    {
        Sanctum::actingAs($this->commuter);

        $res = $this->getJson('/api/v1/commuter/profile')->assertOk();
        $this->assertSame('Maria', $res->json('data.profile.first_name'));
        $this->getJson('/api/v1/commuter/trips')->assertOk();
        $this->getJson('/api/v1/commuter/rewards')->assertOk();
    }
}
