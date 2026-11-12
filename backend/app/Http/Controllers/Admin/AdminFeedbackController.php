<?php

namespace App\Http\Controllers\Admin;

use App\Http\Controllers\Controller;
use App\Services\FeedbackService;
use App\Support\Feedback\FeedbackException;
use App\Traits\ApiResponse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Pagination\Cursor;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;

/**
 * Sprint 6 (T6 revised) — Admin feedback listing for staff performance review.
 *
 *   GET /api/v1/admin/feedback?conductor_id={uuid}
 *   GET /api/v1/admin/feedback?driver_id={uuid}
 *
 * Replaces the standalone "Feedback QR" admin module. The admin now views
 * driver/conductor feedback directly from User Management by double-clicking
 * a row. One of conductor_id / driver_id is required (mutually exclusive —
 * if both are passed, conductor_id wins). Optional rating=1..5 narrows the
 * paginated rows to one star level; optional reason={tag} narrows them to
 * reviews that picked that tag. The summary still covers all ratings and
 * carries `reasons` (tags ranked by count, complaints vs praise).
 *
 * pagination=cursor (+ cursor={next_cursor}) switches to keyset pagination
 * for the admin modal's infinite scroll: no COUNT query per batch, constant
 * cost at any depth, and no duplicated/skipped rows when new feedback lands
 * mid-scroll. The summary is only computed on the first batch (no cursor).
 * Omitting it keeps the original page-based response.
 *
 * Returns paginated feedback plus a
 * summary (average_rating, total_count, 5→1 distribution) so the modal can
 * render aggregate stats alongside the per-shift rows.
 *
 * Role enforcement: ADMIN only (inherited from the /admin route group).
 * Conductor not found / Driver not found → 404. Neither param supplied → 422.
 */
class AdminFeedbackController extends Controller
{
    use ApiResponse;

    public function __construct(
        private readonly FeedbackService $feedbackService,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $conductorId = $request->query('conductor_id');
        $driverId = $request->query('driver_id');
        $perPage = max(1, min((int) $request->query('per_page', 10), 50));
        $validated = $request->validate([
            'rating' => ['nullable', 'integer', 'between:1,5'],
            'pagination' => ['nullable', 'in:page,cursor'],
            'cursor' => ['nullable', 'string', 'max:512'],
            'reason' => ['nullable', 'string', 'max:100'],
        ]);
        $rating = isset($validated['rating']) ? (int) $validated['rating'] : null;
        $reason = $validated['reason'] ?? null;
        $cursorMode = ($validated['pagination'] ?? 'page') === 'cursor';
        $cursor = $cursorMode ? $this->decodeCursor($validated['cursor'] ?? null) : null;

        if (! $conductorId && ! $driverId) {
            return $this->errorResponse(
                'Either conductor_id or driver_id is required.',
                422,
                ['conductor_id' => ['One of conductor_id or driver_id is required.']]
            );
        }

        try {
            $result = $conductorId
                ? $this->feedbackService->listForConductor($conductorId, $perPage, $rating, $cursorMode, $cursor, $reason)
                : $this->feedbackService->listForDriver($driverId, $perPage, $rating, $cursorMode, $cursor, $reason);
        } catch (FeedbackException $e) {
            return $this->errorResponse($e->getMessage(), 404);
        }

        return $this->successResponse($result, 'Feedback retrieved');
    }

    /**
     * Decode and type-check a client-supplied cursor so a tampered value is a
     * 422, never a malformed keyset comparison. Keys match the list's
     * ORDER BY created_at DESC, id DESC.
     */
    private function decodeCursor(?string $encoded): ?Cursor
    {
        if ($encoded === null || $encoded === '') {
            return null;
        }

        $cursor = Cursor::fromEncoded($encoded);
        $valid = $cursor !== null && ! Validator::make([
            'created_at' => $cursor->parameter('created_at'),
            'id' => $cursor->parameter('id'),
        ], [
            'created_at' => ['required', 'string', 'date'],
            'id' => ['required', 'uuid'],
        ])->fails();

        if (! $valid) {
            throw ValidationException::withMessages(['cursor' => 'Invalid feedback cursor.']);
        }

        return $cursor;
    }
}
