// components/admin/users/review-request-modal.tsx
'use client';

import { useId, useState } from 'react';
import { Modal } from '@/components/admin/ui/modal';
import { UserAvatar } from '@/components/admin/ui/user-avatar';
import sheet from './commuter-details.module.css';
import { AlertTriangle, LoaderCircle, ZoomIn, X, IdCard, User, FileText, ExternalLink, Check } from 'lucide-react';
import type { PendingRequest } from '@/app/(admin)/users/data/users-data';
import { DISCOUNT_CATEGORIES, discountStatusLabel, educationSummary, schoolYearSummary, type DiscountApplication } from '@/lib/shared/services/student-renewal.service';

import { InlineError } from '@/components/admin/ui/inline-error';
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Same clock as formatDate (the viewer's), so the date and time always agree.
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const REJECTION_REASONS = [
  'Blurry image',
  'ID does not match the filled details',
  'The ID does not match the role applied for',
  'The ID is expired',
  'The ID does not show the entire front',
] as const;

const RENEWAL_REASONS = [
  'Blurry document',
  'Document does not match the commuter',
  'Current school year or enrollment is not shown',
  'Enrollment proof is expired',
] as const;

const OTHER_REASON = 'Other';

// Same limit as the backend review rule for a renewal reason.
const RENEWAL_REASON_MAX = 500;

// The three outcomes of a renewal review, each with what it does to the
// commuter so the admin reads the consequence before choosing, not after.
const RENEWAL_DECISIONS = [
  { value: 'APPROVED', label: 'Approve', outcome: 'The student discount is renewed until next year’s renewal deadline.', confirm: 'Approve Renewal' },
  { value: 'NEEDS_CORRECTION', label: 'Request corrections', outcome: 'The commuter is sent your reason and has seven days to submit new proof.', confirm: 'Request Corrections' },
  { value: 'REJECTED', label: 'Reject', outcome: 'The commuter is sent your reason and becomes a Regular commuter.', confirm: 'Reject Renewal' },
] as const;

type RenewalDecision = typeof RENEWAL_DECISIONS[number]['value'];

// Rail status dot; unknown statuses fall back to neutral, never to success.
interface ReviewRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  request: PendingRequest | null;
  onApprove: () => void;
  onReject: (reason: string, finalRejection?: boolean) => void;
  isProcessing?: boolean;
  /** The application under review when this is a student renewal, not a
   * registration. Anything but a PENDING one is shown read-only. */
  renewal?: DiscountApplication | null;
  errorMessage?: string;
  /** The modal opened from the table row while the signed document link is
   * still being fetched: show a placeholder and hold the decision buttons. */
  documentLoading?: boolean;
}

