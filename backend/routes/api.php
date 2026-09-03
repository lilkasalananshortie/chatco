<?php

use App\Http\Controllers\Admin\AdminActivityLogController;
use App\Http\Controllers\Admin\AdminAnnouncementController;
use App\Http\Controllers\Admin\AdminController;
use App\Http\Controllers\Admin\AdminFaqController;
use App\Http\Controllers\Admin\AdminFarePointController;
use App\Http\Controllers\Admin\AdminFeedbackController;
use App\Http\Controllers\Admin\AdminLostItemController;
use App\Http\Controllers\Admin\AdminRegistrationController;
use App\Http\Controllers\Admin\AdminRemittanceOptionController;
use App\Http\Controllers\Admin\AdminRouteController;
use App\Http\Controllers\Admin\AdminSettingController;
use App\Http\Controllers\Admin\AdminShiftDeviceController;
use App\Http\Controllers\Admin\AdminSosController;
use App\Http\Controllers\Admin\AdminUserController;
use App\Http\Controllers\Admin\AdminVehicleController;
use App\Http\Controllers\Admin\AdminVoucherController;
use App\Http\Controllers\AnnouncementController;
use App\Http\Controllers\Auth\AuthController;
use App\Http\Controllers\Commuter\CommuterController;
use App\Http\Controllers\Commuter\FeedbackController;
use App\Http\Controllers\Commuter\HailController;
use App\Http\Controllers\Commuter\ShareRideController;
use App\Http\Controllers\Commuter\SosController;
use App\Http\Controllers\Commuter\VehicleLocationController;
use App\Http\Controllers\Conductor\ConductorController;
use App\Http\Controllers\Conductor\ConductorHailController;
use App\Http\Controllers\FaqController;
use App\Http\Controllers\FareMatrixController;
use App\Http\Controllers\LostItemController;
use App\Http\Controllers\Payment\PaymentController;
use App\Http\Controllers\Payment\QrController;
use App\Http\Controllers\RouteGeometryController;
use App\Http\Controllers\SystemStatusController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Auth Routes (Public)
|--------------------------------------------------------------------------
*/
Route::prefix('auth')->group(function () {
    Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:auth');
    Route::post('/register', [AuthController::class, 'register'])->middleware('throttle:auth'); // PUBLIC — commuter self-sign-up (S5-T15)
    // Sign-up email verification — the applicant must enter a 6-digit code
    // mailed to their address before /register will create the account.
    Route::post('/register/send-code', [AuthController::class, 'sendRegistrationCode'])->middleware('throttle:auth');
    Route::post('/register/verify-code', [AuthController::class, 'verifyRegistrationCode'])->middleware('throttle:auth');
    Route::post('/logout', [AuthController::class, 'logout'])->middleware('auth:sanctum');
    // Password reset — public (no auth required, throttled to prevent abuse).
    // 3-step 6-digit-code flow: request code → verify code → set new password.
    Route::post('/forgot-password', [AuthController::class, 'forgotPassword'])->middleware('throttle:auth');
    Route::post('/verify-reset-code', [AuthController::class, 'verifyResetCode'])->middleware('throttle:auth');
    Route::post('/reset-password', [AuthController::class, 'resetPassword'])->middleware('throttle:auth');
});

/*
|--------------------------------------------------------------------------
| Fare Matrix (Public — fare info is public like a bus schedule)
|--------------------------------------------------------------------------
| Single source of truth for fare calculation. The conductor's FareCalcModal
| and the commuter's fare-calculator both consume this endpoint. The admin's
| /settings/fare-matrix page edits the fare_points table; changes are
| immediately visible to all consumers on their next fetch.
*/
Route::get('/fare-matrix', [FareMatrixController::class, 'index'])->middleware('throttle:commuter-hail');
Route::get('/routes/active', [RouteGeometryController::class, 'active'])->middleware('throttle:commuter-hail');

/*
|--------------------------------------------------------------------------
| FAQ (Public — powers the landing-page FAQ chat)
|--------------------------------------------------------------------------
| Returns active FAQ items grouped by category. Admins manage the content at
| /settings/faq-management (see the admin /faqs routes); changes are visible
| to the landing page on its next fetch.
*/
Route::get('/faqs', [FaqController::class, 'index'])->middleware('throttle:commuter-hail');

