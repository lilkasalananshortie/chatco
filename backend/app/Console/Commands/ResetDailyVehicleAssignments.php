<?php

namespace App\Console\Commands;

use App\Enums\ShiftStatus;
use App\Models\Driver;
use App\Models\Remittance;
use App\Models\ShiftLog;
use App\Models\Vehicle;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Artisan command: php artisan vehicles:reset-daily-assignments
 *
 * Automatic daily reset (12:00 AM). For every vehicle, each unit starts the
 * new day with no active personnel. Any shift still ACTIVE at midnight is
 * treated as an end-of-day close-out:
 *
 *   1. A Remittance record is created (the conductor's collected cash + gcash
 *      is auto-remitted, no shortage → status COMPLETE). NO passenger count is
 *      recorded for the midnight auto-remit (total_passengers = 0).
 *   3. The vehicle's current driver/conductor/active-shift assignment is cleared.
 *   4. The driver's active_shift_id is cleared.
 *
 * The shift itself is flipped to ENDED (with time_out) so the conductor's
 * money is recorded as remitted automatically at midnight.
 *
 * Data integrity: historical records are only APPENDED to, never destroyed —
 * shift_logs rows are ended (not deleted), and a remittance row is created.
 * Only the mutable "current assignment" columns on the vehicles table are
 * reset to null.
 *
 * Scheduled to run daily at 00:00 via routes/console.php:
 *   Schedule::command('vehicles:reset-daily-assignments')->dailyAt('00:00')
 *
 * Production deployment requires the Laravel scheduler to be running:
 *   php artisan schedule:work   (dev)
 *   php artisan schedule:run    (production, via system cron: * * * * *)
 *
 * The command can also be run manually for testing/ops:
 *   php artisan vehicles:reset-daily-assignments
 */
class ResetDailyVehicleAssignments extends Command
{
    /**
     * @var string
     */
    protected $signature = 'vehicles:reset-daily-assignments';

    /**
     * @var string
     */
    protected $description = 'End active shifts + auto-remit their cash/gcash, then clear current driver/conductor/shift on all vehicles (daily 12AM reset).';

    /**
     * Execute the console command.
     */
    public function handle(): int
    {
        // ─── 1/4. Close out every shift that is still ACTIVE at midnight ───
        // Each one is ended + its cash/gcash auto-remitted (status COMPLETE),
        // and its driver assignment cleared. Historical rows are appended to,
        // never destroyed.
        $activeShifts = ShiftLog::where('status', ShiftStatus::ACTIVE)->get();

        $remitted = 0;
        foreach ($activeShifts as $shift) {
            try {
                $this->closeOutShift($shift);
                $remitted++;
            } catch (\Throwable $e) {
                $this->error("  ✗ Failed to close out shift {$shift->shift_id}: {$e->getMessage()}");
                Log::error('Daily midnight shift close-out failed', [
                    'shift_id' => $shift->shift_id,
                    'error'    => $e->getMessage(),
                ]);
            }
        }

        // ─── 3. Clear current assignment on EVERY vehicle ─────────────────
        // Idempotent guarantee that all units start the new day unassigned —
        // catches any vehicle whose assignment lingered without an active shift.
        $affected = Vehicle::query()->update([
            'driver_id'       => null,
            'conductor_id'    => null,
            'active_shift_id' => null,
        ]);

        $this->info("{$remitted} active shift(s) ended + auto-remitted; {$affected} vehicle(s) reset.");

        return self::SUCCESS;
    }

    /**
     * End a single ACTIVE shift as a midnight close-out: create its remittance
     * (cash + gcash auto-remitted, no shortage, NO passenger count), flip the
     * shift to ENDED, and clear the driver's active_shift_id. The vehicle
     * columns are cleared by the bulk reset in handle().
     *
     * Mirrors ShiftService::endShiftViaRemittance, but the totals come purely
     * from the DB (no conductor-declared cash) and total_passengers is 0.
     */
    private function closeOutShift(ShiftLog $shift): void
    {
        $shiftIdValue = $shift->getRawOriginal('shift_id');

        $cashTotal = (float) DB::selectOne(
            "SELECT COALESCE(SUM(final_amount), 0) as total FROM transactions WHERE shift_id = ? AND payment_method = 'CASH' AND status = 'PAID'",
            [$shiftIdValue]
        )->total;

        $gcashTotal = (float) DB::selectOne(
            "SELECT COALESCE(SUM(final_amount), 0) as total FROM transactions WHERE shift_id = ? AND payment_method = 'GCASH' AND status = 'PAID'",
            [$shiftIdValue]
        )->total;

        $timeOut = now();

        DB::transaction(function () use ($shift, $cashTotal, $gcashTotal, $timeOut) {
            Remittance::create([
                'shift_id'          => $shift->shift_id,
                'conductor_id'      => $shift->conductor_id,
                'driver_id'         => $shift->driver_id,
                'vehicle_id'        => $shift->vehicle_id,
                'date'              => $shift->time_in->toDateString(),
                'conductor_name'    => $shift->conductor_name,
                'driver_name'       => $shift->driver_name,
                'unit_number'       => $shift->unit_number,
                'total_passengers'  => 0, // Midnight auto-remit records no passenger count.
                'time_in'           => $shift->time_in,
                'time_out'          => $timeOut,
                'total_collected'   => $cashTotal,
                'remitted_amount'   => $cashTotal,
                'shortage'          => 0, // Auto-remit: full amount, no shortage.
                'cash_total'        => $cashTotal,
                'gcash_total'       => $gcashTotal,
                'remittance_status' => 'COMPLETE',
            ]);

            $shift->update([
                'status'    => ShiftStatus::ENDED->value,
                'is_active' => false,
                'time_out'  => $timeOut,
            ]);

            if ($shift->driver_id) {
                Driver::where('id', $shift->driver_id)
                    ->where('active_shift_id', $shift->shift_id)
                    ->update(['active_shift_id' => null]);
            }
        });

        Log::info('Shift auto-remitted at midnight daily reset', [
            'shift_id'     => $shift->shift_id,
            'conductor_id' => $shift->conductor_id,
            'cash_total'   => $cashTotal,
            'gcash_total'  => $gcashTotal,
        ]);
    }
}
