<?php

namespace App\Services;

use App\Enums\CapacityStatus;
use App\Events\VehicleLocationUpdated;
use App\Models\OverspeedEvent;
use App\Models\ShiftLog;
use App\Models\Vehicle;
use App\Models\VehicleLocation;
use App\Models\User;
use App\Models\Setting;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

class LocationService
{
    /**
     * Update a vehicle's GPS position.
     *
     * - Requires an active shift (no shift = no GPS update)
     * - Upserts vehicle_locations by vehicle_id (always latest position)
     * - Broadcasts VehicleLocationUpdated via Pusher
     */
    public function updateLocation(
        User $conductor,
        float $lat,
        float $lng,
        ?float $speed = null,
        ?float $heading = null,
        ?string $capacityStatus = null,
    ): VehicleLocation {
        // 1. Validate lat/lng ranges
        if ($lat < -90 || $lat > 90) {
            abort(422, 'Latitude must be between -90 and 90');
        }

        if ($lng < -180 || $lng > 180) {
            abort(422, 'Longitude must be between -180 and 180');
        }

        // 2. Get the conductor's active shift
        $activeShift = ShiftLog::where('conductor_id', $conductor->id)
            ->active()
            ->first();

        if (! $activeShift) {
            abort(422, 'No active shift');
        }

        // 3. Get vehicle_id from the active shift
        $vehicleId = $activeShift->vehicle_id;

        // 4. Upsert vehicle_locations by vehicle_id. Capacity is only written
        //    when explicitly provided, so a GPS-only update does NOT clobber a
        //    conductor-set status; a brand-new row defaults to AVAILABLE.
        $location = VehicleLocation::firstOrNew(['vehicle_id' => $vehicleId]);
        $location->fill([
            'conductor_id' => $conductor->id,
            'lat' => $lat,
            'lng' => $lng,
            'speed' => $speed,
            'heading' => $heading,
        ]);
        if ($capacityStatus !== null) {
            $location->capacity_status = $capacityStatus;
        } elseif (! $location->exists) {
            $location->capacity_status = CapacityStatus::AVAILABLE->value;
        }
        $location->save();

        // 5. Record an overspeeding incident when the reported speed exceeds
        //    the configured limit (persisted history for the admin monitoring
        //    module — tracks the shift's TOP speed).
        if ($speed !== null) {
            $this->recordOverspeed($activeShift, (float) $speed);
        }

        // 6. Broadcast the update via Pusher
        $this->broadcastLocationUpdate($vehicleId);

        return $location;
    }

    /**
     * The current speed limit in km/h (settings `speed_limit_kmh`, default 60),
     * cached briefly so high-frequency GPS pings don't hammer the settings table.
     */
    private function speedLimitKmh(): int
    {
        return (int) Cache::remember('overspeed.limit_kmh', 60, function () {
            return (int) (Setting::where('key', 'speed_limit_kmh')->value('value') ?? 60);
        });
    }

    /**
     * Record/refresh the overspeeding history row for a shift.
     *
     * One row per shift: the row keeps the HIGHEST speed reached over the
     * limit. A faster ping raises top_speed; a slower (still-over) ping only
     * refreshes last_logged_at. Speeds at or under the limit are ignored.
     */
    private function recordOverspeed(ShiftLog $shift, float $speed): void
    {
        $threshold = $this->speedLimitKmh();
        if ($threshold <= 0 || $speed <= $threshold) {
            return; // within the limit — nothing to log
        }

        $roundedSpeed = (int) round($speed);
        $now = now();

        $event = OverspeedEvent::firstOrNew(['shift_id' => $shift->shift_id]);

        // Already logged a faster (or equal) top speed this shift — just note
        // that they're still over the limit and stop.
        if ($event->exists && $roundedSpeed <= (int) $event->top_speed) {
            $event->last_logged_at = $now;
            $event->save();
            return;
        }

        $event->fill([
            'conductor_id'   => $shift->conductor_id,
            'driver_id'      => $shift->driver_id,
            'vehicle_id'     => $shift->vehicle_id,
            'conductor_name' => $shift->conductor_name,
            'driver_name'    => $shift->driver_name,
            'unit_number'    => $shift->unit_number,
            'plate_number'   => $shift->plate_number,
            'top_speed'      => $roundedSpeed,
            'threshold'      => $threshold,
            'date'           => $now->toDateString(),
            'last_logged_at' => $now,
        ])->save();
    }

