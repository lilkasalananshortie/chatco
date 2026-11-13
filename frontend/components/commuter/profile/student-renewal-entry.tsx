'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useRewardsData } from '@/contexts/rewards-context';
import { getFareConfig } from '@/lib/shared/fare/fare-matrix.service';

const formatDate = (value: string, withTime = false) => new Date(value).toLocaleString('en-PH', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila',
  ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
});

/**
 * Profile-card counterpart of the discount application entry for current
 * students. It reads the renewal state the Rewards tab badge already loads,
 * so it shows exactly while that badge counts the renewal and clears once
 * the renewal is approved. Former students (now Regular) are covered by
 * DiscountApplicationEntry instead.
 */
export function StudentRenewalEntry() {
  const { renewal, refreshRenewal } = useRewardsData();
  // Opening the profile is a natural moment to pick up a review decision.
  useEffect(() => { refreshRenewal(); }, [refreshRenewal]);
  if (!renewal?.notice_active || renewal.commuter_type !== 'STUDENT') return null;

  const { status, can_submit: canSubmit, application } = renewal;
  const discount = `${getFareConfig().discountRate}% student discount`;
  const content = status === 'PENDING'
    ? { text: 'Your student renewal is being reviewed. We’ll notify you when it’s done, so there’s no need to submit again.', link: 'View renewal status' }
    : status === 'NEEDS_CORRECTION'
      ? { text: `An admin asked for a correction to your student renewal. Send corrected proof${application?.correction_due_at ? ` by ${formatDate(application.correction_due_at, true)}` : ''} to continue the review.`, link: 'Submit corrected proof' }
      : status === 'REJECTED'
        ? { text: 'Your student renewal was not approved.', link: 'Submit again' }
        // The notice starts a few days before submissions open.
        : !canSubmit
          ? { lead: 'Student renewal is coming up.', text: `It opens on ${formatDate(renewal.opens_at)}. Have your current school ID or enrollment proof ready to keep your ${discount}.`, link: 'View renewal status' }
          : { lead: 'Student renewal is due.', text: `Upload your current school ID or enrollment proof before ${formatDate(renewal.deadline)} to keep your ${discount}.`, link: 'Renew student status' };
  // Something to do only when the server will accept a submission.
  const primary = canSubmit && status !== 'PENDING';

  return <div className="mt-4 border-t border-white/15 pt-4 text-sm light:border-[#1A5FB4]/15">
    <p className={`leading-relaxed ${status === 'REJECTED' ? 'text-red-200 light:text-red-700' : 'text-white/85 light:text-gray-700'}`}>
      {'lead' in content && <span className="font-semibold text-white light:text-gray-900">{content.lead} </span>}
      {content.text}
    </p>
    {(status === 'REJECTED' || status === 'NEEDS_CORRECTION') && application?.reason && <p className="mt-1 wrap-break-word text-white/70 light:text-gray-600"><span className="text-white/50 light:text-gray-500">Reason: </span>{application.reason}</p>}
    <Link href="/student-renewal" onClick={() => window.dispatchEvent(new Event('commuter:close-popovers'))} className={`mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#99C1F1] sm:w-auto sm:inline-flex ${primary ? 'bg-[#1A5FB4] text-white hover:bg-[#164A8F]' : 'border border-[#2A4A70] bg-[#13283F] text-white hover:bg-[#1A3350] light:border-gray-200 light:bg-white light:text-gray-800 light:hover:bg-gray-50'}`}>
      {status === 'REJECTED' && !canSubmit ? 'View renewal status' : content.link}
      {primary && <ArrowRight size={16} aria-hidden="true" />}
    </Link>
  </div>;
}
