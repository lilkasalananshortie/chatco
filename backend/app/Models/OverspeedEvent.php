<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * A recorded overspeeding incident for the admin monitoring history.
 * One row per shift, tracking the top speed reached over the limit.
 */
class OverspeedEvent extends Model
{
    protected $fillable = [
        'shift_id',
        'conductor_id',
        'driver_id',
        'vehicle_id',
        'conductor_name',
        'driver_name',
        'unit_number',
        'plate_number',
        'top_speed',
        'threshold',
        'date',
        'last_logged_at',
    ];

    protected function casts(): array
    {
        return [
            'top_speed' => 'integer',
            'threshold' => 'integer',
            'date' => 'date',
            'last_logged_at' => 'datetime',
        ];
    }
}
