<?php

namespace App\Services;

use App\Enums\HailStatus;
use App\Events\HailCreated;
use App\Events\HailStatusChanged;
use App\Exceptions\OutsideRadiusException;
use App\Helpers\GeoHelper;
use App\Models\Hail;
use App\Models\Route;
use App\Models\ShiftLog;
use App\Models\User;
use App\Models\VehicleLocation;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpKernel\Exception\HttpException;

class HailService
{
    private const HAIL_TTL_MINUTES = 3;

    public function __construct(
        private ShiftDeviceService $shiftDeviceService,
        private LocationService $locationService,
    ) {}

    /**
     * Every unit whose radius covers the commuter gets its own copy of the
     * hail, so each of those conductors sees the pickup point. The unit the
     * commuter picked must pass; the others are added only when they pass the
     * same checks. Returns the picked unit's copy.
     */
    public function createHail(
        User $commuter,
        string $vehicleId,
        float $commuterLat,
        float $commuterLng,
    ): Hail {
        if (! $commuter->isCommuter()) {
            abort(403, 'Forbidden');
        }

        // Unlocked pre-filter over the units shown on the commuter map; the
        // locked checks below are authoritative. Sorted so concurrent hails
        // covering the same units lock rows in the same order.
        $vehicleIds = $this->locationService->getAllActiveLocations()
            ->filter(fn ($row) => GeoHelper::haversineMeters(
                $commuterLat,
                $commuterLng,
                (float) $row->lat,
                (float) $row->lng,
            ) <= GeoHelper::HAIL_RADIUS_M)
            ->pluck('vehicle_id')
            ->push($vehicleId)
            ->unique()
            ->sort()
            ->values();

        return DB::transaction(function () use ($commuter, $vehicleId, $vehicleIds, $commuterLat, $commuterLng) {
            // Serializes a commuter's hail creation attempts without a global lock.
            User::query()->whereKey($commuter->id)->lockForUpdate()->firstOrFail();
            if (Hail::query()->where('commuter_id', $commuter->id)->pending()->exists()) {
                abort(409, 'Duplicate pending hail');
            }

            $shifts = ShiftLog::query()
                ->whereIn('vehicle_id', $vehicleIds)
                ->active()
                ->orderBy('vehicle_id')
                ->lockForUpdate()
                ->get()
                ->keyBy('vehicle_id');
            $locations = VehicleLocation::query()
                ->whereIn('vehicle_id', $vehicleIds)
                ->orderBy('vehicle_id')
                ->lockForUpdate()
                ->get()
                ->keyBy('vehicle_id');

            $routes = [];
            $hails = [];
            $expiresAt = now()->addMinutes(self::HAIL_TTL_MINUTES);
            foreach ($vehicleIds as $id) {
                try {
                    $distance = $this->hailableDistance($shifts->get($id), $locations->get($id), $commuterLat, $commuterLng, $routes);
                } catch (HttpException|OutsideRadiusException $e) {
                    // The picked unit keeps its exact refusal; other units are extras.
                    if ($id === $vehicleId) {
                        throw $e;
                    }

                    continue;
                }

                $hails[$id] = Hail::create([
                    'commuter_id' => $commuter->id,
                    'vehicle_id' => $id,
                    'commuter_lat' => $commuterLat,
                    'commuter_lng' => $commuterLng,
                    'distance_m' => $distance,
                    'status' => HailStatus::PENDING,
                    'expires_at' => $expiresAt,
                ]);
            }

            DB::afterCommit(function () use ($hails): void {
                foreach ($hails as $hail) {
                    broadcast(new HailCreated($hail));
                }
            });

            return $hails[$vehicleId];
        }, 3);
    }

    /**
     * Distance from the commuter to a unit that can take the hail; throws the
     * reason it can't. $shift and $location must already be locked.
     *
     * @param  array<string, Route|null>  $routes  per-request route cache
     */
    private function hailableDistance(
        ?ShiftLog $shift,
        ?VehicleLocation $location,
        float $commuterLat,
        float $commuterLng,
        array &$routes,
    ): float {
        if (! $shift || $shift->is_on_break) {
            abort(422, $shift ? 'Vehicle is currently on break' : 'Vehicle not on duty');
        }

        if (! $location
            || $location->shift_id !== $shift->shift_id
            || $location->updated_at === null
            || $location->updated_at->lt($shift->time_in)
            || $location->lat === null
            || $location->lng === null) {
            abort(422, 'Vehicle position is unavailable');
        }
        // Same offline rule as the commuter map, so a hidden unit can't be hailed.
        if ($location->updated_at->lt(now()->subSeconds(LocationService::COMMUTER_FRESH_SECONDS))) {
            abort(422, 'Vehicle is offline');
        }

        $distance = GeoHelper::haversineMeters(
            $commuterLat,
            $commuterLng,
            (float) $location->lat,
            (float) $location->lng,
        );
        if ($distance > GeoHelper::HAIL_RADIUS_M) {
            throw new OutsideRadiusException($distance);
        }

        $route = null;
        if ($shift->route_id) {
            $route = $routes[$shift->route_id] ??= Route::find($shift->route_id);
        }
        if ($route?->hasGeometry() && GeoHelper::distanceToPolylineMeters(
            $commuterLat,
            $commuterLng,
            $route->geometry,
        ) > GeoHelper::HAIL_RADIUS_M) {
            abort(422, 'Pickup point is outside the active route coverage.');
        }

        return $distance;
    }