export function ReviewRequestModal({ isOpen, onClose, request, onApprove, onReject, isProcessing = false, renewal = null, errorMessage, documentLoading = false }: ReviewRequestModalProps) {
  const [selectedReason, setSelectedReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [isImageExpanded, setIsImageExpanded] = useState(false);
  const [decision, setDecision] = useState<RenewalDecision | ''>('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmTitleId = useId();
  const confirmBodyId = useId();
  const rejectReasonId = useId();

  // Reset internal state whenever the modal is closed or a different
  // request is opened — prevents a stale rejection reason from a previous
  // review bleeding into the next one.
  if (!request) return null;

  const isDiscountRequest = renewal !== null;
  const isApplication = renewal?.request_type === 'APPLICATION';
  const isStudentProof = renewal?.requested_type === 'STUDENT';
  const requestName = isApplication ? 'application' : 'renewal';
  const decisions = RENEWAL_DECISIONS.map(option => !isApplication ? option : {
    ...option,
    outcome: option.value === 'APPROVED' ? `The account becomes ${DISCOUNT_CATEGORIES[renewal.requested_type]}. The verified discount becomes available.` : option.value === 'REJECTED' ? 'The commuter is sent your reason. Their account remains Regular.' : 'The commuter is sent your reason and can submit new proof at any time. Their account remains Regular until approved.',
    confirm: option.value === 'APPROVED' ? 'Approve Application' : option.value === 'REJECTED' ? 'Reject Application' : option.confirm,
  });
  const readOnly = isDiscountRequest && renewal.status !== 'PENDING';
  const documentIsPdf = renewal?.document_mime === 'application/pdf';

  if (isProcessing) {
    return (
      <Modal adminThemed isOpen={isOpen} onClose={() => {}} maxWidth="max-w-md">
        <div role="status" aria-live="polite" className="flex flex-col items-center px-2 py-6 text-center">
          <LoaderCircle size={36} className="mb-4 animate-spin text-[#62A0EA] admin-light:text-[#1A5FB4]" aria-hidden="true" />
          <h2 className="text-xl font-bold text-white admin-light:text-slate-900">
            {isDiscountRequest
              ? decision === 'APPROVED' ? `Approving ${requestName}...` : decision === 'NEEDS_CORRECTION' ? 'Requesting corrections...' : `Rejecting ${requestName}...`
              : showRejectConfirm ? 'Rejecting registration...' : 'Approving registration...'}
          </h2>
          <p className="mt-2 text-sm text-slate-400 admin-light:text-slate-500">Processing {request.name}&apos;s submission. Please wait.</p>
        </div>
      </Modal>
    );
  }

  const isOtherReason = selectedReason === OTHER_REASON;
  const effectiveReason = isOtherReason ? customReason.trim() : selectedReason;
  const resetRejectState = () => {
    setShowRejectConfirm(false);
    setSelectedReason('');
    setCustomReason('');
  };

  const handleRejectClick = () => {
    if (effectiveReason) {
      onReject(effectiveReason);
    }
  };

  // Approval needs no reason; the other two outcomes send one to the commuter.
  const decisionNeedsReason = decision === 'NEEDS_CORRECTION' || decision === 'REJECTED';
  const handleDecisionConfirm = () => {
    if (decision === 'APPROVED') onApprove();
    else if (decisionNeedsReason && effectiveReason) onReject(effectiveReason, decision === 'REJECTED');
  };

  const showingConfirm = showRejectConfirm || showApproveConfirm;
  const initials = `${request.firstName?.[0] ?? ''}${request.surname?.[0] ?? ''}`.toUpperCase() || '—';
  const sectionClasses = 'rounded-xl border border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-[#F8FAFC] p-4';
  const fieldLabelClasses = 'text-[10px] font-semibold uppercase tracking-wider text-slate-500';
  const fieldValueClasses = 'mt-1 truncate text-sm font-medium text-white admin-light:text-slate-900';
  // `min-w-0` on each cell is required for `truncate` to work inside
  // a grid track (grid items default to min-width:auto, which lets
  // long, unbroken strings like emails/usernames blow the column out
  // instead of ellipsizing). Long values still show in full via the
  // `title` tooltip on hover. Username + Email get their own
  // full-width row since they're the fields most likely to run long.
  const detailsSection = (
    <section className={sectionClasses}>
      <div className="mb-3 flex items-center gap-2">
        <User className="h-4 w-4 text-[#62A0EA] admin-light:text-[#1A5FB4]" />
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 admin-light:text-slate-500">{isDiscountRequest ? 'Commuter Details' : 'Applicant Details'}</h3>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className={fieldLabelClasses}>First Name</p>
          <p className={fieldValueClasses} title={request.firstName}>{request.firstName}</p>
        </div>
        <div className="min-w-0">
          <p className={fieldLabelClasses}>Middle Name</p>
          <p className={fieldValueClasses} title={request.middleName || undefined}>{request.middleName || '—'}</p>
        </div>
        <div className="min-w-0">
          <p className={fieldLabelClasses}>Surname</p>
          <p className={fieldValueClasses} title={request.surname}>{request.surname}</p>
        </div>
        <div className="min-w-0">
          <p className={fieldLabelClasses}>Birthdate</p>
          <p className={fieldValueClasses}>{formatDate(request.birthdate)}</p>
        </div>
        <div className="min-w-0">
          <p className={fieldLabelClasses}>Gender</p>
          <p className={fieldValueClasses}>{request.gender}</p>
        </div>
        <div className="min-w-0">
          <p className={fieldLabelClasses}>Phone Number</p>
          <p className={fieldValueClasses} title={request.phoneNumber}>{request.phoneNumber}</p>
        </div>
        {/* A renewal shows its submission date with the enrollment details
            and the email in the identity strip, so neither repeats here. */}
        {!isDiscountRequest && (
          <div className="col-span-2 min-w-0">
            <p className={fieldLabelClasses}>Date Applied</p>
            <p className={fieldValueClasses}>{formatDate(request.createdAt)}</p>
          </div>
        )}
        <div className="col-span-2 min-w-0">
          <p className={fieldLabelClasses}>Username</p>
          <p className={fieldValueClasses} title={request.username}>{request.username}</p>
        </div>
        {!isDiscountRequest && (
          <div className="col-span-2 min-w-0">
            <p className={fieldLabelClasses}>Email</p>
            <p className={fieldValueClasses} title={request.email}>{request.email}</p>
          </div>
        )}
      </div>
      {/* A Student sign-up's school details, checked against the ID beside
          them; approving the registration approves these too. */}
      {!isDiscountRequest && request.studentDetails && (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[#2A3A55] pt-4 admin-light:border-[#E2E8F0]">
          <div className="col-span-2 min-w-0">
            <p className={fieldLabelClasses}>School</p>
            <p className={fieldValueClasses} title={request.studentDetails.school_name}>{request.studentDetails.school_name}</p>
          </div>
          <div className="min-w-0">
            <p className={fieldLabelClasses}>Level</p>
            <p className={fieldValueClasses}>{educationSummary(request.studentDetails)}</p>
          </div>
          <div className="min-w-0">
            <p className={fieldLabelClasses}>Year / Term</p>
            <p className={fieldValueClasses}>{schoolYearSummary(request.studentDetails)}</p>
          </div>
        </div>
      )}
    </section>
  );

  // Full-size image lightbox — sits above the review modal (z-60 vs the
  // modal's z-50) so it isn't clipped by the panel's own scroll area.
  const lightbox = isImageExpanded && (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80"
      onClick={() => setIsImageExpanded(false)}
    >
      <button
        type="button"
        onClick={() => setIsImageExpanded(false)}
        className="absolute top-4 right-4 rounded-md border border-[#2A3A55] bg-[#131C2E] p-2 text-slate-200 transition-colors hover:bg-[#1A2540] hover:text-white"
        aria-label="Close full-size image"
      >
        <X size={22} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={request.idImageUrl}
        alt={isDiscountRequest ? 'Uploaded supporting document (full size)' : 'Uploaded ID (full size)'}
        className="max-w-full max-h-full object-contain rounded-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  // Discount applications and student renewals: the identity-rail layout
  // shared with Commuter Details and Rejected Account Details. The person and
  // the request's timeline sit in the rail with the decision at its foot; the
  // proof and the account details it is checked against fill the record.
  if (isDiscountRequest) {
    const category = DISCOUNT_CATEGORIES[renewal.requested_type];
    const selectedDecision = decisions.find((option) => option.value === decision);
    const reasons = isStudentProof ? RENEWAL_REASONS : REJECTION_REASONS;
    const chooseDecision = (value: RenewalDecision) => { setDecision(value); setSelectedReason(''); setCustomReason(''); };
    // Cancelling an approval returns the rail to its three buttons; a
    // correction or rejection keeps its chosen reason for another try.
    const closeConfirm = () => { setConfirmOpen(false); if (decision === 'APPROVED') setDecision(''); };
    const confirmClass = decision === 'APPROVED' ? sheet.actionApprove : decision === 'REJECTED' ? sheet.actionSuspend : sheet.actionEdit;
    const personal = [
      { label: 'First name', value: request.firstName },
      { label: 'Middle name', value: request.middleName },
      { label: 'Last name', value: request.surname },
      { label: 'Birthdate', value: request.birthdate ? formatDate(request.birthdate) : null },
      { label: 'Gender', value: request.gender },
    ];

    return (
      <Modal adminThemed isOpen={isOpen} onClose={() => { if (!isProcessing) onClose(); }} maxWidth="max-w-md sm:max-w-3xl">
        <div className={sheet.sheet}>
          <aside className={sheet.rail} aria-label="Commuter">
            <div className={sheet.railIdentity}>
              <UserAvatar src={request.profileImageUrl} alt={`Profile photo of ${request.name}`} className="h-14 w-14 sm:h-22 sm:w-22" iconClassName="h-6 w-6 sm:h-9 sm:w-9" sizes="(min-width: 640px) 88px, 56px" />
              <div className={sheet.railIdentityText}>
                <h2 className={sheet.kicker}>{readOnly ? (isApplication ? 'Application details' : 'Renewal details') : (isApplication ? 'Review discount application' : 'Review renewal')}</h2>
                <p className={sheet.personName}>{request.name}</p>
                <p className={sheet.personMeta}>
                  <span>
                    {discountStatusLabel(renewal)}
                  </span>
                  <span>{isApplication ? `Wants ${category}` : 'Student renewal'}</span>
                </p>
              </div>
            </div>

            <dl className={sheet.timeline}>
              <div><dt>Submitted</dt><dd>{formatDate(renewal.submitted_at)}, {formatTime(renewal.submitted_at)}</dd></div>
              {renewal.revision > 1 && <div><dt>Attempt</dt><dd>Resubmission {renewal.revision - 1}</dd></div>}
              {renewal.cycle_year !== null && <div><dt>Renewal cycle</dt><dd>{renewal.cycle_year}</dd></div>}
              {renewal.correction_due_at && (
                <div>
                  <dt>Correction deadline</dt>
                  <dd>{new Date(renewal.correction_due_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' })} (PH time)</dd>
                </div>
              )}
            </dl>
          </aside>

          <div className={sheet.record}>
            {/* What the previous reviewer told the commuter, read before re-checking. */}
            {renewal.reason && (
              <section className={sheet.recordSection}>
                <h3 className={sheet.sectionTitle}>Note from the last review</h3>
                <p className={sheet.reviewNote}>{renewal.reason}</p>
              </section>
            )}

            <section className={sheet.recordSection}>
              <h3 className={sheet.sectionTitle}>{isStudentProof ? 'Enrollment proof' : 'Supporting document'}</h3>
              <div className={sheet.proofRow}>
                {documentLoading ? (
                  <p role="status" className={sheet.idEmpty}>Loading document…</p>
                ) : !request.idImageUrl ? (
                  <p className={sheet.idEmpty}>No supporting document was attached.</p>
                ) : documentIsPdf ? (
                  // A PDF cannot be previewed inline, so it opens in a new tab.
                  <a href={request.idImageUrl} target="_blank" rel="noreferrer" className={`${sheet.idThumb} ${sheet.pdfThumb}`}>
                    <FileText size={26} aria-hidden="true" />
                    <span>Open PDF</span>
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                ) : (
                  <button type="button" onClick={() => setIsImageExpanded(true)} className={`${sheet.idThumb} cursor-zoom-in`} aria-label="View the supporting document full size">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={request.idImageUrl} alt="" />
                  </button>
                )}
                <dl className={`${sheet.fieldRows} ${sheet.proofFacts}`}>
                  <div className={sheet.field}><dt>Category</dt><dd>{category}</dd></div>
                  {isStudentProof && <>
                    <div className={sheet.field}><dt>School</dt><dd>{renewal.school_name || 'Not provided'}</dd></div>
                    <div className={sheet.field}><dt>Level</dt><dd>{educationSummary(renewal)}</dd></div>
                    <div className={sheet.field}><dt>Year / term</dt><dd>{schoolYearSummary(renewal)}</dd></div>
                  </>}
                </dl>
              </div>
            </section>

            <section className={sheet.recordSection}>
              <h3 className={sheet.sectionTitle}>Personal information</h3>
              <dl className={sheet.fieldGrid}>
                {personal.map(detail => (
                  <div key={detail.label} className={sheet.field}>
                    <dt>{detail.label}</dt>
                    <dd className={detail.value ? undefined : sheet.muted}>{detail.value || 'Not provided'}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className={sheet.recordSection}>
              <h3 className={sheet.sectionTitle}>Contact and account</h3>
              <dl className={sheet.fieldRows}>
                <div className={sheet.field}><dt>Username</dt><dd className={request.username ? undefined : sheet.muted}>{request.username || 'Not provided'}</dd></div>
                <div className={sheet.field}><dt>Email</dt><dd>{request.email}</dd></div>
                <div className={sheet.field}><dt>Phone number</dt><dd>{request.phoneNumber}</dd></div>
              </dl>
            </section>
          </div>

          {/* The decision sits at the foot of the rail. Choosing an outcome
              shows what it does (and the reason field when one is sent); the
              second button confirms it, so nothing happens on a single click. */}
          {!readOnly && (
            <footer className={`${sheet.sheetActions} ${sheet.decisionActions}`}>
              {errorMessage && <p role="alert" className={sheet.decisionError}>{errorMessage}</p>}
              {selectedDecision ? (
                <>
                  <p className={sheet.decisionOutcome} aria-live="polite">{selectedDecision.outcome}</p>
                  {decisionNeedsReason && (
                    <div>
                      <label htmlFor={rejectReasonId} className={sheet.decisionLabel}>Reason sent to the commuter</label>
                      <select
                        id={rejectReasonId}
                        value={selectedReason}
                        onChange={(e) => setSelectedReason(e.target.value)}
                        className="mt-1.5 block h-11 w-full rounded-md border border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 text-sm text-white admin-light:text-slate-900 scheme-dark admin-light:scheme-light focus:outline-none focus:border-[#62A0EA] admin-light:focus:border-[#1A5FB4]"
                      >
                        <option value="" disabled>Select a reason...</option>
                        {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                        <option value={OTHER_REASON}>{OTHER_REASON}</option>
                      </select>
                      {isOtherReason && (
                        <textarea
                          value={customReason}
                          onChange={(e) => setCustomReason(e.target.value)}
                          rows={3}
                          autoFocus
                          maxLength={RENEWAL_REASON_MAX}
                          aria-label="Other reason"
                          placeholder={decision === 'NEEDS_CORRECTION' ? 'Describe what needs to be corrected...' : 'Describe the reason for rejection...'}
                          className="mt-2 block w-full resize-none rounded-md border border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 py-2.5 text-sm text-white admin-light:text-slate-900 placeholder-slate-500 admin-light:placeholder-slate-400 focus:outline-none focus:border-[#62A0EA] admin-light:focus:border-[#1A5FB4]"
                        />
                      )}
                    </div>
                  )}
                  {/* Opens the confirmation dialog; nothing is decided here. */}
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    disabled={(decisionNeedsReason && !effectiveReason) || documentLoading}
                    className={confirmClass}
                  >
                    Continue
                  </button>
                  <button type="button" onClick={() => setDecision('')} className={sheet.actionClose}>Back</button>
                </>
              ) : (
                <>
                  {/* Approve sends no reason, so it goes straight to the confirmation. */}
                  <button type="button" onClick={() => { chooseDecision('APPROVED'); setConfirmOpen(true); }} disabled={documentLoading} className={sheet.actionApprove}>{isApplication ? `Approve as ${category}` : 'Approve renewal'}</button>
                  <button type="button" onClick={() => chooseDecision('NEEDS_CORRECTION')} className={sheet.actionClose}>Request correction</button>
                  <button type="button" onClick={() => chooseDecision('REJECTED')} className={sheet.actionSuspend}>Reject</button>
                </>
              )}
            </footer>
          )}
        </div>
        {lightbox}

        {/* Confirmation dialog: the decision only happens here. It sits above
            the review modal (z-60) like the image viewer; Cancel is focused
            first so Enter never confirms by accident. */}
        {confirmOpen && selectedDecision && (
          <div
            className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4"
            onClick={closeConfirm}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeConfirm(); } }}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={confirmTitleId}
              aria-describedby={confirmBodyId}
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-sm rounded-xl border border-[#2A3A55] bg-[#1A2540] p-6 shadow-2xl admin-light:border-[#E2E8F0] admin-light:bg-white"
            >
              <h3 id={confirmTitleId} className="text-lg font-bold leading-snug text-white admin-light:text-slate-900">
                {decision === 'APPROVED'
                  ? `Approve ${request.name}'s ${isApplication ? `${category} application` : 'student renewal'}?`
                  : decision === 'REJECTED' ? `Reject this ${requestName}?` : 'Send this back for correction?'}
              </h3>
              <div id={confirmBodyId} className="mt-3 space-y-3 text-sm leading-relaxed text-slate-300 admin-light:text-slate-600">
                <p>{selectedDecision.outcome}</p>
                {decisionNeedsReason && effectiveReason && (
                  <div className="rounded-md border border-[#2A3A55] bg-[#131C2E] p-3 admin-light:border-[#E2E8F0] admin-light:bg-[#F8FAFC]">
                    <p className="text-xs font-medium text-slate-400 admin-light:text-slate-500">Reason sent to {request.firstName || 'the commuter'}</p>
                    <p className="mt-1 wrap-anywhere text-white admin-light:text-slate-900">{effectiveReason}</p>
                  </div>
                )}
              </div>
              <div className="mt-6 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={closeConfirm}
                  className="min-h-11 rounded-md border border-[#2A3A55] bg-[#131C2E] text-sm font-semibold text-slate-200 transition-colors hover:bg-[#0E1628] admin-light:border-[#CBD5E1] admin-light:bg-white admin-light:text-slate-700 admin-light:hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={(event) => { if (event.detail <= 1) { setConfirmOpen(false); handleDecisionConfirm(); } }}
                  className={`min-h-11 rounded-md border text-sm font-semibold text-white transition-colors ${decision === 'APPROVED' ? 'border-[#047857] bg-[#047857] hover:bg-[#065F46]' : decision === 'REJECTED' ? 'border-red-600 bg-red-600 hover:bg-red-700' : 'border-[#62A0EA] bg-[#62A0EA] hover:bg-[#4A8BD4] admin-light:border-[#1A5FB4] admin-light:bg-[#1A5FB4] admin-light:hover:bg-[#164A8F]'}`}
                >
                  {selectedDecision.confirm}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    );
  }

  return (
    <Modal adminThemed isOpen={isOpen} onClose={() => { if (!isProcessing) onClose(); }} maxWidth="max-w-2xl">
      <div className="pr-8">
        <h2 className="text-xl font-bold text-white admin-light:text-slate-900 sm:text-2xl">Review Registration Request</h2>
        <p className="mt-1 text-sm text-slate-500">Verify the applicant’s details against their uploaded ID before deciding.</p>
      </div>

      <div className="mt-5 space-y-4">
        {/* Applicant identity strip — the one place a human name/email/type
            summary lives, so the admin doesn't have to scan the field grid
            below just to know who they're looking at. */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-[#F8FAFC] p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#2A3A55] admin-light:border-[#CBD5E1] bg-[#131C2E] admin-light:bg-[#F1F5F9] text-sm font-bold text-slate-200 admin-light:text-slate-700">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white admin-light:text-slate-900" title={request.name}>{request.name}</p>
              <p className="truncate text-xs text-slate-500" title={request.email}>{request.email}</p>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Commuter Type</p>
            <p className="text-sm font-semibold text-white admin-light:text-slate-900">{request.commuterType}</p>
          </div>
        </div>

        {/* Repeat-applicant warning — this identity (email/contact) has been
            rejected before. Helps the admin spot applicants nearing the
            re-registration cooldown threshold. */}
        {request.rejectionCount > 0 && (
          <div className="space-y-3 rounded-xl border border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-[#F8FAFC] p-4">
            <div className="flex items-start space-x-2">
              <AlertTriangle size={16} aria-hidden="true" className="text-slate-400 admin-light:text-slate-500 mt-0.5 shrink-0" />
              <p className="text-sm text-slate-200 admin-light:text-slate-800">
                This applicant has been rejected{' '}
                <span className="font-semibold">
                  {request.rejectionCount} {request.rejectionCount === 1 ? 'time' : 'times'}
                </span>{' '}
                before.
                {request.blockedUntil && ` Registration is restricted until ${new Date(request.blockedUntil).toLocaleString()}.`}
              </p>
            </div>
            {request.rejectionHistory.length > 0 && (
              <div className="max-h-32 space-y-2 overflow-y-auto border-t border-[#2A3A55] admin-light:border-[#E2E8F0] pt-2">
                {request.rejectionHistory.map((entry) => (
                  <div key={`${entry.attemptNumber}-${entry.rejectedAt}`} className="text-xs text-slate-300 admin-light:text-slate-700">
                    <span className="font-semibold text-white admin-light:text-slate-900">Attempt {entry.attemptNumber}</span>
                    {' - '}{entry.reason}
                    <span className="ml-2 text-slate-500">{new Date(entry.rejectedAt).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ID document + applicant fields, side by side on sm+ so the image
            and the data an admin cross-checks it against sit in one glance
            instead of a long single-column scroll. A renewal gets a wider
            document column: the proof is the thing being judged. */}
        <div className={`grid grid-cols-1 gap-4 sm:grid-cols-[13rem_1fr]`}>
          <section className={sectionClasses}>
            <div className="mb-3 flex items-center gap-2">
              <IdCard className="h-4 w-4 text-[#62A0EA] admin-light:text-[#1A5FB4]" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 admin-light:text-slate-500">ID Document</h3>
            </div>
            {/* A REGULAR applicant may register without an ID while the
                "Force Valid ID Upload" setting is off. */}
            {documentLoading ? (
              <div role="status" className="flex aspect-3/4 w-full items-center justify-center rounded-lg border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#131C2E] admin-light:bg-[#F1F5F9] text-xs text-slate-500">Loading document…</div>
            ) : !request.idImageUrl ? (
              <p className="rounded-lg border border-dashed border-white/10 admin-light:border-[#E2E8F0] px-4 py-10 text-center text-sm text-slate-400 admin-light:text-slate-500">
                No ID uploaded. ID upload was optional for this registration.
              </p>
            ) : documentIsPdf ? (
              // A PDF cannot be previewed inline, so it keeps the image's
              // frame and opens in a new tab instead.
              <div className="flex aspect-3/4 w-full flex-col items-center justify-center gap-3 rounded-lg border border-[#2A3A55] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-[#F1F5F9] px-3 text-center">
                <FileText size={28} className="text-[#62A0EA] admin-light:text-[#1A5FB4]" aria-hidden="true" />
                <p className="text-sm font-medium text-white admin-light:text-slate-900">PDF document</p>
                <a href={request.idImageUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#2A3A55] admin-light:border-[#CBD5E1] bg-[#131C2E] admin-light:bg-white px-3 text-sm font-semibold text-slate-200 admin-light:text-slate-700 transition-colors hover:bg-[#0E1628] admin-light:hover:bg-slate-50">
                  Open Document<ExternalLink size={14} aria-hidden="true" />
                </a>
              </div>
            ) : (
            <>
            {/* Click to view full size, since the thumbnail is too small to
                actually verify text/photo details against. */}
            <button
              type="button"
              onClick={() => setIsImageExpanded(true)}
              className="group relative block w-full cursor-zoom-in overflow-hidden rounded-lg border border-white/10 admin-light:border-[#E2E8F0]"
              aria-label="View full-size ID image"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={request.idImageUrl} alt="Uploaded ID" className="aspect-3/4 w-full object-cover" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/40">
                <ZoomIn size={20} className="text-white opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </button>
            <p className="mt-2 text-center text-xs text-slate-500">Uploaded Valid ID · tap to enlarge</p>
            </>
            )}
          </section>

          {detailsSection}
        </div>

        {/* Sits with the decision controls, not at the top of the modal: a
            failed review leaves the admin at the bottom of a scrolled panel. */}
        {errorMessage && <InlineError>{errorMessage}</InlineError>}

        {/* Registration decision bar. The two button slots never move:
            Reject/Approve become Cancel/Confirm in place, so the confirm
            lands where the admin just clicked and both buttons always share
            the same width. Only the text on the left changes per step. */}
        {(
          <div className="space-y-3 pt-2">
            {showRejectConfirm && (
              <div>
                <label htmlFor={rejectReasonId} className="text-sm font-semibold text-slate-300 admin-light:text-slate-700">Reason for rejection</label>
                <select
                  id={rejectReasonId}
                  value={selectedReason}
                  onChange={(e) => setSelectedReason(e.target.value)}
                  disabled={isProcessing}
                  className="mt-2 block h-11 w-full rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 text-sm text-white admin-light:text-slate-900 scheme-dark admin-light:scheme-light focus:outline-none focus:ring-1 focus:ring-[#62A0EA] admin-light:focus:ring-[#1A5FB4]"
                >
                  <option value="" disabled className="bg-gray-800 admin-light:bg-white">Select a reason...</option>
                  {REJECTION_REASONS.map((reason) => (
                    <option key={reason} value={reason} className="bg-gray-800 admin-light:bg-white">{reason}</option>
                  ))}
                  <option value={OTHER_REASON} className="bg-gray-800 admin-light:bg-white">{OTHER_REASON}</option>
                </select>

                {/* Free-text box only appears when "Other" is selected. */}
                {isOtherReason && (
                  <textarea
                    value={customReason}
                    onChange={(e) => setCustomReason(e.target.value)}
                    disabled={isProcessing}
                    rows={2}
                    autoFocus
                    aria-label="Describe the reason for rejection"
                    placeholder="Describe the reason for rejection..."
                    className="mt-2 block w-full resize-none rounded-md border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#0E1628] admin-light:bg-white px-3 py-2.5 text-sm text-white admin-light:text-slate-900 placeholder-slate-500 admin-light:placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-[#62A0EA] admin-light:focus:ring-[#1A5FB4]"
                  />
                )}
              </div>
            )}

            <div className="flex flex-col gap-3 rounded-lg border border-[#1E2D45] admin-light:border-[#E2E8F0] bg-[#1A2540] admin-light:bg-[#F8FAFC] p-3 sm:flex-row sm:items-center sm:gap-4 sm:pl-4">
              <div className="min-w-0 flex-1" aria-live="polite">
                {showApproveConfirm ? (
                  <>
                    <p className="text-sm font-semibold text-white admin-light:text-slate-900">Approve as a {request.commuterType} commuter?</p>
                    <p className="text-xs text-slate-400 admin-light:text-slate-500">They can log in right away.</p>
                  </>
                ) : showRejectConfirm ? (
                  <>
                    <p className="text-sm font-semibold text-white admin-light:text-slate-900">Reject this registration?</p>
                    <p className="text-xs text-slate-400 admin-light:text-slate-500">The reason is emailed to {request.firstName || request.name}.</p>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 admin-light:text-slate-500">Decision</p>
                    <p className="truncate text-sm font-semibold text-white admin-light:text-slate-900" title={`${request.name} · ${request.commuterType}`}>{request.name} · {request.commuterType}</p>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 sm:w-76 sm:shrink-0">
                {showingConfirm ? (
                  <button
                    type="button"
                    onClick={showRejectConfirm ? resetRejectState : () => setShowApproveConfirm(false)}
                    disabled={isProcessing}
                    className="h-11 rounded-lg border border-[#2A3B57] admin-light:border-[#CBD5E1] bg-[#131C2E] admin-light:bg-white text-sm font-semibold text-slate-300 admin-light:text-slate-700 transition-colors hover:bg-[#172238] admin-light:hover:bg-[#F1F5F9] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] admin-light:focus-visible:ring-[#1A5FB4] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowRejectConfirm(true)}
                    disabled={isProcessing}
                    className="flex h-11 items-center justify-center gap-2 rounded-lg border border-[#2A3B57] admin-light:border-[#CBD5E1] bg-[#131C2E] admin-light:bg-white text-sm font-semibold text-red-300 admin-light:text-red-600 transition-colors hover:bg-[#172238] admin-light:hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] admin-light:focus-visible:ring-[#1A5FB4] disabled:opacity-50"
                  >
                    <X size={16} aria-hidden="true" />
                    Reject
                  </button>
                )}

                {/* `detail > 1` is the second click of a double-click: the
                    confirm sits exactly where Approve/Reject was, so without
                    this guard a double-click would confirm on its own. */}
                {showApproveConfirm ? (
                  <button
                    type="button"
                    onClick={(event) => { if (event.detail <= 1) onApprove(); }}
                    disabled={isProcessing}
                    className="flex h-11 items-center justify-center gap-2 rounded-lg border border-emerald-700 bg-emerald-700 text-sm font-semibold text-white transition-colors hover:border-emerald-800 hover:bg-emerald-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A2540] admin-light:focus-visible:ring-offset-[#F8FAFC] disabled:opacity-50"
                  >
                    <Check size={16} aria-hidden="true" />
                    Confirm
                  </button>
                ) : showRejectConfirm ? (
                  <button
                    type="button"
                    onClick={(event) => { if (event.detail <= 1) handleRejectClick(); }}
                    disabled={!effectiveReason || isProcessing}
                    className="flex h-11 items-center justify-center gap-2 rounded-lg border border-red-600 bg-red-600 text-sm font-semibold text-white transition-colors hover:border-red-700 hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A2540] admin-light:focus-visible:ring-offset-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X size={16} aria-hidden="true" />
                    Confirm
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowApproveConfirm(true)}
                    disabled={isProcessing}
                    className="flex h-11 items-center justify-center gap-2 rounded-lg border border-emerald-700 bg-emerald-700 text-sm font-semibold text-white transition-colors hover:border-emerald-800 hover:bg-emerald-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A2540] admin-light:focus-visible:ring-offset-[#F8FAFC] disabled:opacity-50"
                  >
                    <Check size={16} aria-hidden="true" />
                    Approve
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      </div>

      {lightbox}
    </Modal>
  );
}
