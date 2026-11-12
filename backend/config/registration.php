<?php

return [

    'terms_version' => '2026-10-12',
    'privacy_version' => '2026-10-12',

    // The first renewal window is November 2026.
    'student_renewal_first_year' => 2026,
    // Default only: Settings > Financial Rules saves the live month (Setting::studentRenewalMonth()).
    'student_renewal_month' => 11,

    /*
    |--------------------------------------------------------------------------
    | Registration Rejection Safety Net
    |--------------------------------------------------------------------------
    |
    | A commuter whose registration is rejected may re-register with the same
    | email/username (the account is soft-deleted and the identifiers freed).
    | To stop abuse of that re-registration path, every rejection is logged and
    | counted against the applicant's identity (email OR contact number). Once
    | the count reaches `rejection_threshold`, a cooldown of `cooldown_days` is
    | applied — the applicant cannot create a new account until it elapses.
    |
    | Both values are tunable via env so operations can loosen/tighten the
    | policy without a code change.
    |
    */

    // Number of rejections (inclusive) at which a cooldown block is triggered.
    'rejection_threshold' => (int) env('REGISTRATION_REJECTION_THRESHOLD', 3),

    // How many days the applicant is blocked from re-registering once the
    // threshold is reached.
    'cooldown_days' => (int) env('REGISTRATION_COOLDOWN_DAYS', 3),

];
