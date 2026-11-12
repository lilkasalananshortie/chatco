<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * `category` / `conductor_category` hold the commuter's selected feedback tags,
 * comma-joined. At 50 characters a long selection was cut mid-tag on submit
 * ("…Dirty Vehicle, Lo"), losing tags the admin Ratings & Feedback modal
 * displays and ranks. 255 fits every preset tag for either role at once.
 *
 * A new migration (not an edit of create_feedback_table) because the column
 * already exists on deployed databases.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('feedback', function (Blueprint $table) {
            $table->string('category', 255)->nullable()->change();
            $table->string('conductor_category', 255)->nullable()->change();
        });
    }

    public function down(): void
    {
        // Rows longer than 50 characters must be shortened before rolling back.
        Schema::table('feedback', function (Blueprint $table) {
            $table->string('category', 50)->nullable()->change();
            $table->string('conductor_category', 50)->nullable()->change();
        });
    }
};
