// lib/auth/register.ts
//
// Frontend service for commuter self-registration.
// Submits multipart form data (including the ID image file) to
// POST /api/auth/register → Laravel /api/v1/auth/register.

import { compressImage, IMAGE_COMPRESSION } from "@/lib/utils/compress-image";

export type AppliedType = "REGULAR" | "STUDENT" | "SENIOR" | "PWD";

export interface RegistrationAgreement {
  terms_accepted: true;
  privacy_acknowledged: true;
  registration_confirmed: true;
  terms_version: string;
  privacy_version: string;
}

export interface RegisterInput extends RegistrationAgreement {
  first_name: string;
  middle_name?: string;
  suffix?: string;
  surname: string;
  birthdate: string;
  gender: string;
  email: string;
  contact_number: string;
  username: string;
  password: string;
  password_confirmation: string;
  applied_type: AppliedType;
  language_preference?: string;
  /** Optional only for a REGULAR commuter while the admin's "Force Valid ID
   *  Upload" setting is off; the backend enforces who must send one. */
  id_image: File | null;
  /** A Student's school details (school_name, education_level, grade_level,
   *  school_year, enrollment_term), the same fields renewal asks for. */
  student_details?: Record<string, string>;
}

export interface RegisterResult {
  id: string;
  email: string;
  role: string;
  account_status: string;
  applied_type: string;
}

export class RegisterError extends Error {
  errors: Record<string, string[]>;
  status: number;

  constructor(message: string, errors: Record<string, string[]>, status: number) {
    super(message);
    this.name = "RegisterError";
    this.errors = errors;
    this.status = status;
  }
}

/**
 * Register a new commuter account.
 *
 * Sends multipart form data to /api/auth/register. On success, returns the
 * new account details (account_status = PENDING). On 422, throws a
 * RegisterError with field-specific validation messages.
 */
export async function register(input: RegisterInput): Promise<RegisterResult> {
  const formData = new FormData();

  formData.append("first_name", input.first_name);
  if (input.middle_name) formData.append("middle_name", input.middle_name);
  if (input.suffix) formData.append("suffix", input.suffix);
  formData.append("surname", input.surname);
  formData.append("birthdate", input.birthdate);
  formData.append("gender", input.gender);
  formData.append("email", input.email);
  formData.append("contact_number", input.contact_number);
  formData.append("username", input.username);
  formData.append("password", input.password);
  formData.append("password_confirmation", input.password_confirmation);
  formData.append("applied_type", input.applied_type);
  formData.append("terms_accepted", String(input.terms_accepted));
  formData.append("privacy_acknowledged", String(input.privacy_acknowledged));
  formData.append("registration_confirmed", String(input.registration_confirmed));
  formData.append("terms_version", input.terms_version);
  formData.append("privacy_version", input.privacy_version);
  if (input.language_preference) formData.append("language_preference", input.language_preference);
  if (input.id_image) formData.append("id_image", await compressImage(input.id_image, IMAGE_COMPRESSION.document));
  if (input.applied_type === "STUDENT") {
    for (const [key, value] of Object.entries(input.student_details ?? {})) formData.append(key, value);
  }

  const res = await fetch("/api/auth/register", {
    method: "POST",
    body: formData, // browser sets Content-Type: multipart/form-data automatically
  });

  const data = await res.json();

  if (!res.ok) {
    throw new RegisterError(
      data.message ?? "Registration failed.",
      data.errors ?? {},
      res.status
    );
  }

  return data.data as RegisterResult;
}
