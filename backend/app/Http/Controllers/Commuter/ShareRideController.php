<?php

namespace App\Http\Controllers\Commuter;

use App\Http\Controllers\Controller;
use App\Models\CommuterProfile;
use App\Models\SharedRideLink;
use App\Traits\ApiResponse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Commuter Share Ride Controller.
 *
 *   POST /api/v1/commuter/share-ride    → create a tracking link
 *   GET  /api/v1/commuter/share-ride    → the commuter's live link, or null
 *   GET  /api/v1/share/{token}          → public: get the latest position
 *   DELETE /api/v1/commuter/share-ride  → deactivate the active link
 *
 * The commuter generates a tracking token → shares the URL → anyone with
 * the URL can see the commuter's live GPS position on a map for 30 minutes.
 */
class ShareRideController extends Controller
{
    use ApiResponse;

    /** Default link TTL in minutes. */
    private const TTL_MINUTES = 30;

    /**
     * POST /api/v1/commuter/share-ride
     *
     * Creates (or refreshes) a tracking link for the authenticated commuter.
     * If an active non-expired link already exists, returns it instead of
     * creating a duplicate. Optionally accepts lat/lng to set the initial
     * position.
     */
    public function store(Request $request): JsonResponse
    {
        $profile = $request->user()->commuterProfile;

        if (! $profile) {
            return $this->errorResponse('Commuter profile required.', 422);
        }

        $validated = $request->validate([
            'lat' => 'nullable|numeric',
            'lng' => 'nullable|numeric',
            'rotate' => 'nullable|boolean',
            'token' => 'nullable|string|max:100',
        ]);

        // Deactivating the old link and creating/reusing one below must be
        // atomic — otherwise two near-simultaneous calls (a double-tapped
        // "Start Sharing", or a rotate racing a live-position push) could
        // each see no conflicting link and both end up active. Locking the
        // commuter's own profile row for the transaction serializes those
        // calls so only one ever "wins", matching the payment flows'
        // lock-a-stable-parent-row pattern elsewhere in the app.
        [$link, $created] = DB::transaction(function () use ($profile, $validated, $request) {
            CommuterProfile::where('id', $profile->id)->lockForUpdate()->first();

            // A live update must never resurrect an expired or stopped share.
            if (! empty($validated['token'])) {
                $existing = SharedRideLink::where('commuter_id', $profile->id)
                    ->where('token', $validated['token'])->where('is_active', true)
                    ->where('expires_at', '>', now())->first();
                abort_unless($existing, 409, 'This sharing session has ended.');
                if (isset($validated['lat'], $validated['lng'])) {
                    $existing->update(['lat' => $validated['lat'], 'lng' => $validated['lng'], 'last_updated_at' => now()]);
                }

                return [$existing, false];
            }

            // A "start sharing" action (rotate=true) mints a brand-new token every
            // time: deactivate any existing active link so the new URL is unique
            // and every previously shared link immediately reads as expired.
            // Live position pushes (rotate=false) instead REUSE the current link so
            // the token stays stable while the map updates.
            if ($request->boolean('rotate')) {
                SharedRideLink::where('commuter_id', $profile->id)
                    ->where('is_active', true)
                    ->update(['is_active' => false]);
            } else {
                $existing = SharedRideLink::where('commuter_id', $profile->id)
                    ->where('is_active', true)
                    ->where('expires_at', '>', now())
                    ->latest()
                    ->first();

                if ($existing) {
                    // Update position if provided.
                    if (isset($validated['lat']) && isset($validated['lng'])) {
                        $existing->update([
                            'lat' => $validated['lat'],
                            'lng' => $validated['lng'],
                            'last_updated_at' => now(),
                        ]);
                    }

                    return [$existing, false];
                }
            }

            // Create a new link.
            $link = SharedRideLink::create([
                'commuter_id' => $profile->id,
                'lat' => $validated['lat'] ?? null,
                'lng' => $validated['lng'] ?? null,
                'expires_at' => now()->addMinutes(self::TTL_MINUTES),
                'last_updated_at' => now(),
                'is_active' => true,
            ]);

            return [$link, true];
        }, 3);

        return $this->successResponse([
            'token' => $link->token,
            'expires_at' => $link->expires_at->toIso8601String(),
            'share_url' => rtrim(config('app.frontend_url'), '/')."/share/{$link->token}",
        ], $created ? 'Share link created' : 'Share link retrieved', $created ? 201 : 200);
    }

