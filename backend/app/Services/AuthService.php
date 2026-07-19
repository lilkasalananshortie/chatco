<?php

namespace App\Services;

use App\Enums\UserRole;
use App\Exceptions\AccountSuspendedException;
use App\Exceptions\RegistrationPendingException;
use App\Models\CommuterProfile;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class AuthService
{
    /**
     * Login with email, conductor generated_username, or commuter username.
     * Single optimized query with eager-loaded profiles.
     *
     * A commuter can sign in with EITHER their email OR the username they
     * chose at sign-up — both resolve to the same account. Conductors use
     * their admin-generated username. The SoftDeletes scope on User already
     * excludes rejected (soft-deleted) accounts, so a freed username reused
     * by a new commuter resolves only to the live account.
     */
    public function login(string $login, string $password): array
    {
        // Group the identity checks in a single closure so the SoftDeletes
        // scope (deleted_at IS NULL) wraps the whole OR set — otherwise SQL
        // precedence (AND binds tighter than OR) would let the orWhereHas
        // branches match soft-deleted (rejected) accounts.
        $user = User::with([
            'adminProfile',
            'conductorProfile',
            'commuterProfile',
        ])
            ->where(function ($q) use ($login) {
                $q->where('email', $login)
                    ->orWhereHas('conductorProfile', function ($qq) use ($login) {
                        $qq->where('generated_username', $login);
                    })
                    ->orWhereHas('commuterProfile', function ($qq) use ($login) {
                        $qq->where('username', $login);
                    });
            })
            ->first();

        if (! $user || ! Hash::check($password, $user->password)) {
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

        $token = $user->createToken('auth-token')->plainTextToken;

        return [
            'user' => $user,
            'token' => $token,
        ];
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
     * ID IMAGE (DEFERRED PERSISTENCE)
     * -------------------------------
     * The valid-ID image is accepted and validated by RegisterRequest as a
     * non-empty string, but the binary is NOT yet persisted to a storage
     * disk — we only store a derived path/identifier in
     * commuter_profiles.id_image_url so the API contract is honoured. When
     * the storage decision is made (S3 / local / etc.), swap the
     * resolveIdImagePath() call below for a real Storage::put() and write
     * the resulting URL — no schema or contract change required.
     *
     * @param  array<string, mixed>  $data  validated payload from RegisterRequest
     * @return array{user: User, profile: CommuterProfile}
     *
     * @throws ValidationException when the email is already held by a live user
     */
    public function register(array $data): array
    {
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

        return DB::transaction(function () use ($data): array {
            $user = User::create([
                'email' => $data['email'],
                'password' => $data['password'], // 'hashed' cast on User
                'role' => UserRole::COMMUTER,
            ]);

            $profile = CommuterProfile::create([
                'id' => $user->id,
                'first_name' => $data['first_name'],
                'middle_name' => $data['middle_name'] ?? null,
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
                'id_image_url' => $this->storeIdImage($user, $data['id_image']),
                'verified_at' => null,
                'rejection_reason' => null,
            ]);

            return [
                'user' => $user,
                'profile' => $profile,
            ];
        });
    }

    /**
     * Store the uploaded valid-ID image to the configured disk and return
     * the storage path. The file is saved to storage/app/public/ids/ so it
     * can be served via the public storage symlink. NEVER store the raw
     * file in the DB — only the path.
     *
     * @param  User  $user
     * @param  \Illuminate\Http\UploadedFile  $file
     * @return string  The storage path (e.g. 'ids/uuid-abc123.jpg')
     */
    private function storeIdImage(User $user, $file): string
    {
        // Store to the 'public' disk (storage/app/public/ids/)
        // The filename includes the user ID for traceability.
        $extension = $file->getClientOriginalExtension() ?: 'jpg';
        $filename = $user->id . '-' . Str::random(16) . '.' . $extension;

        return $file->storeAs('ids', $filename, 'public');
    }
}
