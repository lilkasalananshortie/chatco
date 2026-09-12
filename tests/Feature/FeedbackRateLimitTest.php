<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class FeedbackRateLimitTest extends TestCase
{
    use RefreshDatabase;

    private User $commuter;

    protected function setUp(): void
    {
        parent::setUp();

        Cache::flush();
        $this->commuter = User::factory()->commuter()->create();
    }

    public function test_feedback_submission_has_a_dedicated_five_per_minute_limit(): void
    {
        for ($attempt = 1; $attempt <= 5; $attempt++) {
            $this->actingAs($this->commuter)
                ->postJson('/api/v1/commuter/feedback', [])
                ->assertStatus(422);
        }

        $this->actingAs($this->commuter)
            ->postJson('/api/v1/commuter/feedback', [])
            ->assertStatus(429)
            ->assertExactJson([
                'success' => false,
                'data' => null,
                'message' => 'Too many requests. Please slow down.',
                'errors' => null,
                'meta' => null,
            ]);
    }

    public function test_feedback_limit_is_keyed_per_user(): void
    {
        for ($attempt = 1; $attempt <= 5; $attempt++) {
            $this->actingAs($this->commuter)
                ->postJson('/api/v1/commuter/feedback', [])
                ->assertStatus(422);
        }

        $otherCommuter = User::factory()->commuter()->create();

        $this->actingAs($otherCommuter)
            ->postJson('/api/v1/commuter/feedback', [])
            ->assertStatus(422);
    }

    public function test_unrelated_commuter_actions_do_not_consume_feedback_attempts(): void
    {
        for ($attempt = 1; $attempt <= 10; $attempt++) {
            $this->actingAs($this->commuter)
                ->postJson('/api/v1/commuter/location', [])
                ->assertStatus(422);
        }

        $this->actingAs($this->commuter)
            ->postJson('/api/v1/commuter/feedback', [])
            ->assertStatus(422);
    }

    public function test_feedback_route_is_isolated_without_changing_unrelated_route_limiters(): void
    {
        $this->assertContains(
            'throttle:commuter-feedback',
            $this->middlewareFor('POST', '/api/v1/commuter/feedback'),
        );

        foreach ([
            ['POST', '/api/v1/commuter/hail', 'throttle:commuter-hail'],
            ['POST', '/api/v1/commuter/location', 'throttle:commuter-hail'],
            ['POST', '/api/v1/commuter/payments/claim', 'throttle:commuter-hail'],
            ['POST', '/api/v1/commuter/receipts/claim', 'throttle:commuter-hail'],
            ['PUT', '/api/v1/commuter/profile', 'throttle:conductor-write'],
        ] as [$method, $uri, $existingLimiter]) {
            $middleware = $this->middlewareFor($method, $uri);

            $this->assertContains($existingLimiter, $middleware, $uri);
            $this->assertNotContains('throttle:commuter-feedback', $middleware, $uri);
        }
    }

    /** @return array<int, string> */
    private function middlewareFor(string $method, string $uri): array
    {
        return Route::getRoutes()
            ->match(Request::create($uri, $method))
            ->gatherMiddleware();
    }
}