// Public system status — powers the landing-page maintenance screen. Admins
// toggle maintenance mode at /settings/app-configuration.
Route::get('/system-status', [SystemStatusController::class, 'index'])->middleware('throttle:commuter-hail');

// Public tracking endpoint — no auth required. Anyone with the token
// can view the commuter's live position (for the share-ride feature).
// Throttled per (IP + token) — see 'share-ride-track' in
// AppServiceProvider — so the 5s polling cadence is untouched while
// excessive hammering of one link is capped.
Route::get('/share/{token}', [ShareRideController::class, 'show'])->middleware('throttle:share-ride-track');

/*
|--------------------------------------------------------------------------
| Authenticated User Route
|--------------------------------------------------------------------------
*/
Route::middleware('auth:sanctum')->get('/user', [AuthController::class, 'user']);

/*
|--------------------------------------------------------------------------
| Commuter Routes (COMMUTER role required)
|--------------------------------------------------------------------------
*/
Route::prefix('commuter')->middleware(['auth:sanctum', 'role:COMMUTER'])->group(function () {
    Route::get('/profile', [CommuterController::class, 'profile'])->middleware('throttle:conductor-read');
    Route::put('/profile', [CommuterController::class, 'updateProfile'])->middleware('throttle:conductor-write');
    Route::post('/change-password', [CommuterController::class, 'changePassword'])->middleware('throttle:conductor-write');
    Route::get('/trips', [CommuterController::class, 'trips'])->middleware('throttle:conductor-read');
    Route::get('/rewards', [CommuterController::class, 'rewards'])->middleware('throttle:conductor-read');
    Route::post('/location', [CommuterController::class, 'updateLocation'])->middleware('throttle:commuter-hail');

    // Share Live Location — commuter generates a tracking link
    Route::post('/share-ride', [ShareRideController::class, 'store'])->middleware('throttle:commuter-hail');
    Route::delete('/share-ride', [ShareRideController::class, 'destroy'])->middleware('throttle:commuter-hail');

    // Hail lifecycle (commuter-side) — 10 req/min per user
    Route::post('/hail', [HailController::class, 'store'])->middleware('throttle:commuter-hail');
    Route::delete('/hail/{id}', [HailController::class, 'destroy'])->middleware('throttle:commuter-hail');

    // Payment lifecycle (commuter-side) — claim GCash + view history
    Route::post('/payments/claim', [PaymentController::class, 'claim'])->middleware('throttle:commuter-hail');
    Route::get('/payments', [PaymentController::class, 'history'])->middleware('throttle:conductor-read');

    // Paper cash receipt — scan the printed QR to bind the ride to this
    // commuter so it counts toward the reward cycle. Throttled like the other
    // scan-driven claim: the token is unguessable, and the low ceiling keeps
    // it from being brute-forced.
    Route::post('/receipts/claim', [PaymentController::class, 'claimReceipt'])->middleware('throttle:commuter-hail');

    // Cover the commuter's own portion of a claimed, still-PENDING GCash ride
    // with one of their available vouchers. Same throttle as the other
    // claim-adjacent, money-affecting commuter actions above.
    Route::post('/payments/{id}/redeem-voucher', [PaymentController::class, 'redeemVoucher'])->middleware('throttle:commuter-hail');

    // Feedback submission (S6) — its dedicated 5/min per-user limiter keeps
    // feedback retries isolated from hail, location, and payment claim limits.
    // The DB constraint still enforces one feedback per commuter per shift.
    Route::post('/feedback', [FeedbackController::class, 'store'])->middleware('throttle:commuter-feedback');

    // Feedback history (S6-T7) — the commuter's OWN feedback, newest first.
    // Powers the ride-history "Leave Feedback" / "View Feedback" flow: the
    // frontend fetches this once, builds a {shift_id → feedback} map, and
    // marks each PAID ride accordingly. Read-throttled (conductor-read =
    // 60/min). commuter_id is always auth()->id() server-side.
    Route::get('/feedback', [FeedbackController::class, 'index'])->middleware('throttle:conductor-read');

    // SOS alert (S6-T5) — commuter triggers an emergency alert with lat/lng.
    // Strictly rate-limited at 1/min per commuter (throttle:sos) to prevent
    // abuse. Admins acknowledge + resolve via /admin/sos endpoints.
    Route::post('/sos', [SosController::class, 'trigger'])->middleware('throttle:sos');

    // SOS status poll (S6-T10) — commuter polls their own alert to detect
    // when the admin acknowledges / resolves. Read-throttled (60/min) so the
    // modal can poll every 3s. Scoped to auth commuter in the service.
    Route::get('/sos/{id}', [SosController::class, 'show'])->middleware('throttle:conductor-read');

    // Lost & Found watchlist (S6-T3) — commuter's bookmarked items.
    // The browse + claim + watchlist toggle endpoints live in the shared
    // /lost-found group (any auth role for browse, COMMUTER for claim/watch).
    Route::get('/watchlist', [LostItemController::class, 'myWatchlist'])->middleware('throttle:conductor-read');

    // Lost & Found claims — the commuter's OWN claims (item eager-loaded).
    // Powers the "My Claims" tab + per-card claim badges so claim state
    // persists in the DB instead of living in React state.
    Route::get('/claims', [LostItemController::class, 'myClaims'])->middleware('throttle:conductor-read');
});