    /**
     * Cancels the hail and its copies on the other units in range (a commuter
     * has at most one pending hail, so their pending rows are those copies).
     * Copies go first: the picked unit's copy may already be closed, e.g. its
     * shift ended, and its 409 must not leave the others on a conductor map.
     */
    public function cancelHail(User $commuter, string $hailId): Hail
    {
        if (Hail::query()->whereKey($hailId)->firstOrFail()->commuter_id !== $commuter->id) {
            abort(403, 'Forbidden');
        }

        Hail::query()
            ->where('commuter_id', $commuter->id)
            ->pending()
            ->whereKeyNot($hailId)
            ->pluck('id')
            ->each(function (string $id) use ($commuter): void {
                try {
                    $this->transitionHail($id, HailStatus::CANCELLED, $commuter);
                } catch (HttpException $e) {
                    // Expired or closed by its own unit in the meantime.
                    if ($e->getStatusCode() !== 409) {
                        throw $e;
                    }
                }
            });

        return $this->transitionHail($hailId, HailStatus::CANCELLED, $commuter);
    }

    public function acceptHail(
        User $conductor,
        string $hailId,
        ?string $deviceId = null,
        ?string $deviceType = null,
    ): Hail {
        return $this->transitionHail($hailId, HailStatus::ACCEPTED, $conductor, $deviceId, $deviceType);
    }

    public function rejectHail(
        User $conductor,
        string $hailId,
        ?string $deviceId = null,
        ?string $deviceType = null,
    ): Hail {
        return $this->transitionHail($hailId, HailStatus::REJECTED, $conductor, $deviceId, $deviceType);
    }

    public function getPendingHailsForVehicle(string $vehicleId): Collection
    {
        return Hail::query()
            ->pending()
            ->forVehicle($vehicleId)
            ->where('expires_at', '>', now())
            ->with('commuter')
            ->orderByDesc('created_at')
            ->get();
    }

    /**
     * Pending-only conditional transitions make repeated sweeps and competing
     * accept/cancel/reject requests idempotent. The related shift is locked
     * first everywhere, matching shift closeout's lock order.
     */
    private function transitionHail(
        string $hailId,
        HailStatus $target,
        User $actor,
        ?string $deviceId = null,
        ?string $deviceType = null,
    ): Hail {
        return DB::transaction(function () use ($hailId, $target, $actor, $deviceId, $deviceType) {
            $candidate = Hail::query()->whereKey($hailId)->firstOrFail();
            $shift = ShiftLog::query()
                ->where('vehicle_id', $candidate->vehicle_id)
                ->active()
                ->lockForUpdate()
                ->first();
            $hail = Hail::query()->whereKey($hailId)->lockForUpdate()->firstOrFail();

            if ($target === HailStatus::CANCELLED) {
                if ($hail->commuter_id !== $actor->id) {
                    abort(403, 'Forbidden');
                }
            } elseif (! $shift || $shift->conductor_id !== $actor->id) {
                abort(403, 'Forbidden');
            }

            if ($target !== HailStatus::CANCELLED) {
                $this->shiftDeviceService->assertCanOperate($shift, $deviceId, $deviceType);
            }

            if ($hail->status !== HailStatus::PENDING) {
                abort(409, 'Hail is no longer pending');
            }
            if ($target === HailStatus::ACCEPTED && $hail->expires_at->isPast()) {
                abort(409, 'Hail has expired');
            }

            $hail->update([
                'status' => $target->value,
                'conductor_id' => $target === HailStatus::ACCEPTED ? $actor->id : $hail->conductor_id,
            ]);
            $hail->refresh();
            DB::afterCommit(fn () => broadcast(new HailStatusChanged($hail)));

            return $hail;
        }, 3);
    }

    public function expireStaleHails(): int
    {
        $expired = 0;

        Hail::query()
            ->where('status', HailStatus::PENDING->value)
            ->where('expires_at', '<=', now())
            ->orderBy('id')
            ->chunkById(100, function ($candidates) use (&$expired): void {
                foreach ($candidates as $candidate) {
                    DB::transaction(function () use ($candidate, &$expired): void {
                        // Lock shift before hail, consistent with accept/cancel/closeout.
                        ShiftLog::query()
                            ->where('vehicle_id', $candidate->vehicle_id)
                            ->active()
                            ->lockForUpdate()
                            ->first();
                        $hail = Hail::query()->whereKey($candidate->id)->lockForUpdate()->first();
                        if (! $hail || $hail->status !== HailStatus::PENDING || $hail->expires_at->isFuture()) {
                            return;
                        }

                        $hail->update(['status' => HailStatus::EXPIRED->value]);
                        $hail->refresh();
                        $expired++;
                        DB::afterCommit(fn () => broadcast(new HailStatusChanged($hail)));
                    }, 3);
                }
            });

        return $expired;
    }
}
