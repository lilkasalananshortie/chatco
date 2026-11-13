"use client";

import { DiscountApplicationEntry } from './discount-application-entry';
import { StudentRenewalEntry } from './student-renewal-entry';
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, CircleHelp, Clock, KeyRound, Loader2, LogOut, Mail, Pencil, Phone, Save, ShieldCheck, ShieldX, UserRound, X } from "lucide-react";
import { useProfile } from "@/app/(commuter)/profile/use-profile";
import { AccountStatus } from "@/app/(commuter)/profile/types";
import { getCommuterTypeLabel } from "@/types";
import ChangeEmailDialog, { maskEmail } from "./change-email-dialog";
import ProfileThemeToggle from "./profile-theme-toggle";
import ProfilePhoto from "./profile-photo";
import AccountMenu, { type SignOutControl } from "./account-menu";

/**
 * The commuter Profile body, shared by both shells — same split as the
 * conductor's SettingsContent:
 *   - the full page (app/(commuter)/profile/page.tsx), used below xl:, by the
 *     lg: sidebar, and for direct links/refreshes;
 *   - the xl:+ popover (CommuterProfileModal), opened from CommuterDock so
 *     the commuter doesn't leave whatever tab they were on.
 * useProfile() owns all the data/business logic, so there is exactly one
 * implementation of it.
 *
 * `variant="page"` keeps a fixed mobile heading above the scrolling content and
 * full-height loading/error states; `variant="modal"` drops them because the
 * popover panel is the scroll container.
 *
 * At lg:+ Log out lives in AccountMenu instead of a lone button at the
 * bottom: the page renders it beside the avatar, and the popover renders it
 * in its own header, receiving the confirm trigger via `onSignOutControl`.
 *
 * The logout confirmation and Change Password dialogs are portaled to
 * <body>: inside the popover, the panel's transform-based entrance animation
 * would otherwise make their `fixed inset-0` overlays position relative to
 * the panel instead of the viewport.
 */
