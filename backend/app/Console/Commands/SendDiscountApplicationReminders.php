<?php

namespace App\Console\Commands;

use App\Models\DiscountApplication;
use App\Services\AnnouncementService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class SendDiscountApplicationReminders extends Command
{
    protected $signature = 'discount-applications:send-reminders';

    protected $description = 'Remind admins once per submission about discount applications waiting at least 24 hours';

    public function handle(AnnouncementService $announcements): int
    {
        $cutoff = now()->subDay();
        $failed = 0;
        $eligible = fn () => DiscountApplication::query()
            ->where('request_type', 'APPLICATION')
            ->where('status', 'PENDING')
            ->where('submitted_at', '<=', $cutoff)
            ->whereHas('commuter.user')
            // Sign-up school details wait with the registration, which has its own reminders.
            ->whereRelation('commuter', 'account_status', '!=', 'PENDING')
            ->whereNotExists(function ($query) {
                // Include read, archived and deleted reminders to avoid repeat alerts.
                $query->selectRaw('1')->from('announcements')
                    ->whereColumn('announcements.reference_id', 'discount_applications.id')
                    ->where('announcements.type', 'DISCOUNT_APPLICATION_WAITING')
                    ->whereColumn('announcements.created_at', '>=', 'discount_applications.submitted_at');
            });

        $eligible()->select('id')->chunkById(100, function ($applications) use ($eligible, $announcements, &$failed) {
            foreach ($applications as $candidate) {
                try {
                    DB::transaction(function () use ($candidate, $eligible, $announcements) {
                        DiscountApplication::query()->whereKey($candidate->id)->lockForUpdate()->first();
                        $application = $eligible()->with('commuter:id,first_name,surname')->whereKey($candidate->id)->first();
                        if (! $application) return;

                        $name = trim($application->commuter->first_name.' '.$application->commuter->surname);
                        $hours = max(24, (int) $application->submitted_at->diffInHours(now()));
                        $announcements->notifyAdmins(
                            'DISCOUNT_APPLICATION_WAITING',
                            "Discount review waiting {$hours} hours: {$name}",
                            "{$name}'s {$application->requested_type} discount application has been awaiting review for {$hours} hours.",
                            $application->id,
                        );
                    }, 3);
                } catch (\Throwable $error) {
                    $failed++;
                    Log::error('Discount application reminder failed', ['application_id' => $candidate->id, 'message' => $error->getMessage()]);
                }
            }
        });

        return $failed > 0 ? self::FAILURE : self::SUCCESS;
    }
}
