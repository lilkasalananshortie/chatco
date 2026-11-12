<?php

namespace App\Services;

use App\Enums\ActivityLogCategory;
use App\Models\CommuterProfile;
use App\Models\DiscountApplication;
use App\Models\User;
use App\Support\MessageTemplates;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;

/** Shared proof/review mechanics; annual scheduling stays in StudentRenewalService. */
class DiscountApplicationService
{
    public const DOCUMENT_DISK = 'r2_private';

    public function documentDisk(string $path): string
    {
        // The immutable prefix identifies the bucket, including historical revisions.
        // Legacy ids/... proofs stay on their original disk; no object migration.
        return str_starts_with($path, 'discount-proofs/') ? 'r2_renewals' : self::DOCUMENT_DISK;
    }

    public function deleteDocument(string $path): void
    {
        try {
            Storage::disk($this->documentDisk($path))->delete($path);
        } catch (\Throwable $error) {
            report($error); // Cleanup must never hide the original submission failure.
        }
    }

    public function __construct(private AnnouncementService $announcements, private ActivityLogService $activity) {}

    public function assertEligible(CommuterProfile $profile): void
    {
        abort_unless($profile->commuter_type === 'REGULAR'
            && in_array($profile->account_status, ['ACTIVE', 'APPROVED'], true)
            && $profile->user && ! $profile->user->activeSuspension,
            403, 'Discount applications are available only to active Regular commuters.');
    }

    public function state(User $user): array
    {
        $profile = $user->commuterProfile;
        abort_unless($profile, 404, 'Commuter profile not found.');
        $outstanding = $profile->discountApplications()->select(DiscountApplication::SUMMARY_COLUMNS)->outstanding()->orderBy('submitted_at')->first();
        $application = $outstanding ?? $profile->discountApplications()->select(DiscountApplication::SUMMARY_COLUMNS)->where('request_type', 'APPLICATION')->latest('submitted_at')->latest('id')->first();
        // Approval changes the classification in the same transaction, so an
        // approved application on a Regular account is history (for example a
        // student who did not renew). The commuter starts a fresh application.
        if (! $outstanding && $application?->status === 'APPROVED' && $profile->commuter_type === 'REGULAR') {
            $application = null;
        }
        $eligible = $profile->commuter_type === 'REGULAR'
            && in_array($profile->account_status, ['ACTIVE', 'APPROVED'], true) && ! $user->activeSuspension;
        $correction = $outstanding?->request_type === 'APPLICATION' && $outstanding->status === 'NEEDS_CORRECTION';

        return [
            'commuter_type' => $profile->commuter_type,
            'effective_fare_type' => $profile->effectiveFareType(),
            'discount_expires_at' => $profile->student_discount_expires_at?->toIso8601String(),
            'document_required' => ! app()->environment('local'),
            'can_submit' => $eligible && (! $outstanding || $correction),
            'status' => $application?->status ?? 'NOT_APPLIED',
            'application' => $application ? $this->present($application) : null,
        ];
    }

    public function storeDocument(CommuterProfile $profile, UploadedFile $document, string $folder): string
    {
        try {
            $disk = config('filesystems.uploads.renewal_disk', self::DOCUMENT_DISK);
            $prefix = $disk === 'r2_renewals' ? 'discount-proofs' : 'ids';
            $path = $document->store($prefix.'/commuters/'.$profile->id.'/'.$folder, ['disk' => $disk, 'visibility' => 'private']);
        } catch (\Throwable $error) {
            report($error);
            $path = false;
        }
        abort_unless($path, 502, 'The document could not be stored. Please try again.');

        return $path;
    }

    public function saveSubmission(DiscountApplication $application, array $data, ?string $path, User $user): void
    {
        if ($application->exists) {
            $history = $application->submission_history ?? [];
            $history[] = $application->only(['revision', 'requested_type', 'document_path', 'document_mime', 'school_name', 'education_level', 'grade_level', 'school_year', 'enrollment_term', 'submitted_at', 'reviewed_at', 'reviewed_by', 'status', 'reason']);
            $application->submission_history = $history;
            $this->activity->record(
                ActivityLogCategory::MEMBER,
                "Resubmitted their {$this->categoryLabel($application->requested_type)} discount request",
                $user,
                array_values(array_filter([
                    ['field' => 'Status', 'from' => $this->statusLabel($application->status), 'to' => 'Pending'],
                    $application->reason ? ['field' => 'Reason given', 'from' => $application->reason, 'to' => null] : null,
                ])),
            );
        }
        // A correction keeps its original submission time: renewals only within
        // their deadline, applications always since their corrections never lapse.
        $retainTimelySubmission = $application->status === 'NEEDS_CORRECTION'
            && ($application->request_type === 'APPLICATION' || $application->correction_due_at?->isFuture());
        $application->fill([
            'status' => 'PENDING', 'document_path' => $path,
            'revision' => $application->exists ? $application->revision + 1 : 1,
            'document_mime' => $path && isset($data['document']) ? $data['document']->getMimeType() : null,
            'school_name' => $data['school_name'] ?? null, 'education_level' => $data['education_level'] ?? null,
            'grade_level' => $data['grade_level'] ?? null, 'school_year' => $data['school_year'] ?? null,
            'enrollment_term' => ($data['enrollment_term'] ?? null) ?: null,
            'submitted_at' => now(), 'first_submitted_at' => $retainTimelySubmission ? $application->first_submitted_at : now(),
            'reviewed_by' => null, 'reviewed_at' => null, 'reason' => null, 'correction_due_at' => null,
        ])->save();
    }