    /**
     * GET /api/v1/commuter/share-ride
     *
     * The commuter's live link, or null. Lets the share modal open straight
     * on the running link when it was started in another tab or device.
     * Read-only: never creates a link (that stays an explicit POST).
     */
    public function current(Request $request): JsonResponse
    {
        $profile = $request->user()->commuterProfile;

        if (! $profile) {
            return $this->errorResponse('Commuter profile required.', 422);
        }

        // Served by the (commuter_id, is_active) index.
        $link = SharedRideLink::where('commuter_id', $profile->id)
            ->where('is_active', true)
            ->where('expires_at', '>', now())
            ->latest()
            ->first(['token', 'expires_at']);

        return $this->successResponse($link ? [
            'token' => $link->token,
            'expires_at' => $link->expires_at->toIso8601String(),
            'share_url' => rtrim(config('app.frontend_url'), '/')."/share/{$link->token}",
        ] : null, $link ? 'Active share link' : 'No active share link');
    }

    /**
     * DELETE /api/v1/commuter/share-ride
     *
     * Deactivates the commuter's active share link (manual stop).
     */
    public function destroy(Request $request): JsonResponse
    {
        $profile = $request->user()->commuterProfile;

        if (! $profile) {
            return $this->errorResponse('Commuter profile required.', 422);
        }

        DB::transaction(function () use ($profile) {
            CommuterProfile::where('id', $profile->id)->lockForUpdate()->first();
            SharedRideLink::where('commuter_id', $profile->id)
                ->where('is_active', true)->update(['is_active' => false]);
        }, 3);

        return $this->successResponse(null, 'Share link deactivated');
    }

    /**
     * GET /api/v1/share/{token}
     *
     * PUBLIC endpoint — no auth required. Returns the commuter's latest
     * position if the link is active + not expired. Used by the public
     * /share/{token} tracking page.
     */
    public function show(string $token): JsonResponse
    {
        // One indexed query per poll (unique token + commuter PK join) instead
        // of the link plus an eager-loaded commuter: this route is
        // unauthenticated and polled every 5s by every open viewer, so it is
        // the hottest read in the feature.
        $link = SharedRideLink::query()
            ->leftJoin('commuter_profiles', 'commuter_profiles.id', '=', 'shared_ride_links.commuter_id')
            ->where('shared_ride_links.token', $token)
            ->first([
                'shared_ride_links.lat',
                'shared_ride_links.lng',
                'shared_ride_links.expires_at',
                'shared_ride_links.last_updated_at',
                'shared_ride_links.is_active',
                'commuter_profiles.first_name',
                'commuter_profiles.surname',
                'commuter_profiles.profile_image_url',
            ]);

        if (! $link) {
            return $this->noStore($this->errorResponse('Tracking link not found.', 404));
        }

        $commuterName = trim($link->first_name . ' ' . $link->surname) ?: 'Commuter';

        // A stopped or expired link exposes the name only — never a position
        // or the photo.
        if (! $link->is_active || $link->isExpired()) {
            return $this->noStore($this->successResponse([
                'active' => false,
                'expired' => true,
                'commuter_name' => $commuterName,
            ], 'Tracking link expired'));
        }

        return $this->noStore($this->successResponse([
            'active' => true,
            'expired' => false,
            'commuter_name' => $commuterName,
            // Only while the link is live — an expired link stops exposing the photo.
            'commuter_profile_image_url' => $link->profile_image_url,
            'lat' => $link->lat ? (float) $link->lat : null,
            'lng' => $link->lng ? (float) $link->lng : null,
            'last_updated' => $link->last_updated_at?->toIso8601String(),
            // Age measured on the server's clock, so a viewer whose device
            // clock is off still sees how stale the position is.
            'seconds_since_update' => $link->last_updated_at
                ? (int) max(0, $link->last_updated_at->diffInSeconds(now()))
                : null,
            'expires_at' => $link->expires_at->toIso8601String(),
        ], 'Tracking data retrieved'));
    }

    /** Live locations must never be stored by a browser or shared proxy cache. */
    private function noStore(JsonResponse $response): JsonResponse
    {
        return $response->header('Cache-Control', 'no-store, private');
    }
}
