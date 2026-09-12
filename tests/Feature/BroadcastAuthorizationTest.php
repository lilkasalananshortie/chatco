<?php

namespace Tests\Feature;

use App\Enums\HailStatus;
use App\Events\HailCreated;
use App\Events\HailStatusChanged;
use App\Models\Driver;
use App\Models\Hail;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\Vehicle;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Broadcast;
use Tests\TestCase;

class BroadcastAuthorizationTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'broadcasting.default' => 'pusher',
            'broadcasting.connections.pusher.key' => 'test-key',
            'broadcasting.connections.pusher.secret' => 'test-secret',
            'broadcasting.connections.pusher.app_id' => 'test-app',
            'broadcasting.connections.pusher.options.cluster' => 'ap1',
        ]);

        Broadcast::purge();
        require base_path('routes/channels.php');
    }

    public function test_only_active_vehicle_conductor_can_authorize_sensitive_hail_channel(): void
    {
        $conductor = User::factory()->conductor()->create();
        $vehicle = Vehicle::factory()->create();
        $driver = Driver::factory()->create();
        $shift = ShiftLog::factory()->create([
            'conductor_id' => $conductor->id,
            'driver_id' => $driver->id,
            'vehicle_id' => $vehicle->id,
        ]);
        $vehicle->update(['active_shift_id' => $shift->shift_id]);

        $this->post('/api/v1/broadcasting/auth', [
            'socket_id' => '1234.5678',
            'channel_name' => "private-vehicle.{$vehicle->id}.hails",
        ], $this->tokenHeaders($conductor))->assertOk();
    }

    public function test_unrelated_conductor_cannot_authorize_sensitive_hail_channel(): void
    {
        $assignedConductor = User::factory()->conductor()->create();
        $other = User::factory()->conductor()->create();
        $vehicle = Vehicle::factory()->create();
        $shift = ShiftLog::factory()->create([
            'conductor_id' => $assignedConductor->id,
            'vehicle_id' => $vehicle->id,
        ]);
        $vehicle->update(['active_shift_id' => $shift->shift_id]);

        $this->post('/api/v1/broadcasting/auth', [
            'socket_id' => '1234.5678',
            'channel_name' => "private-vehicle.{$vehicle->id}.hails",
        ], $this->tokenHeaders($other))->assertForbidden();
    }

    public function test_commuter_hail_channel_is_private_to_its_owner_and_payload_is_minimized(): void
    {
        $owner = User::factory()->commuter()->create();
        $vehicle = Vehicle::factory()->create();
        $hail = Hail::create([
            'commuter_id' => $owner->id,
            'vehicle_id' => $vehicle->id,
            'commuter_lat' => 14.9,
            'commuter_lng' => 120.8,
            'distance_m' => 100,
            'status' => HailStatus::PENDING,
            'expires_at' => now()->addMinutes(3),
        ]);

        $this->post('/api/v1/broadcasting/auth', [
            'socket_id' => '1234.5678',
            'channel_name' => "private-commuter.{$owner->id}.hails",
        ], $this->tokenHeaders($owner))->assertOk();

        $this->assertInstanceOf(PrivateChannel::class, (new HailCreated($hail))->broadcastOn());
        $statusEvent = new HailStatusChanged($hail);
        $statusChannels = $statusEvent->broadcastOn();
        $this->assertCount(2, $statusChannels);
        $this->assertContainsOnlyInstancesOf(PrivateChannel::class, $statusChannels);
        $this->assertSame(
            ["private-commuter.{$owner->id}.hails", "private-vehicle.{$vehicle->id}.hails"],
            array_map(fn (PrivateChannel $channel) => $channel->name, $statusChannels),
        );
        $this->assertSame(['hail_id' => $hail->id, 'status' => 'PENDING'], $statusEvent->broadcastWith());
    }

    public function test_other_commuter_cannot_authorize_owner_hail_channel(): void
    {
        $owner = User::factory()->commuter()->create();
        $other = User::factory()->commuter()->create();

        $this->post('/api/v1/broadcasting/auth', [
            'socket_id' => '1234.5678',
            'channel_name' => "private-commuter.{$owner->id}.hails",
        ], $this->tokenHeaders($other))->assertForbidden();
    }

    private function tokenHeaders(User $user): array
    {
        return ['Authorization' => 'Bearer '.$user->createToken('broadcast-test')->plainTextToken];
    }
}
