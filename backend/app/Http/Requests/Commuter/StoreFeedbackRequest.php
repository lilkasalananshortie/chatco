<?php

namespace App\Http\Requests\Commuter;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Validates POST /api/v1/commuter/feedback.
 *
 * Shape/type validation lives here. Crew derivation and duplicate detection
 * live in FeedbackService::submit(). Payment is not required for QR feedback.
 *
 * SECURITY: Server-generated fields (vehicle_id, driver_id, conductor_id,
 * commuter_id) are NEVER accepted from the client. They are NOT listed in
 * rules(), so they will NOT appear in the validated() output. The controller
 * passes only the validated fields to the service, which derives the crew
 * from the referenced shift.
 *
 * Authorization is handled at the route level via role:COMMUTER.
 */
class StoreFeedbackRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'shift_id' => 'required|string|exists:shift_logs,shift_id',
            'rating' => 'required|integer|min:1|max:5',
            'category' => 'nullable|string|max:255',
            'comment' => 'nullable|string|max:2000',
            // Conductor rating — a SEPARATE score from the driver's. Required
            // (mirrors the driver): the commuter rates both crew members.
            'conductor_rating' => 'required|integer|min:1|max:5',
            'conductor_category' => 'nullable|string|max:255',
            'conductor_comment' => 'nullable|string|max:2000',
        ];
    }

    public function messages(): array
    {
        return [
            'shift_id.required' => 'Shift ID is required',
            'shift_id.exists' => 'The selected shift does not exist',
            'rating.required' => 'Rating is required',
            'rating.integer' => 'Rating must be an integer',
            'rating.min' => 'Rating must be at least 1',
            'rating.max' => 'Rating must be at most 5',
            'category.max' => 'Category must be at most 255 characters',
            'comment.max' => 'Comment must be at most 2000 characters',
            'conductor_rating.required' => 'Conductor rating is required',
            'conductor_rating.integer' => 'Conductor rating must be an integer',
            'conductor_rating.min' => 'Conductor rating must be at least 1',
            'conductor_rating.max' => 'Conductor rating must be at most 5',
            'conductor_category.max' => 'Conductor category must be at most 255 characters',
            'conductor_comment.max' => 'Conductor comment must be at most 2000 characters',
        ];
    }
}
