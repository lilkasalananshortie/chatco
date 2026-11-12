'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Modal } from '@/components/admin/ui/modal';
import { Star, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import { formatLogDate } from '@/lib/utils/format';
import {
  list as listFeedback,
  FeedbackFetchError,
  type FeedbackRow,
  type FeedbackSummary,
  type ReasonGroup,
} from '@/lib/admin/services/feedback.service';

/**
 * Admin staff Ratings & Feedback modal (S6-T6 revised).
 *
 * Opened from the "Ratings & Feedback" row action in Fleet Management >
 * Personnel for a driver or conductor.
 *
 * Split layout: the left column is the verdict (average, review count, 5→1
 * breakdown, and the tags commuters picked most, ranked); the right column is
 * what commuters actually said. Each breakdown row and each ranked reason is
 * also a filter, so an admin auditing complaints can jump straight to the
 * 1–2 star reviews or every review that mentions "Overspeeding". The two
 * filters are exclusive: picking one clears the other, so the list count is
 * always known from the summary.
 *
 * Reviews infinite-scroll in batches of 10 from
 * GET /api/admin/feedback?…&pagination=cursor. The first batch carries the
 * summary (which always covers every rating); later batches send the keyset
 * cursor, so they skip the summary + COUNT work server-side and can never
 * repeat or skip a review when new feedback arrives mid-scroll. The next
 * batch starts loading shortly before the bottom is reached.
 *
 * The QR → feedback relationship: the QR is permanently tied to the unit
 * (vehicle). When a commuter scans it, the system resolves TODAY's driver +
 * conductor for that unit and the feedback lands on BOTH their profiles.
 * This modal shows the accumulated history for a single staff member.
 */
export interface FeedbackModalStaff {
  id: string;
  role: 'CONDUCTOR' | 'DRIVER';
  name: string;
}

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  staff: FeedbackModalStaff | null;
}

const BATCH_SIZE = 10;
/** Start fetching the next batch this far before the end of the list. */
const PREFETCH_MARGIN_PX = 240;

function errorMessage(err: unknown): string {
  return err instanceof FeedbackFetchError ? err.message : 'Failed to load feedback.';
}

