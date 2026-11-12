<?php

namespace App\Http\Controllers;

use App\Http\Requests\LostFound\ClaimLostItemRequest;
use App\Services\LostItemService;
use App\Support\LostFound\LostFoundException;
use App\Traits\ApiResponse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;

/**
 * Sprint 6 (T3) — Lost & Found shared endpoints (browse + claim + watchlist).
 *
 *   GET    /api/v1/lost-found                          (any auth role) — paginated browse
 *   GET    /api/v1/lost-found/{itemId}                 (any auth role) — item detail
 *   POST   /api/v1/lost-found/{itemId}/claim           (COMMUTER)       — submit a claim
 *   POST   /api/v1/lost-found/{itemId}/watchlist       (COMMUTER)       — add to watchlist
 *   DELETE /api/v1/lost-found/{itemId}/watchlist       (COMMUTER)       — remove from watchlist
 *   GET    /api/v1/commuter/watchlist                  (COMMUTER)       — my watchlist
 *
 * Admin-only operations (create item, upload image, review claims, release,
 * close) live in AdminLostItemController. This split keeps the role middleware
 * clean: browse is open to all authenticated users, claim/watchlist is
 * commuter-only, and management is admin-only.
 */
class LostItemController extends Controller
{
    use ApiResponse;

    public function __construct(
        private readonly LostItemService $lostItemService,
    ) {}

    /**
     * GET /lost-found?status=&category=&categories[]=&search=&date=&date_from=&date_to=&range=&per_page=
     */
    public function index(Request $request): JsonResponse
    {
        $range = $request->string('range')->toString() ?: null;
        if (! $this->isValidRange($range)) {
            return $this->errorResponse('Invalid time range filter', 422);
        }
        $posted = $this->postedFilters($request);
        if ($posted instanceof JsonResponse) {
            return $posted;
        }

        $filters = [
            'status'   => $request->string('status')->toString() ?: null,
            'category' => $request->string('category')->toString() ?: null,
            'search'   => $request->string('search')->toString() ?: null,
            'date'     => $request->string('date')->toString() ?: null,
            'range'    => $range,
            ...$posted,
        ];
        $perPage = min(max((int) $request->integer('per_page', 15), 1), 50);

        $items = $this->lostItemService->listItems($filters, $perPage, $request->user());

        return $this->successResponse($items, 'Lost items retrieved');
    }

    /**
     * GET /lost-found/{itemId}
     */
    public function show(string $itemId): JsonResponse
    {
        try {
            $item = $this->lostItemService->show($itemId);
        } catch (LostFoundException $e) {
            return $this->errorResponse($e->getMessage(), 404);
        }

        return $this->successResponse($item, 'Lost item retrieved');
    }

    /**
     * POST /lost-found/{itemId}/claim
     */
    public function claim(ClaimLostItemRequest $request, string $itemId): JsonResponse
    {
        try {
            $claim = $this->lostItemService->claim(
                $request->user(),
                $itemId,
                $request->validated(),
                $request->file('images', []),
            );
        } catch (LostFoundException $e) {
            $status = str_contains($e->getMessage(), 'not found') ? 404 : 422;
            return $this->errorResponse($e->getMessage(), $status);
        }

        return $this->successResponse($claim, 'Claim submitted', 201);
    }

    /**
     * GET /commuter/claims
     * The authed commuter's own claims (item eager-loaded), newest first.
     */
    public function myClaims(Request $request): JsonResponse
    {
        $status = $request->string('status')->toString() ?: null;
        $date = $request->string('date')->toString() ?: null;
        $search = $request->string('search')->toString() ?: null;
        $range = $request->string('range')->toString() ?: null;
        $category = $request->string('category')->toString() ?: null;
        if ($status && ! in_array($status, ['PENDING', 'APPROVED', 'REJECTED', 'RELEASED'], true)) {
            return $this->errorResponse('Invalid claim status filter', 422);
        }
        if (! $this->isValidRange($range)) {
            return $this->errorResponse('Invalid time range filter', 422);
        }
        $posted = $this->postedFilters($request);
        if ($posted instanceof JsonResponse) {
            return $posted;
        }

        $perPage = min(max((int) $request->integer('per_page', 10), 1), 50);

        try {
            $claims = $this->lostItemService->myClaims($request->user(), $perPage, $status, $date, $search, $range, $category, $posted);
        } catch (LostFoundException $e) {
            return $this->errorResponse($e->getMessage(), 422);
        }

        return $this->successResponse($claims, 'Claims retrieved');
    }

