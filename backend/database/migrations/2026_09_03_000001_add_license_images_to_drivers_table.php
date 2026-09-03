<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('drivers', function (Blueprint $table) {
            $table->string('license_front_image_url', 500)->nullable()->after('license_number');
            $table->string('license_back_image_url', 500)->nullable()->after('license_front_image_url');
        });
    }

    public function down(): void
    {
        Schema::table('drivers', function (Blueprint $table) {
            $table->dropColumn(['license_front_image_url', 'license_back_image_url']);
        });
    }
};