/** Nearest scrolling ancestor: the review list on desktop, the modal body
 *  on phones (where the columns stack and the whole body scrolls). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

export function FeedbackModal({ isOpen, onClose, staff }: FeedbackModalProps) {
  const [summary, setSummary] = useState<FeedbackSummary | null>(null);
  const [items, setItems] = useState<FeedbackRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingFirst, setIsLoadingFirst] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  /** First-batch failure (initial open or a filter change). */
  const [error, setError] = useState<string | null>(null);
  /** A later batch failed; the loaded reviews stay and a Retry is offered. */
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [ratingFilter, setRatingFilter] = useState<number | null>(null);
  const [reasonFilter, setReasonFilter] = useState<string | null>(null);
  const [reasonGroup, setReasonGroup] = useState<ReasonGroup>('complaints');

  /** One controller per list "session" (open / filter). Starting a new
   *  session aborts every in-flight request of the old one, so a slow
   *  response can never land in the wrong list. */
  const sessionRef = useRef<AbortController | null>(null);
  /** Synchronous guard: the observer can fire again before React commits
   *  isLoadingMore, which would otherwise request the same batch twice. */
  const loadingMoreRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadFirst = useCallback(
    async (rating: number | null, reason: string | null) => {
      if (!staff) return;
      sessionRef.current?.abort();
      const session = new AbortController();
      sessionRef.current = session;
      loadingMoreRef.current = false;

      setIsLoadingFirst(true);
      setIsLoadingMore(false);
      setError(null);
      setLoadMoreError(null);
      listRef.current?.scrollTo({ top: 0 });

      try {
        const result = await listFeedback({
          conductorId: staff.role === 'CONDUCTOR' ? staff.id : undefined,
          driverId: staff.role === 'DRIVER' ? staff.id : undefined,
          perPage: BATCH_SIZE,
          rating: rating ?? undefined,
          reason: reason ?? undefined,
          signal: session.signal,
        });
        if (session.signal.aborted) return;
        setSummary(result.summary);
        setItems(result.feedback);
        setNextCursor(result.pagination.nextCursor);
        setHasMore(result.pagination.hasMore);
      } catch (err) {
        if (session.signal.aborted) return;
        setError(errorMessage(err));
      } finally {
        if (!session.signal.aborted) setIsLoadingFirst(false);
      }
    },
    [staff]
  );

  const loadMore = useCallback(async () => {
    const session = sessionRef.current;
    if (!staff || !session || !nextCursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const result = await listFeedback({
        conductorId: staff.role === 'CONDUCTOR' ? staff.id : undefined,
        driverId: staff.role === 'DRIVER' ? staff.id : undefined,
        perPage: BATCH_SIZE,
        rating: ratingFilter ?? undefined,
        reason: reasonFilter ?? undefined,
        cursor: nextCursor,
        signal: session.signal,
      });
      if (session.signal.aborted) return;
      // The keyset cursor already prevents overlap; de-duplicating by id is
      // a cheap guard so a retried batch can never render a row twice.
      setItems((current) => {
        const seen = new Set(current.map((row) => row.id));
        return [...current, ...result.feedback.filter((row) => !seen.has(row.id))];
      });
      setNextCursor(result.pagination.nextCursor);
      setHasMore(result.pagination.hasMore);
    } catch (err) {
      if (session.signal.aborted) return;
      setLoadMoreError(errorMessage(err));
    } finally {
      if (!session.signal.aborted) {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [staff, nextCursor, ratingFilter, reasonFilter]);

  // The observer is long-lived; read the latest loadMore through a ref.
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  // Reset + load the first batch on open / staff change; abort on close.
  useEffect(() => {
    if (!isOpen || !staff) return;
    setSummary(null);
    setItems([]);
    setNextCursor(null);
    setHasMore(false);
    setRatingFilter(null);
    setReasonFilter(null);
    setReasonGroup('complaints');
    void loadFirst(null, null);
    return () => sessionRef.current?.abort();
  }, [isOpen, staff, loadFirst]);

  // Load the next batch as the bottom approaches. Re-created after every
  // batch: a fresh observer reports immediately, so if the new rows still
  // don't fill the visible area (tall screens) the next batch follows.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isLoadingFirst || loadMoreError) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreRef.current();
      },
      { root: scrollParent(sentinel), rootMargin: `0px 0px ${PREFETCH_MARGIN_PX}px 0px` }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingFirst, loadMoreError, items.length]);

  // Rating and reason filters are exclusive: setting one clears the other.
  const applyFilter = (rating: number | null, reason: string | null = null) => {
    setRatingFilter(rating);
    setReasonFilter(reason);
    void loadFirst(rating, reason);
  };

  const reasonCount = (reason: string) =>
    summary
      ? [...summary.reasons.complaints, ...summary.reasons.praise]
          .filter((item) => item.label === reason)
          .reduce((sum, item) => sum + item.count, 0)
      : 0;

  const listCount = summary
    ? ratingFilter
      ? summary.distribution[String(ratingFilter)] ?? 0
      : reasonFilter
        ? reasonCount(reasonFilter)
        : summary.totalCount
    : 0;
  const listTitle = ratingFilter ? `${ratingFilter}-star reviews` : reasonFilter ? `Mentioning ${reasonFilter}` : 'All reviews';
  const hasFilter = ratingFilter !== null || reasonFilter !== null;

  return (
    <Modal adminThemed isOpen={isOpen} onClose={onClose} maxWidth="max-w-3xl" height="h-[min(640px,85vh)]">
      {staff && (
        <div className="flex flex-col gap-5 md:h-full md:min-h-0">
          {/* Header */}
          <div className="shrink-0 pr-8">
            <h2 className="text-xl font-bold text-white admin-light:text-slate-900">Ratings & Feedback</h2>
            {/* Same quiet dot + label role treatment as the Personnel table. */}
            <div className="mt-1.5 flex items-center gap-2 text-sm">
              <span className="text-slate-300 admin-light:text-slate-700">{staff.name}</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="inline-flex items-center gap-2 text-slate-400 admin-light:text-slate-600">
                {staff.role === 'DRIVER' ? 'Driver' : 'Conductor'}
              </span>
            </div>
          </div>

          {/* First load */}
          {!summary && isLoadingFirst && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16">
              <RefreshCw size={24} aria-hidden="true" className="animate-spin text-slate-500" />
              <p className="text-sm text-slate-400 admin-light:text-slate-500">Loading feedback…</p>
            </div>
          )}

          {/* First load failed */}
          {!summary && !isLoadingFirst && error && (
            <ErrorState message={error} onRetry={() => void loadFirst(ratingFilter, reasonFilter)} />
          )}

          {summary && (
            <div className="flex flex-col gap-5 border-t border-[#1E2D45] pt-5 admin-light:border-[#E2E8F0] md:min-h-0 md:flex-1 md:flex-row md:gap-0">
              <SummaryColumn
                summary={summary}
                activeRating={ratingFilter}
                onSelect={(rating) => applyFilter(rating === ratingFilter ? null : rating)}
                reasonGroup={reasonGroup}
                onReasonGroup={setReasonGroup}
                activeReason={reasonFilter}
                onSelectReason={(reason) => applyFilter(null, reason === reasonFilter ? null : reason)}
              />

              {/* Reviews */}
              <section aria-label="Reviews" className="flex min-w-0 flex-col md:min-h-0 md:flex-1 md:pl-6">
                <div className="flex shrink-0 items-baseline justify-between gap-3 pb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {listTitle}
                    <span className="ml-2 font-normal normal-case tracking-normal tabular-nums">{listCount}</span>
                  </h3>
                  {hasFilter && (
                    <button
                      type="button"
                      onClick={() => applyFilter(null)}
                      className="cursor-pointer text-xs font-medium text-[#62A0EA] transition-colors hover:text-[#8CBBF0] admin-light:text-[#1A5FB4] admin-light:hover:text-[#164A8F]"
                    >
                      Show all reviews
                    </button>
                  )}
                </div>

                {error ? (
                  <ErrorState message={error} onRetry={() => void loadFirst(ratingFilter, reasonFilter)} />
                ) : items.length === 0 && !isLoadingFirst ? (
                  <EmptyReviews filtered={hasFilter} role={staff.role} />
                ) : (
                  <div
                    ref={listRef}
                    className="border-t border-[#1E2D45] admin-light:border-[#E2E8F0] md:min-h-0 md:flex-1 md:overflow-y-auto md:pr-1"
                  >
                    <div
                      role="feed"
                      aria-busy={isLoadingFirst || isLoadingMore}
                      aria-label={listTitle}
                      className={`divide-y divide-[#1E2D45] transition-opacity admin-light:divide-[#E2E8F0] ${isLoadingFirst ? 'opacity-50' : ''}`}
                    >
                      {items.map((row, index) => (
                        <ReviewRow key={row.id} row={row} position={index + 1} setSize={listCount} />
                      ))}
                    </div>

                    {/* Scroll trigger for the next batch. */}
                    <div ref={sentinelRef} aria-hidden="true" className="h-px" />

                    {isLoadingMore && (
                      <p role="status" className="flex items-center justify-center gap-2 border-t border-[#1E2D45] py-4 text-xs text-slate-500 admin-light:border-[#E2E8F0]">
                        <Loader2 size={14} aria-hidden="true" className="animate-spin" />
                        Loading more reviews…
                      </p>
                    )}

                    {loadMoreError && (
                      <div role="alert" className="flex items-center justify-center gap-3 border-t border-[#1E2D45] py-4 text-xs admin-light:border-[#E2E8F0]">
                        <span className="text-red-400 admin-light:text-red-600">{loadMoreError}</span>
                        <button
                          type="button"
                          onClick={() => void loadMore()}
                          className="cursor-pointer font-medium text-[#62A0EA] hover:text-[#8CBBF0] admin-light:text-[#1A5FB4] admin-light:hover:text-[#164A8F]"
                        >
                          Retry
                        </button>
                      </div>
                    )}

                    {!hasMore && !isLoadingFirst && items.length > BATCH_SIZE && (
                      <p className="border-t border-[#1E2D45] py-4 text-center text-xs text-slate-500 admin-light:border-[#E2E8F0]">
                        You&apos;ve reached the end.
                      </p>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── Summary column (verdict + filter) ──────────────────────────────

const REASON_GROUPS: { id: ReasonGroup; label: string; source: string }[] = [
  { id: 'complaints', label: 'Complaints', source: '1–3' },
  { id: 'praise', label: 'Praise', source: '4–5' },
];

function SummaryColumn({
  summary,
  activeRating,
  onSelect,
  reasonGroup,
  onReasonGroup,
  activeReason,
  onSelectReason,
}: {
  summary: FeedbackSummary;
  activeRating: number | null;
  onSelect: (rating: number) => void;
  reasonGroup: ReasonGroup;
  onReasonGroup: (group: ReasonGroup) => void;
  activeReason: string | null;
  onSelectReason: (reason: string) => void;
}) {
  const { averageRating, totalCount, distribution } = summary;
  const maxCount = Math.max(1, ...Object.values(distribution));
  const reasons = summary.reasons[reasonGroup];
  const maxReason = Math.max(1, ...reasons.map((reason) => reason.count));
  const group = REASON_GROUPS.find((item) => item.id === reasonGroup) ?? REASON_GROUPS[0];

  return (
    <aside
      aria-label="Rating summary"
      className="flex shrink-0 flex-col gap-5 border-b border-[#1E2D45] pb-5 admin-light:border-[#E2E8F0] md:min-h-0 md:w-60 md:overflow-y-auto md:border-b-0 md:border-r md:pb-0 md:pr-5 scrollbar-themed"
    >
      <div>
        <p className="text-5xl font-bold leading-none tracking-tight tabular-nums text-white admin-light:text-slate-900">
          {totalCount > 0 ? averageRating.toFixed(1) : '—'}
        </p>
        <Stars rating={Math.round(averageRating)} size={14} className="mt-2.5" />
        <p className="mt-2 text-xs text-slate-500">
          {totalCount === 0 ? 'No reviews yet' : `${totalCount} review${totalCount === 1 ? '' : 's'}`}
        </p>
      </div>

      {/* Each row filters the review list to that star level. */}
      <div className="flex flex-col gap-0.5" role="group" aria-label="Filter reviews by rating">
        {[5, 4, 3, 2, 1].map((star) => {
          const count = distribution[String(star)] ?? 0;
          const isActive = activeRating === star;
          return (
            <button
              key={star}
              type="button"
              onClick={() => onSelect(star)}
              disabled={count === 0 && !isActive}
              aria-pressed={isActive}
              aria-label={`${star}-star reviews, ${count}`}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:cursor-default disabled:opacity-40 ${
                isActive
                  ? 'bg-[#62A0EA] text-[#0B1120] admin-light:bg-[#1A5FB4] admin-light:text-white'
                  : 'text-slate-400 hover:bg-[#131C2E] disabled:hover:bg-transparent admin-light:text-slate-600 admin-light:hover:bg-[#F1F5F9]'
              }`}
            >
              <span className="w-2.5 text-xs font-semibold tabular-nums">{star}</span>
              <Star size={11} aria-hidden="true" className="shrink-0 fill-current" />
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1A2540] admin-light:bg-[#E2E8F0]">
                <span
                  className={`block h-full rounded-full ${isActive ? 'bg-[#0B1120] admin-light:bg-white' : 'bg-amber-400/80'}`}
                  style={{ width: `${(count / maxCount) * 100}%` }}
                />
              </span>
              <span className="w-6 text-right text-xs tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Tags commuters picked, ranked; each row filters the review list. */}
      <section aria-label="Top reasons" className="flex flex-col gap-2.5 border-t border-[#1E2D45] pt-4 admin-light:border-[#E2E8F0]">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Top reasons</h3>
        <div role="group" aria-label="Reason type" className="grid grid-cols-2 rounded-md border border-[#1E2D45] bg-[#131C2E] p-0.5 admin-light:border-[#E2E8F0] admin-light:bg-[#F1F5F9]">
          {REASON_GROUPS.map((item) => {
            const isActive = item.id === reasonGroup;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => onReasonGroup(item.id)}
                className={`cursor-pointer rounded px-2 py-1.5 text-xs font-semibold transition-colors ${
                  isActive
                    ? 'bg-[#62A0EA] text-[#0B1120] admin-light:bg-[#1A5FB4] admin-light:text-white'
                    : 'text-slate-400 hover:text-slate-200 admin-light:text-slate-600 admin-light:hover:text-slate-900'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {reasons.length === 0 ? (
          <p className="text-xs text-slate-500">No {group.label.toLowerCase()} picked yet.</p>
        ) : (
          <ol className="flex flex-col gap-0.5" aria-label={`Top ${group.label.toLowerCase()}`}>
            {reasons.map((reason, index) => {
              const isActive = activeReason === reason.label;
              return (
                <li key={reason.label}>
                  <button
                    type="button"
                    onClick={() => onSelectReason(reason.label)}
                    aria-pressed={isActive}
                    aria-label={`${reason.label}, ${reason.count} review${reason.count === 1 ? '' : 's'}`}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                      isActive
                        ? 'bg-[#62A0EA] font-semibold text-[#0B1120] admin-light:bg-[#1A5FB4] admin-light:text-white'
                        : 'text-slate-300 hover:bg-[#131C2E] admin-light:text-slate-700 admin-light:hover:bg-[#F1F5F9]'
                    }`}
                  >
                    <span className={`w-3 shrink-0 text-[11px] tabular-nums ${isActive ? '' : 'text-slate-500'}`}>{index + 1}</span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate" title={reason.label}>{reason.label}</span>
                        <span className="shrink-0 tabular-nums">{reason.count}</span>
                      </span>
                      <span className={`h-0.5 overflow-hidden rounded-full ${isActive ? 'bg-[#3B6FB0] admin-light:bg-[#5B8AC9]' : 'bg-[#1A2540] admin-light:bg-[#E2E8F0]'}`}>
                        <span
                          className={`block h-full rounded-full ${isActive ? 'bg-[#0B1120] admin-light:bg-white' : 'bg-slate-500 admin-light:bg-slate-400'}`}
                          style={{ width: `${(reason.count / maxReason) * 100}%` }}
                        />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <p className="text-[11px] text-slate-500">From {group.source} star reviews. Select one to filter.</p>
      </section>
    </aside>
  );
}

// ─── Single review ──────────────────────────────────────────────────

function ReviewRow({ row, position, setSize }: { row: FeedbackRow; position: number; setSize: number }) {
  const meta = [
    row.commuter?.name ?? 'Anonymous',
    row.vehicle ? `Unit ${row.vehicle.unitNumber}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <article aria-posinset={position} aria-setsize={setSize} className="py-3.5">
      <div className="flex items-center justify-between gap-3">
        <Stars rating={row.rating} size={12} />
        <span className="shrink-0 text-xs tabular-nums text-slate-500">
          {row.createdAt ? formatLogDate(row.createdAt) : '—'}
        </span>
      </div>
      {row.comment ? (
        <p className="mt-1.5 text-sm leading-relaxed text-slate-200 admin-light:text-slate-800">{row.comment}</p>
      ) : (
        <p className="mt-1.5 text-sm text-slate-500">No written comment</p>
      )}
      <TagLine tags={row.tags} />
      <p className="mt-0.5 truncate text-xs text-slate-500" title={meta}>
        {meta}
      </p>
    </article>
  );
}

/**
 * The commuter's tags on one line, ending in "…" when they don't fit. "Show
 * all" appears only when something is actually hidden (measured, so it tracks
 * the column width) and wraps the full list; hovering shows it too.
 */
function TagLine({ tags }: { tags: string[] }) {
  const lineRef = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = tags.join(' · ');

  useEffect(() => {
    const line = lineRef.current;
    if (!line || expanded) return;
    // ResizeObserver reports once on observe, then on every width change.
    const observer = new ResizeObserver(() => setOverflows(line.scrollWidth > line.clientWidth + 1));
    observer.observe(line);
    return () => observer.disconnect();
  }, [text, expanded]);

  if (tags.length === 0) return null;

  return (
    <div className="mt-2 flex items-baseline gap-2.5">
      <p
        ref={lineRef}
        title={text}
        className={`min-w-0 flex-1 text-xs leading-relaxed text-slate-300 admin-light:text-slate-600 ${expanded ? '' : 'truncate'}`}
      >
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="shrink-0 cursor-pointer text-xs font-medium text-[#62A0EA] transition-colors hover:text-[#8CBBF0] admin-light:text-[#1A5FB4] admin-light:hover:text-[#164A8F]"
        >
          {expanded ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

// ─── Small pieces ───────────────────────────────────────────────────

function Stars({ rating, size, className = '' }: { rating: number; size: number; className?: string }) {
  return (
    <span className={`flex items-center gap-0.5 ${className}`} role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          size={size}
          aria-hidden="true"
          className={
            s <= rating
              ? 'fill-amber-400 text-amber-400 admin-light:fill-amber-500 admin-light:text-amber-500'
              : 'fill-[#1A2540] text-slate-600 admin-light:fill-slate-200 admin-light:text-slate-300'
          }
        />
      ))}
    </span>
  );
}

function EmptyReviews({ filtered, role }: { filtered: boolean; role: FeedbackModalStaff['role'] }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-1 border-t border-[#1E2D45] py-10 admin-light:border-[#E2E8F0]">
      <p className="text-sm text-slate-300 admin-light:text-slate-700">
        {filtered ? 'No reviews match this filter.' : 'No feedback submitted yet.'}
      </p>
      {!filtered && (
        <p className="max-w-xs text-xs text-slate-500">
          Reviews appear here after commuters rate a ride with this {role === 'DRIVER' ? 'driver' : 'conductor'}.
        </p>
      )}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10">
      <AlertCircle size={24} aria-hidden="true" className="text-red-400 admin-light:text-red-600" />
      <p role="alert" className="text-center text-sm text-red-400 admin-light:text-red-600">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="flex cursor-pointer items-center gap-2 rounded-md bg-[#1A2540] px-3 py-1.5 text-sm text-slate-200 transition-colors hover:bg-[#243352] admin-light:bg-[#EEF2F7] admin-light:text-slate-800 admin-light:hover:bg-[#E2E8F0]"
      >
        <RefreshCw size={14} aria-hidden="true" /> Retry
      </button>
    </div>
  );
}