    /**
     * Get all active vehicle locations for the commuter map.
     *
     * - NO distance filter — ALL vehicles visible at ALL times
     * - Joins with vehicles + active shifts + routes
     * - Fallback/initial load endpoint (real-time comes via Pusher)
     * - Ordered by most recently updated first
     */
    public function getAllActiveLocations(): Collection
    {
        return DB::table('vehicle_locations')
            ->join('vehicles', 'vehicle_locations.vehicle_id', '=', 'vehicles.id')
            // Only show vehicles that have an ACTIVE shift. After remittance,
            // active_shift_id is set to null — the vehicle should disappear
            // from the commuter map immediately.
            ->whereNotNull('vehicles.active_shift_id')
            ->leftJoin('shift_logs', function ($join) {
                $join->on('vehicles.active_shift_id', '=', 'shift_logs.shift_id');
            })
            ->leftJoin('routes', 'shift_logs.route_id', '=', 'routes.id')
            ->select([
                'vehicle_locations.vehicle_id',
                'vehicles.plate_number',
                'vehicles.vehicle_type',
                'vehicles.unit_number',
                'vehicles.capacity_status as vehicle_capacity_status',
                'vehicle_locations.lat',
                'vehicle_locations.lng',
                'vehicle_locations.speed',
                'vehicle_locations.heading',
                'vehicle_locations.capacity_status',
                'routes.name as route_name',
                'vehicle_locations.updated_at',
            ])
            ->orderBy('vehicle_locations.updated_at', 'desc')
            ->get();
    }

    /**
     * Get the live fleet monitoring view for admins.
     *
     * Returns all vehicles with an ACTIVE shift, their latest GPS position,
     * capacity status, speed, and a `is_stale` flag (true if the last
     * location update was more than 10 minutes ago — the unit may have
     * lost connectivity or the conductor forgot to broadcast).
     *
     * Includes driver + conductor names from the active shift log.
     *
     * @return \Illuminate\Support\Collection<int, object>
     */
    public function getMonitoringFleet(): Collection
    {
        $now = now();
        $staleThresholdMinutes = 10;

        return DB::table('vehicle_locations')
            ->join('vehicles', 'vehicle_locations.vehicle_id', '=', 'vehicles.id')
            ->whereNotNull('vehicles.active_shift_id')
            ->leftJoin('shift_logs', function ($join) {
                $join->on('vehicles.active_shift_id', '=', 'shift_logs.shift_id');
            })
            ->leftJoin('routes', 'shift_logs.route_id', '=', 'routes.id')
            ->leftJoin('drivers', 'shift_logs.driver_id', '=', 'drivers.id')
            ->leftJoin('conductor_profiles', 'shift_logs.conductor_id', '=', 'conductor_profiles.id')
            ->select([
                'vehicle_locations.vehicle_id as id',
                'vehicles.unit_number',
                'vehicles.plate_number',
                'vehicles.vehicle_type',
                'vehicle_locations.lat',
                'vehicle_locations.lng',
                'vehicle_locations.speed',
                'vehicle_locations.heading',
                'vehicle_locations.capacity_status',
                'routes.name as route_name',
                'vehicle_locations.updated_at as last_update',
                'drivers.first_name as driver_first_name',
                'drivers.last_name as driver_last_name',
                'conductor_profiles.first_name as conductor_first_name',
                'conductor_profiles.last_name as conductor_last_name',
            ])
            ->orderBy('vehicle_locations.updated_at', 'desc')
            ->get()
            ->map(function ($row) use ($now, $staleThresholdMinutes) {
                $lastUpdate = $row->last_update ? \Illuminate\Support\Carbon::parse($row->last_update) : null;
                $minutesSinceUpdate = $lastUpdate ? $now->diffInMinutes($lastUpdate) : null;

                return [
                    'id'                  => $row->id,
                    'unit_number'         => $row->unit_number,
                    'plate_number'        => $row->plate_number,
                    'vehicle_type'        => $row->vehicle_type,
                    'lat'                 => $row->lat !== null ? (float) $row->lat : null,
                    'lng'                 => $row->lng !== null ? (float) $row->lng : null,
                    'speed'               => $row->speed !== null ? (int) $row->speed : null,
                    'heading'             => $row->heading,
                    'capacity_status'     => $row->capacity_status ?? 'AVAILABLE',
                    'route_name'          => $row->route_name,
                    'driver_name'         => trim(($row->driver_first_name ?? '') . ' ' . ($row->driver_last_name ?? '')) ?: null,
                    'conductor_name'      => trim(($row->conductor_first_name ?? '') . ' ' . ($row->conductor_last_name ?? '')) ?: null,
                    'last_update'         => $lastUpdate?->toDateTimeString(),
                    'minutes_since_update'=> $minutesSinceUpdate,
                    'is_stale'            => $minutesSinceUpdate !== null && $minutesSinceUpdate > $staleThresholdMinutes,
                ];
            });
    }

