<?php

use App\Http\Controllers\AnnouncementController;
use App\Http\Controllers\Auth\PasswordChangeController;
use App\Http\Controllers\Commuter\CommuterController;
use App\Http\Controllers\Commuter\EmailChangeController;
use App\Http\Controllers\Commuter\FeedbackController;
use App\Http\Controllers\Commuter\HailController;
use App\Http\Controllers\Commuter\ShareRideController;
use App\Http\Controllers\Commuter\SosController;
use App\Http\Controllers\Commuter\VehicleLocationController;
use App\Http\Controllers\Conductor\ConductorController;
use App\Http\Controllers\Conductor\ConductorHailController;
use App\Http\Controllers\Conductor\MobileTransactionController;
use App\Http\Controllers\FareMatrixController;
use App\Http\Controllers\LostItemController;
use App\Http\Controllers\Mobile\MobileAuthController;
use App\Http\Controllers\Mobile\MobileHailController;
use App\Http\Controllers\Payment\PaymentController;
use App\Http\Controllers\Payment\QrController;
use App\Http\Controllers\RouteGeometryController;
use App\Http\Controllers\SystemStatusController;
use App\Http\Controllers\StudentRenewalController;
use Illuminate\Support\Facades\Route;

// Loaded inside api.php: retains /api/v1 and the existing API middleware.
// Keep domain services, account records, and financial idempotency shared.
Route::prefix('mobile')->group(function () {
    Route::prefix('auth')->group(function () {
        Route::post('/login', [MobileAuthController::class, 'login'])->middleware('throttle:auth');
        Route::post('/register', [MobileAuthController::class, 'register'])->middleware(['throttle:auth', 'maintenance:COMMUTER']);
        Route::post('/register/send-code', [MobileAuthController::class, 'sendRegistrationCode'])->middleware(['throttle:auth', 'maintenance:COMMUTER']);
        Route::post('/register/verify-code', [MobileAuthController::class, 'verifyRegistrationCode'])->middleware(['throttle:auth', 'maintenance:COMMUTER']);
        Route::post('/forgot-password', [MobileAuthController::class, 'forgotPassword'])->middleware('throttle:auth');
        Route::post('/verify-reset-code', [MobileAuthController::class, 'verifyResetCode'])->middleware('throttle:auth');
        Route::post('/reset-password', [MobileAuthController::class, 'resetPassword'])->middleware('throttle:auth');
        Route::get('/session', [MobileAuthController::class, 'session'])->middleware(['auth:sanctum', 'role:CONDUCTOR,COMMUTER'])->name('mobile.auth.session');
        Route::post('/set-new-password', [MobileAuthController::class, 'setNewPassword'])->middleware(['auth:sanctum', 'role:CONDUCTOR,COMMUTER', 'throttle:auth'])->name('mobile.auth.set-new-password');
        Route::post('/logout', [MobileAuthController::class, 'logout'])->middleware(['auth:sanctum', 'role:CONDUCTOR,COMMUTER'])->name('mobile.auth.logout');
    });

    Route::get('/user', [MobileAuthController::class, 'user'])->middleware(['auth:sanctum', 'role:CONDUCTOR,COMMUTER']);
    Route::get('/fare-matrix', [FareMatrixController::class, 'index'])->middleware('throttle:public-read');
    Route::get('/routes/active', [RouteGeometryController::class, 'active'])->middleware('throttle:public-read');
    Route::get('/system-status', [SystemStatusController::class, 'index'])->middleware('throttle:commuter-hail');

    // Ownership checks and simulation restrictions remain in PaymentController.
    Route::prefix('payments')->middleware(['auth:sanctum', 'role:CONDUCTOR,COMMUTER', 'maintenance'])->group(function () {
        Route::get('/{id}/status', [PaymentController::class, 'status'])->middleware('throttle:conductor-read');
        Route::post('/{id}/cancel', [PaymentController::class, 'cancel'])->middleware('throttle:conductor-write');
        Route::post('/{id}/simulate', [PaymentController::class, 'simulate'])->middleware('throttle:conductor-write');
    });
});

