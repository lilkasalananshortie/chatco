'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { getFareConfig } from '@/lib/shared/fare/fare-matrix.service';
import { APPLICATION_LABELS, DISCOUNT_CATEGORIES, getApplicationState, type ApplicationState } from '@/lib/shared/services/student-renewal.service';
import { toCommuterType } from '@/types';

export function DiscountApplicationEntry({ commuterType, onClassificationChanged }: { commuterType: string; onClassificationChanged: () => void }) {
  const [state, setState] = useState<ApplicationState | null>(null);
  const [failed, setFailed] = useState(false);
  const reportedType = useRef(commuterType);
  useEffect(() => {
    // The profile holds the converted type ("SENIOR_CITIZEN"); the raw
    // state holds the backend value ("SENIOR"), so compare converted values.
    const serverType = state ? toCommuterType(state.commuter_type) : undefined;
    if (serverType && serverType !== commuterType && reportedType.current !== serverType) {
      reportedType.current = serverType;
      onClassificationChanged();
    }
  }, [state, commuterType, onClassificationChanged]);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => { void getApplicationState(controller.signal).then(next => {
      if (!controller.signal.aborted) { setState(next); setFailed(false); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); }); };
    load(); window.addEventListener('focus', load);
    return () => { controller.abort(); window.removeEventListener('focus', load); };
  }, [commuterType]);
  // Only Regular accounts (including ones that reverted from a discount) can
  // apply. A discounted account never sees this, and an approval hides it as
  // soon as the server reports the new classification.
  if ((state?.commuter_type ?? commuterType) !== 'REGULAR') return null;
  // An unknown status must not be presented as an account that hasn't applied.
  if (!state && !failed) return <div role="status" className="mt-4 border-t border-white/15 pt-4 text-sm text-white/60 light:border-[#1A5FB4]/15 light:text-gray-500">
    Loading discount application status...
  </div>;
  const application = state?.application;
  const renewal = application?.request_type === 'RENEWAL';
  const category = application ? DISCOUNT_CATEGORIES[application.requested_type] : '';
  // Cancelled or legacy expired requests leave nothing open, so the commuter
  // is offered a fresh application.
  const status = state && application && !['CANCELLED', 'EXPIRED'].includes(state.status) ? state.status : 'NOT_APPLIED';
  const content = !state ? { text: 'Unable to load your discount application status.', link: 'View application status' }
    : renewal ? { text: `Student renewal: ${APPLICATION_LABELS[status]}`, link: 'View Student renewal' }
    : status === 'PENDING' ? { text: 'Your discount application is currently under review. Check here for updates on your application status.', link: 'View application status' }
    : status === 'NEEDS_CORRECTION' ? { text: `An admin asked for a correction to your ${category} discount application. Send corrected documents to continue the review.`, link: 'Update your application' }
    : status === 'REJECTED' ? { text: `Your ${category} discount application was not approved.`, link: 'Apply again' }
    // Cached live rate when the fare matrix has loaded this session; otherwise the same 20% default the type badge uses.
    : { lead: 'Student, PWD or Senior Citizen?', text: `Verify your ID to pay ${getFareConfig().discountRate}% less on every ride.`, link: 'Apply for a discount' };
  // Waiting on an admin (or no status to act on) is a look, not a next step.
  const primary = !!state && status !== 'PENDING';
  return <div className="mt-4 border-t border-white/15 pt-4 text-sm light:border-[#1A5FB4]/15">
    <p className={`leading-relaxed ${status === 'REJECTED' ? 'text-red-200 light:text-red-700' : 'text-white/85 light:text-gray-700'}`}>
      {'lead' in content && <span className="font-semibold text-white light:text-gray-900">{content.lead} </span>}
      {content.text}
    </p>
    {(status === 'REJECTED' || status === 'NEEDS_CORRECTION') && application?.reason && <p className="mt-1 wrap-break-word text-white/70 light:text-gray-600"><span className="text-white/50 light:text-gray-500">Reason: </span>{application.reason}</p>}
    {failed && <p className="mt-1 text-xs text-white/50 light:text-gray-500">Open your application to check its latest status.</p>}
    <Link href={renewal ? '/student-renewal' : '/discount-application'} onClick={() => window.dispatchEvent(new Event('commuter:close-popovers'))} className={`mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#99C1F1] sm:w-auto sm:inline-flex ${primary ? 'bg-[#1A5FB4] text-white hover:bg-[#164A8F]' : 'border border-[#2A4A70] bg-[#13283F] text-white hover:bg-[#1A3350] light:border-gray-200 light:bg-white light:text-gray-800 light:hover:bg-gray-50'}`}>
      {content.link}
      {primary && <ArrowRight size={16} aria-hidden="true" />}
    </Link>
  </div>;
}
