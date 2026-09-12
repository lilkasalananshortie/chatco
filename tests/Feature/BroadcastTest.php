<?php

namespace Tests\Feature;

use App\Events\VehicleLocationUpdated;
use Illuminate\Broadcasting\Channel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class BroadcastTest extends TestCase
{
    use RefreshDatabase;

    /**
     * The VehicleLocationUpdated event is a ShouldBroadcast value object.
     * We test its broadcast contract (channel, event name, payload) by
     * instantiating it directly and calling the broadcast methods —
     * this avoids depending on Broadcast::fake() (which was removed in
     * this Laravel version) and tests the event class in isolation.
     */
    public function test_vehicle_location_updated_event_broadcasts_on_vehicles_channel(): void
    {
        $payload = [
            'vehicle_id' => 'test-vehicle-id',
            'plate_number' => 'ABC123',
            'vehicle_type' => 'Jeepney',
            'lat' => 14.5995,
            'lng' => 120.9842,
            'speed' => 45.50,
            'heading' => 180.00,
            'capacity_status' => 'AVAILABLE',
            'route_name' => 'Route 1',
            'updated_at' => now()->toIso8601String(),
        ];

        $event = new VehicleLocationUpdated($payload);

        // Broadcasts on the public 'vehicles' channel
        $channel = $event->broadcastOn();
        $this->assertInstanceOf(Channel::class, $channel);
        $this->assertEquals('vehicles', $channel->name);

        // Event name matches the frontend listener expectation
        $this->assertEquals('VehicleLocationUpdated', $event->broadcastAs());

        // Payload is passed through unchanged
        $this->assertEquals($payload, $event->broadcastWith());
        $this->assertEquals($payload['vehicle_id'], $event->broadcastWith()['vehicle_id']);
    }

    public function test_vehicles_channel_is_public(): void
    {
        // Public channels never call the private-channel authentication URL.
        $channel = (new VehicleLocationUpdated([]))->broadcastOn();

        $this->assertSame(Channel::class, $channel::class);
        $this->assertSame('vehicles', $channel->name);
    }
}
