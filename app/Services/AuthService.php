<?php

namespace App\Services;

use App\Enums\UserRole;
use App\Exceptions\AccountSuspendedException;
use App\Exceptions\RegistrationPendingException;
use App\Models\CommuterProfile;
use App\Models\ConductorProfile;
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
    ) {}

    /**
     * Login with email, conductor generated_username, or commuter username.
     *
     * A commuter can sign in with EITHER their email OR the username they
     * chose at sign-up — both resolve to the same account. Conductors use
     * their admin-generated username. The SoftDeletes scope on User already
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

        // ─── Single-device enforcement (all roles) ──────────────────
        // Every account is limited to one active session. Logging in on a new
        // device revokes every previously issued token, so the old device's
        // next authenticated request 401s and the shared API client
        // (frontend/lib/api/client.ts handleSessionEnded) redirects it to
        // /login?reason=session_ended — no frontend changes needed, the same
        // mechanism already in place for staff accounts.
        //
        // The revoke + issue happen inside a transaction holding a row lock
        // on the user, so concurrent login attempts (rapid double-taps, two
        // devices racing to sign in) serialize instead of interleaving.
        // Without the lock, two requests could each see "nothing to delete
        // yet" and both survive, leaving more than one active session; with
        // it, the second request's delete always runs after the first
        // request's create has committed, so exactly one token is ever left
        // standing and each request's own new token always survives its own
        // delete (never a later request's).
        // For conductors, the last identified device to complete login becomes
        // the active shift's operating device. The user row and shift row are
        // locked before the handoff and token replacement, so two concurrent
        // logins serialize: exactly one device owns the shift and exactly one
        // token remains valid after the final commit. Shift, vehicle, driver,
        // transaction and remittance records are not recreated or reassigned.
        //
        // A legacy conductor client that omits device_id may still log in when
        // no device owns the shift, but it cannot displace an identified owner.
        // Current Web and Mobile clients always send a stable device_id.
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

            // --- Phase 3: Platform-scoped session isolation for conductors ---
            // A conductor logging in on MOBILE must not revoke the active WEB
            // token (and vice-versa), so each platform maintains its own token
            // slot.  Only tokens belonging to the same platform are replaced.
            //
            // Rules:
            //   • conductor + known deviceType  → delete same-platform tokens only
            //   • conductor + null deviceType   → delete all tokens (legacy path,
            //                                     keeps all existing AuthTests green)
            //   • any other role                → delete all tokens (standard
            //                                     single-session security)
            if ($lockedUser->isConductor() && $deviceType !== null) {
                $tokenName = 'auth-token:' . $deviceType;
                $lockedUser->tokens()->where('name', $tokenName)->delete();
            } else {
                $lockedUser->tokens()->delete();
                $deviceType = null; // force generic token name below
            }

            $tokenName = ($lockedUser->isConductor() && $deviceType !== null)
                ? 'auth-token:' . $deviceType
                : 'auth-token';

            return [
                'token' => $lockedUser->createToken($tokenName)->plainTextToken,
                'handoff' => $handoff,
            ];
        }, 3);

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
     * Resolve a login identifier (email, conductor generated_username, or
     * commuter username) to a User with all profile relations eager loaded.
     *
     * Deliberately three targeted lookups instead of one query ORing across
     * `email` and two `whereHas` subqueries: MySQL cannot use the unique
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
     * Logout — revoke only the current token.
     */
    public function logout(User $user): void
    {
        $user->currentAccessToken()->delete();
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
        $idImagePath = $this->storeIdImage($userId, $data['id_image']);

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
                ]);

                $applicantName = trim($profile->first_name.' '.$profile->surname);
                DB::afterCommit(fn () => $this->announcementService->notifyAdmins(
                    'NEW_REGISTRATION',
                    'New registration request',
                    "{$applicantName} signed up and is awaiting verification.",
                    $user->id,
                ));

                return [
                    'user' => $user,
                    'profile' => $profile,
                ];
            });
        } catch (\Throwable $e) {
            $this->deleteIdImage($idImagePath);

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