    /**
     * DELETE /lost-found/claims/{claimId}
     * Commuter withdraws their own PENDING claim.
     */
    public function cancelClaim(Request $request, string $claimId): JsonResponse
    {
        try {
            $this->lostItemService->cancelClaim($request->user(), $claimId);
        } catch (LostFoundException $e) {
            $status = str_contains($e->getMessage(), 'not found') ? 404 : 422;
            return $this->errorResponse($e->getMessage(), $status);
        }

        return $this->successResponse(null, 'Claim cancelled');
    }

    /**
     * POST /lost-found/{itemId}/watchlist
     * Idempotent — returns 201 if newly added, 200 if already watching.
     */
    public function watchlist(Request $request, string $itemId): JsonResponse
    {
        try {
            $entry = $this->lostItemService->addToWatchlist(
                $request->user(),
                $itemId,
            );
        } catch (LostFoundException $e) {
            $status = str_contains($e->getMessage(), 'not found') ? 404 : 422;
            return $this->errorResponse($e->getMessage(), $status);
        }

        $wasRecentlyCreated = $entry->wasRecentlyCreated;
        return $this->successResponse(
            $entry,
            $wasRecentlyCreated ? 'Added to watchlist' : 'Already on watchlist',
            $wasRecentlyCreated ? 201 : 200,
        );
    }

    /**
     * DELETE /lost-found/{itemId}/watchlist
     * Idempotent — 200 whether or not the item was on the watchlist.
     */
    public function unwatch(Request $request, string $itemId): JsonResponse
    {
        $this->lostItemService->removeFromWatchlist($request->user(), $itemId);

        return $this->successResponse(null, 'Removed from watchlist');
    }

    /**
     * GET /commuter/watchlist
     * Paginated list of the authed commuter's watchlisted items.
     */
    public function myWatchlist(Request $request): JsonResponse
    {
        $perPage = min(max((int) $request->integer('per_page', 15), 1), 50);
        $date = $request->string('date')->toString() ?: null;
        $search = $request->string('search')->toString() ?: null;
        $range = $request->string('range')->toString() ?: null;
        $category = $request->string('category')->toString() ?: null;
        if (! $this->isValidRange($range)) {
            return $this->errorResponse('Invalid time range filter', 422);
        }
        $posted = $this->postedFilters($request);
        if ($posted instanceof JsonResponse) {
            return $posted;
        }

        try {
            $watchlist = $this->lostItemService->myWatchlist(
                $request->user(),
                $perPage,
                $date,
                $search,
                $range,
                $category,
                $posted,
            );
        } catch (LostFoundException $e) {
            return $this->errorResponse($e->getMessage(), 422);
        }

        return $this->successResponse($watchlist, 'Watchlist retrieved');
    }

    /**
     * Posted-date window (date_from..date_to, inclusive, Y-m-d) and
     * multi-category (categories[]) filters shared by the commuter list
     * endpoints. Either end of the window may be omitted. Returns the
     * filters for LostItemService::applyPostedFilters, or a 422 response.
     *
     * @return array{date_from: ?string, date_to: ?string, categories: list<string>}|JsonResponse
     */
    private function postedFilters(Request $request): array|JsonResponse
    {
        $rules = [
            'date_from' => ['nullable', 'date_format:Y-m-d'],
            'date_to' => ['nullable', 'date_format:Y-m-d'],
            'categories' => ['nullable', 'array', 'max:20'],
            'categories.*' => ['string', 'max:20'],
        ];
        // Only compare the ends when both are given: after_or_equal against
        // a missing field would parse the field name itself as a date.
        if ($request->filled('date_from')) {
            $rules['date_to'][] = 'after_or_equal:date_from';
        }

        $validator = Validator::make($request->only(['date_from', 'date_to', 'categories']), $rules);
        if ($validator->fails()) {
            return $this->errorResponse($validator->errors()->first(), 422);
        }

        return [
            'date_from' => $request->string('date_from')->toString() ?: null,
            'date_to' => $request->string('date_to')->toString() ?: null,
            'categories' => array_values(array_unique((array) $request->input('categories', []))),
        ];
    }

    /** Null (no range) is valid; anything else must be one of TIME_RANGES. */
    private function isValidRange(?string $range): bool
    {
        return $range === null || in_array($range, LostItemService::TIME_RANGES, true);
    }
}