    public function submit(User $user, array $data): array
    {
        $profile = $user->commuterProfile;
        abort_unless($profile, 404, 'Commuter profile not found.');
        // One User instance throughout, so the user row and its activeSuspension
        // load once instead of again for $profile->user and the locked copy.
        $profile->setRelation('user', $user);
        $this->assertEligible($profile);
        // Cheap pre-check before the R2 upload; the locked re-check below is
        // the real guard.
        abort_if($this->hasBlockingRequest($profile), 409, 'You already have an active discount request.');
        // Local workflow debugging intentionally discards any proof payload,
        // so a selected file can never fall through to the remote R2 disk.
        $path = isset($data['document']) && ! app()->environment('local')
            ? $this->storeDocument($profile, $data['document'], 'applications') : null;
        try {
            DB::transaction(function () use ($user, $profile, $data, $path) {
                $locked = CommuterProfile::whereKey($profile->id)->lockForUpdate()->firstOrFail();
                // Re-read only the suspension under the lock (the user row
                // itself cannot change eligibility).
                $user->unsetRelation('activeSuspension');
                $locked->setRelation('user', $user);
                $this->assertEligible($locked);
                $active = $locked->discountApplications()->outstanding()->lockForUpdate()->first();
                $resubmission = isset($data['application_id']);
                if ($resubmission) {
                    abort_unless($active && $active->id === $data['application_id'] && $active->request_type === 'APPLICATION'
                        && $active->status === 'NEEDS_CORRECTION' && $active->revision === (int) $data['revision'],
                        409, 'This application or its correction window has changed. Refresh before submitting.');
                    abort_unless($active->requested_type === $data['requested_type'], 422, 'The discount category cannot change during a correction.');
                } else {
                    abort_if($active, 409, 'You already have an active discount request.');
                }
                $application = $active ?? new DiscountApplication([
                    'commuter_id' => $locked->id, 'request_type' => 'APPLICATION',
                    'requested_type' => $data['requested_type'], 'cycle_year' => null,
                ]);
                $this->saveSubmission($application, $data, $path, $user);
                $category = $this->categoryLabel($application->requested_type);
                $applicantName = $locked->first_name.' '.$locked->surname;
                $this->announcements->notifyAdmins('DISCOUNT_APPLICATION_NEW',
                    $resubmission ? "Corrected {$category} documents: {$applicantName}" : "{$category} discount application: {$applicantName}",
                    $applicantName.($resubmission
                        ? " sent corrected documents for their {$category} discount application."
                        : " applied for a {$category} discount."), $application->id);
                $this->activity->record(ActivityLogCategory::MEMBER, "Applied for a {$category} discount", $user);
            }, 3);
        } catch (\Throwable $error) {
            if ($path) {
                $this->deleteDocument($path);
            }
            throw $error;
        }

        // Submitting changes only the application, never the user or profile,
        // so the loaded models are reused instead of $user->fresh() re-reading
        // the user, profile and suspension.
        return $this->state($user);
    }

    /**
     * True when an open request stops a new submission — anything outstanding
     * except an application sent back for correction. Same rule as state()'s
     * can_submit, minus the eligibility part the caller has already asserted.
     */
    private function hasBlockingRequest(CommuterProfile $profile): bool
    {
        $outstanding = $profile->discountApplications()->outstanding()
            ->orderBy('submitted_at')->first(['request_type', 'status']);

        return $outstanding !== null
            && ! ($outstanding->request_type === 'APPLICATION' && $outstanding->status === 'NEEDS_CORRECTION');
    }