export default function ProfileContent({ variant = "page", onSignOutControl }: { variant?: "page" | "modal"; onSignOutControl?: (control: SignOutControl | null) => void }) {
  const isPage = variant === "page";
  const detailsHeadingId = useId();
  const contactHeadingId = useId();
  const securityHeadingId = useId();
  const contactInputId = useId();
  const contactFormId = useId();
  const contactErrorId = useId();
  const photoHelpId = useId();
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const closeEmailDialog = useCallback(() => setShowEmailDialog(false), []);
  // Logging out is one tap from a scrollable page and is not undoable without
  // re-entering credentials, so it goes through a confirmation first — same
  // treatment the admin side already gives it (components/admin/ui/sign-out-modal).
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const subdialogRef = useRef<HTMLDivElement>(null);
  const {
    profile,
    loadState,
    loadError,
    retryLoad,
    applyEmailChange,
    applyPhotoChange,
    isEditing,
    editData,
    startEditing,
    cancelEditing,
    saveProfile,
    isSaving,
    saveError,
    handleEditChange,
    showPasswordModal,
    setShowPasswordModal,
    passwordStep,
    passwordData,
    setPasswordData,
    verificationCode,
    setVerificationCode,
    resendSecondsLeft,
    isChangingPassword,
    handleRequestPasswordChangeCode,
    handleConfirmPasswordChange,
    handleResendCode,
    handleBackToPasswordForm,
    passwordError,
    passwordErrorField,
    closePasswordModal,
    successMessage,
    handleReuploadId,
    handleLogout,
  } = useProfile();

  // Hand the confirm trigger to the popover's header menu once the profile
  // has loaded (the confirmation dialog only renders in the loaded state).
  const isLoaded = !!profile;
  useEffect(() => {
    if (!onSignOutControl || !isLoaded) return;
    onSignOutControl({ request: () => setShowLogoutConfirm(true), locked: false });
    return () => onSignOutControl(null);
  }, [onSignOutControl, isLoaded]);

  useEffect(() => {
    if ((isPage && !showPasswordModal) || (!showLogoutConfirm && !showPasswordModal)) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => Array.from(subdialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? []);
    controls()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isChangingPassword) {
        setShowLogoutConfirm(false);
        closePasswordModal();
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  // The hook's close handler changes identity on render; keep focus stable
  // while typing rather than re-focusing the first field on every keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPage, showLogoutConfirm, showPasswordModal, isChangingPassword]);

  // ─── Load error ───────────────────────────────────────────────────
  if (loadState === "error") {
    return (
      <div className={isPage ? "h-full w-full flex flex-col items-center justify-center bg-[#050F1A] light:bg-[#F8FAFC] p-6" : "flex flex-col items-center justify-center px-6 py-20"}>
        <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-red-400 light:text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <p className="text-white font-semibold text-sm mb-1 light:text-gray-900">Couldn&apos;t load profile</p>
        <p className="text-white/40 text-xs light:text-gray-500 mb-5 text-center max-w-sm">{loadError}</p>
        <button
          onClick={retryLoad}
          className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#1A5FB4] text-white hover:bg-[#164A8F] transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  // ─── Loading ──────────────────────────────────────────────────────
  if (!profile) {
    return (
      <div className={isPage ? "h-full w-full flex flex-col items-center justify-center bg-[#050F1A] light:bg-[#F8FAFC]" : "flex flex-col items-center justify-center py-20"}>
        <div className="w-8 h-8 border-2 border-white/20 border-t-[#62A0EA] light:border-gray-200 light:border-t-[#1A5FB4] rounded-full animate-spin" />
        <p className="text-white/40 text-xs light:text-gray-500 mt-3">Loading your profile…</p>
      </div>
    );
  }

  // Account status reads as plain text with an icon, not a coloured pill;
  // only a rejection is red.
  const getStatusConfig = (status: AccountStatus) => {
    const plain = "text-white/85 light:text-gray-700";
    switch (status) {
      case "ACTIVE":
        return { color: plain, text: "Verified", icon: ShieldCheck };
      case "PENDING_VERIFICATION":
      case "PENDING":
        return { color: plain, text: "Pending Verification", icon: Clock };
      case "DISCOUNT_REJECTED":
      case "REJECTED":
        return { color: "text-red-400 light:text-red-600", text: "Rejected", icon: ShieldX };
      case "APPROVED":
        return { color: plain, text: "Approved", icon: ShieldCheck };
      default:
        return { color: "text-white/60 light:text-gray-500", text: status ?? "Unknown", icon: CircleHelp };
    }
  };

  const statusConfig = getStatusConfig(profile.accountStatus);
  const StatusIcon = statusConfig.icon;
  const discountPercentage = profile.commuterType === "REGULAR" ? 0 : 20;

  const inputClasses =
    `w-full px-4 py-3 rounded-xl border ${isPage ? "text-base lg:text-sm" : "text-sm"} transition-colors focus:outline-none focus:ring-2 focus:ring-[#62A0EA]/20 focus:border-[#62A0EA]`;
  const disabledInputClasses = `${inputClasses} bg-[#050F1A] border-white/5 text-white/30 cursor-not-allowed light:bg-gray-100 light:border-gray-200 light:text-gray-400`;
  const enabledInputClasses = `${inputClasses} bg-[#050F1A] border-white/10 text-white placeholder:text-white/30 light:bg-white light:border-gray-200 light:text-gray-900 light:placeholder:text-gray-400`;
  const errorInputClasses = `${inputClasses} bg-[#050F1A] border-red-500/50 text-white placeholder:text-white/30 light:bg-white light:text-gray-900 light:placeholder:text-gray-400 focus:ring-red-500/20 focus:border-red-500`;

  const fieldClass = (
    field: "currentPassword" | "newPassword" | "confirmNewPassword" | "code"
  ) =>
    passwordErrorField === field ? errorInputClasses : enabledInputClasses;

  return (
    <div className={isPage ? "flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#050F1A] light:bg-[#F8FAFC]" : undefined}>
      {isPage && (
          <div className="mx-auto flex w-full max-w-2xl shrink-0 items-start justify-between gap-4 px-4 pt-6 pb-5 sm:px-6 lg:hidden">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-tight text-white light:text-gray-900">My profile</h1>
              <p className="mt-1 text-sm text-white/50 light:text-gray-500">Your details and account settings.</p>
            </div>
            <ProfileThemeToggle />
          </div>
      )}
      <div className={isPage ? "min-h-0 flex-1 overflow-y-auto pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-8" : undefined}>
      <div className={isPage ? "max-w-2xl mx-auto px-4 pb-6 sm:px-6 lg:p-8 space-y-5 lg:space-y-6" : "space-y-4 p-6"}>
        {/* Header & Avatar */}
        <div className={isPage ? "max-lg:relative max-lg:isolate max-lg:overflow-hidden rounded-2xl border border-[#62A0EA]/20 bg-gradient-to-br from-[#102E50] to-[#071A2E] light:border-[#1A5FB4]/20 light:from-[#F0F7FF] light:to-white p-5 lg:rounded-none lg:border-0 lg:bg-none lg:p-0" : "relative isolate overflow-hidden rounded-2xl border border-[#62A0EA]/25 bg-gradient-to-br from-[#153C66] via-[#0C2743] to-[#071A2E] p-6 shadow-lg shadow-black/10 light:border-[#1A5FB4]/20 light:from-[#F0F7FF] light:via-[#F7FAFF] light:to-white light:shadow-black/5"}>
          {/* Page: rings only below lg, where the header is still a card. */}
          <div aria-hidden="true" className={`pointer-events-none absolute -right-10 -top-16 -z-10 h-56 w-56 rounded-full border border-[#99C1F1]/10 light:border-[#1A5FB4]/10 bg-[#62A0EA]/5 ${isPage ? "lg:hidden" : ""}`}><div className="absolute inset-6 rounded-full border border-[#99C1F1]/10 light:border-[#1A5FB4]/10" /><div className="absolute inset-12 rounded-full border border-[#99C1F1]/10 light:border-[#1A5FB4]/10" /></div>
          <div className={isPage ? "flex items-center gap-4 lg:gap-5" : "flex items-center gap-5"}>
          <ProfilePhoto profile={profile} onUploaded={applyPhotoChange} helpId={photoHelpId} className="group relative flex h-20 w-20 items-center justify-center rounded-2xl border border-[#99C1F1]/30 bg-[#1A5FB4] text-2xl font-bold text-white shadow-lg ring-4 ring-white/5 transition-colors hover:border-[#99C1F1] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#99C1F1] sm:h-24 sm:w-24 sm:text-3xl" />
          <div className="min-w-0 flex-1">
            <h2 className={isPage ? "break-words text-xl font-bold leading-snug text-white light:text-gray-900 lg:text-2xl" : "break-words text-2xl font-bold leading-snug tracking-tight text-white light:text-gray-900"}>
              {profile.firstName} {profile.surname}
            </h2>
            <p className="text-white/50 text-sm mt-1 break-words light:text-gray-500">@{profile.username}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex max-w-full items-center gap-1.5 text-xs font-medium leading-tight ${statusConfig.color}`}
              >
                <StatusIcon size={14} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
                <span className="break-words">{statusConfig.text}</span>
              </span>
              <span className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-[#2A4A70] bg-[#13283F] px-2 py-1 text-[11px] font-semibold leading-tight text-white light:border-gray-200 light:bg-white light:text-gray-800">
                <span className="break-words">{getCommuterTypeLabel(profile.commuterType)}</span>
                {discountPercentage > 0 && (
                  <span className="border-l border-white/30 pl-2 whitespace-nowrap tabular-nums light:border-gray-300">{discountPercentage}% off</span>
                )}
              </span>
            </div>
          </div>
          {isPage && <div className="hidden self-start lg:block"><AccountMenu signOut={{ request: () => setShowLogoutConfirm(true), locked: false }} trigger="gear" /></div>}
          </div>
          {['ACTIVE', 'APPROVED'].includes(profile.accountStatus) && <DiscountApplicationEntry commuterType={profile.commuterType} onClassificationChanged={retryLoad} />}
          {['ACTIVE', 'APPROVED'].includes(profile.accountStatus) && profile.commuterType === 'STUDENT' && <StudentRenewalEntry />}
        </div>

        <p id={photoHelpId} className="text-xs text-white/45 light:text-gray-500">Profile photo: JPG, PNG, or WebP. Maximum 3 MB and 4096 × 4096 pixels. Choosing a photo uploads it to your account.</p>

        {/* Transient success banner */}
        {successMessage && (
          <div role="status" className="bg-[#0B223A] border border-[#1E3A5C] light:bg-white light:border-gray-200 rounded-xl p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <svg
              className="w-5 h-5 text-[#62A0EA] light:text-[#1A5FB4] flex-shrink-0 mt-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-white text-sm font-medium light:text-gray-800">
              {successMessage}
            </p>
          </div>
        )}

        {/* Verification Alert */}
        {profile.accountStatus === "PENDING_VERIFICATION" && (
          <div className="bg-[#0B223A] border border-[#1E3A5C] light:bg-white light:border-gray-200 rounded-xl p-4 flex items-start gap-3">
            <svg
              className="w-5 h-5 text-white/70 light:text-gray-500 flex-shrink-0 mt-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
              />
            </svg>
            <div>
              <p className="text-white text-sm font-bold light:text-gray-900">
                Verification Pending
              </p>
              <p className="text-white/65 text-xs light:text-gray-600 mt-0.5">
                Your discount is on hold until an admin verifies your uploaded
                ID.
              </p>
            </div>
          </div>
        )}

        {profile.accountStatus === "DISCOUNT_REJECTED" && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-start gap-3">
            <svg
              className="w-5 h-5 text-red-400 light:text-red-600 flex-shrink-0 mt-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div className="flex-1">
              <p className="text-red-200 text-sm font-bold light:text-red-900">
                Discount Application Rejected
              </p>
              <p className="text-red-200/60 text-xs light:text-red-800 mt-0.5 mb-2">
                The ID you uploaded for the{" "}
                <span className="font-bold text-red-300 light:text-red-700">
                  {profile.appliedType && getCommuterTypeLabel(profile.appliedType)}
                </span>{" "}
                discount was not approved. Your account is active, but you are
                currently classified as a{" "}
                <span className="font-bold text-red-300 light:text-red-700">Regular</span>{" "}
                commuter. You can re-upload a valid ID to reapply.
              </p>
              <button
                onClick={handleReuploadId}
                className="text-xs font-bold text-white bg-red-500 hover:bg-red-600 px-4 py-1.5 rounded-lg transition-colors"
              >
                Re-upload ID
              </button>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        {isPage && <div className="hidden space-y-6 lg:block">
        <div className="flex gap-3">
          <button
            onClick={isEditing ? cancelEditing : startEditing}
            className={`flex-1 py-3 rounded-xl text-sm font-semibold transition-colors border ${
              isEditing
                ? "bg-white/5 border-white/10 text-white/60 hover:bg-white/10 light:bg-white light:border-gray-200 light:text-gray-600 light:hover:bg-gray-100"
                : "bg-[#1A5FB4] border-[#1A5FB4] text-white hover:bg-[#164A8F]"
            }`}
          >
            {isEditing ? "Cancel Editing" : "Edit Profile"}
          </button>
          <button
            onClick={() => setShowPasswordModal(true)}
            className="flex-1 py-3 rounded-xl text-sm font-semibold border border-white/10 text-white/60 hover:bg-white/5 light:border-gray-200 light:text-gray-600 light:hover:bg-gray-100 transition-colors"
          >
            Change Password
          </button>
        </div>

        {/* Profile Form */}
        <div className="bg-[#071A2E] border border-white/10 rounded-2xl p-6 space-y-5 shadow-lg light:bg-white light:border-gray-200 light:shadow-black/5">
          <h3 className="text-xs font-bold text-white/30 light:text-gray-400 uppercase tracking-wider">
            Personal Information
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
            <div>
              <label className="block text-xs font-medium text-white/50 light:text-gray-500 mb-1.5">
                First Name
              </label>
              <input
                type="text"
                value={profile.firstName}
                disabled
                className={disabledInputClasses}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-white/50 light:text-gray-500 mb-1.5">
                Surname
              </label>
              <input
                type="text"
                value={profile.surname}
                disabled
                className={disabledInputClasses}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-white/50 light:text-gray-500 mb-1.5">
                Birthdate
              </label>
              <input
                type="text"
                value={new Date(profile.birthdate).toLocaleDateString(
                  "en-US",
                  { year: "numeric", month: "long", day: "numeric" }
                )}
                disabled
                className={disabledInputClasses}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-white/50 light:text-gray-500 mb-1.5">
                Commuter Type
              </label>
              <input
                type="text"
                value={getCommuterTypeLabel(profile.commuterType)}
                disabled
                className={disabledInputClasses}
              />
            </div>

            <div>
              <p className="block text-xs font-medium text-white/50 light:text-gray-500 mb-1.5">Email Address</p>
              <button type="button" onClick={() => setShowEmailDialog(true)} aria-label="Change email address" className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-white/10 bg-[#050F1A] px-4 py-3 text-left text-sm text-white/90 light:text-gray-900 hover:border-[#62A0EA]/40 hover:bg-white/5 light:border-gray-200 light:bg-white light:hover:border-[#1A5FB4]/40 light:hover:bg-gray-50">
                <span className="min-w-0 flex-1 break-all">{profile.email ? maskEmail(profile.email) : "Not provided"}</span><Pencil size={16} aria-hidden="true" className="shrink-0 text-[#99C1F1] light:text-[#1A5FB4]" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-white/50 light:text-gray-500 mb-1.5">
                Contact Number
              </label>
              <input
                type="tel"
                value={
                  isEditing
                    ? (editData.contactNumber ?? profile.contactNumber)
                    : profile.contactNumber
                }
                onChange={(e) =>
                  handleEditChange("contactNumber", e.target.value)
                }
                disabled={!isEditing}
                maxLength={11}
                placeholder="09171234567"
                className={isEditing ? enabledInputClasses : disabledInputClasses}
              />
            </div>
          </div>

          {saveError && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 light:border-red-200 light:bg-red-50 light:text-red-700 text-xs font-medium p-3 rounded-lg">
              {saveError}
            </div>
          )}

          {isEditing && (
            <button
              onClick={saveProfile}
              disabled={isSaving}
              className="w-full mt-4 py-3 rounded-xl text-sm font-bold bg-[#1A5FB4] text-white hover:bg-[#164A8F] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isSaving ? (
                <svg
                  className="animate-spin h-5 w-5 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              ) : (
                "Save Changes"
              )}
            </button>
          )}
        </div>
        </div>}
        <div className={isPage ? "space-y-5 lg:hidden" : "grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"}>
          <section aria-labelledby={detailsHeadingId} className={isPage ? "rounded-2xl border border-white/10 bg-[#071A2E] p-5 light:border-gray-200 light:bg-white" : "min-w-0 rounded-2xl border border-white/10 bg-[#0B223A] p-5 light:border-gray-200 light:bg-white xl:row-span-2 xl:self-stretch"}>
            <h3 id={detailsHeadingId} className={`flex items-center gap-2 text-sm font-semibold text-white light:text-gray-900 ${isPage ? "" : "gap-3"}`}><UserRound size={22} aria-hidden="true" className="shrink-0 text-[#99C1F1] light:text-[#1A5FB4]" />Personal details</h3>
            {!isPage && <p className="mt-3 text-xs text-white/40 light:text-gray-500">Your registered information</p>}
            <dl className={isPage ? "mt-4 grid grid-cols-2 gap-x-4 gap-y-5" : "mt-5 grid grid-cols-2 gap-x-4 gap-y-5"}>
              <div><dt className="text-xs text-white/50 light:text-gray-500">First name</dt><dd className="mt-1 break-words text-sm text-white/90 light:text-gray-900">{profile.firstName}</dd></div>
              <div><dt className="text-xs text-white/50 light:text-gray-500">Surname</dt><dd className="mt-1 break-words text-sm text-white/90 light:text-gray-900">{profile.surname}</dd></div>
              <div><dt className="text-xs text-white/50 light:text-gray-500">Birthdate</dt><dd className="mt-1 text-sm text-white/90 light:text-gray-900">{profile.birthdate && Number.isFinite(new Date(profile.birthdate).getTime()) ? new Date(profile.birthdate).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" }) : "Not provided"}</dd></div>
              <div><dt className="text-xs text-white/50 light:text-gray-500">Commuter type</dt><dd className="mt-1 text-sm text-white/90 light:text-gray-900">{getCommuterTypeLabel(profile.commuterType)}</dd></div>
              <div className={isPage ? "col-span-full" : "col-span-full border-t border-white/10 pt-4 light:border-gray-200"}>
                <dt className="text-xs text-white/50 light:text-gray-500">Email address</dt>
                <dd className={isPage ? "mt-1" : "mt-2"}>
                  <p className={isPage ? "break-all text-sm text-white/90 light:text-gray-900" : "min-h-11 break-all rounded-xl border border-white/10 bg-[#071A2E] px-3 py-3 light:border-gray-200 light:bg-gray-50 text-sm text-white/90 light:text-gray-900"}>{profile.email ? maskEmail(profile.email) : "Not provided"}</p>
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby={contactHeadingId} className={isPage ? "rounded-2xl border border-white/10 bg-[#071A2E] p-5 light:border-gray-200 light:bg-white" : "min-w-0 rounded-2xl border border-white/10 bg-[#0B223A] p-5 light:border-gray-200 light:bg-white"}>
            <div className="flex items-center justify-between gap-3">
              <h3 id={contactHeadingId} className={`flex items-center gap-2 text-sm font-semibold text-white light:text-gray-900 ${isPage ? "" : "gap-3"}`}><Phone size={22} aria-hidden="true" className="shrink-0 text-[#99C1F1] light:text-[#1A5FB4]" />Contact number</h3>
              {!isEditing && <button type="button" onClick={startEditing} aria-label="Edit contact number" className={`inline-flex shrink-0 items-center gap-2 rounded-lg border border-[#337DD2] bg-[#1A5FB4] px-3 text-xs font-semibold text-white transition-colors hover:border-[#164A8F] hover:bg-[#164A8F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] ${isPage ? "min-h-11" : "min-h-9"}`}><Pencil size={14} aria-hidden="true" /> Edit</button>}
              {isEditing && !isPage && (
                <div className="flex shrink-0 items-center gap-2">
                  <button type="button" onClick={cancelEditing} disabled={isSaving} aria-label="Cancel contact edit" title="Cancel" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/70 transition-colors hover:bg-white/5 light:border-gray-200 light:text-gray-600 light:hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] disabled:opacity-50"><X size={17} aria-hidden="true" /></button>
                  <button type="submit" form={contactFormId} disabled={isSaving || editData.contactNumber === profile.contactNumber} aria-label={isSaving ? "Saving contact number" : "Save contact number"} title={isSaving ? "Saving..." : "Save"} className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-[#1A5FB4] text-white transition-colors hover:bg-[#164A8F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] disabled:opacity-50">{isSaving ? <Loader2 size={17} aria-hidden="true" className="animate-spin" /> : <Check size={17} aria-hidden="true" />}</button>
                </div>
              )}
            </div>
            {isEditing ? (
              <form id={contactFormId} onSubmit={event => { event.preventDefault(); if (!isSaving) void saveProfile(); }} className="mt-3">
                <label htmlFor={contactInputId} className="sr-only">Contact number</label>
                <input id={contactInputId} type="tel" inputMode="numeric" autoComplete="tel-national" autoFocus disabled={isSaving} value={editData.contactNumber ?? profile.contactNumber} onChange={event => handleEditChange("contactNumber", event.target.value)} maxLength={11} placeholder="09171234567" aria-invalid={!!saveError} aria-describedby={saveError ? contactErrorId : undefined} className={`${saveError ? errorInputClasses : enabledInputClasses} disabled:opacity-50`} />
                {saveError && <p id={contactErrorId} role="alert" className="mt-2 text-xs text-red-400 light:text-red-600">{saveError}</p>}
                {isPage && <div className="mt-3 flex justify-center gap-2">
                  <button type="button" onClick={cancelEditing} disabled={isSaving} className={`${isPage ? "min-h-11 flex-1" : "min-h-10"} rounded-lg border border-white/10 px-4 text-sm font-medium text-white/70 hover:bg-white/5 light:border-gray-200 light:text-gray-600 light:hover:bg-gray-100 disabled:opacity-50`}>Cancel</button>
                  <button type="submit" disabled={isSaving || editData.contactNumber === profile.contactNumber} className={`${isPage ? "min-h-11 flex-1 justify-center" : "min-h-10"} inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#1A5FB4] px-4 text-sm font-semibold text-white hover:bg-[#164A8F] disabled:opacity-50`}>
                    {isSaving ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <Save size={16} className="shrink-0" />}{isSaving ? "Saving..." : isPage ? "Save" : "Save changes"}
                  </button>
                </div>}
              </form>
            ) : <p className={isPage ? "mt-2 text-sm text-white/90 light:text-gray-900" : "mt-4 rounded-xl border border-white/5 bg-[#071A2E] px-3 py-3 light:border-gray-200 light:bg-gray-50 text-sm font-medium tracking-wide text-white/90 light:text-gray-900"}>{profile.contactNumber || "Not provided"}</p>}
          </section>

          <section aria-labelledby={securityHeadingId} className={isPage ? "rounded-2xl border border-white/10 bg-[#071A2E] p-5 light:border-gray-200 light:bg-white" : "min-w-0 rounded-2xl border border-white/10 bg-[#0B223A] p-5 light:border-gray-200 light:bg-white"}>
            <h3 id={securityHeadingId} className={`flex items-center gap-2 text-sm font-semibold text-white light:text-gray-900 ${isPage ? "mb-2" : "mb-4 gap-3"}`}><ShieldCheck size={22} aria-hidden="true" className="shrink-0 text-[#99C1F1] light:text-[#1A5FB4]" />Account security</h3>
            <button type="button" onClick={() => setShowEmailDialog(true)} className={`flex min-h-12 w-full items-center gap-3 rounded-lg py-3 text-left text-sm text-white/80 transition-colors hover:bg-white/5 light:text-gray-700 light:hover:bg-gray-100 ${isPage ? "" : "rounded-xl border border-white/10 bg-[#071A2E] px-3 hover:border-[#62A0EA]/40 light:border-gray-200 light:bg-white light:hover:border-[#1A5FB4]/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"}`}>
              <Mail size={18} aria-hidden="true" className={isPage ? "shrink-0 text-white/50 light:text-gray-400" : "shrink-0 text-[#99C1F1] light:text-[#1A5FB4]"} /><span className="min-w-0 flex-1"><span className="block">Change email</span>{!isPage && <span className="mt-1 block text-[11px] font-normal text-white/40 light:text-gray-500">Verify a new address</span>}</span><ChevronRight size={16} aria-hidden="true" className="shrink-0 text-white/40 light:text-gray-400" />
            </button>
            <button type="button" onClick={() => setShowPasswordModal(true)} className={`flex min-h-12 w-full items-center gap-3 rounded-lg py-3 text-left text-sm text-white/80 transition-colors hover:bg-white/5 light:text-gray-700 light:hover:bg-gray-100 ${isPage ? "" : "mt-2 rounded-xl border border-white/10 bg-[#071A2E] px-3 hover:border-[#62A0EA]/40 light:border-gray-200 light:bg-white light:hover:border-[#1A5FB4]/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"}`}>
              <KeyRound size={18} aria-hidden="true" className={isPage ? "shrink-0 text-white/50 light:text-gray-400" : "shrink-0 text-[#99C1F1] light:text-[#1A5FB4]"} /><span className="min-w-0 flex-1"><span className="block">Change password</span>{!isPage && <span className="mt-1 block text-[11px] font-normal text-white/40 light:text-gray-500">Update your sign-in password</span>}</span><ChevronRight size={16} aria-hidden="true" className="shrink-0 text-white/40 light:text-gray-400" />
            </button>
          </section>
          <div className={isPage ? "pt-1" : "col-span-full flex justify-center border-t border-white/10 pt-4 light:border-gray-200 lg:hidden"}>
            <button type="button" onClick={() => setShowLogoutConfirm(true)} className={`${isPage ? "flex min-h-12 w-full justify-center rounded-xl border border-red-500/20 bg-red-500/5 px-2" : "inline-flex min-h-11 w-full max-w-xs justify-center rounded-xl border border-red-500/20 bg-red-500/5 px-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"} items-center gap-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 light:text-red-600`}><LogOut size={17} aria-hidden="true" /> Log out</button>
          </div>
        </div>
      </div>

      </div>

      {showEmailDialog && <ChangeEmailDialog currentEmail={profile.email} onClose={closeEmailDialog} onChanged={applyEmailChange} />}

      {/* --- LOG OUT CONFIRMATION --- */}
      {showLogoutConfirm && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
          onClick={() => setShowLogoutConfirm(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-confirm-title"
        >
          <div
            ref={subdialogRef}
            data-profile-subdialog="logout"
            className="bg-[#071A2E] w-full max-w-sm rounded-2xl border border-white/10 light:bg-white light:border-gray-200 shadow-2xl p-6 text-center animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto w-14 h-14 rounded-full bg-red-500/10 flex items-center justify-center">
              <svg className="w-7 h-7 text-red-400 light:text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75" />
              </svg>
            </div>

            <h2 id="logout-confirm-title" className="text-white font-bold text-lg mt-4 light:text-gray-900">
              Log out?
            </h2>
            <p className="text-white/50 text-sm mt-2 light:text-gray-500">
              You&apos;ll need to sign in again to book rides, scan receipts and
              view your rewards.
            </p>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 light:bg-white light:border-gray-200 light:text-gray-700 light:hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleLogout}
                className="flex-1 py-3 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                Log Out
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* --- CHANGE PASSWORD MODAL --- */}
      {showPasswordModal && createPortal(
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
          onClick={() => { if (!isChangingPassword) closePasswordModal(); }}
        >
          <div
            ref={subdialogRef}
            data-profile-subdialog="password"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-password-title"
            aria-describedby="profile-password-description"
            className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#62A0EA]/20 bg-[#071A2E] shadow-2xl shadow-black/40 light:border-gray-200 light:bg-white light:shadow-black/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 border-b border-white/10 p-5 light:border-gray-200 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#99C1F1]/25 bg-[#62A0EA]/15 text-[#B6D3F6] light:border-[#1A5FB4]/20 light:bg-[#1A5FB4]/10 light:text-[#1A5FB4]"><KeyRound size={21} aria-hidden="true" /></span>
                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#99C1F1] light:text-[#1A5FB4]">Account security</p>
                    <h2 id="profile-password-title" className="text-xl font-bold leading-tight tracking-tight text-white light:text-gray-900">Change password</h2>
                  </div>
                </div>
                <button type="button" onClick={closePasswordModal} disabled={isChangingPassword} aria-label="Close change password" title="Close" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/10 hover:text-white light:border-gray-200 light:bg-white light:text-gray-600 light:hover:bg-gray-100 light:hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] disabled:opacity-50"><X size={18} aria-hidden="true" /></button>
              </div>
              <p id="profile-password-description" className="mt-4 text-sm leading-relaxed text-white/55 light:text-gray-500">
                {passwordStep === "form" ? "Choose a new password, then confirm the change with a code sent to your email." : "Verify your email to finish updating your password."}
              </p>
            </div>

            <ol aria-label="Password change progress" className="grid shrink-0 grid-cols-2 gap-3 border-b border-white/10 px-5 py-4 light:border-gray-200 sm:px-6">
              {["New password", "Verify email"].map((label, index) => {
                const active = passwordStep === "form" ? index === 0 : index === 1;
                const complete = passwordStep === "verify" && index === 0;
                return (
                  <li key={label} aria-current={active ? "step" : undefined} className={`flex items-center justify-center gap-2 text-xs font-medium transition-colors ${active ? "text-[#B6D3F6] light:text-[#1A5FB4]" : complete ? "text-emerald-300 light:text-emerald-700" : "text-white/35 light:text-gray-400"}`}>
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${active ? "border-[#62A0EA]/50 bg-[#1A5FB4] light:text-white" : complete ? "border-emerald-500/30 bg-emerald-500/10" : "border-white/15 bg-white/5 light:border-gray-300 light:bg-gray-50"}`}>{complete ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
                    {label}
                  </li>
                );
              })}
            </ol>

            <form onSubmit={event => { event.preventDefault(); if (!isChangingPassword) { if (passwordStep === "form") void handleRequestPasswordChangeCode(); else void handleConfirmPasswordChange(); } }} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 overflow-y-auto p-5 modal-scroll sm:p-6">
                {passwordError && !passwordErrorField && <p role="alert" className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm leading-relaxed text-red-300 light:border-red-200 light:bg-red-50 light:text-red-700">{passwordError}</p>}

                {passwordStep === "form" ? (
                  <div className="space-y-4">
                    {([
                      { field: "currentPassword", id: "profile-current-password", errorId: "profile-current-password-error", label: "Current password", autoComplete: "current-password" },
                      { field: "newPassword", id: "profile-new-password", errorId: "profile-new-password-error", label: "New password", autoComplete: "new-password" },
                      { field: "confirmNewPassword", id: "profile-confirm-password", errorId: "profile-confirm-password-error", label: "Confirm new password", autoComplete: "new-password" },
                    ] as const).map(({ field, id, errorId, label, autoComplete }) => (
                      <div key={field} className={field === "currentPassword" ? "border-b border-white/10 pb-5 light:border-gray-200" : undefined}>
                        <label htmlFor={id} className="mb-2 block text-sm font-medium text-white/80 light:text-gray-700">{label}</label>
                        <input
                          id={id}
                          type="password"
                          value={passwordData[field]}
                          disabled={isChangingPassword}
                          onChange={event => setPasswordData(previous => ({ ...previous, [field]: event.target.value }))}
                          aria-invalid={passwordErrorField === field}
                          aria-describedby={[field === "newPassword" ? "profile-password-rules" : "", passwordErrorField === field ? errorId : ""].filter(Boolean).join(" ") || undefined}
                          placeholder={field === "currentPassword" ? "Enter your current password" : field === "newPassword" ? "Create a new password" : "Re-enter your new password"}
                          className={`${fieldClass(field)} text-base sm:text-sm disabled:opacity-50`}
                          autoComplete={autoComplete}
                        />
                        {passwordErrorField === field && <p id={errorId} role="alert" className="mt-2 text-xs leading-relaxed text-red-300 light:text-red-600">{passwordError}</p>}
                      </div>
                    ))}
                    <div id="profile-password-rules" className="rounded-xl border border-[#62A0EA]/15 bg-[#62A0EA]/5 p-4 light:border-[#1A5FB4]/15 light:bg-[#F0F7FF]">
                      <p className="mb-3 flex items-center gap-2 text-xs font-medium text-[#B6D3F6] light:text-[#1A5FB4]"><ShieldCheck size={15} aria-hidden="true" />Your new password needs</p>
                      <ul className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px] text-white/55 light:text-gray-500">
                        {[
                          { label: "8+ characters", met: passwordData.newPassword.length >= 8 },
                          { label: "An uppercase letter", met: /[A-Z]/.test(passwordData.newPassword) },
                          { label: "A number", met: /[0-9]/.test(passwordData.newPassword) },
                          { label: "A symbol", met: /[^A-Za-z0-9\s]/.test(passwordData.newPassword) },
                        ].map(({ label, met }) => <li key={label} className={`flex items-center gap-1.5 transition-colors ${met ? "text-emerald-300 light:text-emerald-700" : ""}`}><span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${met ? "border-emerald-500/40 bg-emerald-500/15" : "border-white/20 light:border-gray-300"}`}>{met && <Check size={10} aria-hidden="true" />}</span>{label}<span className="sr-only">{met ? ": met" : ": not met"}</span></li>)}
                      </ul>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-5">
                    <div className="rounded-xl border border-[#62A0EA]/20 bg-[#0B223A] p-4 light:border-[#1A5FB4]/15 light:bg-[#F0F7FF]">
                      <div className="flex items-start gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#62A0EA]/10 text-[#99C1F1] light:text-[#1A5FB4]"><Mail size={20} aria-hidden="true" /></span>
                        <div>
                          <h3 className="text-sm font-semibold text-white light:text-gray-900">Check your inbox</h3>
                          <p className="mt-1 text-xs leading-relaxed text-white/55 light:text-gray-500">We sent a six-digit code to your registered email. Enter it below to confirm your new password.</p>
                        </div>
                      </div>
                    </div>
                    <div>
                      <label htmlFor="profile-verification-code" className="mb-2 block text-sm font-medium text-white/80 light:text-gray-700">Verification code</label>
                      <input
                        id="profile-verification-code"
                        aria-invalid={passwordErrorField === "code"}
                        aria-describedby={passwordErrorField === "code" ? "profile-verification-code-error" : undefined}
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={verificationCode}
                        disabled={isChangingPassword}
                        onChange={event => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="000000"
                        className={`${fieldClass("code")} py-4 text-center text-xl tracking-[0.35em] font-mono disabled:opacity-50`}
                        autoComplete="one-time-code"
                      />
                      {passwordErrorField === "code" && <p id="profile-verification-code-error" role="alert" className="mt-2 text-xs leading-relaxed text-red-300 light:text-red-600">{passwordError}</p>}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button type="button" onClick={handleBackToPasswordForm} disabled={isChangingPassword} className="min-h-10 rounded-lg px-2 text-xs font-medium text-white/55 transition-colors hover:bg-white/5 hover:text-white light:text-gray-500 light:hover:bg-gray-100 light:hover:text-gray-900 disabled:opacity-50">← Edit passwords</button>
                      <button type="button" onClick={handleResendCode} disabled={resendSecondsLeft > 0 || isChangingPassword} className="min-h-10 rounded-lg px-2 text-xs font-medium text-[#99C1F1] transition-colors hover:bg-white/5 disabled:text-white/30 light:text-[#1A5FB4] light:hover:bg-gray-100 light:disabled:text-gray-300 disabled:cursor-not-allowed">{resendSecondsLeft > 0 ? `Resend in ${resendSecondsLeft}s` : "Resend code"}</button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 gap-3 border-t border-white/10 bg-[#0B223A] p-5 light:border-gray-200 light:bg-gray-50 sm:px-6">
                <button type="button" onClick={closePasswordModal} disabled={isChangingPassword} className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/15 px-3 text-sm font-semibold text-white/70 transition-colors hover:bg-white/5 light:border-gray-200 light:bg-white light:text-gray-700 light:hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={isChangingPassword || (passwordStep === "form" ? !passwordData.currentPassword || !passwordData.newPassword || !passwordData.confirmNewPassword : verificationCode.length !== 6)} className="inline-flex min-h-11 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-[#1A5FB4] px-3 text-sm font-semibold text-white shadow-lg shadow-[#1A5FB4]/20 transition-colors hover:bg-[#164A8F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] disabled:opacity-50">
                  {isChangingPassword && <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin" />}
                  {isChangingPassword ? passwordStep === "form" ? "Sending..." : "Updating..." : passwordStep === "form" ? "Send code" : "Update password"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