    /**
     * Update a vehicle's capacity status.
     *
     * - Only conductors with an active shift can update
     * - Values restricted to: AVAILABLE, STANDING, FULL
     * - Broadcasts VehicleLocationUpdated via Pusher
     */
    public function updateCapacityStatus(User $conductor, string $status): VehicleLocation
    {
        // 1. Validate status value
        $validStatuses = array_column(CapacityStatus::cases(), 'value');
        if (! in_array($status, $validStatuses)) {
            abort(422, 'Invalid capacity status. Must be: AVAILABLE, STANDING, or FULL');
        }

        // 2. Get the conductor's active shift
        $activeShift = ShiftLog::where('conductor_id', $conductor->id)
            ->active()
            ->first();

        if (! $activeShift) {
            abort(422, 'No active shift');
        }

        // 3. Get vehicle_id from the active shift
        $vehicleId = $activeShift->vehicle_id;

        // 4. Upsert vehicle_locations with new capacity_status
        $location = VehicleLocation::updateOrCreate(
            ['vehicle_id' => $vehicleId],
            [
                'conductor_id' => $conductor->id,
                'capacity_status' => $status,
            ],
        );

        // 5. Broadcast the update via Pusher
        $this->broadcastLocationUpdate($vehicleId);

        return $location;
    }

    /**
     * Build the broadcast payload and fire the event.
     *
     * This is the shared helper used by both GPS updates and capacity
     * status updates — every change triggers a real-time push.
     */
    private function broadcastLocationUpdate(string $vehicleId): void
    {
        $locationData = DB::table('vehicle_locations')
            ->join('vehicles', 'vehicle_locations.vehicle_id', '=', 'vehicles.id')
            ->leftJoin('shift_logs', function ($join) {
                $join->on('vehicles.active_shift_id', '=', 'shift_logs.shift_id');
            })
            ->leftJoin('routes', 'shift_logs.route_id', '=', 'routes.id')
            ->where('vehicle_locations.vehicle_id', $vehicleId)
            ->select([
                'vehicle_locations.vehicle_id',
                'vehicles.plate_number',
                'vehicles.vehicle_type',
                'vehicle_locations.lat',
                'vehicle_locations.lng',
                'vehicle_locations.speed',
                'vehicle_locations.heading',
                'vehicle_locations.capacity_status',
                'routes.name as route_name',
                'vehicle_locations.updated_at',
            ])
            ->first();

        if ($locationData) {
            broadcast(new VehicleLocationUpdated((array) $locationData))->toOthers();
        }
    }

    /**
     * Persisted overspeeding history for the admin monitoring module.
     * Returns one recorded incident per shift (its top speed over the limit),
     * most recent first. Recorded live by recordOverspeed() on each GPS ping.
     */
    public function getOverspeedHistory(int $limit = 200): Collection
    {
        return OverspeedEvent::query()
            ->orderByDesc('last_logged_at')
            ->limit($limit)
            ->get()
            ->map(function (OverspeedEvent $e) {
                return [
                    'id'          => (string) $e->id,
                    'unit'        => $e->unit_number,
                    'plate'       => $e->plate_number,
                    'speed'       => (int) $e->top_speed,
                    'threshold'   => (int) $e->threshold,
                    'driver'      => $e->driver_name,
                    'conductor'   => $e->conductor_name,
                    'date'        => $e->date?->toDateString(),
                    'last_update' => $e->last_logged_at?->toIso8601String(),
                ];
            });
    }
}