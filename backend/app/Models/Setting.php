<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

class Setting extends Model
{
    public const RIDES_FOR_FREE_REWARD_KEY = 'rides_for_free_reward';

    public const DEFAULT_RIDES_FOR_FREE_REWARD = 10;

    public const MAX_RIDES_FOR_FREE_REWARD = 100;

    public const REWARD_RULE_CACHE_KEY = 'settings.reward_rule';

    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id',
        'key',
        'value',
        'reward_rule_version',
        'category',
        'updated_by',
    ];

    protected function casts(): array
    {
        return [
            'updated_by' => 'string',
            'reward_rule_version' => 'integer',
        ];
    }

    protected static function booted(): void
    {
        static::creating(function (Setting $setting) {
            if (empty($setting->id)) {
                $setting->id = (string) Str::uuid();
            }
        });

        static::saved(function (Setting $setting): void {
            if ($setting->key === self::RIDES_FOR_FREE_REWARD_KEY) {
                self::forgetRewardRuleCache();
            }
            if ($setting->key === self::STUDENT_RENEWAL_MONTH_KEY) {
                Cache::forget(self::STUDENT_RENEWAL_MONTH_CACHE_KEY);
            }
        });

        static::deleted(function (Setting $setting): void {
            if ($setting->key === self::RIDES_FOR_FREE_REWARD_KEY) {
                self::forgetRewardRuleCache();
            }
        });
    }

    /** Settings > App Configuration > "Force Valid ID Upload". */
    public const REQUIRE_ID_UPLOAD_KEY = 'require_id_upload';

    /**
     * Whether a REGULAR commuter must upload an ID to register. Defaults to
     * true (the behaviour before this setting was read) until an admin saves
     * the toggle. Student, Senior and PWD applicants always need an ID: it is
     * the proof of their discount, so this toggle never relaxes it for them.
     */
    public static function requiresIdUpload(): bool
    {
        $value = static::query()->where('key', self::REQUIRE_ID_UPLOAD_KEY)->value('value');

        return $value === null || $value === 'true';
    }

    /** Settings > Financial Rules > "Student renewal month" (1-12). */
    public const STUDENT_RENEWAL_MONTH_KEY = 'student_renewal_month';

    public const STUDENT_RENEWAL_MONTH_CACHE_KEY = 'settings.student_renewal_month';

    /** The month students renew in. Falls back to config until an admin saves one. */
    public static function studentRenewalMonth(): int
    {
        // Cached as an int (0 = not saved) because Cache::remember never stores null.
        $saved = Cache::remember(self::STUDENT_RENEWAL_MONTH_CACHE_KEY, now()->addMinutes(5),
            fn (): int => (int) static::where('key', self::STUDENT_RENEWAL_MONTH_KEY)->value('value'));

        return $saved >= 1 && $saved <= 12 ? $saved : (int) config('registration.student_renewal_month', 11);
    }

    /** Settings > Voucher Generator > "Receipt QR free-ride promo". */
    public const RECEIPT_SCAN_REWARD_KEY = 'receipt_scan_reward_enabled';

    /**
     * Whether scanning a paper cash receipt's QR binds the ride and counts it
     * toward the free-ride reward. Defaults to true (the behaviour before this
     * setting existed) until an admin saves the toggle.
     */
    public static function receiptScanRewardEnabled(): bool
    {
        $value = static::query()->where('key', self::RECEIPT_SCAN_REWARD_KEY)->value('value');

        return $value === null || $value === 'true';
    }

    /**
     * Return a calculation-safe reward threshold.
     *
     * Admin writes are validated, but this fallback also protects calculations
     * from legacy or manually corrupted setting rows.
     */
    public static function ridesForFreeReward(): int
    {
        return self::rewardRule()['threshold'];
    }

    /**
     * Return the active threshold and its non-retroactive rule version.
     *
     * Every real threshold change increments the version. Qualifying rides
     * remain attached to the version active when they became rewardable, so a
     * lower threshold never reinterprets historical rides.
     *
     * @return array{threshold: int, version: int}
     */
    public static function rewardRule(bool $lockForUpdate = false): array
    {
        if (! $lockForUpdate) {
            return Cache::remember(
                self::REWARD_RULE_CACHE_KEY,
                now()->addMinutes(5),
                fn (): array => self::loadRewardRule(),
            );
        }

        return self::loadRewardRule(lockForUpdate: true);
    }

    public static function forgetRewardRuleCache(): void
    {
        Cache::forget(self::REWARD_RULE_CACHE_KEY);
    }

    /** @return array{threshold: int, version: int} */
    private static function loadRewardRule(bool $lockForUpdate = false): array
    {
        $query = static::where('key', self::RIDES_FOR_FREE_REWARD_KEY);
        if ($lockForUpdate) {
            $query->lockForUpdate();
        }

        $setting = $query->first();

        return [
            'threshold' => self::validatedRewardThreshold($setting?->value),
            'version' => max(1, (int) ($setting?->reward_rule_version ?? 1)),
        ];
    }

    public static function validatedRewardThreshold(mixed $configured): int
    {
        $validated = filter_var($configured, FILTER_VALIDATE_INT, [
            'options' => [
                'min_range' => 1,
                'max_range' => self::MAX_RIDES_FOR_FREE_REWARD,
            ],
        ]);

        return $validated === false
            ? self::DEFAULT_RIDES_FOR_FREE_REWARD
            : $validated;
    }
}
