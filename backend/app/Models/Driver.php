<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Str;

class Driver extends Model
{
    use HasFactory, SoftDeletes;

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'first_name',
        'middle_name',
        'last_name',
        'birthday',
        'contact',
        'license_number',
        'license_front_image_url',
        'license_back_image_url',
        'hire_date',
        'profile_picture_url',
        'status',
        'vehicle_id',
        'active_shift_id',
    ];

    protected function casts(): array
    {
        return [
            'birthday' => 'date',
            'hire_date' => 'date',
            'active_shift_id' => 'string',
        ];
    }

    /**
     * Auto-generate UUID for the primary key on create.
     * The drivers table uses a UUID PK (not auto-increment), so the
     * model must populate it before insert — matches the User/Route
     * pattern used elsewhere in the codebase.
     */
    protected static function booted(): void
    {
        static::creating(function (Driver $driver) {
            if (empty($driver->id)) {
                $driver->id = (string) Str::uuid();
            }
        });
    }

    public function vehicle()
    {
        return $this->belongsTo(Vehicle::class);
    }

    /**
     * The currently active shift for this driver.
     * FK active_shift_id → shift_logs.shift_id
     */
    public function activeShift()
    {
        return $this->belongsTo(ShiftLog::class, 'active_shift_id', 'shift_id');
    }

    public function shiftLogs()
    {
        return $this->hasMany(ShiftLog::class);
    }

    public function hasActiveShift(): bool
    {
        return ! is_null($this->active_shift_id);
    }

    public function getActiveShift(): ?ShiftLog
    {
        return $this->activeShift;
    }
}
