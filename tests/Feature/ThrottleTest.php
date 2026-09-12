<?php

namespace Tests\Feature;

use App\Models\Driver;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

/**
 * Sprint 2 hardening — per-route rate limiting.
 *
 * Verifies that the throttle middleware on the conductor GPS endpoint
 * (POST /api/conductor/location, limit 30 req/min) returns 429 with the
 * project's ApiResponse JSON envelope once the limit is exceeded.
 *
 * Notes on test environment:
 *   - phpunit.xml sets CACHE_STORE=array. The ArrayStore is a singleton
 *     bound in the container, so rate-limiter attempts accumulate across
 *     requests issued within a single test method — which is exactly what
 *     we need to trigger the limit without waiting real wall-clock time.
 *   - Cache::flush() is called in setUp() to prevent cross-test
 *     contamination, since RefreshDatabase only resets the DB, not the
 *     cache.
 */
class ThrottleTest extends TestCase
{
    use RefreshDatabase;

    private User $conductor;
    private Vehicle $vehicle;
    private Driver $driver;
    private Route $route;
    private ShiftLog $shift;

    protected function setUp(): void
    {
        parent::setUp();

        // Flush the rate-limiter cache between tests so prior test runs
        // don't leave residual attempt counts that would make this test
        // flaky.
        Cache::flush();

        $this->conductor = User::factory()->conductor()->create();
        $this->vehicle = Vehicle::factory()->create();
        $this->driver = Driver::factory()->create();
        $this->route = Route::factory()->create();

        $this->shift = ShiftLog::create([
            'shift_id' => 'SFT-' . now()->format('YmdHis'),
            'conductor_id' => $this->conductor->id,
            'driver_id' => $this->driver->id,
            'vehicle_id' => $this->vehicle->id,
            'route_id' => $this->route->id,
            'conductor_name' => 'Conductor Test',
            'driver_name' => $this->driver->first_name . ' ' . $this->driver->last_name,
            'plate_number' => $this->vehicle->plate_number,
            'unit_number' => $this->vehicle->unit_number,
            'time_in' => now(),
            'status' => 'ACTIVE',
        ]);

        $this->vehicle->update(['active_shift_id' => $this->shift->shift_id]);
        $this->driver->update(['active_shift_id' => $this->shift->shift_id]);
    }

    /**
     * The GPS location endpoint is limited to 30 requests per minute.
     * The first 30 requests must succeed; the 31st must return 429.
     */
    public function test_location_endpoint_is_rate_limited_after_30_requests(): void
    {
        $payload = ['lat' => 14.5995, 'lng' => 120.9842];

        // Send exactly 30 requests — the configured limit. All should pass.
        for ($i = 0; $i < 30; $i++) {
            $this->actingAs($this->conductor)
                ->postJson('/api/v1/conductor/location', $payload)
                ->assertOk();
        }

        // 31st request — exceeds the limit, must be rejected with 429.
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', $payload);

        $response->assertStatus(429);
    }

    /**
     * The 429 response must use the project's ApiResponse JSON envelope
     * (success / data / message / errors / meta), not Laravel's default
     * HTML exception page. The frontend relies on this shape to surface
     * rate-limit errors gracefully.
     */
    public function test_throttle_429_response_uses_api_envelope(): void
    {
        $payload = ['lat' => 14.5995, 'lng' => 120.9842];

        // Exhaust the 30-request limit.
        for ($i = 0; $i < 30; $i++) {
            $this->actingAs($this->conductor)
                ->postJson('/api/v1/conductor/location', $payload)
                ->assertOk();
        }

        // Trigger the 429 and inspect the body shape.
        $response = $this->actingAs($this->conductor)
            ->postJson('/api/v1/conductor/location', $payload);

        $response->assertStatus(429);
        $response->assertJsonStructure([
            'success',
            'data',
            'message',
            'errors',
            'meta',
        ]);
        $response->assertJson([
            'success' => false,
            'data'    => null,
            'errors'  => null,
            'meta'    => null,
        ]);
        $this->assertNotEmpty($response->json('message'));
    }

    /**
     * Normal conductor usage — one GPS update every 5 seconds, i.e. 12
     * requests per minute — must never trip the rate limiter. This guards
     * against the limit being set too aggressively for real-world use.
     */
    public function test_normal_cadence_does_not_trip_rate_limiter(): void
    {
        $payload = ['lat' => 14.5995, 'lng' => 120.9842];

        // 12 requests = one update every 5s for one minute. Well within
        // the 30 req/min limit.
        for ($i = 0; $i < 12; $i++) {
            $this->actingAs($this->conductor)
                ->postJson('/api/v1/conductor/location', $payload)
                ->assertOk();
        }
    }
}