/*
|--------------------------------------------------------------------------
| Mobile Specific Conductor Routes (Phase 1 Isolation)
|--------------------------------------------------------------------------
| Dedicated namespace /api/v1/mobile/conductor/* for mobile app clients.
| Isolates mobile traffic from web conductor traffic so future platform-specific
| behaviors can evolve independently without breaking web endpoints.
|--------------------------------------------------------------------------
*/
Route::prefix('mobile/conductor')->middleware(['auth:sanctum', 'role:CONDUCTOR', 'maintenance'])->group(function () {
    Route::get('/shift', [ConductorController::class, 'shiftStatus'])->middleware('throttle:conductor-read');
    Route::get('/shift-logs', [ConductorController::class, 'shiftLogs'])->middleware('throttle:conductor-read');
    Route::get('/profile', [ConductorController::class, 'profile'])->middleware('throttle:conductor-read');
    Route::post('/profile/photo', [ConductorController::class, 'uploadProfilePhoto'])->middleware('throttle:conductor-write');
    Route::get('/units', [ConductorController::class, 'units'])->middleware('throttle:conductor-read');
    Route::get('/drivers', [ConductorController::class, 'drivers'])->middleware('throttle:conductor-read');
    Route::get('/receipt-settings', [ConductorController::class, 'receiptSettings'])->middleware('throttle:conductor-read');
    Route::get('/safety-settings', [ConductorController::class, 'safetySettings'])->middleware('throttle:conductor-read');
    Route::get('/ratings', [ConductorController::class, 'ratings'])->middleware('throttle:conductor-read');

    Route::post('/shifts/start', [ConductorController::class, 'startShift'])->middleware('throttle:conductor-mutation');
    Route::post('/shifts/device/claim', [ConductorController::class, 'claimShiftDevice'])->middleware('throttle:conductor-mutation');
    Route::post('/shifts/device/release', [ConductorController::class, 'releaseShiftDevice'])->middleware('throttle:conductor-mutation');
    Route::post('/remittances', [ConductorController::class, 'remittances'])->middleware('throttle:conductor-mutation');
    Route::get('/remittances', [ConductorController::class, 'remittancesIndex'])->middleware('throttle:conductor-read');

    Route::post('/sos', [App\Http\Controllers\Conductor\SosController::class, 'trigger'])->middleware('throttle:conductor-mutation');
    Route::get('/sos/{id}', [App\Http\Controllers\Conductor\SosController::class, 'show'])->middleware('throttle:conductor-read');
    Route::patch('/sos/{id}/stop', [App\Http\Controllers\Conductor\SosController::class, 'stop'])->middleware('throttle:conductor-write');

    Route::post('/location', [ConductorController::class, 'updateLocation'])->middleware('throttle:conductor-gps');
    Route::post('/capacity-status', [ConductorController::class, 'updateCapacityStatus'])->middleware('throttle:conductor-write');
    Route::post('/break-status', [ConductorController::class, 'updateBreakStatus'])->middleware('throttle:conductor-write');

    Route::get('/transactions', [MobileTransactionController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/transactions', [MobileTransactionController::class, 'store'])->middleware('throttle:conductor-write');
    Route::post('/transactions/sync', [MobileTransactionController::class, 'syncBatch'])->middleware('throttle:conductor-write');
    Route::post('/payments/gcash/initiate', [ConductorController::class, 'initiateGcash'])->middleware('throttle:conductor-write');
    Route::get('/payments/gcash/pending', [ConductorController::class, 'pendingGcash'])->middleware('throttle:conductor-read');
    Route::get('/announcements', [AnnouncementController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/announcements/{id}/read', [AnnouncementController::class, 'markRead'])->middleware('throttle:conductor-write');
    Route::get('/earnings', [ConductorController::class, 'earnings'])->middleware('throttle:conductor-read');

    Route::get('/hails', [ConductorHailController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/hails/{id}/accept', [ConductorHailController::class, 'accept'])->middleware('throttle:conductor-write');
    Route::post('/hails/{id}/reject', [ConductorHailController::class, 'reject'])->middleware('throttle:conductor-write');
});

/*
|--------------------------------------------------------------------------
| Mobile Specific Commuter Routes (Phase 1 Isolation)
|--------------------------------------------------------------------------
| Dedicated namespace /api/v1/mobile/commuter/* for commuter mobile app clients.
| Isolates mobile commuter traffic from web commuter traffic so platform-specific
| behaviors can evolve independently without breaking web endpoints.
|--------------------------------------------------------------------------
*/
Route::prefix('mobile/commuter')->middleware(['auth:sanctum', 'role:COMMUTER', 'maintenance'])->group(function () {
    Route::get('/change-email', [EmailChangeController::class, 'state'])->middleware('throttle:commuter-read');
    Route::prefix('change-email')->middleware('throttle:commuter-security')->group(function () {
        Route::post('/start', [EmailChangeController::class, 'start']);
        Route::post('/send-code', [EmailChangeController::class, 'sendCode']);
        Route::post('/verify-identity', [EmailChangeController::class, 'verifyIdentity']);
        Route::post('/confirm', [EmailChangeController::class, 'confirm']);
        Route::post('/cancel', [EmailChangeController::class, 'cancel']);
    });
    Route::get('/discount-applications', [StudentRenewalController::class, 'applicationState'])->middleware('throttle:commuter-read');
    Route::post('/discount-applications', [StudentRenewalController::class, 'applicationSubmit'])->middleware('throttle:conductor-write');
    Route::post('/discount-applications/cancel', [StudentRenewalController::class, 'applicationCancel'])->middleware('throttle:conductor-write');
    Route::get('/student-renewal', [StudentRenewalController::class, 'state'])->middleware('throttle:commuter-read');
    Route::post('/student-renewal', [StudentRenewalController::class, 'submit'])->middleware('throttle:conductor-write');
    Route::post('/student-renewal/regular', [StudentRenewalController::class, 'regular'])->middleware('throttle:conductor-write');
    Route::post('/student-renewal/reminder', [StudentRenewalController::class, 'reminder'])->middleware('throttle:conductor-write');
    Route::get('/profile', [CommuterController::class, 'profile'])->middleware('throttle:conductor-read');
    Route::put('/profile', [CommuterController::class, 'updateProfile'])->middleware('throttle:conductor-write');
        Route::post('/profile/photo', [CommuterController::class, 'uploadProfilePhoto'])->middleware('throttle:conductor-write');
    Route::post('/change-password/request-code', [PasswordChangeController::class, 'requestCode'])->middleware('throttle:account-security');
    Route::post('/change-password/confirm', [PasswordChangeController::class, 'confirm'])->middleware('throttle:account-security');
    Route::get('/trips', [CommuterController::class, 'trips'])->middleware('throttle:conductor-read');
    Route::get('/rewards', [CommuterController::class, 'rewards'])->middleware('throttle:conductor-read');
    Route::get('/vouchers', [CommuterController::class, 'vouchers'])->middleware('throttle:commuter-read');
    Route::post('/location', [CommuterController::class, 'updateLocation'])->middleware('throttle:commuter-hail');

    Route::post('/share-ride', [ShareRideController::class, 'store'])->middleware('throttle:share-ride-update');
    Route::delete('/share-ride', [ShareRideController::class, 'destroy'])->middleware('throttle:share-ride-update');

    Route::post('/hail', [HailController::class, 'store'])->middleware('throttle:commuter-hail');
    Route::get('/hail/{id}', [MobileHailController::class, 'show'])->middleware('throttle:commuter-read');
    Route::get('/hails/active', [MobileHailController::class, 'active'])->middleware('throttle:commuter-read');
    Route::delete('/hail/{id}', [HailController::class, 'destroy'])->middleware('throttle:commuter-hail');

    Route::post('/payments/claim', [PaymentController::class, 'claim'])->middleware('throttle:commuter-hail');
    Route::get('/payments', [PaymentController::class, 'history'])->middleware('throttle:conductor-read');
    Route::post('/receipts/claim', [PaymentController::class, 'claimReceipt'])->middleware('throttle:commuter-hail');
    Route::post('/payments/{id}/redeem-voucher', [PaymentController::class, 'redeemVoucher'])->middleware('throttle:commuter-hail');

    Route::post('/feedback', [FeedbackController::class, 'store'])->middleware('throttle:commuter-feedback');
    Route::get('/feedback', [FeedbackController::class, 'index'])->middleware('throttle:conductor-read');

    Route::post('/sos', [SosController::class, 'trigger'])->middleware('throttle:sos');
    Route::get('/sos/{id}', [SosController::class, 'show'])->middleware('throttle:conductor-read');
    Route::patch('/sos/{id}/stop', [SosController::class, 'stop'])->middleware('throttle:conductor-write');

    Route::get('/watchlist', [LostItemController::class, 'myWatchlist'])->middleware('throttle:conductor-read');
    Route::get('/claims', [LostItemController::class, 'myClaims'])->middleware('throttle:conductor-read');

    Route::post('/qr/validate', [QrController::class, 'verify'])->middleware('throttle:commuter-write');
    Route::post('/qr/scan', [QrController::class, 'scan'])->middleware('throttle:commuter-write');
    Route::post('/qr/scan-public', [QrController::class, 'scanPublic'])->middleware('throttle:commuter-write');

    Route::get('/vehicles/locations', [VehicleLocationController::class, 'index'])->middleware('throttle:vehicle-locations');

    Route::get('/announcements', [AnnouncementController::class, 'index'])->middleware('throttle:commuter-read');
    Route::get('/announcements/unread-count', [AnnouncementController::class, 'unreadCount'])->middleware('throttle:commuter-read');
    Route::post('/announcements/mark-all-read', [AnnouncementController::class, 'markAllRead'])->middleware('throttle:commuter-write');
    Route::post('/announcements/{id}/read', [AnnouncementController::class, 'markRead'])->middleware('throttle:commuter-write');
});
