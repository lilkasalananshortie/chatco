<?php

/**
 * Overspeeding history — a persisted log for the admin monitoring module.
 *
 * WHY:
 *   The admin "Overspeeding History" table previously showed only a LIVE
 *   snapshot of vehicles currently over the speed limit (from
 *   vehicle_locations); nothing was recorded, so an incident vanished the
 *   moment the unit slowed down. This table persists each overspeeding
 *   incident so admins have a durable, date-filterable history.
 *
 * GRAIN: one row per shift. The row tracks the TOP speed reached during that
 * shift (updated upward as faster GPS pings arrive), plus the denormalized
 * conductor/driver/unit identity so the history survives even if the shift
 * or personnel records change later.
 *
 * Additive + guarded (MySQL dev + SQLite tests).
 */

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('overspeed_events')) {
            return;
        }

        Schema::create('overspeed_events', function (Blueprint $table) {
            $table->id();

            // One row per shift — the dedup key for "top speed this shift".
            $table->string('shift_id', 20)->unique();

            // Denormalized identity (mirrors the remittances pattern) so the
            // history stays intact regardless of later record changes. No FK
            // constraints, keeping this feature self-contained.
            $table->uuid('conductor_id')->nullable();
            $table->uuid('driver_id')->nullable();
            $table->uuid('vehicle_id')->nullable();
            $table->string('conductor_name', 100)->nullable();
            $table->string('driver_name', 100)->nullable();
            $table->string('unit_number', 20)->nullable();
            $table->string('plate_number', 20)->nullable();

            // Highest speed reached over the limit (km/h) + the limit that
            // applied when it was logged.
            $table->unsignedSmallInteger('top_speed');
            $table->unsignedSmallInteger('threshold');

            // For the admin date filter, and when the top speed last changed.
            $table->date('date')->index();
            $table->timestamp('last_logged_at');

            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('overspeed_events');
    }
};
