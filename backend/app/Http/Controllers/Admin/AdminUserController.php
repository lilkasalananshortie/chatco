<?php

namespace App\Http\Controllers\Admin;

use App\Enums\ActivityLogCategory;
use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\UpdateUserRequest;
use App\Services\ActivityLogService;
use App\Services\AdminService;
use App\Traits\ApiResponse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Admin user management (S5-T3): list, view, update, soft-delete.
 *
 * Thin controller — all logic lives in AdminService. Every route is behind
 * auth:sanctum + role:ADMIN (see routes/api.php), so authorization is not
 * re-checked here. There is no impersonation / user-switching action.
 */
class AdminUserController extends Controller
{
    use ApiResponse;

    public function __construct(
        private AdminService $adminService,
        private ActivityLogService $activityLogService,
    ) {}

    /**
     * GET /api/v1/admin/users?role=&search=&per_page=&page=
     */
    public function index(Request $request): JsonResponse
    {
        $users = $this->adminService->listUsers([
            'role'     => $request->query('role'),
            'search'   => $request->query('search'),
            'per_page' => $request->integer('per_page', 15),
            'sort' => $request->query('sort', 'recent'),
            'account_status' => $request->query('account_status'),
            'commuter_type' => $request->query('commuter_type'),
            'active_only' => $request->boolean('active_only'),
            // The signed-in admin manages their own account from Settings, not here.
            'exclude_id' => $request->user()->id,
        ]);

        return $this->successResponse($users, 'Users retrieved');
    }

    /**
     * GET /api/v1/admin/users/{id}
     */
    public function show(string $id): JsonResponse
    {
        $user = $this->adminService->getUser($id);

        if ($user === null) {
            return $this->errorResponse('User not found', 404);
        }

        return $this->successResponse($user, 'User retrieved');
    }

    /**
     * PUT /api/v1/admin/users/{id}
     */
    public function update(UpdateUserRequest $request, string $id): JsonResponse
    {
        // Snapshot for the activity log's before/after values.
        $before = $this->adminService->getUser($id);

        $user = $this->adminService->updateUser(
            $id,
            $request->validated(),
            $request->user(),
        );

        if ($user === null) {
            return $this->errorResponse('User not found', 404);
        }

        $changes = ActivityLogService::diff($before ?? [], $user, [
            'first_name' => 'First name',
            'middle_name' => 'Middle name',
            'last_name' => 'Last name',
            'account_status' => 'Account status',
            'contact_number' => 'Contact number',
            'birthdate' => 'Date of birth',
        ]);
        // A save that changed nothing isn't an action worth an entry.
        if ($changes !== []) {
            $this->activityLogService->record(
                ActivityLogCategory::MEMBER,
                "Updated member {$user['name']}: ".ActivityLogService::changedFields($changes),
                $request->user(),
                $changes,
            );
        }

        return $this->successResponse($user, 'User updated');
    }

    /**
     * DELETE /api/v1/admin/users/{id}
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        // Captured before delete() — the record is gone by the time the log
        // call below would otherwise resolve a display name for it.
        $target = $this->adminService->getUser($id);

        $deleted = $this->adminService->deleteUser($id, $request->user());

        if (! $deleted) {
            return $this->errorResponse('User not found', 404);
        }

        $this->activityLogService->record(
            ActivityLogCategory::MEMBER,
            'Deleted member ' . ($target['name'] ?? $id),
            $request->user(),
        );

        return $this->successResponse(null, 'User deleted');
    }

    public function suspend(Request $request, string $id): JsonResponse
    {
        $validated = $request->validate([
            'reason_code' => ['required', Rule::in([
                'POLICY_VIOLATION',
                'FRAUD_SUSPECTED',
                'SAFETY_CONCERN',
                'INAPPROPRIATE_PROFILE_PHOTO',
                'PAYMENT_ISSUE',
                'OTHER',
            ])],
            'reason' => ['required', 'string', 'min:5', 'max:500'],
            'is_permanent' => ['required', 'boolean'],
            'duration_days' => [
                Rule::requiredIf(! $request->boolean('is_permanent')),
                'nullable',
                'integer',
                Rule::in([1, 3, 7, 14, 30, 90]),
            ],
        ]);

        $user = $this->adminService->suspendUser($id, $validated, $request->user());

        $this->activityLogService->record(
            ActivityLogCategory::MEMBER,
            "Suspended member {$user['name']}",
            $request->user(),
        );

        return $this->successResponse($user, 'Account suspended and active sessions revoked.');
    }

    public function unsuspend(Request $request, string $id): JsonResponse
    {
        $user = $this->adminService->unsuspendUser($id, $request->user());

        $this->activityLogService->record(
            ActivityLogCategory::MEMBER,
            "Reactivated member {$user['name']}",
            $request->user(),
        );

        return $this->successResponse($user, 'Account reactivated.');
    }

    public function suspensions(string $id): JsonResponse
    {
        return $this->successResponse(
            $this->adminService->suspensionHistory($id),
            'Suspension history retrieved'
        );
    }
}
