'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ImagePlus, Loader2, Mail, ShieldCheck, UserRound, X } from 'lucide-react';
import { Modal } from '@/components/admin/ui/modal';
import { CONTACT_NUMBER_ERROR, CONTACT_NUMBER_PATTERN, formatContactNumberInput } from '@/lib/utils/format';
import { compressImage, IMAGE_COMPRESSION } from '@/lib/utils/compress-image';

interface RegisterAdminModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

type FormValues = {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  contactNumber: string;
  address: string;
  username: string;
};

type FieldName = keyof FormValues;
type FormErrors = Partial<Record<FieldName | 'profilePicture', string>>;

const EMPTY_FORM: FormValues = {
  firstName: '',
  middleName: '',
  lastName: '',
  email: '',
  contactNumber: '',
  address: '',
  username: '',
};

const REQUIRED_FIELDS: FieldName[] = ['firstName', 'lastName', 'email', 'contactNumber', 'address', 'username'];

const FIELD_LABELS: Record<FieldName, string> = {
  firstName: 'First name',
  middleName: 'Middle name',
  lastName: 'Last name',
  email: 'Email address',
  contactNumber: 'Contact number',
  address: 'Complete address',
  username: 'Username',
};

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,50}$/;

export function RegisterAdminModal({ isOpen, onClose, onCreated }: RegisterAdminModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [profilePicture, setProfilePicture] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [stage, setStage] = useState<'form' | 'confirm' | 'result'>('form');
  const [isLoading, setIsLoading] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(false);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handleClose = () => {
    setForm(EMPTY_FORM);
    setProfilePicture(null);
    setPreviewUrl(null);
    setErrors({});
    setSubmissionError(null);
    setEmailSent(false);
    setStage('form');
    setIsLoading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    onClose();
  };

  const updateField = (name: FieldName, value: string) => {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  };

  const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setErrors((current) => ({ ...current, profilePicture: 'Choose a JPG, PNG, or WebP image.' }));
      event.target.value = '';
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setErrors((current) => ({ ...current, profilePicture: 'The image must be 5 MB or smaller.' }));
      event.target.value = '';
      return;
    }
    setProfilePicture(file);
    setPreviewUrl(URL.createObjectURL(file));
    setErrors((current) => ({ ...current, profilePicture: undefined }));
  };

  const removeImage = () => {
    setProfilePicture(null);
    setPreviewUrl(null);
    setErrors((current) => ({ ...current, profilePicture: undefined }));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    for (const field of REQUIRED_FIELDS) {
      if (!form[field].trim()) next[field] = `${FIELD_LABELS[field]} is required.`;
    }
    if (form.email.trim() && !EMAIL_PATTERN.test(form.email.trim())) {
      next.email = 'Enter a valid email address.';
    }
    if (form.contactNumber.trim() && !CONTACT_NUMBER_PATTERN.test(form.contactNumber.trim())) {
      next.contactNumber = CONTACT_NUMBER_ERROR;
    }
    if (form.username.trim() && !USERNAME_PATTERN.test(form.username.trim())) {
      next.username = 'Use 3–50 letters, numbers, periods, underscores, or hyphens.';
    }
    return next;
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate();
    if (errors.profilePicture) nextErrors.profilePicture = errors.profilePicture;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      const firstField = REQUIRED_FIELDS.find((field) => nextErrors[field]);
      if (firstField) document.getElementById(`admin-register-${firstField}`)?.focus();
      else fileInputRef.current?.focus();
      return;
    }
    setSubmissionError(null);
    setStage('confirm');
  };

  const confirmRegistration = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setSubmissionError(null);

    const requestBody = new FormData();
    requestBody.append('first_name', form.firstName.trim());
    if (form.middleName.trim()) requestBody.append('middle_name', form.middleName.trim());
    requestBody.append('last_name', form.lastName.trim());
    requestBody.append('email', form.email.trim());
    requestBody.append('contact_number', form.contactNumber.trim());
    requestBody.append('address', form.address.trim());
    requestBody.append('username', form.username.trim());
    if (profilePicture) requestBody.append('profile_picture', await compressImage(profilePicture, IMAGE_COMPRESSION.avatar));

    try {
      const response = await fetch('/api/admin/admins', {
        method: 'POST',
        body: requestBody,
        credentials: 'include',
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 422 && body?.errors) {
          const fieldMap: Record<string, FieldName | 'profilePicture'> = {
            first_name: 'firstName',
            middle_name: 'middleName',
            last_name: 'lastName',
            email: 'email',
            contact_number: 'contactNumber',
            address: 'address',
            username: 'username',
            profile_picture: 'profilePicture',
          };
          const nextErrors: FormErrors = {};
          for (const [field, messages] of Object.entries(body.errors as Record<string, string[]>)) {
            const mappedField = fieldMap[field];
            if (mappedField && messages?.[0]) nextErrors[mappedField] = messages[0];
          }
          setErrors(nextErrors);
          setStage('form');
        } else {
          setSubmissionError(body?.message ?? `Unable to create admin account (HTTP ${response.status}).`);
          setStage('form');
        }
        return;
      }

      setEmailSent(Boolean(body?.data?.email_sent));
      onCreated?.();
      setStage('result');
    } catch {
      setSubmissionError('Unable to reach the server. Please try again.');
      setStage('form');
    } finally {
      setIsLoading(false);
    }
  };

  const inputClasses = (field: FieldName) => `block min-h-11 w-full rounded-md border bg-[#0E1628] admin-light:bg-white px-3 py-2.5 text-sm text-white admin-light:text-slate-900 placeholder:text-slate-500 admin-light:placeholder:text-slate-400 outline-none transition-colors focus:ring-1 disabled:cursor-not-allowed disabled:opacity-60 ${
    errors[field]
      ? 'border-red-500/60 admin-light:border-red-300 focus:border-red-400 focus:ring-red-400/25'
      : 'border-[#1E2D45] admin-light:border-[#CBD5E1] focus:border-[#62A0EA] admin-light:focus:border-[#1A5FB4] focus:ring-[#62A0EA]/25 admin-light:focus:ring-[#1A5FB4]/20'
  }`;

  const fullName = [form.firstName, form.middleName, form.lastName].map((part) => part.trim()).filter(Boolean).join(' ');

  return (
    <Modal adminThemed isOpen={isOpen} onClose={isLoading ? () => {} : handleClose} maxWidth="max-w-3xl">
      {stage === 'form' && (
        <form onSubmit={handleSubmit} noValidate>
          <header className="mb-5 border-b border-[#2A3A55] admin-light:border-[#E2E8F0] pb-4 pr-8">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#62A0EA]/20 bg-[#62A0EA]/10 text-[#99C1F1] admin-light:border-[#1A5FB4]/15 admin-light:bg-[#1A5FB4]/5 admin-light:text-[#1A5FB4]">
                <ShieldCheck size={21} aria-hidden="true" />
              </div>
              <div>
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#99C1F1] admin-light:text-[#1A5FB4]">User Management</p>
                <h2 id="register-admin-title" className="text-lg font-bold text-white admin-light:text-slate-900 sm:text-xl">Register New Admin Account</h2>
              </div>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-400 admin-light:text-slate-500">Enter the new administrator’s details. Their temporary credentials will be emailed, and they’ll set a new password at first sign-in.</p>
            <p className="mt-2 text-xs text-slate-500 admin-light:text-slate-500"><span className="text-red-400 admin-light:text-red-600">*</span> Required fields</p>
          </header>

          {submissionError && <div role="alert" className="mb-4 rounded-md border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-400 admin-light:text-red-600">{submissionError}</div>}

          <section aria-labelledby="admin-register-personal" className="space-y-3">
            <h3 id="admin-register-personal" className="flex items-center gap-2 text-sm font-semibold text-white admin-light:text-slate-900"><UserRound size={16} className="text-slate-400 admin-light:text-slate-500" aria-hidden="true" /> Personal information</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field id="admin-register-firstName" label="First name" required error={errors.firstName}>
                <input id="admin-register-firstName" autoComplete="given-name" value={form.firstName} onChange={(event) => updateField('firstName', event.target.value)} maxLength={100} className={inputClasses('firstName')} placeholder="e.g. Juan" aria-invalid={Boolean(errors.firstName)} aria-describedby={errors.firstName ? 'admin-register-firstName-error' : undefined} />
              </Field>
              <Field id="admin-register-middleName" label="Middle name" hint="Optional" error={errors.middleName}>
                <input id="admin-register-middleName" autoComplete="additional-name" value={form.middleName} onChange={(event) => updateField('middleName', event.target.value)} maxLength={100} className={inputClasses('middleName')} placeholder="Middle name" aria-invalid={Boolean(errors.middleName)} aria-describedby={errors.middleName ? 'admin-register-middleName-error' : undefined} />
              </Field>
              <Field id="admin-register-lastName" label="Last name / surname" required error={errors.lastName}>
                <input id="admin-register-lastName" autoComplete="family-name" value={form.lastName} onChange={(event) => updateField('lastName', event.target.value)} maxLength={100} className={inputClasses('lastName')} placeholder="e.g. Dela Cruz" aria-invalid={Boolean(errors.lastName)} aria-describedby={errors.lastName ? 'admin-register-lastName-error' : undefined} />
              </Field>
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628]/60 admin-light:bg-[#F8FAFC] p-3 sm:flex-row sm:items-center">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#2A3A55] admin-light:border-[#CBD5E1] bg-[#1A2540] admin-light:bg-white">
                {previewUrl ? (
                  // Preview from a local object URL; upload happens only after confirmation.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="Admin profile picture preview" className="h-full w-full object-cover" />
                ) : <UserRound size={28} className="text-slate-500 admin-light:text-slate-400" aria-hidden="true" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white admin-light:text-slate-900">Profile picture <span className="ml-1 text-xs font-normal text-slate-400 admin-light:text-slate-500">Optional</span></p>
                <p className="mt-1 text-xs text-slate-500 admin-light:text-slate-500">JPG, PNG, or WebP up to 5 MB.</p>
                {errors.profilePicture && <p role="alert" className="mt-1 text-xs text-red-400 admin-light:text-red-600">{errors.profilePicture}</p>}
              </div>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageChange} className="sr-only" aria-label="Choose profile picture" />
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button type="button" onClick={() => fileInputRef.current?.click()} className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[#2A3A55] admin-light:border-[#CBD5E1] px-3 text-xs font-medium text-slate-200 admin-light:text-slate-700 transition-colors hover:bg-[#1A2540] admin-light:hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#62A0EA] admin-light:focus-visible:outline-[#1A5FB4]">
                  <ImagePlus size={15} aria-hidden="true" /> {profilePicture ? 'Replace' : 'Upload photo'}
                </button>
                {profilePicture && <button type="button" onClick={removeImage} className="inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-xs font-medium text-red-400 admin-light:text-red-600 hover:bg-red-400/10 admin-light:hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"><X size={14} aria-hidden="true" /> Remove</button>}
                {profilePicture && <span className="max-w-full truncate text-xs text-slate-500 admin-light:text-slate-500 sm:max-w-36" title={profilePicture.name}>{profilePicture.name}</span>}
              </div>
            </div>
          </section>

          <section aria-labelledby="admin-register-contact" className="mt-5 space-y-3 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] pt-5">
            <h3 id="admin-register-contact" className="flex items-center gap-2 text-sm font-semibold text-white admin-light:text-slate-900"><Mail size={16} className="text-slate-400 admin-light:text-slate-500" aria-hidden="true" /> Contact information</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="admin-register-email" label="Email address" required error={errors.email}>
                <input id="admin-register-email" type="email" autoComplete="email" value={form.email} onChange={(event) => updateField('email', event.target.value)} maxLength={255} className={inputClasses('email')} placeholder="juan.delacruz@gmail.com" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'admin-register-email-error' : undefined} />
              </Field>
              <Field id="admin-register-contactNumber" label="Contact number" required error={errors.contactNumber}>
                <input id="admin-register-contactNumber" type="tel" inputMode="numeric" autoComplete="tel-national" value={form.contactNumber} onChange={(event) => updateField('contactNumber', formatContactNumberInput(event.target.value))} maxLength={11} pattern="09[0-9]{9}" className={inputClasses('contactNumber')} placeholder="09171234567" aria-invalid={Boolean(errors.contactNumber)} aria-describedby={errors.contactNumber ? 'admin-register-contactNumber-error' : undefined} />
              </Field>
              <Field id="admin-register-address" label="Complete address" required error={errors.address} className="sm:col-span-2">
                <textarea id="admin-register-address" autoComplete="street-address" rows={2} value={form.address} onChange={(event) => updateField('address', event.target.value)} maxLength={255} className={`${inputClasses('address')} min-h-20 resize-y`} placeholder="House / unit, street, barangay, city or municipality, province" aria-invalid={Boolean(errors.address)} aria-describedby={errors.address ? 'admin-register-address-error' : undefined} />
              </Field>
            </div>
          </section>

          <section aria-labelledby="admin-register-account" className="mt-5 space-y-3 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] pt-5">
            <h3 id="admin-register-account" className="flex items-center gap-2 text-sm font-semibold text-white admin-light:text-slate-900"><ShieldCheck size={16} className="text-slate-400 admin-light:text-slate-500" aria-hidden="true" /> Account information</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="admin-register-username" label="Username" required error={errors.username}>
                <input id="admin-register-username" autoComplete="off" autoCapitalize="none" spellCheck={false} value={form.username} onChange={(event) => updateField('username', event.target.value.replace(/\s/g, ''))} maxLength={50} className={inputClasses('username')} placeholder="e.g. juan.delacruz" aria-invalid={Boolean(errors.username)} aria-describedby={errors.username ? 'admin-register-username-error' : undefined} />
              </Field>
              <div>
                <p className="mb-1.5 text-xs font-medium text-slate-300 admin-light:text-slate-700">Account role <span className="ml-1 font-normal text-slate-500 admin-light:text-slate-500">Fixed role</span></p>
                <div className="flex min-h-11 items-center gap-2 rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#111A2B] admin-light:bg-[#F1F5F9] px-3 text-sm text-slate-400 admin-light:text-slate-600" aria-label="Account role: Admin, fixed">
                  <ShieldCheck size={15} className="text-[#62A0EA] admin-light:text-[#1A5FB4]" aria-hidden="true" /> Admin <span className="ml-auto text-[11px] text-slate-500 admin-light:text-slate-500">Predefined</span>
                </div>
              </div>
            </div>
          </section>

          <footer className="mt-6 flex flex-col-reverse gap-2 border-t border-[#1E2D45] admin-light:border-[#E2E8F0] pt-4 sm:flex-row sm:justify-end">
            <button type="button" onClick={handleClose} className="min-h-11 rounded-md border border-[#2A3A55] admin-light:border-[#CBD5E1] px-4 text-sm font-medium text-slate-300 admin-light:text-slate-700 transition-colors hover:bg-[#1A2540] admin-light:hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#62A0EA] admin-light:focus-visible:outline-[#1A5FB4]">Cancel</button>
            <button type="submit" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-4 text-sm font-semibold text-[#071A2E] admin-light:text-white transition-colors hover:bg-[#7FB3F0] admin-light:hover:bg-[#164A8F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#62A0EA] disabled:cursor-not-allowed disabled:opacity-60"><Check size={16} aria-hidden="true" /> Register Admin</button>
          </footer>
        </form>
      )}

      {stage === 'confirm' && (
        <section aria-labelledby="admin-register-confirm-title" className="px-1 py-3">
          <header className="pr-8">
            <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg border border-[#62A0EA]/20 bg-[#62A0EA]/10 text-[#99C1F1] admin-light:border-[#1A5FB4]/15 admin-light:bg-[#1A5FB4]/5 admin-light:text-[#1A5FB4]"><ShieldCheck size={22} aria-hidden="true" /></div>
            <h2 id="admin-register-confirm-title" className="text-lg font-bold text-white admin-light:text-slate-900">Review admin registration</h2>
            <p className="mt-1 text-sm text-slate-400 admin-light:text-slate-500">Check the details before creating this admin account.</p>
          </header>
          <dl className="mt-5 space-y-3 rounded-lg border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-[#F8FAFC] p-4 text-sm">
            <SummaryRow label="Name" value={fullName} />
            <SummaryRow label="Email" value={form.email.trim()} />
            <SummaryRow label="Contact number" value={form.contactNumber.trim()} />
            <SummaryRow label="Address" value={form.address.trim()} />
            <SummaryRow label="Username" value={form.username.trim()} />
            <SummaryRow label="Role" value="Admin" />
            <SummaryRow label="Profile picture" value={profilePicture?.name ?? 'Not provided'} />
          </dl>
          <div className="mt-4 flex items-start gap-2 rounded-md border border-[#1E2D45] bg-[#1A2540] p-3 text-sm text-slate-200 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC] admin-light:text-slate-700">
            <Mail size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-400 admin-light:text-slate-500" />
            Continuing will create this admin account and send temporary credentials to the email shown above.
          </div>
          <footer className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setStage('form')} disabled={isLoading} className="min-h-11 rounded-md border border-[#2A3A55] admin-light:border-[#CBD5E1] px-4 text-sm font-medium text-slate-300 admin-light:text-slate-700 transition-colors hover:bg-[#1A2540] admin-light:hover:bg-slate-50 disabled:opacity-60">Back to form</button>
            <button type="button" onClick={confirmRegistration} disabled={isLoading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-4 text-sm font-semibold text-[#071A2E] admin-light:text-white transition-colors hover:bg-[#7FB3F0] admin-light:hover:bg-[#164A8F] disabled:cursor-wait disabled:opacity-70">
              {isLoading ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Registering…</> : 'Register Admin'}
            </button>
          </footer>
        </section>
      )}

      {stage === 'result' && (
        <section aria-labelledby="admin-register-result-title" className="flex flex-col items-center px-2 py-5 text-center">
          {emailSent
            ? <Check size={36} aria-hidden="true" className="mb-4 text-[#62A0EA] admin-light:text-[#1A5FB4]" />
            : <AlertCircle size={36} aria-hidden="true" className="mb-4 text-red-400 admin-light:text-red-600" />}
          <h2 id="admin-register-result-title" className="text-xl font-bold text-white admin-light:text-slate-900">Admin account created</h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400 admin-light:text-slate-500">{fullName} can sign in with {form.email.trim()}.</p>
          {emailSent ? (
            <p role="status" className="mt-4 w-full rounded-md border border-[#1E2D45] bg-[#1A2540] p-3 text-sm font-medium text-slate-200 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC] admin-light:text-slate-700">Temporary credentials were sent to {form.email.trim()}. The new Admin must set a new password at first sign-in.</p>
          ) : (
            <p role="status" className="mt-4 w-full rounded-md border border-[#1E2D45] bg-[#1A2540] p-3 text-sm font-medium text-slate-200 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC] admin-light:text-slate-700">The account was created, but the credentials email could not be sent. Ask the new Admin to use Forgot Password to recover access.</p>
          )}
          <button type="button" onClick={handleClose} className="mt-6 min-h-11 w-full rounded-md bg-[#62A0EA] admin-light:bg-[#1A5FB4] px-4 text-sm font-semibold text-[#071A2E] admin-light:text-white transition-colors hover:bg-[#7FB3F0] admin-light:hover:bg-[#164A8F] sm:w-auto">Done</button>
        </section>
      )}
    </Modal>
  );
}

function Field({ id, label, required = false, hint, error, className = '', children }: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-slate-300 admin-light:text-slate-700">
        {label}{required && <span className="text-red-400 admin-light:text-red-600" aria-hidden="true"> *</span>}{hint && <span className="ml-1 font-normal text-slate-500 admin-light:text-slate-500">{hint}</span>}
      </label>
      {children}
      {error && <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1 text-xs text-red-400 admin-light:text-red-600"><AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{error}</p>}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col gap-1 border-b border-[#1E2D45]/70 admin-light:border-[#E2E8F0] pb-2 last:border-b-0 last:pb-0 sm:flex-row sm:justify-between"><dt className="text-xs text-slate-400 admin-light:text-slate-500">{label}</dt><dd className="break-all font-medium text-white admin-light:text-slate-900 sm:text-right">{value}</dd></div>;
}