/*
|--------------------------------------------------------------------------
| Conductor Routes (CONDUCTOR role required)
|--------------------------------------------------------------------------
| Per-route throttle limits use named rate limiters (defined in
| AppServiceProvider::configureRateLimiters) so the 429 response uses
| the project's ApiResponse JSON envelope. Limits are tuned to the
| legitimate cadence of each endpoint:
|   - Read endpoints:  60 req/min  (1 req/s — generous for UI polling)
|   - GPS updates:     30 req/min  (supports 5s cadence w/ ~2.5x headroom)
|   - Shift mutations: 10 req/min  (one active shift per conductor anyway)
|   - Transactions:    30 req/min  (still a 501 stub — minimal limit)
|--------------------------------------------------------------------------
*/
Route::prefix('conductor')->middleware(['auth:sanctum', 'role:CONDUCTOR'])->group(function () {
    // Read endpoints — 60 req/min (generous for UI polling)
    Route::get('/shift', [ConductorController::class, 'shiftStatus'])->middleware('throttle:conductor-read');
    Route::get('/shift-logs', [ConductorController::class, 'shiftLogs'])->middleware('throttle:conductor-read');
    Route::get('/profile', [ConductorController::class, 'profile'])->middleware('throttle:conductor-read');
    Route::get('/units', [ConductorController::class, 'units'])->middleware('throttle:conductor-read');
    Route::get('/drivers', [ConductorController::class, 'drivers'])->middleware('throttle:conductor-read');
    Route::get('/receipt-settings', [ConductorController::class, 'receiptSettings'])->middleware('throttle:conductor-read');

    // Ratings for a shift the conductor crewed — powers the metrics page.
    // shift_id is required; the service scopes rows to auth()->id() so a
    // conductor can only read feedback for their own shifts.
    Route::get('/ratings', [ConductorController::class, 'ratings'])->middleware('throttle:conductor-read');

    // Mutations — strict limit (one shift per conductor at a time anyway).
    // 'maintenance' blocks starting a shift (conductor self-assignment) while
    // Maintenance Mode is on, so no assignment state is created mid-maintenance.
    Route::post('/shifts/start', [ConductorController::class, 'startShift'])->middleware(['maintenance', 'throttle:conductor-mutation']);
    Route::post('/shifts/device/claim', [ConductorController::class, 'claimShiftDevice'])->middleware('throttle:conductor-mutation');
    Route::post('/shifts/device/release', [ConductorController::class, 'releaseShiftDevice'])->middleware('throttle:conductor-mutation');
    Route::post('/remittances', [ConductorController::class, 'remittances'])->middleware('throttle:conductor-mutation');

    // Read — conductor's own submitted remittance history (Week 5).
    // Scoped to auth conductor in ConductorService::listRemittances().
    Route::get('/remittances', [ConductorController::class, 'remittancesIndex'])->middleware('throttle:conductor-read');

    // SOS alert — conductor triggers an emergency alert with lat/lng, mirroring
    // the commuter flow (sender_role=CONDUCTOR). Admins acknowledge + resolve
    // via /admin/sos. Mutation-throttled; the poll is read-throttled (60/min)
    // so the modal can poll every 3s. Scoped to the auth conductor in the service.
    Route::post('/sos', [App\Http\Controllers\Conductor\SosController::class, 'trigger'])->middleware('throttle:conductor-mutation');
    Route::get('/sos/{id}', [App\Http\Controllers\Conductor\SosController::class, 'show'])->middleware('throttle:conductor-read');

    // GPS updates — allows 5-second cadence with headroom for retries/reconnects
    Route::post('/location', [ConductorController::class, 'updateLocation'])->middleware('throttle:conductor-gps');

    // Capacity status updates
    Route::post('/capacity-status', [ConductorController::class, 'updateCapacityStatus'])->middleware('throttle:conductor-write');
    Route::post('/break-status', [ConductorController::class, 'updateBreakStatus'])->middleware('throttle:conductor-write');

    // Transaction lifecycle (S4-T5) — cash recording, GCash initiate, earnings.
    // POST fare recording uses conductor-write (30/min) — comfortably above
    // the real boarding cadence; reads use conductor-read (60/min).
    Route::get('/transactions', [ConductorController::class, 'transactions'])->middleware('throttle:conductor-read');
    Route::post('/transactions', [ConductorController::class, 'storeTransaction'])->middleware('throttle:conductor-write');
    Route::post('/payments/gcash/initiate', [ConductorController::class, 'initiateGcash'])->middleware('throttle:conductor-write');
    // Resumable PENDING GCash payment for the active shift (or null) — lets
    // the QR screen survive navigation/refresh instead of minting duplicates.
    Route::get('/payments/gcash/pending', [ConductorController::class, 'pendingGcash'])->middleware('throttle:conductor-read');
    Route::get('/earnings', [ConductorController::class, 'earnings'])->middleware('throttle:conductor-read');

    // Hail lifecycle (conductor-side) — reads 60/min, mutations via write limiter
    Route::get('/hails', [ConductorHailController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/hails/{id}/accept', [ConductorHailController::class, 'accept'])->middleware('throttle:conductor-write');
    Route::post('/hails/{id}/reject', [ConductorHailController::class, 'reject'])->middleware('throttle:conductor-write');
});

/*
|--------------------------------------------------------------------------
| Vehicle Locations (Authenticated — any role)
|--------------------------------------------------------------------------
*/
Route::prefix('vehicles')->middleware(['auth:sanctum'])->group(function () {
    Route::get('/locations', [VehicleLocationController::class, 'index'])->middleware('throttle:vehicle-locations');
});

/*
|--------------------------------------------------------------------------
| Admin Routes (ADMIN role required)
|--------------------------------------------------------------------------
*/
Route::prefix('admin')->middleware(['auth:sanctum', 'role:ADMIN'])->group(function () {
    Route::get('/dashboard', [AdminController::class, 'dashboard']);
    Route::get('/analytics', [AdminController::class, 'analytics'])->middleware('throttle:conductor-read');
    Route::get('/monitoring', [AdminController::class, 'monitoring'])->middleware('throttle:conductor-read');
    Route::get('/monitoring/overspeed', [AdminController::class, 'overspeed'])->middleware('throttle:conductor-read');
    Route::get('/monitoring/demand-zones', [AdminController::class, 'demandZones'])->middleware('throttle:conductor-read');
    Route::get('/users', [AdminUserController::class, 'index'])->middleware('throttle:conductor-read');
    Route::get('/users/{id}', [AdminUserController::class, 'show'])->middleware('throttle:conductor-read');
    Route::put('/users/{id}', [AdminUserController::class, 'update'])->middleware('throttle:conductor-write');
    Route::patch('/users/{id}', [AdminUserController::class, 'update'])->middleware('throttle:conductor-write');
    Route::delete('/users/{id}', [AdminUserController::class, 'destroy'])->middleware('throttle:conductor-write');
    Route::post('/users/{id}/suspend', [AdminUserController::class, 'suspend'])->middleware('throttle:admin-write');
    Route::post('/users/{id}/unsuspend', [AdminUserController::class, 'unsuspend'])->middleware('throttle:admin-write');
    Route::get('/users/{id}/suspensions', [AdminUserController::class, 'suspensions'])->middleware('throttle:conductor-read');
    Route::get('/registrations', [AdminRegistrationController::class, 'pending'])->middleware('throttle:conductor-read');
    Route::get('/registrations/rejected', [AdminRegistrationController::class, 'rejected'])->middleware('throttle:conductor-read');
    Route::post('/registrations', [AdminRegistrationController::class, 'store'])->middleware('throttle:conductor-write');
    Route::post('/registrations/{id}/approve', [AdminRegistrationController::class, 'approve'])->middleware('throttle:conductor-write');
    Route::post('/registrations/{id}/reject', [AdminRegistrationController::class, 'reject'])->middleware('throttle:conductor-write');
    Route::get('/users/{id}/activity', [AdminController::class, 'userActivity'])->middleware('throttle:conductor-read');
    Route::get('/personnel', [AdminController::class, 'personnel'])->middleware('throttle:conductor-read');
    Route::get('/drivers', [AdminController::class, 'drivers'])->middleware('throttle:conductor-read');
    Route::post('/drivers', [AdminController::class, 'storeDriver'])->middleware('throttle:conductor-write');
    Route::get('/drivers/{id}', [AdminController::class, 'showDriver'])->middleware('throttle:conductor-read');
    Route::post('/drivers/{id}/license-images', [AdminController::class, 'uploadDriverLicenseImages'])->middleware('throttle:conductor-write');
    Route::delete('/drivers/{id}/license-images/{side}', [AdminController::class, 'destroyDriverLicenseImage'])->middleware('throttle:conductor-write');
    Route::get('/drivers/{id}/license-images/{side}', [AdminController::class, 'showDriverLicenseImage'])->middleware('throttle:conductor-read');
    Route::put('/drivers/{id}', [AdminController::class, 'updateDriver'])->middleware('throttle:conductor-write');
    Route::patch('/drivers/{id}', [AdminController::class, 'updateDriver'])->middleware('throttle:conductor-write');
    Route::delete('/drivers/{id}', [AdminController::class, 'destroyDriver'])->middleware('throttle:conductor-write');
    Route::get('/conductors/{id}', [AdminController::class, 'showConductor'])->middleware('throttle:conductor-read');
    Route::put('/conductors/{id}', [AdminController::class, 'updateConductor'])->middleware('throttle:conductor-write');
    Route::patch('/conductors/{id}', [AdminController::class, 'updateConductor'])->middleware('throttle:conductor-write');
    Route::get('/conductors', [AdminController::class, 'conductors'])->middleware('throttle:conductor-read');
    Route::post('/conductors', [AdminController::class, 'storeConductor'])->middleware('throttle:conductor-write');
    Route::delete('/conductors/{id}', [AdminController::class, 'destroyConductor'])->middleware('throttle:conductor-write');
    Route::post('/conductors/{id}/disable', [AdminController::class, 'disableConductor'])->middleware('throttle:conductor-write');
    Route::post('/conductors/{id}/reset-credentials', [AdminController::class, 'resetConductorCredentials'])->middleware('throttle:conductor-write');
    Route::get('/terminated-personnel', [AdminController::class, 'terminatedPersonnel'])->middleware('throttle:conductor-read');
    Route::get('/vehicles', [AdminVehicleController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/vehicles', [AdminVehicleController::class, 'store'])->middleware('throttle:conductor-write');
    Route::get('/vehicles/{id}', [AdminVehicleController::class, 'show'])->middleware('throttle:conductor-read');
    Route::put('/vehicles/{id}', [AdminVehicleController::class, 'update'])->middleware('throttle:conductor-write');
    Route::patch('/vehicles/{id}', [AdminVehicleController::class, 'update'])->middleware('throttle:conductor-write');
    Route::delete('/vehicles/{id}', [AdminVehicleController::class, 'destroy'])->middleware('throttle:conductor-write');
    Route::get('/routes', [AdminRouteController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/routes', [AdminRouteController::class, 'store'])->middleware('throttle:conductor-write');
    Route::get('/routes/{id}', [AdminRouteController::class, 'show'])->middleware('throttle:conductor-read');
    Route::put('/routes/{id}', [AdminRouteController::class, 'update'])->middleware('throttle:conductor-write');
    Route::patch('/routes/{id}', [AdminRouteController::class, 'update'])->middleware('throttle:conductor-write');
    Route::delete('/routes/{id}', [AdminRouteController::class, 'destroy'])->middleware('throttle:conductor-write');
    Route::put('/routes/{id}/draft', [AdminRouteController::class, 'saveDraft'])->middleware('throttle:conductor-write');
    Route::post('/routes/{id}/publish', [AdminRouteController::class, 'publish'])->middleware('throttle:conductor-write');
    Route::get('/routes/{id}/versions', [AdminRouteController::class, 'versions'])->middleware('throttle:conductor-read');
    Route::get('/fare-points', [AdminFarePointController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/fare-points', [AdminFarePointController::class, 'store'])->middleware('throttle:conductor-write');
    Route::put('/fare-points/reorder', [AdminFarePointController::class, 'reorder'])->middleware('throttle:conductor-write');
    Route::put('/fare-points/{id}', [AdminFarePointController::class, 'update'])->middleware('throttle:conductor-write');
    Route::patch('/fare-points/{id}', [AdminFarePointController::class, 'update'])->middleware('throttle:conductor-write');
    Route::delete('/fare-points/{id}', [AdminFarePointController::class, 'destroy'])->middleware('throttle:conductor-write');
    Route::get('/settings', [AdminSettingController::class, 'index'])->middleware('throttle:conductor-read');
    Route::put('/settings/{key}', [AdminSettingController::class, 'update'])->middleware('throttle:conductor-write');
    Route::get('/vouchers', [AdminVoucherController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/vouchers', [AdminVoucherController::class, 'store'])->middleware('throttle:conductor-write');
    Route::delete('/vouchers/{id}', [AdminVoucherController::class, 'destroy'])->middleware('throttle:conductor-write');
    Route::get('/remittance-options', [AdminRemittanceOptionController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/remittance-options', [AdminRemittanceOptionController::class, 'store'])->middleware('throttle:conductor-write');
    Route::put('/remittance-options/{id}', [AdminRemittanceOptionController::class, 'update'])->middleware('throttle:conductor-write');
    Route::delete('/remittance-options/{id}', [AdminRemittanceOptionController::class, 'destroy'])->middleware('throttle:conductor-write');
    Route::get('/faqs', [AdminFaqController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/faqs', [AdminFaqController::class, 'store'])->middleware('throttle:conductor-write');
    Route::put('/faqs/{id}', [AdminFaqController::class, 'update'])->middleware('throttle:conductor-write');
    Route::delete('/faqs/{id}', [AdminFaqController::class, 'destroy'])->middleware('throttle:conductor-write');
    Route::get('/transactions', [AdminController::class, 'transactions'])->middleware('throttle:conductor-read');
    Route::get('/remittances', [AdminController::class, 'remittances'])->middleware('throttle:conductor-read');
    Route::post('/remittances/{shiftId}/cash-declaration', [AdminController::class, 'declareCash'])->middleware('throttle:admin-write');
    Route::get('/announcements', [AdminAnnouncementController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/announcements', [AdminAnnouncementController::class, 'store'])->middleware('throttle:admin-write');
    Route::get('/announcements/{id}', [AdminAnnouncementController::class, 'show'])->middleware('throttle:conductor-read');
    Route::put('/announcements/{id}', [AdminAnnouncementController::class, 'update'])->middleware('throttle:admin-write');
    Route::patch('/announcements/{id}', [AdminAnnouncementController::class, 'update'])->middleware('throttle:admin-write');
    Route::patch('/announcements/{id}/archive', [AdminAnnouncementController::class, 'archive'])->middleware('throttle:admin-write');
    Route::get('/shift-logs', [AdminController::class, 'shiftLogs'])->middleware('throttle:conductor-read');
    Route::post('/shifts/{shift}/device/recover', [AdminShiftDeviceController::class, 'recover'])->middleware('throttle:admin-write');

    // ── Lost & Found management (S6-T3) ─────────────────────────
    // Replaces the old AdminController::lostItems() 501 stub. Admin creates
    // reported items, reviews claims (approve/reject), and closes released
    // items. Commuter-side browse + claim live in the /lost-found group.
    Route::get('/lost-items', [AdminLostItemController::class, 'index'])->middleware('throttle:conductor-read');
    Route::post('/lost-items', [AdminLostItemController::class, 'store'])->middleware('throttle:admin-write');
    Route::get('/lost-items/{itemId}', [AdminLostItemController::class, 'show'])->middleware('throttle:conductor-read');
    Route::patch('/lost-items/{itemId}', [AdminLostItemController::class, 'update'])->middleware('throttle:admin-write');
    Route::post('/lost-items/{itemId}/photos', [AdminLostItemController::class, 'addPhoto'])->middleware('throttle:admin-write');
    Route::delete('/lost-items/{itemId}/photos/{photoId}', [AdminLostItemController::class, 'destroyPhoto'])->middleware('throttle:admin-write');
    Route::patch('/lost-items/{itemId}/reactivate', [AdminLostItemController::class, 'reactivate'])->middleware('throttle:admin-write');
    Route::get('/lost-items/{itemId}/claims', [AdminLostItemController::class, 'claims'])->middleware('throttle:conductor-read');
    Route::post('/lost-items/{itemId}/claims/manual', [AdminLostItemController::class, 'storeManualClaim'])->middleware('throttle:admin-write');
    Route::patch('/lost-items/{itemId}/claims/{claimId}/approve', [AdminLostItemController::class, 'approveClaim'])->middleware('throttle:admin-write');
    Route::patch('/lost-items/{itemId}/claims/{claimId}/release', [AdminLostItemController::class, 'releaseClaim'])->middleware('throttle:admin-write');
    Route::patch('/lost-items/{itemId}/claims/{claimId}/reject', [AdminLostItemController::class, 'rejectClaim'])->middleware('throttle:admin-write');
    Route::patch('/lost-items/{itemId}/close', [AdminLostItemController::class, 'close'])->middleware('throttle:admin-write');

    // ── SOS alert management (S6-T5) ────────────────────────────
    // Admins monitor the live feed, acknowledge alerts (signal 'I see this'),
    // and resolve them when the situation is handled.
    Route::get('/sos', [AdminSosController::class, 'index'])->middleware('throttle:conductor-read');
    Route::patch('/sos/{id}/acknowledge', [AdminSosController::class, 'acknowledge'])->middleware('throttle:admin-write');
    Route::patch('/sos/{id}/resolve', [AdminSosController::class, 'resolve'])->middleware('throttle:admin-write');

    // ── Staff feedback listing (S6-T6 revised) ─────────────────
    // Replaces the standalone admin "Feedback QR" module. The admin views
    // driver/conductor feedback from User Management by double-clicking a
    // row. Pass conductor_id OR driver_id. Returns paginated feedback + a
    // summary (average_rating, total_count, 5→1 distribution).
    Route::get('/feedback', [AdminFeedbackController::class, 'index'])->middleware('throttle:conductor-read');

    // ── Activity Logs (audit trail) ─────────────────────────────
    // Read-only admin audit trail — every admin-mutating action across the
    // panel writes one row via ActivityLogService::record(). See the 13
    // categories in App\Enums\ActivityLogCategory.
    Route::get('/activity-logs', [AdminActivityLogController::class, 'index'])->middleware('throttle:conductor-read');
});

/*
|--------------------------------------------------------------------------
| Payment Routes (Shared + Webhook)
|--------------------------------------------------------------------------
|   GET  /payments/{id}/status  -> auth:sanctum (any role) — status polling
|   POST /payments/webhook      -> PUBLIC (no auth) — PayMongo webhook (S4-T6)
|
| The commuter-side payment routes (claim, history) live in the commuter
| group above. The conductor-side GCash initiate route lives in the
| conductor group above.
|--------------------------------------------------------------------------
*/
Route::prefix('payments')->group(function () {
    // Status polling — auth required, any role (conductor or commuter)
    Route::middleware('auth:sanctum')->group(function () {
        Route::get('/{id}/status', [PaymentController::class, 'status'])->middleware('throttle:conductor-read');

        // Cancel a PENDING GCash payment — conductor can abort if the commuter
        // didn't scan in time, or the commuter changed their mind. Transitions
        // the transaction PENDING → CANCELLED through the state machine.
        Route::post('/{id}/cancel', [PaymentController::class, 'cancel'])->middleware('throttle:conductor-write');

        // DEV ONLY (config payments.allow_simulation): drive a PENDING GCash
        // payment to a terminal status without a real provider. Hard-disabled
        // in production by the controller.
        Route::post('/{id}/simulate', [PaymentController::class, 'simulate'])->middleware('throttle:conductor-write');
    });

    // PayMongo webhook — PUBLIC (server-to-server, signature-verified in S4-T6)
    Route::post('/webhook', [PaymentController::class, 'webhook']);
});

/*
|--------------------------------------------------------------------------
| Lost & Found — Shared Browse + Commuter Claim (S6-T3)
|--------------------------------------------------------------------------
|   GET  /lost-found            (any auth role) — paginated browse
|   GET  /lost-found/{itemId}   (any auth role) — item detail
|   POST /lost-found/{itemId}/claim      (COMMUTER) — submit a claim with proof
|   POST /lost-found/{itemId}/watchlist  (COMMUTER) — add to watchlist
|   DELETE /lost-found/{itemId}/watchlist (COMMUTER) — remove from watchlist
|
| Admin management (create, review claims, close) lives in the /admin
| group above via AdminLostItemController.
|--------------------------------------------------------------------------
*/
Route::prefix('lost-found')->middleware(['auth:sanctum'])->group(function () {
    Route::get('/', [LostItemController::class, 'index'])->middleware('throttle:commuter-read');
    // Registered before /{itemId} so 'claims' is never captured as an item id.
    Route::delete('/claims/{claimId}', [LostItemController::class, 'cancelClaim'])->middleware(['role:COMMUTER', 'throttle:commuter-write']);
    Route::get('/{itemId}', [LostItemController::class, 'show'])->middleware('throttle:commuter-read');
    Route::post('/{itemId}/claim', [LostItemController::class, 'claim'])->middleware(['role:COMMUTER', 'throttle:commuter-write']);
    Route::post('/{itemId}/watchlist', [LostItemController::class, 'watchlist'])->middleware(['role:COMMUTER', 'throttle:commuter-write']);
    Route::delete('/{itemId}/watchlist', [LostItemController::class, 'unwatch'])->middleware(['role:COMMUTER', 'throttle:commuter-write']);
});

/*
|--------------------------------------------------------------------------
| Announcements — User-Facing Reads (S6-T4)
|--------------------------------------------------------------------------
|   GET  /announcements                (any auth role) — ACTIVE feed w/ is_read
|   GET  /announcements/unread-count   (any auth role) — bell badge count
|   POST /announcements/mark-all-read  (any auth role) — bulk mark-as-read
|   POST /announcements/{id}/read      (any auth role) — mark-as-read (204)
|
| Admin CRUD (create/update/archive) lives in the /admin group above via
| AdminAnnouncementController.
|--------------------------------------------------------------------------
*/
Route::prefix('announcements')->middleware(['auth:sanctum'])->group(function () {
    Route::get('/unread-count', [AnnouncementController::class, 'unreadCount'])->middleware('throttle:commuter-read');
    Route::post('/mark-all-read', [AnnouncementController::class, 'markAllRead'])->middleware('throttle:commuter-write');
    Route::get('/', [AnnouncementController::class, 'index'])->middleware('throttle:commuter-read');
    Route::post('/{id}/read', [AnnouncementController::class, 'markRead'])->middleware('throttle:commuter-write');
});

/*
|--------------------------------------------------------------------------
| QR Routes — Feedback Unit-QR (S6)
|--------------------------------------------------------------------------
| Repurposed from S1 501 stubs. These are NOT the GCash payment QR — the
| GCash flow uses /conductor/payments/gcash/initiate + /commuter/payments/claim.
|
|   POST /qr/generate  (ADMIN)    — issue HMAC-signed unit-QR for a vehicle
|   POST /qr/validate  (COMMUTER) — verify signature + expiry (pre-check)
|   POST /qr/scan      (COMMUTER) — verify + resolve today's driver+conductor
|
| Each route has its own role middleware (the 3 roles are split, not shared)
| because the issuer (admin) and the consumers (commuters) are different.
|--------------------------------------------------------------------------
*/
Route::prefix('qr')->middleware(['auth:sanctum'])->group(function () {
    Route::post('/generate', [QrController::class, 'generate'])->middleware(['role:ADMIN', 'throttle:admin-write']);
    Route::post('/validate', [QrController::class, 'verify'])->middleware(['role:COMMUTER', 'throttle:commuter-write']);
    Route::post('/scan', [QrController::class, 'scan'])->middleware(['role:COMMUTER', 'throttle:commuter-write']);
    // Permanent unit-QR: commuter scans the printed QR, frontend extracts the
    // vehicle_id, this resolves today's driver + conductor from shift_logs.
    Route::post('/scan-public', [QrController::class, 'scanPublic'])->middleware(['role:COMMUTER', 'throttle:commuter-write']);
});
