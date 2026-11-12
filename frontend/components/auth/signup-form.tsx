"use client";

import { useState, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { register, type AppliedType, type RegistrationAgreement, RegisterError } from "@/lib/auth/register";
import RegistrationTermsModal from "./registration-terms-modal";
import { sendVerificationCode, verifyEmailCode, VerificationError } from "@/lib/auth/email-verification";
import Stepper, { Step } from "@/components/Stepper";
import styles from "./signup.module.css";
import CodeInput from "@/components/auth/code-input";
import { AdminDatePicker } from "@/components/admin/ui/admin-date-picker";
import { CONTACT_NUMBER_PATTERN, CONTACT_NUMBER_ERROR, formatContactNumberInput } from "@/lib/utils/format";
import { PASSWORD_RULES } from "@/lib/utils/password-policy";
import { useDiscountProof } from "@/components/commuter/discount-proof-fields";
import { EDUCATION_LABELS, ENROLLMENT_TERMS, HIGH_SCHOOL_GRADES, type EducationLevel } from "@/lib/shared/services/student-renewal.service";

// Camera-dependent, so it stays out of the initial bundle and off the server.
const IdCaptureModal = dynamic(() => import("@/components/auth/id-capture-modal"), {
  ssr: false,
});

// Map the form's display labels to the backend's enum values
const COMMUTER_TYPE_OPTIONS: { label: string; value: AppliedType }[] = [
  { label: "Regular", value: "REGULAR" },
  { label: "Student", value: "STUDENT" },
  { label: "Senior Citizen", value: "SENIOR" },
  { label: "PWD", value: "PWD" },
];

// Mirrors RegisterRequest's suffix allow-list on the backend.
const SUFFIX_OPTIONS = ["Jr.", "Sr.", "II", "III", "IV"];

// What the ID upload box asks for, based on the commuter type chosen in step 1.
const ID_UPLOAD_LABELS: Record<AppliedType, string> = {
  REGULAR: "Upload Valid ID *",
  STUDENT: "Upload Student ID / Any School Form *",
  SENIOR: "Upload Senior Citizen ID/Card *",
  PWD: "Upload PWD ID/Card *",
};

/** Capitalizes the first letter of each word as the user types, e.g. "matti" -> "Matti". */
function formatPersonName(value: string): string {
  return value.replace(/(^|\s)([a-z])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ACCEPTED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const LAST_STEP = 4;
// Same cap as RegisterRequest (max:16).
const USERNAME_MAX = 16;

const STEP_COPY: Record<number, { title: string; subtitle: string }> = {
  1: { title: "Personal Information", subtitle: "Tell us a bit about yourself" },
  2: { title: "Contact & Verification", subtitle: "We need this for verification" },
  3: { title: "Confirm Your Email", subtitle: "Enter the 6-digit code we just emailed you" },
  4: { title: "Account Credentials", subtitle: "Secure your account" },
};

/**
 * Which step owns each backend field. When the server rejects the final
 * submit over something entered earlier — a taken email, a bad birthdate —
 * we send the user back to that step instead of showing an error next to
 * fields they can't see.
 */
const FIELD_STEP: Record<string, number> = {
  first_name: 1, middle_name: 1, suffix: 1, surname: 1, birthdate: 1, gender: 1, applied_type: 1,
  school_name: 1, education_level: 1, grade_level: 1, school_year: 1, enrollment_term: 1,
  email: 2, contact_number: 2, id_image: 2,
  username: 4, password: 4, password_confirmation: 4,
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupForm({ onBusyChange, initialMaintenanceMessage = null }: {
  onBusyChange?: (busy: boolean) => void;
  initialMaintenanceMessage?: string | null;
}) {
  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const registrationInFlight = useRef(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Timestamp of the last step change — used to ignore a phantom submit that
  // fires in the same instant we advance onto the final step.
  const lastStepChangeAt = useRef<number>(0);

  const [formData, setFormData] = useState({
    surname: "",
    firstName: "",
    middleName: "",
    suffix: "",
    birthdate: "",
    gender: "",
    email: "",
    contactNumber: "",
    appliedType: "" as AppliedType | "",
    username: "",
    password: "",
    confirmPassword: "",
  });
  // A Student's school details: the same state, rules and payload renewal and
  // onsite registration use. The proof document is the step 2 ID upload.
  const school = useDiscountProof();
  const isStudent = formData.appliedType === "STUDENT";
  const [idImage, setIdImage] = useState<File | null>(null);
  // Admin setting "Force Valid ID Upload" (public via /api/system-status).
  // Defaults to required, so a failed or slow lookup never relaxes the rule.
  const [idUploadRequired, setIdUploadRequired] = useState(true);
  const [maintenanceMessage] = useState<string | null>(initialMaintenanceMessage);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // Blurred "Take a Picture" / "Upload an Image" choice shown over the ID box.
  const [showIdOptions, setShowIdOptions] = useState(false);
  const [showIdCamera, setShowIdCamera] = useState(false);

  // ── Email verification state ──
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeNote, setCodeNote] = useState<string | null>(null);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  // The address that has actually been verified. Compared against the current
  // input, so editing the email silently voids the verification.
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    onBusyChange?.(isLoading || isSendingCode || isVerifyingCode || showIdCamera || showTerms);
  }, [isLoading, isSendingCode, isVerifyingCode, showIdCamera, showTerms, onBusyChange]);

  const normalizedEmail = formData.email.trim().toLowerCase();
  const isEmailVerified = verifiedEmail !== null && verifiedEmail === normalizedEmail;

  useEffect(() => {
    const timer = setTimeout(() => {
      const content = contentRef.current;
      content?.closest("dialog")?.scrollTo({ top: 0, behavior: "instant" });
      content?.querySelector<HTMLInputElement>("input:not([type='file'])")?.focus({ preventScroll: true });
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420);
    return () => clearTimeout(timer);
  }, [step, isSuccess]);

  // Resend cooldown ticker.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    // Capitalized/digit-stripped live so the field already shows what gets saved.
    setFormData({
      ...formData,
      [name]: name === "middleName" ? formatPersonName(value)
        : name === "contactNumber" ? formatContactNumberInput(value)
        : value,
    });

    // Editing the email abandons any code already typed — it belongs to the
    // old address. (The verification itself is void by comparison, not state.)
    if (name === "email") {
      setCode("");
      setCodeError(null);
      setCodeNote(null);
    }

    // Clear the related field error as the user edits. Some form fields use a
    // different name than the backend key, so map those too.
    setFieldErrors(prev => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      delete next[name];
      if (name === "firstName") delete next.first_name;
      if (name === "password" || name === "confirmPassword") delete next.password_confirmation;
      if (name === "contactNumber") delete next.contact_number;
      if (name === "appliedType") delete next.applied_type;
      return next;
    });
  };

  /** Shared by the file picker and the camera capture — same size/type rules either way. */
  const acceptIdFile = (file: File): boolean => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setFileError("That file type isn't supported. Upload a JPG, PNG, or WebP image.");
      setIdImage(null);
      setFileName(null);
      return false;
    }
    if (file.size > MAX_FILE_SIZE) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      setFileError(`That image is ${mb}MB. Please upload one under 5MB.`);
      setIdImage(null);
      setFileName(null);
      return false;
    }

    setFileError(null);
    setIdImage(file);
    setFileName(file.name);
    return true;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const file = e.target.files?.[0];
    if (!file) {
      setIdImage(null);
      setFileName(null);
      return;
    }
    acceptIdFile(file);
  };

  /** The camera modal hands back a captured photo as a File — same acceptance path. */
  const handleIdCapture = (file: File) => {
    acceptIdFile(file);
    setShowIdCamera(false);
  };

  // Whether the selected commuter type requires an ID upload
  const requiresId = formData.appliedType && formData.appliedType !== "REGULAR";
  // Student/Senior/PWD always prove their discount; a Regular commuter's ID
  // follows the admin setting.
  const idNeeded = Boolean(requiresId) || idUploadRequired;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/system-status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return;
        if (json?.data?.require_id_upload === false) setIdUploadRequired(false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  /**
   * Per-step client checks. Writes field-level errors (keyed by backend field
   * name) so each problem is flagged on the input it belongs to, instead of
   * one banner saying "fill out all required fields".
   */
  const validateStep = (stepNum: number): boolean => {
    const errors: Record<string, string[]> = {};

    if (stepNum === 1) {
      if (!formData.firstName.trim()) errors.first_name = ["Enter your first name."];
      if (!formData.surname.trim()) errors.surname = ["Enter your surname."];
      if (!formData.birthdate) {
        errors.birthdate = ["Enter your birthdate."];
      } else if (new Date(formData.birthdate) >= new Date(new Date().toDateString())) {
        errors.birthdate = ["Your birthdate must be in the past."];
      }
      if (!formData.gender) errors.gender = ["Select your gender."];
      if (!formData.appliedType) errors.applied_type = ["Select the commuter type you're applying for."];
      if (isStudent) {
        if (!school.schoolName.trim()) errors.school_name = ["Enter the name of your school."];
        if (!school.educationLevel) errors.education_level = ["Select your education level."];
        if (school.educationLevel === "HIGH_SCHOOL" && !school.gradeLevel) errors.grade_level = ["Select your grade level."];
        if (!school.schoolYear.trim()) errors.school_year = ["Enter the school year."];
        if (school.educationLevel === "COLLEGE" && !school.term.trim()) errors.enrollment_term = ["Select your enrollment term."];
      }
    }

    if (stepNum === 2) {
      if (!formData.email.trim()) {
        errors.email = ["Enter your email address."];
      } else if (!EMAIL_PATTERN.test(normalizedEmail)) {
        errors.email = ["That doesn't look like a valid email address."];
      }

      if (!formData.contactNumber.trim()) {
        errors.contact_number = ["Enter your contact number."];
      } else if (!CONTACT_NUMBER_PATTERN.test(formData.contactNumber.trim())) {
        errors.contact_number = [CONTACT_NUMBER_ERROR];
      }

      if (!idImage && idNeeded) {
        setFileError(
          requiresId
            ? "Upload the valid ID that proves your Student, Senior, or PWD discount."
            : "A valid ID image is required to complete registration."
        );
      }
    }

    if (stepNum === LAST_STEP) {
      if (!formData.username.trim()) errors.username = ["Choose a username."];
      // Mirrors RegisterRequest: letters, numbers, '.' and '_' only, max 16.
      else if (!/^[A-Za-z0-9._]+$/.test(formData.username)) errors.username = ["Usernames can only use letters, numbers, periods (.) and underscores (_), with no spaces."];
      else if (formData.username.length > USERNAME_MAX) errors.username = [`Usernames can be at most ${USERNAME_MAX} characters.`];
      if (!formData.password) {
        errors.password = ["Enter a password."];
      } else {
        const missing = PASSWORD_RULES.filter(r => !r.test(formData.password));
        if (missing.length > 0) errors.password = ["Your password doesn't meet every requirement below yet."];
      }
      if (!formData.confirmPassword) {
        errors.password_confirmation = ["Re-enter your password to confirm it."];
      } else if (formData.password && formData.password !== formData.confirmPassword) {
        errors.password_confirmation = ["These passwords don't match."];
      }
    }

    setFieldErrors(errors);

    const blockedByFile = stepNum === 2 && !idImage && idNeeded;
    if (Object.keys(errors).length > 0 || blockedByFile) return false;

    setServerError(null);
    return true;
  };

  /** Request a verification code for the address on step 2. */
  const requestCode = async (isResend: boolean): Promise<boolean> => {
    setIsSendingCode(true);
    setCodeError(null);
    setCodeNote(null);
    setServerError(null);

    try {
      const result = await sendVerificationCode(normalizedEmail, formData.contactNumber.trim());
      setResendIn(result.resend_in_seconds || 60);
      setCode("");
      setCodeNote(
        isResend
          ? "A new code is on its way — the previous one no longer works."
          : `We sent a 6-digit code to ${normalizedEmail}.`
      );
      return true;
    } catch (err) {
      if (err instanceof VerificationError) {
        // Already asked for a code moments ago — they have a usable one, so
        // let them carry on to the code screen rather than blocking here.
        // Only the per-address cooldown says so (resendInSeconds); a plain
        // rate-limit 429 means no code may exist, so it falls through to the
        // error below instead of restarting the timer with nothing sent.
        if (err.status === 429 && err.resendInSeconds) {
          setResendIn(err.resendInSeconds);
          setCodeNote("You requested a code a moment ago — check your inbox for it.");
          return true;
        }

        // Anything the server pinned to a field (address in use, rejection
        // cooldown) belongs to step 2, where the applicant can fix it. The
        // inline message under that field is enough — showing the same
        // thing again as a top banner is redundant.
        if (Object.keys(err.errors).length > 0) {
          setFieldErrors(err.errors);
          setStep(2);
        } else {
          setServerError(err.message);
        }
      } else {
        setServerError("We couldn't send the code. Please try again.");
      }
      return false;
    } finally {
      setIsSendingCode(false);
    }
  };

  const goToStep = (next: number) => {
    lastStepChangeAt.current = Date.now();
    setStep(next);
  };

  const handleNext = async () => {
    if (!validateStep(step)) return;
    setServerError(null);

    if (step === 2) {
      // Already proved this exact address — don't make them do it twice.
      if (isEmailVerified) {
        setFieldErrors({});
        goToStep(4);
        return;
      }

      const sent = await requestCode(false);
      if (!sent) return;
      setFieldErrors({});
      goToStep(3);
      return;
    }

    setFieldErrors({});
    goToStep(step + 1);
  };

  const handlePrev = () => {
    setServerError(null);
    setFieldErrors({});
    // Step 4 sits behind verification: going back lands on the contact step,
    // where the email lives, not on a code screen for a code already spent.
    goToStep(step === 4 ? 2 : step - 1);
  };

  /** Step 3 — check the code and move on to credentials. */
  const handleVerifyCode = async () => {
    if (code.length !== 6) {
      setCodeError("Enter all 6 digits from the email.");
      return;
    }

    setIsVerifyingCode(true);
    setCodeError(null);
    setCodeNote(null);

    try {
      await verifyEmailCode(normalizedEmail, code);
      setVerifiedEmail(normalizedEmail);
      goToStep(4);
    } catch (err) {
      if (err instanceof VerificationError) {
        setCodeError(err.message);
        // Code spent or rate-limited — clear the boxes so the next thing typed
        // is a fresh code, not a correction of a dead one.
        if (err.needsNewCode) {
          setCode("");
          setResendIn(0);
        }
      } else {
        setCodeError("We couldn't check that code. Please try again.");
      }
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (registrationInFlight.current || showTerms) return;

    // Enter on the code screen should verify, not submit a half-filled form.
    if (step === 3) {
      if (!isVerifyingCode) handleVerifyCode();
      return;
    }

    // Only the final step (Account Credentials) registers. This also stops an
    // accidental Enter keypress on an earlier step from firing a half-empty
    // request that comes back with raw "field is required" errors.
    if (step !== LAST_STEP) return;

    // Ignore a submit that fires in the same instant we advanced onto step 4.
    // The "Next Step" and "Create Account" buttons share a slot, so the
    // keypress/activation that triggered "Next" can carry over onto the newly
    // rendered submit button. A real user can't fill this step that fast.
    if (Date.now() - lastStepChangeAt.current < 400) return;

    if (!validateStep(LAST_STEP)) return;

    if (!idImage && idNeeded) {
      setFileError("A valid ID image is required.");
      setStep(2);
      return;
    }

    // The address must still be the verified one — someone could have gone
    // back and edited it after verifying.
    if (!isEmailVerified) {
      setServerError("Your email address changed, so it needs verifying again.");
      setFieldErrors({ email: ["Verify this address to continue."] });
      goToStep(2);
      return;
    }

    setServerError(null);
    setShowTerms(true);
  };

  const submitRegistration = async (agreement: RegistrationAgreement) => {
    if (registrationInFlight.current || !showTerms) return;
    registrationInFlight.current = true;
    setIsLoading(true);
    setServerError(null);
    setFieldErrors({});

    try {
      await register({
        ...agreement,
        first_name: formData.firstName,
        middle_name: formData.middleName || undefined,
        suffix: formData.suffix || undefined,
        surname: formData.surname,
        birthdate: formData.birthdate,
        gender: formData.gender,
        email: normalizedEmail,
        contact_number: formData.contactNumber,
        username: formData.username,
        password: formData.password,
        password_confirmation: formData.confirmPassword,
        applied_type: formData.appliedType as AppliedType,
        id_image: idImage,
        // Only text fields here (no document), so every value is a string.
        student_details: isStudent ? Object.fromEntries(school.formData(true, false)) as Record<string, string> : undefined,
      });

      // Success — show pending review screen (no auto-login)
      setShowTerms(false);
      setIsSuccess(true);
    } catch (err) {
      if (err instanceof RegisterError) {
        setFieldErrors(err.errors);

        // Send the user to the earliest step that owns a rejected field, so
        // the message is next to the input that caused it.
        const steps = Object.keys(err.errors)
          .map((field) => FIELD_STEP[field])
          .filter((s): s is number => typeof s === "number");
        const earliest = steps.length > 0 ? Math.min(...steps) : LAST_STEP;
        if (steps.length > 0) setShowTerms(false);

        if (earliest < LAST_STEP) {
          goToStep(earliest);
          setServerError(
            err.errors.email?.[0] ??
            "Something needs fixing on an earlier step — check the highlighted fields."
          );
        } else {
          setServerError(err.message);
        }
      } else {
        setServerError("An unexpected error occurred. Please try again.");
      }
    } finally {
      registrationInFlight.current = false;
      setIsLoading(false);
    }
  };

  if (maintenanceMessage !== null) {
    return (
      <div className={styles.success} role="status" aria-live="polite">
        <h2 id="signup-heading" className={styles.title}>Under maintenance</h2>
        <p id="signup-description" className={`${styles.subtitle} whitespace-pre-line break-words max-w-full`}>
          {maintenanceMessage}
        </p>
        <p className={styles.subtitle}>Sign-up is temporarily unavailable. Please try again later.</p>
      </div>
    );
  }

  // ── Success: Pending Review Screen ──
  if (isSuccess) {
    return (
      <div className={styles.success}>
        <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center mb-6">
          <svg className="w-10 h-10 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
          </svg>
        </div>
        <h2 id="signup-heading" className="text-2xl font-bold text-[#071A2E] mb-3">Registration Submitted!</h2>
        <p id="signup-description" className="text-base text-gray-500 max-w-md mb-2">
          Your account is <span className="font-semibold text-amber-600">pending admin approval</span>.
          An administrator will review your valid ID and verify your discount tier.
        </p>
        <p className="text-sm text-gray-400 max-w-md mb-8">
          We&apos;ll email <span className="font-medium text-gray-500">{normalizedEmail}</span> as soon as your
          account is approved. You cannot log in until then.
        </p>
        <Link
          href="/login" replace scroll={false}
          className={styles.primaryButton}
        >
          Back to Login
        </Link>
      </div>
    );
  }

  const inputClasses = styles.input;
  const labelClasses = styles.label;
  const errorClasses = styles.fieldError;

  // Helper to get field error (maps form field names to backend field names)
  const getFieldError = (formField: string, backendField?: string): string | null => {
    const key = backendField ?? formField;
    return fieldErrors[key]?.[0] ?? null;
  };

  const errorRing = (field: string) => (getFieldError(field) ? styles.invalid : "");
  const clearFieldError = (...fields: string[]) => setFieldErrors((previous) => {
    if (!fields.some((field) => field in previous)) return previous;
    const next = { ...previous };
    for (const field of fields) delete next[field];
    return next;
  });
  const schoolYearStart = new Date().getFullYear();

  return (
    <div ref={contentRef} className={styles.form}>
      {/* Form Content */}
      <form onSubmit={handleSubmit} className={styles.formElement} aria-busy={isLoading || isSendingCode || isVerifyingCode}>
        <Stepper
          currentStep={step}
          disableStepIndicators
          hideNavigation
          header={
            <>
              {/* Dynamic Header */}
              <div className={styles.stepHeading}>
                <h2 id="signup-heading" className={styles.title}>
                  {STEP_COPY[step].title}
                </h2>
                <p id="signup-description" className={styles.subtitle}>
                  {STEP_COPY[step].subtitle}
                </p>
              </div>

              {/* Server Error Banner */}
              {serverError && (
                <div role="alert" className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 flex gap-3">
                  <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
                  </svg>
                  <p className="text-sm text-red-600 font-medium">{serverError}</p>
                </div>
              )}
            </>
          }
          footer={
            <>
              {/* Navigation Buttons */}
              <div className={styles.navigation}>
                {step > 1 && (
                  <button
                    type="button"
                    onClick={handlePrev}
                    disabled={isLoading || isSendingCode || isVerifyingCode}
                    className={styles.backButton}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
                    </svg>
                    Back
                  </button>
                )}

                {step === 3 ? (
                  <button
                    key="nav-verify"
                    type="button"
                    onClick={handleVerifyCode}
                    disabled={isVerifyingCode || isSendingCode}
                    className={styles.primaryButton}
                  >
                    {isVerifyingCode ? (
                      <Spinner />
                    ) : (
                      <>
                        Verify &amp; Continue
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                        </svg>
                      </>
                    )}
                  </button>
                ) : step < LAST_STEP ? (
                  <button
                    key="nav-next"
                    type="button"
                    onClick={handleNext}
                    disabled={isSendingCode}
                    className={styles.primaryButton}
                  >
                    {isSendingCode ? (
                      <>
                        <Spinner />
                        Sending code…
                      </>
                    ) : (
                      <>
                        {step === 2 && !isEmailVerified ? "Send Code" : "Next Step"}
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                        </svg>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    key="nav-submit"
                    type="submit"
                    disabled={isLoading}
                    className={styles.primaryButton}
                  >
                    {isLoading ? <Spinner /> : "Create Account"}
                  </button>
                )}
              </div>
            </>
          }
        >
          {/* STEP 1 — Personal Info */}
          <Step key="1">
            <div className={styles.personalGrid}>
              <div>
                <label htmlFor="firstName" className={labelClasses}>
                  First Name *
                </label>
                <input id="firstName" name="firstName" type="text" value={formData.firstName} onChange={handleChange} className={`${inputClasses} ${errorRing("first_name")}`} placeholder="Juan" />
                {getFieldError("first_name") && <p className={errorClasses}>{getFieldError("first_name")}</p>}
              </div>
              <div>
                <label htmlFor="surname" className={labelClasses}>
                  Surname *
                </label>
                <input id="surname" name="surname" type="text" value={formData.surname} onChange={handleChange} className={`${inputClasses} ${errorRing("surname")}`} placeholder="Dela Cruz" />
                {getFieldError("surname") && <p className={errorClasses}>{getFieldError("surname")}</p>}
              </div>
              <div>
                <label htmlFor="middleName" className={labelClasses}>
                  Middle Name <span className={styles.optional}>Optional</span>
                </label>
                <input id="middleName" name="middleName" type="text" value={formData.middleName} onChange={handleChange} className={inputClasses} placeholder="Santos" />
              </div>
              <div>
                <label htmlFor="suffix" className={labelClasses}>
                  Suffix
                </label>
                <select id="suffix" name="suffix" value={formData.suffix} onChange={handleChange} className={inputClasses}>
                  <option value="">None</option>
                  {SUFFIX_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="birthdate" className={labelClasses}>
                  Birthdate *
                </label>
                <AdminDatePicker
                  id="birthdate"
                  value={formData.birthdate}
                  onChange={(birthdate) => {
                    setFormData((previous) => ({ ...previous, birthdate }));
                    setFieldErrors((previous) => {
                      const next = { ...previous };
                      delete next.birthdate;
                      return next;
                    });
                  }}
                  ariaLabel="Birthdate"
                  invalid={Boolean(getFieldError("birthdate"))}
                  errorId="signup-birthdate-error"
                  clearLabel="Clear birthdate"
                  popover
                  yearNavigation
                  className={styles.datePicker}
                  triggerClassName={`${inputClasses} ${styles.dateTrigger} ${errorRing("birthdate")}`}
                />
                <input name="birthdate" type="hidden" value={formData.birthdate} />
                {getFieldError("birthdate") && <p id="signup-birthdate-error" className={errorClasses}>{getFieldError("birthdate")}</p>}
              </div>
              <div>
                <label htmlFor="gender" className={labelClasses}>
                  Gender *
                </label>
                <select id="gender" name="gender" value={formData.gender} onChange={handleChange} className={`${inputClasses} ${errorRing("gender")}`}>
                  <option value="" disabled>
                    Select Gender
                  </option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Prefer not to say">Prefer not to say</option>
                </select>
                {getFieldError("gender") && <p className={errorClasses}>{getFieldError("gender")}</p>}
              </div>
              <div>
                <label htmlFor="appliedType" className={labelClasses}>
                  Commuter Type *
                </label>
                <select id="appliedType" name="appliedType" value={formData.appliedType} onChange={handleChange} className={`${inputClasses} ${errorRing("applied_type")}`}>
                  <option value="" disabled>
                    Select Type
                  </option>
                  {COMMUTER_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {getFieldError("applied_type") && <p className={errorClasses}>{getFieldError("applied_type")}</p>}
              </div>
            </div>

            {/* Student only: the school details renewal asks for. The student
                ID / school form itself is uploaded on step 2. */}
            {isStudent && (
              <section aria-labelledby="signup-school-heading" className={styles.schoolDetails}>
                <h3 id="signup-school-heading" className={styles.schoolHeading}>School details</h3>
                <p className={styles.schoolNote}>Reviewed with your student ID before your discount is approved.</p>
                <div className={styles.schoolGrid}>
                  <div className={styles.wide}>
                    <label htmlFor="schoolName" className={labelClasses}>School *</label>
                    <input id="schoolName" type="text" maxLength={150} autoComplete="organization" value={school.schoolName}
                      onChange={(e) => { school.setSchoolName(e.target.value); clearFieldError("school_name"); }}
                      className={`${inputClasses} ${errorRing("school_name")}`} placeholder="Name of your school or university" />
                    {getFieldError("school_name") && <p className={errorClasses}>{getFieldError("school_name")}</p>}
                  </div>
                  <div className={school.educationLevel === "HIGH_SCHOOL" ? undefined : styles.wide}>
                    <label htmlFor="educationLevel" className={labelClasses}>Education level *</label>
                    <select id="educationLevel" value={school.educationLevel}
                      onChange={(e) => {
                        const level = e.target.value as EducationLevel;
                        school.setEducationLevel(level);
                        if (level === "COLLEGE") school.setGradeLevel("");
                        clearFieldError("education_level", "grade_level", "enrollment_term");
                      }}
                      className={`${inputClasses} ${errorRing("education_level")}`}>
                      <option value="" disabled>Select level</option>
                      {(Object.keys(EDUCATION_LABELS) as EducationLevel[]).map((level) => (
                        <option key={level} value={level}>{EDUCATION_LABELS[level]}</option>
                      ))}
                    </select>
                    {getFieldError("education_level") && <p className={errorClasses}>{getFieldError("education_level")}</p>}
                  </div>
                  {school.educationLevel === "HIGH_SCHOOL" && (
                    <div>
                      <label htmlFor="gradeLevel" className={labelClasses}>Grade level *</label>
                      <select id="gradeLevel" value={school.gradeLevel}
                        onChange={(e) => { school.setGradeLevel(e.target.value); clearFieldError("grade_level"); }}
                        className={`${inputClasses} ${errorRing("grade_level")}`}>
                        <option value="" disabled>Select grade</option>
                        {HIGH_SCHOOL_GRADES.map((grade) => <option key={grade} value={grade}>Grade {grade}</option>)}
                      </select>
                      {getFieldError("grade_level") && <p className={errorClasses}>{getFieldError("grade_level")}</p>}
                    </div>
                  )}
                  <div>
                    <label htmlFor="schoolYear" className={labelClasses}>School year *</label>
                    <input id="schoolYear" type="text" maxLength={20} value={school.schoolYear}
                      onChange={(e) => { school.setSchoolYear(e.target.value); clearFieldError("school_year"); }}
                      className={`${inputClasses} ${errorRing("school_year")}`} placeholder={`For example, ${schoolYearStart}–${schoolYearStart + 1}`} />
                    {getFieldError("school_year") && <p className={errorClasses}>{getFieldError("school_year")}</p>}
                  </div>
                  <div>
                    <label htmlFor="enrollmentTerm" className={labelClasses}>
                      Enrollment term {school.educationLevel === "HIGH_SCHOOL" ? <span className={styles.optional}>Optional</span> : "*"}
                    </label>
                    <select id="enrollmentTerm" value={school.term}
                      onChange={(e) => { school.setTerm(e.target.value); clearFieldError("enrollment_term"); }}
                      className={`${inputClasses} ${errorRing("enrollment_term")}`}>
                      {/* Optional for high school, so the empty choice stays pickable there. */}
                      <option value="" disabled={school.educationLevel !== "HIGH_SCHOOL"}>{school.educationLevel === "HIGH_SCHOOL" ? "No term" : "Select term"}</option>
                      {ENROLLMENT_TERMS.map((term) => <option key={term} value={term}>{term}</option>)}
                    </select>
                    {getFieldError("enrollment_term") && <p className={errorClasses}>{getFieldError("enrollment_term")}</p>}
                  </div>
                </div>
              </section>
            )}
          </Step>

          {/* STEP 2 — Contact + ID Upload */}
          <Step key="2">
            <div className={styles.stepFields}>
              <div className={styles.contactFields}>
                <div>
                  <label htmlFor="email" className={labelClasses}>
                    Email Address *
                  </label>
                  <input id="email" name="email" type="email" value={formData.email} onChange={handleChange} className={`${inputClasses} ${errorRing("email")}`} placeholder="juandelacruz@gmail.com" />
                  {getFieldError("email") && <p className={errorClasses}>{getFieldError("email")}</p>}
                  {isEmailVerified ? (
                    <p className="mt-1.5 text-sm text-green-600 font-medium flex items-center gap-1.5">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                      </svg>
                      Verified
                    </p>
                  ) : (
                    <p className="mt-1.5 text-xs text-gray-400">We&apos;ll send a 6-digit code here to confirm it&apos;s yours.</p>
                  )}
                </div>
                <div>
                  <label htmlFor="contactNumber" className={labelClasses}>
                    Contact Number *
                  </label>
                  <input
                    id="contactNumber"
                    name="contactNumber"
                    type="tel"
                    value={formData.contactNumber}
                    onChange={handleChange}
                    maxLength={11}
                    className={`${inputClasses} ${errorRing("contact_number")}`}
                    placeholder="09171234567"
                  />
                  {getFieldError("contact_number") && <p className={errorClasses}>{getFieldError("contact_number")}</p>}
                </div>
              </div>
              <div>
                <label className={labelClasses}>{formData.appliedType === "REGULAR" && !idNeeded ? "Upload Valid ID (optional)" : formData.appliedType ? ID_UPLOAD_LABELS[formData.appliedType] : "Valid ID Upload *"}</label>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setShowIdOptions(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setShowIdOptions(true);
                    }
                  }}
                  className={`${styles.uploadArea} group ${
                    fileError ? "border-red-300 bg-red-50" : fileName ? "border-green-400 bg-green-50 hover:bg-green-100" : "border-[#1A5FB4]/30 bg-[#F8FAFC] hover:bg-[#F0F7FF]"
                  }`}
                >
                  {/*
                      fileInputRef.current.click() (fired by the "Upload an Image" button below)
                      dispatches a real click event that bubbles up through this input's ancestors
                      — including the container div's onClick — undoing the setShowIdOptions(false)
                      that same button just set. Stop it here so a completed upload doesn't
                      immediately reopen the overlay.
                    */}
                  <input ref={fileInputRef} id="validId" name="validId" type="file" accept="image/jpeg,image/jpg,image/png,image/webp" onChange={handleFileChange} onClick={(e) => e.stopPropagation()} className="hidden" />
                  {fileName ? (
                    <>
                      <svg className="w-10 h-10 text-green-500 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                      </svg>
                      <span className="text-base font-medium text-green-700 max-w-xs truncate px-4 text-center">{fileName}</span>
                      <span className="text-sm text-green-500 mt-1">Click to change</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-10 h-10 text-[#1A5FB4]/50 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                      </svg>
                      <span className="text-base text-gray-500">Click to add your ID (JPG, PNG, WebP — max 5MB)</span>
                    </>
                  )}

                  {/*
                      Blurred choice overlay — click the box, pick how to provide the ID.
                      Once an ID is already uploaded, the success state (checkmark + filename)
                      is what's shown at rest; this overlay only reappears on hover (or a
                      click, for touch devices without hover) so it doesn't cover the
                      confirmation that the upload succeeded.
                    */}
                  {(showIdOptions || fileName) && (
                    <div
                      className={`absolute inset-0 rounded-2xl backdrop-blur-md bg-white/70 flex flex-col items-center justify-center gap-3 px-6 transition-opacity duration-200 ${
                        fileName && !showIdOptions ? "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto" : "opacity-100"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowIdOptions(false);
                      }}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowIdOptions(false);
                          setShowIdCamera(true);
                        }}
                        className="w-full max-w-xs flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold bg-[#1A5FB4] text-white hover:bg-[#164A8F] transition-colors shadow-md shadow-[#1A5FB4]/20"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.174C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
                          />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
                        </svg>
                        Take a Picture of Your ID
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowIdOptions(false);
                          fileInputRef.current?.click();
                        }}
                        className="w-full max-w-xs flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold bg-white text-[#1A5FB4] border border-[#1A5FB4]/30 hover:bg-[#F0F7FF] transition-colors"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                        </svg>
                        Upload an Image
                      </button>
                    </div>
                  )}
                </div>
                {fileError && <p className={errorClasses}>{fileError}</p>}
                {getFieldError("id_image") && <p className={errorClasses}>{getFieldError("id_image")}</p>}
                <p className="text-xs text-gray-400 mt-2">A valid ID is required for all registrations. Student, Senior, or PWD selections require a matching valid ID.</p>
              </div>
            </div>
          </Step>

          {/* STEP 3 — Email Verification */}
          <Step key="3">
            <div className={styles.stepFields}>
              <div className={styles.emailNotice}>
                <svg className="w-5 h-5 text-[#1A5FB4] flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
                  />
                </svg>
                <div className="min-w-0">
                  <p className="text-sm text-gray-700">
                    Code sent to <span className="font-semibold text-[#071A2E] break-all">{normalizedEmail}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Wrong address?{" "}
                    <button type="button" onClick={handlePrev} className="font-semibold text-[#1A5FB4] hover:text-[#164A8F] underline underline-offset-2">
                      Go back and change it
                    </button>
                  </p>
                </div>
              </div>

              <div>
                <label className={labelClasses}>6-Digit Code *</label>
                {/* Checked on submit only — typing the last digit must not
                      turn the row red before the user has asked us to look. */}
                <CodeInput
                  value={code}
                  onChange={(next) => {
                    setCode(next);
                    setCodeError(null);
                  }}
                  disabled={isVerifyingCode || isSendingCode}
                  hasError={Boolean(codeError)}
                />
                {codeError && <p className={errorClasses}>{codeError}</p>}
                {!codeError && codeNote && <p className="text-sm text-gray-500 mt-1.5">{codeNote}</p>}
              </div>

              <div className={styles.resendRow}>
                <span className="text-gray-500">Didn&apos;t get the email?</span>
                {resendIn > 0 ? (
                  <span className="text-gray-400 tabular-nums">Resend available in {resendIn}s</span>
                ) : (
                  <button type="button" onClick={() => requestCode(true)} disabled={isSendingCode} className="font-semibold text-[#1A5FB4] hover:text-[#164A8F] disabled:opacity-60 disabled:cursor-not-allowed">
                    {isSendingCode ? "Sending…" : "Send a new code"}
                  </button>
                )}
              </div>
            </div>
          </Step>

          {/* STEP 4 — Credentials */}
          <Step key="4">
            <div className={styles.stepFields}>
              <div>
                <label htmlFor="username" className={labelClasses}>
                  Username *
                </label>
                <input id="username" name="username" type="text" value={formData.username} onChange={handleChange} maxLength={USERNAME_MAX} aria-describedby="username-hint" className={`${inputClasses} ${errorRing("username")}`} placeholder="juandelacruz_01" />
                {getFieldError("username")
                  ? <p className={errorClasses}>{getFieldError("username")}</p>
                  : <p id="username-hint" className="mt-1.5 text-xs text-[#8093aa]">Up to {USERNAME_MAX} characters ({formData.username.length}/{USERNAME_MAX}).</p>}
              </div>
              <div>
                <label htmlFor="password" className={labelClasses}>
                  Password *
                </label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    value={formData.password}
                    onChange={handleChange}
                    className={`${inputClasses} pr-14 ${errorRing("password")}`}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243"
                        />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178Z"
                        />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                      </svg>
                    )}
                  </button>
                </div>
                {getFieldError("password") && <p className={errorClasses}>{getFieldError("password")}</p>}

                {/* Live requirement checklist */}
                <ul className={styles.passwordRules}>
                  {PASSWORD_RULES.map((rule) => {
                    const met = rule.test(formData.password);
                    return (
                      <li key={rule.id} className={`flex items-center gap-2 text-sm ${met ? "text-green-600" : "text-gray-400"}`}>
                        {met ? (
                          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                          </svg>
                        ) : (
                          <span className="w-4 h-4 flex-shrink-0 flex items-center justify-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-current" />
                          </span>
                        )}
                        {rule.label}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <label htmlFor="confirmPassword" className={labelClasses}>
                  Confirm Password *
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showPassword ? "text" : "password"}
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  className={`${inputClasses} ${errorRing("password_confirmation")}`}
                  placeholder="••••••••"
                />
                {getFieldError("password_confirmation") && <p className={errorClasses}>{getFieldError("password_confirmation")}</p>}
              </div>
            </div>
          </Step>
        </Stepper>
      </form>

      {showIdCamera && <IdCaptureModal onCapture={handleIdCapture} onClose={() => setShowIdCamera(false)} />}
      {showTerms && (
        <RegistrationTermsModal
          busy={isLoading}
          error={serverError}
          onBack={() => {
            if (registrationInFlight.current) return;
            setShowTerms(false);
            setServerError(null);
          }}
          onConfirm={submitRegistration}
        />
      )}

      <p className={styles.accountPrompt}>
        Already have an account?{" "}
        <Link href="/login" replace scroll={false} className="font-semibold text-[#1A5FB4] hover:text-[#164A8F]">
          Sign in instead
        </Link>
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  );
}
