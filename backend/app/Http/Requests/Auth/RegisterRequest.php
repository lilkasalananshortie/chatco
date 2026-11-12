<?php

namespace App\Http\Requests\Auth;

use App\Models\DiscountApplication;
use App\Models\Setting;
use App\Rules\PhilippineMobileNumber;
use App\Rules\StrongPassword;
use App\Rules\UniqueContactNumber;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Validates POST /api/v1/auth/register (public — commuter self-sign-up).
 *
 * The commuter registers themselves with their valid-ID details + a chosen
 * password. The account is created with account_status=PENDING and
 * commuter_type=applied_type; an admin must approve before login is allowed.
 *
 * EMAIL UNIQUENESS + SOFT-DELETED REUSE
 * --------------------------------------
 * The users.email column has a DB-level unique index, but SoftDeleted rows
 * still physically occupy the table (SoftDeletes is an Eloquent scope, not a
 * DB constraint). To honour the spec ("an email belonging only to a
 * soft-deleted account is reusable"), AdminService::rejectRegistration
 * rewrites a rejected applicant's email to a unique 'rejected+{timestamp}'
 * placeholder, freeing the canonical address. AuthService::register() then
 * enforces uniqueness manually against NON-deleted users only, so a
 * previously-rejected email can be re-registered.
 *
 * EMAIL VERIFICATION
 * ------------------
 * The address must already be verified — the applicant requests a 6-digit code
 * (POST /auth/register/send-code) and enters it (POST /auth/register/verify-code)
 * before this endpoint will create anything. That check lives in
 * AuthService::register via EmailVerificationService, not here, because it
 * needs to run alongside the rejection-cooldown guard.
 *
 * ID IMAGE
 * --------
 * The valid-ID image is uploaded as a multipart file. We validate it's an
 * image (jpeg/png/webp) with a 5MB max. The file is stored to
 * storage/app/public/ids/ and the path is persisted to
 * commuter_profiles.id_image_url. NEVER store the raw file in the DB.
 */
class RegisterRequest extends FormRequest
{
    /** Predefined suffix choices — kept in sync with the sign-up form's dropdown. */
    public const SUFFIX_OPTIONS = ['Jr.', 'Sr.', 'II', 'III', 'IV'];

    public function authorize(): bool
    {
        return true; // public endpoint
    }

    /**
     * Normalise the email before anything looks at it.
     *
     * The verification code is stored against the lower-cased address, and
     * uniqueness is checked against the stored value — so "Juan@Gmail.com"
     * here has to resolve to the same key as the "juan@gmail.com" the
     * applicant verified a minute ago.
     *
     * Also title-cases middle_name here (not just on the frontend) so the
     * saved value is properly capitalized regardless of what actually
     * reached the server, e.g. "matti" / "MATTI" -> "Matti".
     */
    protected function prepareForValidation(): void
    {
        if (is_string($this->email)) {
            $this->merge(['email' => Str::lower(trim($this->email))]);
        }

        if (is_string($this->middle_name) && trim($this->middle_name) !== '') {
            $this->merge(['middle_name' => Str::title(trim($this->middle_name))]);
        }

        foreach (DiscountApplication::STUDENT_TEXT_FIELDS as $field) {
            if (is_string($this->input($field))) {
                $this->merge([$field => trim($this->input($field))]);
            }
        }
    }

    public function rules(): array
    {
        return [
            'first_name' => ['required', 'string', 'max:100'],
            'middle_name' => ['nullable', 'string', 'max:100'],
            'suffix' => ['nullable', 'string', Rule::in(self::SUFFIX_OPTIONS)],
            'surname' => ['required', 'string', 'max:100'],
            'birthdate' => ['required', 'date', 'before:today'],
            'gender' => ['required', 'string', 'max:20'],
            'email' => ['required', 'string', 'email:rfc', 'max:255'],
            'contact_number' => ['required', 'string', new PhilippineMobileNumber, new UniqueContactNumber],
            // Letters, digits, '.' and '_' only: no spaces or other symbols.
            'username' => ['required', 'string', 'max:16', 'regex:/^[A-Za-z0-9._]+$/', 'unique:commuter_profiles,username'],
            'password' => ['required', 'string', 'confirmed', new StrongPassword],
            'language_preference' => ['nullable', 'string', 'max:20'],
            'applied_type' => ['required', 'string', Rule::in(['REGULAR', 'STUDENT', 'SENIOR', 'PWD'])],
            'terms_accepted' => ['required', 'accepted'],
            'privacy_acknowledged' => ['required', 'accepted'],
            'registration_confirmed' => ['required', 'accepted'],
            'terms_version' => ['required', Rule::in([config('registration.terms_version')])],
            'privacy_version' => ['required', Rule::in([config('registration.privacy_version')])],
            // Discount types must prove eligibility, so their ID is always
            // required; a REGULAR commuter's ID follows the admin's
            // "Force Valid ID Upload" setting.
            'id_image' => [
                Rule::requiredIf(fn () => $this->input('applied_type') !== 'REGULAR' || Setting::requiresIdUpload()),
                'nullable', 'file', 'image', 'mimes:jpeg,jpg,png,webp', 'max:5120',
            ],
            // A Student gives the same school details renewal and the admin's
            // onsite registration ask for; reviewed with the registration.
            ...DiscountApplication::studentDetailRules($this->input('applied_type') === 'STUDENT'),
        ];
    }

    public function messages(): array
    {
        return [
            'terms_accepted.required' => 'Please read and accept the Terms of Service.',
            'terms_accepted.accepted' => 'Please read and accept the Terms of Service.',
            'privacy_acknowledged.required' => 'Please acknowledge the Privacy Policy.',
            'privacy_acknowledged.accepted' => 'Please acknowledge the Privacy Policy.',
            'registration_confirmed.required' => 'Please confirm your registration details and the admin approval requirement.',
            'registration_confirmed.accepted' => 'Please confirm your registration details and the admin approval requirement.',
            'terms_version.in' => 'The terms have changed. Reload registration and review the current terms.',
            'privacy_version.in' => 'The privacy policy has changed. Reload registration and review the current policy.',
            'applied_type.in' => 'The applied type must be one of: REGULAR, STUDENT, SENIOR, PWD.',
            'suffix.in' => 'The suffix must be one of: '.implode(', ', self::SUFFIX_OPTIONS).'.',
            'username.unique' => 'The username has already been taken.',
            'username.max' => 'Usernames can be at most 16 characters.',
            'username.regex' => 'Usernames can only use letters, numbers, periods (.) and underscores (_), with no spaces.',
            'id_image.required' => 'A valid ID image is required to complete registration.',
            'password.confirmed' => 'The password confirmation does not match.',
        ];
    }
}