    /**
     * The commuter withdraws their own open application (pending or sent back
     * for correction), freeing them to apply under another category. Allowed
     * even while suspended, since it only gives up a request. Renewals are
     * withdrawn through "No Longer a Student" instead.
     */
    public function cancel(User $user, string $applicationId): array
    {
        $profile = $user->commuterProfile;
        abort_unless($profile, 404, 'Commuter profile not found.');
        DB::transaction(function () use ($user, $profile, $applicationId) {
            // Same lock order as submit and review: profile first, then the application,
            // so a cancel and an admin decision on the same request cannot both win.
            $locked = CommuterProfile::whereKey($profile->id)->lockForUpdate()->firstOrFail();
            $application = $locked->discountApplications()->whereKey($applicationId)
                ->where('request_type', 'APPLICATION')->lockForUpdate()->first();
            abort_unless($application, 404, 'Discount application not found.');
            abort_unless(in_array($application->status, ['PENDING', 'NEEDS_CORRECTION'], true), 409,
                'This application has already been reviewed and can no longer be cancelled.');
            $previous = $application->status;
            $application->update(['status' => 'CANCELLED', 'correction_due_at' => null]);
            $this->activity->record(
                ActivityLogCategory::MEMBER,
                "Cancelled their {$this->categoryLabel($application->requested_type)} discount application",
                $user,
                [['field' => 'Status', 'from' => $this->statusLabel($previous), 'to' => 'Cancelled']],
            );
        }, 3);

        return $this->state($user->fresh());
    }

    /** PENDING → "Pending", NEEDS_CORRECTION → "Needs correction". */
    private function statusLabel(string $status): string
    {
        return ucfirst(strtolower(str_replace('_', ' ', $status)));
    }

    public function categoryLabel(string $type): string
    {
        return match ($type) { 'STUDENT' => 'Student', 'SENIOR' => 'Senior Citizen', 'PWD' => 'PWD', default => 'Regular' };
    }

    public function list(array $filters)
    {
        // Table pages never show the proof; only the single-application fetch
        // behind the review dialog gets a signed document link.
        $withDocument = isset($filters['id']);
        $columns = DiscountApplication::SUMMARY_COLUMNS;

        return DiscountApplication::select($withDocument ? [...$columns, 'document_path'] : $columns)
            ->with(['commuter:id,first_name,middle_name,surname,birthdate,gender,contact_number,username,commuter_type', 'commuter.user:id,email'])
            ->whereHas('commuter.user')
            // A sign-up's school details are reviewed with the pending
            // registration, not here, so nothing is reviewed twice.
            ->whereRelation('commuter', 'account_status', '!=', 'PENDING')
            ->when($filters['status'] ?? null, fn ($q, $status) => $q->where('status', $status))
            ->when($filters['request_type'] ?? null, fn ($q, $kind) => $q->where('request_type', $kind))
            ->when($filters['requested_type'] ?? null, fn ($q, $type) => $q->where('requested_type', $type))
            ->when($filters['id'] ?? null, fn ($q, $id) => $q->whereKey($id))
            ->when($filters['search'] ?? null, function ($q, $search) {
                // A full name spans separate columns, so every word must match one of
                // them ("juan dela" → first_name AND surname), in any order.
                foreach (preg_split('/\s+/', trim($search), -1, PREG_SPLIT_NO_EMPTY) ?: [] as $word) {
                    $term = '%'.str_replace(['%', '_'], ['\\%', '\\_'], $word).'%';
                    $q->whereHas('commuter', fn ($profile) => $profile->where(fn ($p) => $p->where('first_name', 'like', $term)
                        ->orWhere('middle_name', 'like', $term)->orWhere('surname', 'like', $term)
                        ->orWhere('suffix', 'like', $term)->orWhere('email', 'like', $term)));
                }
            })
            ->orderBy('submitted_at')->orderBy('id')->paginate($filters['per_page'] ?? 10)
            ->through(fn ($application) => $this->present($application, true, $withDocument));
    }

