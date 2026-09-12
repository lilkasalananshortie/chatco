<?php

namespace Tests\Feature;

use App\Enums\ShiftStatus;
use App\Models\Driver;
use App\Models\Feedback;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * GET /api/v1/conductor/ratings?shift_id=…
 *
 * Powers the conductor metrics page. Returns the feedback rows for a shift the
 * conductor crewed. Verifies:
 *   - the conductor gets their shift's feedback (200 + rows)
 *   - both the driver rating and the conductor rating are present per row
 *   - scoping: a conductor cannot read another conductor's shift feedback
 *   - missing shift_id → 422
 *   - unauthenticated → 401
 */
class ConductorRatingsTest extends TestCase
{
    use RefreshDatabase;

    private User $conductor;
    private User $commuter;
    private Driver $driver;
    private Vehicle $vehicle;
    private ShiftLog $shift;

    protected function setUp(): void
    {
        parent::setUp();

        $this->conductor = User::factory()->conductor()->create();
        $this->commuter = User::factory()->commuter()->create();
        $this->driver = Driver::factory()->create();
        $this->vehicle = Vehicle::factory()->create();

        $this->shift = ShiftLog::create([
            'shift_id'       => 'SFT-RATE-' . now()->format('YmdHis'),
            'conductor_id'   => $this->conductor->id,
            'driver_id'      => $this->driver->id,
            'vehicle_id'     => $this->vehicle->id,
            'route_id'       => null,
            'conductor_name' => 'Test Conductor',
            'driver_name'    => 'Test Driver',
            'unit_number'    => $this->vehicle->unit_number,
            'plate_number'   => $this->vehicle->plate_number,
            'time_in'        => now(),
            'time_out'       => null,
            'is_active'      => true,
            'status'         => ShiftStatus::ACTIVE->value,
        ]);
    }

    private function seedFeedback(): Feedback
    {
        return Feedback::create([
            'shift_id'           => $this->shift->shift_id,
            'vehicle_id'         => $this->vehicle->id,
            'driver_id'          => $this->driver->id,
            'conductor_id'       => $this->conductor->id,
            'commuter_id'        => $this->commuter->id,
            'rating'             => 4,
            'category'           => 'DRIVING',
            'comment'            => 'Smooth ride',
            'conductor_rating'   => 5,
            'conductor_category' => 'COURTESY',
            'conductor_comment'  => 'Very polite',
        ]);
    }

    private function conductorToken(User $conductor = null): string
    {
        return ($conductor ?? $this->conductor)->createToken('test')->plainTextToken;
    }

    public function test_conductor_gets_ratings_for_their_shift(): void
    {
        $feedback = $this->seedFeedback();

        $response = $this->withHeader('Authorization', 'Bearer ' . $this->conductorToken())
            ->getJson('/api/v1/conductor/ratings?shift_id=' . $this->shift->shift_id);

        $response->assertStatus(200)
            ->assertJsonPath('success', true)
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $feedback->id)
            ->assertJsonPath('data.0.shift_id', $this->shift->shift_id)
            ->assertJsonPath('data.0.rating', 4)
            ->assertJsonPath('data.0.conductor_rating', 5)
            ->assertJsonPath('data.0.driver_id', $this->driver->id)
            ->assertJsonPath('data.0.conductor_id', $this->conductor->id);
    }

    public function test_conductor_cannot_read_another_conductors_shift(): void
    {
        $this->seedFeedback();
        $otherConductor = User::factory()->conductor()->create();

        $response = $this->withHeader('Authorization', 'Bearer ' . $this->conductorToken($otherConductor))
            ->getJson('/api/v1/conductor/ratings?shift_id=' . $this->shift->shift_id);

        // Scoped to conductor_id = auth id → no rows for a shift they didn't crew.
        $response->assertStatus(200)->assertJsonCount(0, 'data');
    }

    public function test_missing_shift_id_returns_422(): void
    {
        $response = $this->withHeader('Authorization', 'Bearer ' . $this->conductorToken())
            ->getJson('/api/v1/conductor/ratings');

        $response->assertStatus(422);
    }

    public function test_unauthenticated_returns_401(): void
    {
        $response = $this->getJson('/api/v1/conductor/ratings?shift_id=' . $this->shift->shift_id);

        $response->assertStatus(401);
    }
}
