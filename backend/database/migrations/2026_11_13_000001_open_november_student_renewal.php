<?php

use App\Models\Setting;
use App\Services\StudentRenewalService;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        // The earlier migration has already run on deployed databases. Change
        // the saved setting and existing student deadlines together so the
        // November 2026 window opens for students who are already enrolled.
        DB::transaction(function (): void {
            Setting::updateOrCreate(
                ['key' => Setting::STUDENT_RENEWAL_MONTH_KEY],
                ['value' => '11', 'category' => 'financial']
            );

            StudentRenewalService::alignExpiries(11);
        });

        Cache::forget(Setting::STUDENT_RENEWAL_MONTH_CACHE_KEY);
    }

    public function down(): void
    {
        // Expiry dates and the previous admin setting cannot be reconstructed.
    }
};