    public function review(User $admin, string $id, array $data): array
    {
        return DB::transaction(function () use ($admin, $id, $data) {
            $candidate = DiscountApplication::findOrFail($id);
            // All transitions lock the profile first, then the application.
            $profile = CommuterProfile::whereKey($candidate->commuter_id)->lockForUpdate()->firstOrFail();
            $application = DiscountApplication::whereKey($id)->lockForUpdate()->firstOrFail();
            abort_unless($application->status === 'PENDING', 409, 'This application has already been processed.');
            // A sign-up's school details are decided with the registration itself.
            abort_if($profile->account_status === 'PENDING', 409, 'Review this student with their pending registration.');
            abort_unless($application->revision === (int) $data['revision'], 409, 'The supporting document has changed. Reopen the application before reviewing it.');
            $isRenewal = $application->request_type === 'RENEWAL';
            $decision = $data['decision'];
            if ($isRenewal) {
                app(StudentRenewalService::class)->assertEligible($profile);
            } elseif ($decision === 'APPROVED') {
                // Only approval changes the classification. Rejecting or asking
                // for a correction stays possible after the account is suspended
                // or changed, so the request never sits in the queue for good.
                $this->assertEligible($profile);
            }
            $application->fill([
                'status' => $decision, 'reviewed_by' => $admin->id, 'reviewed_at' => now(),
                'reason' => $data['reason'] ?? null,
                // Renewals keep the seven-day window; application corrections have no deadline.
                'correction_due_at' => $decision === 'NEEDS_CORRECTION' && $isRenewal ? now()->addDays(7) : null,
            ])->save();
            if ($decision === 'APPROVED') {
                $type = $isRenewal ? 'STUDENT' : $application->requested_type;
                $expiry = $type === 'STUDENT'
                    ? ($isRenewal ? app(StudentRenewalService::class)->cutoff($application->cycle_year + 1) : CommuterProfile::initialStudentExpiry())
                    : null;
                $profile->update(['commuter_type' => $type, 'applied_type' => $type, 'student_discount_expires_at' => $expiry]);
            } elseif ($decision === 'REJECTED' && $isRenewal) {
                $profile->update(['commuter_type' => 'REGULAR', 'applied_type' => 'STUDENT']);
            }
            // Wording is admin-editable (Settings > Notifications).
            $templateKey = ($isRenewal ? 'renewal_' : 'discount_').match ($decision) {
                'APPROVED' => 'approved',
                'NEEDS_CORRECTION' => 'correction',
                default => 'rejected',
            }.'_template';
            $message = MessageTemplates::render(MessageTemplates::get($templateKey), [
                'name' => trim($profile->first_name.' '.$profile->surname),
                'discount_type' => $this->categoryLabel($application->requested_type),
                'reason' => $application->reason,
            ]);
            // The title carries the outcome so the Updates list reads at a glance;
            // the feed already labels the category (Discount application / Student renewal).
            $category = $this->categoryLabel($application->requested_type);
            $title = $isRenewal ? match ($decision) {
                'APPROVED' => 'Student status renewed',
                'NEEDS_CORRECTION' => 'Renewal needs correction',
                default => 'Student renewal rejected',
            } : match ($decision) {
                'APPROVED' => "{$category} discount approved",
                'NEEDS_CORRECTION' => "{$category} discount needs correction",
                default => "{$category} discount rejected",
            };
            $this->announcements->notifyUser($profile->id, $isRenewal ? 'STUDENT_RENEWAL_DONE' : 'DISCOUNT_APPLICATION_DONE',
                $title, $message, $application->id);
            $verb = match ($decision) {
                'APPROVED' => 'Approved',
                'NEEDS_CORRECTION' => 'Asked for corrections on',
                default => 'Rejected',
            };
            $subject = $isRenewal ? 'student renewal' : "{$category} discount application";
            $this->activity->record(
                ActivityLogCategory::MEMBER,
                "{$verb} the {$subject} of {$profile->first_name} {$profile->surname}",
                $admin,
                array_values(array_filter([
                    ['field' => 'Status', 'from' => 'Pending', 'to' => $this->statusLabel($decision)],
                    $application->reason ? ['field' => 'Reason', 'from' => null, 'to' => $application->reason] : null,
                ])),
            );

            return $this->present($application, true);
        }, 3);
    }

    public function present(DiscountApplication $application, bool $admin = false, bool $withDocument = true): array
    {
        $result = $application->only(['id', 'request_type', 'requested_type', 'cycle_year', 'revision', 'status', 'school_name', 'education_level', 'grade_level', 'school_year', 'enrollment_term', 'reason', 'reviewed_by', 'document_mime']);
        foreach (['submitted_at', 'first_submitted_at', 'reviewed_at', 'correction_due_at'] as $field) {
            $result[$field] = $application->$field?->toIso8601String();
        }
        if ($admin) {
            $profile = $application->commuter;
            $result['commuter'] = $profile->only(['id', 'first_name', 'middle_name', 'surname', 'birthdate', 'gender', 'contact_number', 'username', 'commuter_type']);
            $result['commuter']['email'] = $profile->user->email;
            if ($withDocument && $application->document_path) {
                $result['document_url'] = Storage::disk($this->documentDisk($application->document_path))->temporaryUrl($application->document_path, now()->addMinutes(10));
            }
        }

        return $result;
    }

}
