<?php

namespace App\Services;

use App\Enums\ActivityLogCategory;
use App\Enums\UserRole;
use App\Exceptions\AccountSuspendedException;
use App\Exceptions\MaintenanceException;
use App\Exceptions\RegistrationPendingException;
use App\Models\AdminProfile;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
use App\Models\DiscountApplication;
use App\Models\SharedRideLink;
use App\Models\ShiftLog;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class AuthService
{
    /**
     * A valid (but unused) bcrypt hash to check the submitted password
     * against when no account was found, so a nonexistent login and a wrong
     * password take the same amount of time. Without this, Hash::check is
     * skipped entirely on a miss and the response returns measurably faster,
     * letting an attacker enumerate valid emails/usernames by timing alone.
     */
    private const DUMMY_PASSWORD_HASH = '$2y$12$B.44LXKXybjm672nQTiDeeCEcR.cqHjJAueeBHBI/y.SrDDaIc.FG';

    public function __construct(
        private RegistrationGuard $registrationGuard,
        private EmailVerificationService $emailVerification,
        private AnnouncementService $announcementService,
        private ActivityLogService $activityLog,
        private DailyAssignmentResetService $dailyReset,
    ) {}

    /**
     * Login with email, admin username, conductor generated_username, or
     * commuter username.
     *
     * A commuter can sign in with EITHER their email OR the username they
     * chose at sign-up — both resolve to the same account. Conductors use
     * their admin-generated username. Admins can use their email or the
     * username set when their account was created (User Management). The SoftDeletes scope on User already
     * excludes rejected (soft-deleted) accounts, so a freed username reused
     * by a new commuter resolves only to the live account.
     */
    public function login(
        string $login,
        string $password,
        ?string $deviceId = null,
        ?string $deviceType = null,
    ): array {
        $user = $this->resolveLoginUser($login);

        if (! $user || ! Hash::check($password, $user->password ?? self::DUMMY_PASSWORD_HASH)) {
            // Only admin accounts: commuter/conductor attempts would bury the
            // log, and an unknown login name is attacker-chosen text.
            if ($user?->isAdmin()) {
                $this->activityLog->record(ActivityLogCategory::ACCOUNT, 'Failed sign-in attempt (wrong password)', $user);
            }
            throw ValidationException::withMessages([
                'login' => ['The provided credentials are incorrect.'],
            ]);
        }

        // Credentials are valid — block login based on the commuter's
        // account_status. Checked AFTER the password so it never reveals
        // whether an email exists.
        //   SUSPENDED  -> AccountSuspendedException      (admin set in S5-T3)
        //   PENDING    -> RegistrationPendingException  (awaiting approval)
        //   REJECTED   -> RegistrationPendingException  (admin declined)
        //   APPROVED/ACTIVE -> allowed to log in
        if ($user->activeSuspension) {
            $suspension = $user->activeSuspension;
            $duration = $suspension->is_permanent
                ? 'permanently'
                : 'until '.$suspension->ends_at?->timezone(config('app.timezone'))->format('M j, Y g:i A');

            throw new AccountSuspendedException(
                "This account is suspended {$duration}. Reason: {$suspension->reason}"
            );
        }

        // An admin-disabled conductor (AdminController::disableConductor) had
        // only their tokens revoked, so without this check the same username
        // and password signed straight back in. Resetting credentials sets
        // the status back to ACTIVE, which is how the account is re-enabled.
        if ($user->isConductor() && $user->conductorProfile?->status === 'DISABLED') {
            throw new AccountSuspendedException(
                'This conductor account has been disabled. Ask an administrator to reset your credentials.'
            );
        }

        if ($user->isCommuter()) {
            $status = $user->commuterProfile?->account_status;

            if ($status === 'SUSPENDED') {
                throw new AccountSuspendedException;
            }

            if ($status === 'PENDING' || $status === 'REJECTED') {
                throw new RegistrationPendingException(
                    $status === 'PENDING'
                        ? 'Your account is pending admin approval.'
                        : 'Your registration was rejected. Please contact support.'
                );
            }
        }

        // ─── Single-session enforcement ──────────────
        // Admins, and any login that omits device_type, get one active session
        // per account: logging in revokes every previously issued token.
        // Conductors get one session across WEB and MOBILE. Commuters get one
        // session per platform, so their web and mobile apps can stay signed
        // in together. The displaced device's next authenticated
        // request 401s and the shared API client
        // (frontend/lib/api/client.ts handleSessionEnded) redirects it to
        // /login?reason=session_ended.
        //
        // The revoke + issue happen inside a transaction holding a row lock
        // on the user, so concurrent login attempts (rapid double-taps, two
        // devices racing to sign in) serialize instead of interleaving.
        // Without the lock, two requests could each see "nothing to delete
        // yet" and both survive, leaving more than one active session per
        // slot; with it, the second request's delete always runs after the
        // first request's create has committed, so only the latest conductor
        // token (or one token per commuter platform) remains and each request's new token always
        // survives its own delete (never a later request's).
        // For conductors, the last identified device to complete login becomes
        // the active shift's operating device and only valid account session.
        // The user row and shift row are
        // locked before the handoff and token replacement, so two concurrent
        // logins serialize: exactly one device owns the shift and one
        // conductor token remains valid after the final commit. Shift,
        // vehicle, driver, transaction and remittance records are not
        // recreated or reassigned.
        //
        // A legacy conductor client that omits device_id may still log in when
        // no device owns the shift, but it cannot displace an identified owner.
        // Current Web and Mobile clients always send a stable device_id.
        // Check before issuing/revoking tokens or handing an active shift to a device.
        $maintenanceMessage = app(MaintenanceStatus::class)->messageFor($user->role);
        if ($maintenanceMessage !== null) {
            throw new MaintenanceException($maintenanceMessage);
        }

        // Clear yesterday's shifts and unit assignments before the conductor's
        // active-shift lookup below, so a shift left open from an earlier day
        // is ended (its remittance stays not-remitted) instead of resumed.
        // Once per day; a failure here must never block signing in.
        if ($user->isAdmin() || $user->isConductor()) {
            try {
                $this->dailyReset->runIfDue();
            } catch (\Throwable $error) {
                Log::error('Daily assignment reset on login failed', [
                    'exception' => $error::class,
                    'message' => $error->getMessage(),
                ]);
            }
        }

        $loginResult = DB::transaction(function () use ($user, $deviceId, $deviceType) {
            $lockedUser = User::query()->whereKey($user->id)->lockForUpdate()->firstOrFail();
            $handoff = null;

            if ($lockedUser->isConductor()) {
                $activeShift = ShiftLog::query()
                    ->where('conductor_id', $lockedUser->id)
                    ->active()
                    ->lockForUpdate()
                    ->first();

                if ($activeShift?->operating_device_id !== null && $deviceId === null) {
                    abort(409, 'Update this conductor client before moving an active shift from another device.');
                }

                if ($activeShift && $deviceId !== null) {
                    $previousDeviceId = $activeShift->operating_device_id;
                    $isDifferentDevice = $previousDeviceId !== null
                        && ! hash_equals($previousDeviceId, $deviceId);

                    if ($isDifferentDevice) {
                        $handoff = [
                            'shift_id' => $activeShift->shift_id,
                            'from_device_type' => $activeShift->operating_device_type,
                            'from_device_suffix' => substr($previousDeviceId, -8),
                            'to_device_type' => $deviceType,
                            'to_device_suffix' => substr($deviceId, -8),
                        ];
                    }

                    if ($previousDeviceId === null || $isDifferentDevice) {
                        $activeShift->update([
                            'operating_device_id' => $deviceId,
                            'operating_device_type' => $deviceType,
                            'operating_device_claimed_at' => now(),
                        ]);
                    }
                }
            }

            // Keep commuter sessions platform-scoped. Conductors and admins
            // use one account session across platforms.
            $isPlatformScopedCommuter = $lockedUser->isCommuter() && $deviceType !== null;

            if ($isPlatformScopedCommuter) {
                $tokenName = 'auth-token:' . $deviceType;
                // Sweep legacy generic commuter tokens so an older session
                // cannot survive indefinitely.
                $lockedUser->tokens()->whereIn('name', [$tokenName, 'auth-token'])->delete();
            } else {
                $endedSessions = $lockedUser->tokens()->delete();
            }

            $tokenName = $isPlatformScopedCommuter
                ? 'auth-token:' . $deviceType
                : 'auth-token';

            return [
                'token' => $lockedUser->createToken($tokenName)->plainTextToken,
                'handoff' => $handoff,
                'ended_sessions' => $endedSessions ?? 0,
            ];
        }, 3);

        if ($user->isAdmin()) {
            // Admins are single-session, so a sign-in elsewhere signs the
            // previous device out; that's worth knowing when auditing.
            $this->activityLog->record(
                ActivityLogCategory::ACCOUNT,
                $loginResult['ended_sessions'] > 0 ? 'Signed in and ended the session on another device' : 'Signed in',
                $user,
            );
        }

        if ($loginResult['handoff'] !== null) {
            Log::notice('Conductor active shift moved to a newly logged-in device.', [
                'conductor_id' => $user->id,
                ...$loginResult['handoff'],
            ]);
        }

        return [
            'user' => $user,
            'token' => $loginResult['token'],
        ];
    }

    /**
     * Resolve a login identifier (email, admin username, conductor
     * generated_username, or commuter username) to a User with all profile
     * relations eager loaded.
     *
     * Deliberately targeted lookups instead of one query ORing across
     * `email` and `whereHas` subqueries: MySQL cannot use the unique
     * index on `users.email` when it's OR'd against correlated EXISTS
     * subqueries on other tables, so that shape degrades to a full table
     * scan of `users` on every login attempt (confirmed via EXPLAIN). Each
     * branch below hits its own unique index instead — email is checked
     * first since it's the common case, and the SoftDeletes scope on both
     * User and the profile models still excludes rejected/removed accounts.
     */
    private function resolveLoginUser(string $login): ?User
    {
        $with = ['adminProfile', 'conductorProfile', 'commuterProfile', 'activeSuspension'];

        $user = User::with($with)->where('email', $login)->first();
        if ($user) {
            return $user;
        }

        $adminId = AdminProfile::where('username', $login)->value('id');
        if ($adminId) {
            return User::with($with)->find($adminId);
        }

        $conductorId = ConductorProfile::where('generated_username', $login)->value('id');
        if ($conductorId) {
            return User::with($with)->find($conductorId);
        }

        $commuterId = CommuterProfile::where('username', $login)->value('id');
        if ($commuterId) {
            return User::with($with)->find($commuterId);
        }

        return null;
    }

    /**
     * Logout — revoke only the current token, and end the commuter's live
     * location share: a signed-out commuter's link must read as expired, not
     * keep showing their last position until its 30 minutes run out.
     */
    public function logout(User $user): void
    {
        $user->currentAccessToken()->delete();

        if ($user->isCommuter()) {
            // Commuter profile id == user id. Uses the (commuter_id, is_active) index.
            SharedRideLink::where('commuter_id', $user->id)
                ->where('is_active', true)
                ->update(['is_active' => false]);
        }

        if ($user->isAdmin()) {
            $this->activityLog->record(ActivityLogCategory::ACCOUNT, 'Signed out', $user);
        }
    }

    /**
     * Get authenticated user with preloaded profiles.
     */
    public function getAuthenticatedUser(User $user): User
    {
        return $user->load([
            'adminProfile',
            'conductorProfile',
            'commuterProfile',
        ]);
    }

    /**
     * POST /auth/register — commuter self-sign-up.
     *
     * Creates a User (role=COMMUTER) + CommuterProfile with
     * account_status=PENDING and commuter_type=applied_type. NO token is
     * issued — the commuter cannot log in until an admin approves (see
     * AdminService::approveRegistration).
     *
     * EMAIL UNIQUENESS
     * ----------------
     * A DB-level unique index backs users.email, and the SoftDeletes scope
     * does NOT exempt soft-deleted rows from that index. The 'unique:users'
     * validation rule in RegisterRequest by default ALSO matches soft-deleted
     * rows, which would block reuse of an email freed by a prior rejection.
     * We therefore enforce uniqueness manually against NON-deleted users
     * here, so a previously-rejected email can be re-registered.
     *
     * ID IMAGE PERSISTENCE (private R2 object path)
     * ---------------------------------------------
     * The valid-ID image is accepted and validated by RegisterRequest and its
     * binary is persisted to the configured private storage disk.
     *
     * The database stores only the object path; admins receive temporary URLs.
     *
     *
     *
     *
     *
     *
     * @param  array<string, mixed>  $data  validated payload from RegisterRequest
     * @return array{user: User, profile: CommuterProfile}
     *
     * @throws ValidationException when the email is already held by a live user
     */
    public function register(array $data): array
    {
        // Safety net: if this email/contact has been rejected too many times,
        // enforce the re-registration cooldown before doing anything else.
        // Throws a 422 with a friendly "try again after {date}" message.
        $this->registrationGuard->assertNotBlocked(
            $data['email'] ?? null,
            $data['contact_number'] ?? null,
        );

        // The applicant must have proved they own this inbox (6-digit code,
        // step 3 of the sign-up form). Checked here rather than in
        // RegisterRequest so the ONLY path that creates a self-signed-up
        // account enforces it — including any future caller of this service.
        // The admin's onsite registration flow is deliberately exempt: staff
        // have the applicant and their ID standing in front of them.
        $this->emailVerification->assertVerified($data['email']);

        // Manual uniqueness check against NON-deleted users. Soft-deleted
        // (rejected) accounts have had their email rewritten to a unique
        // 'rejected+{timestamp}' placeholder by AdminService::rejectRegistration,
        // so they never collide with a fresh registration using the canonical
        // address. We scope to non-deleted users explicitly for clarity and
        // defence-in-depth.
        $emailTaken = User::whereNull('users.deleted_at')
            ->where('email', $data['email'])
            ->exists();

        if ($emailTaken) {
            throw ValidationException::withMessages([
                'email' => ['The email has already been taken.'],
            ]);
        }

        // Upload the ID image BEFORE opening the transaction. This is a
        // network call to external storage (R2) — running it inside
        // DB::transaction() (as before) held the transaction, and the row
        // locks the User insert takes, open for however long that upload
        // took, which delays both the commit and the moment the pending
        // registration becomes visible to the admin's next query.
        // The generated id is assigned explicitly below (via $user->id =
        // ..., not through mass assignment — 'id' is deliberately excluded
        // from User::$fillable) so it matches the id already baked into the
        // uploaded filename, rather than letting the `creating` hook mint a
        // different one.
        $userId = (string) Str::uuid();
        // Optional only for a REGULAR commuter while "Force Valid ID Upload"
        // is off (RegisterRequest enforces who must provide one).
        $idImagePath = ! empty($data['id_image']) ? $this->storeIdImage($userId, $data['id_image']) : null;

        // The exists() check above is a TOCTOU race: two requests for the same
        // email submitted close together can both pass it and both reach
        // User::create(). The DB-level unique index (users.email, and
        // commuter_profiles.username below it) is the real guard against a
        // duplicate account — this try/catch just translates that guard's
        // failure into the same friendly ValidationException the pre-check
        // throws, instead of letting a raw QueryException surface as a 500.
        //
        // Any failure here (the race above, or anything else that aborts the
        // transaction) leaves $idImagePath uploaded with no owning account —
        // delete it before rethrowing so a failed registration never orphans
        // a government ID in R2.
        try {
            $created = DB::transaction(function () use ($data, $userId, $idImagePath): array {
                $user = new User([
                    'email' => $data['email'],
                    'password' => $data['password'], // 'hashed' cast on User
                    'role' => UserRole::COMMUTER,
                ]);
                $user->id = $userId;
                $user->save();

                $agreedAt = now();
                $profile = CommuterProfile::create([
                    'id' => $user->id,
                    'first_name' => $data['first_name'],
                    'middle_name' => $data['middle_name'] ?? null,
                    'suffix' => $data['suffix'] ?? null,
                    'surname' => $data['surname'],
                    'birthdate' => $data['birthdate'],
                    'gender' => $data['gender'],
                    'email' => $data['email'],
                    'contact_number' => $data['contact_number'],
                    'commuter_type' => $data['applied_type'],
                    'applied_type' => $data['applied_type'],
                    'username' => $data['username'],
                    'language_preference' => $data['language_preference'] ?? 'English',
                    'account_status' => 'PENDING',
                    'id_image_url' => $idImagePath,
                    'verified_at' => null,
                    'rejection_reason' => null,
                    'terms_version' => $data['terms_version'],
                    'privacy_version' => $data['privacy_version'],
                    'terms_accepted_at' => $agreedAt,
                    'privacy_acknowledged_at' => $agreedAt,
                    'registration_confirmed_at' => $agreedAt,
                ]);

                // School details go where renewals and discount applications
                // keep theirs. It stays PENDING with the registration and is
                // decided by approveRegistration()/rejectRegistration(), so the
                // admin reviews it once, next to the ID. The ID image is the
                // proof, so no separate document is stored.
                if ($data['applied_type'] === 'STUDENT') {
                    DiscountApplication::create([
                        'commuter_id' => $profile->id,
                        'request_type' => 'APPLICATION',
                        'requested_type' => 'STUDENT',
                        'status' => 'PENDING',
                        'school_name' => $data['school_name'],
                        'education_level' => $data['education_level'],
                        'grade_level' => $data['grade_level'] ?? null,
                        'school_year' => $data['school_year'],
                        'enrollment_term' => ($data['enrollment_term'] ?? null) ?: null,
                        'submitted_at' => $agreedAt,
                        'first_submitted_at' => $agreedAt,
                    ]);
                }

                $applicantName = trim($profile->first_name.' '.$profile->surname);
                DB::afterCommit(fn () => $this->announcementService->notifyAdmins(
                    'NEW_REGISTRATION',
                    "New registration: {$applicantName}",
                    "{$applicantName} signed up and is awaiting verification.",
                    $user->id,
                ));
                DB::afterCommit(fn () => $this->activityLog->record(
                    ActivityLogCategory::MEMBER,
                    'Signed up as a '.ucfirst(strtolower($profile->applied_type)).' commuter; awaiting verification',
                    $user,
                ));

                return [
                    'user' => $user,
                    'profile' => $profile,
                ];
            });
        } catch (\Throwable $e) {
            if ($idImagePath !== null) {
                $this->deleteIdImage($idImagePath);
            }

            throw $e instanceof QueryException ? $this->translateUniqueViolation($e) : $e;
        }

        // One account per verification. Burning it here (after the transaction
        // commits) stops a single verified address from being replayed into a
        // second registration inside the verification window.
        $this->emailVerification->consume($data['email']);

        return $created;
    }

    /**
     * Turn a DB-level unique-index violation into the same friendly
     * ValidationException the pre-checks throw, so a benign race (two
     * submissions for the same email/username landing inside the same
     * few milliseconds) reaches the applicant as a normal form error
     * instead of a 500.
     *
     * SQLSTATE 23000 is "integrity constraint violation" on every driver
     * Laravel supports (unique, not-null, FK...); we only want to translate
     * the two unique keys this endpoint can actually hit, so anything else
     * — including a 23000 from an unrelated constraint — is rethrown as-is.
     *
     * The message format differs per driver — MySQL names the constraint
     * ('users_email_unique'), SQLite names the column ('users.email') — so
     * both are checked. This is also what the test suite (SQLite) exercises.
     */
    private function translateUniqueViolation(QueryException $e): \Throwable
    {
        if ($e->getCode() !== '23000') {
            return $e;
        }

        $message = $e->getMessage();

        if (str_contains($message, 'users_email_unique') || str_contains($message, 'users.email')) {
            return ValidationException::withMessages([
                'email' => ['This email is already registered. Sign in instead, or use "Forgot password" if you can\'t get in.'],
            ]);
        }

        if (str_contains($message, 'commuter_profiles_username_unique') || str_contains($message, 'commuter_profiles.username')) {
            return ValidationException::withMessages([
                'username' => ['The username has already been taken.'],
            ]);
        }

        return $e;
    }

    /**
     * Store the uploaded valid-ID image to the configured disk and return
     * the storage path. Government/student IDs are stored on the configured
     * private disk and are exposed to admins only through temporary URLs.
     * NEVER store the raw file in the DB — only the object path.
     *
     * Takes the user id as a string (rather than a User model) so callers can
     * upload before the User row exists — see the call site in register().
     *
     * @param  UploadedFile  $file
     * @return string The storage path (e.g. 'ids/uuid-abc123.jpg')
     */
    private function storeIdImage(string $userId, $file): string
    {
        // The filename includes the user ID for traceability.
        $extension = $file->getClientOriginalExtension() ?: 'jpg';
        $filename = $userId.'-'.Str::random(16).'.'.$extension;

        return $file->storeAs(
            "ids/commuters/{$userId}",
            $filename,
            config('filesystems.uploads.private_id_disk', 'r2_private')
        );
    }

    /**
     * Best-effort cleanup of an ID image uploaded via storeIdImage() whose
     * owning registration failed to persist. Never throws — a failed delete
     * here must not mask the original registration failure the caller is
     * about to rethrow — but it does log, so an orphaned private ID left
     * behind by a disk-level failure is still visible operationally instead
     * of silently disappearing.
     */
    private function deleteIdImage(string $path): void
    {
        try {
            Storage::disk(config('filesystems.uploads.private_id_disk', 'r2_private'))->delete($path);
        } catch (\Throwable $e) {
            Log::warning('Failed to clean up orphaned registration ID image after a failed registration.', [
                'path' => $path,
                'exception' => $e->getMessage(),
            ]);
        }
    }
}
