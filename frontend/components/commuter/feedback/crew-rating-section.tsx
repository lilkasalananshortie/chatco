"use client";

/**
 * One crew member's rating block: stars → tags → optional comment.
 *
 * The feedback page rates TWO people (driver, then conductor) with identical
 * controls, which previously meant the same ~60 lines of markup existed twice
 * and had already drifted (the conductor block carried a duplicate heading).
 * Keeping it here means a fix to the stars or the tag pills lands on both.
 *
 * Progressive disclosure is intentional and preserved: tags only appear once a
 * star is picked, and the comment box only once a tag is picked, so the form
 * never presents everything at once.
 */

/** Matches `comment`/`conductor_comment` max:2000 in StoreFeedbackRequest. */
export const COMMENT_MAX_LENGTH = 2000;

const RATING_WORDS = ["Terrible", "Poor", "Average", "Good", "Excellent"] as const;

interface CrewRatingSectionProps {
  /** Who is being rated — drives the copy only. */
  label: string;
  /** Display name, shown under the prompt when the crew resolved. */
  name?: string | null;
  rating: number;
  hoverRating: number;
  onHoverRating: (value: number) => void;
  onRate: (value: number) => void;
  /** Preset tags for the current rating polarity (positive vs negative). */
  tags: readonly string[];
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  comment: string;
  onCommentChange: (value: string) => void;
  commentPlaceholder: string;
}

export function CrewRatingSection({
  label,
  name,
  rating,
  hoverRating,
  onHoverRating,
  onRate,
  tags,
  selectedTags,
  onToggleTag,
  comment,
  onCommentChange,
  commentPlaceholder,
}: CrewRatingSectionProps) {
  // Hover previews the score without committing it; falls back to the real one.
  const displayRating = hoverRating || rating;
  const isPositive = rating >= 4;

  return (
    <div className="space-y-6">
      {/* ── Stars ─────────────────────────────────────────────── */}
      <div className="bg-[#071A2E] border border-white/10 rounded-2xl p-6 light:bg-white light:border-gray-200 flex flex-col items-center">
        <h3 className="text-white/70 text-sm font-semibold light:text-gray-700">How was your {label}?</h3>
        {name && (
          <p className="text-white/30 text-xs mt-1 light:text-gray-500 text-center truncate max-w-full">{name}</p>
        )}

        {/* Pointer events preview, focus events mirror it for keyboard users. */}
        <div
          className="flex gap-2 sm:gap-3 mt-4"
          role="group"
          aria-label={`${label} rating, 1 to 5 stars`}
          onMouseLeave={() => onHoverRating(0)}
        >
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              aria-label={`${star} star${star > 1 ? "s" : ""}`}
              aria-pressed={rating === star}
              onMouseEnter={() => onHoverRating(star)}
              onFocus={() => onHoverRating(star)}
              onBlur={() => onHoverRating(0)}
              onClick={() => onRate(star)}
              className="transition-transform duration-150 hover:scale-110 active:scale-95 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA]"
            >
              <svg
                className={`w-9 h-9 sm:w-10 sm:h-10 transition-colors duration-150 ${
                  star <= displayRating
                    ? "text-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]"
                    : "text-white/10 light:text-gray-200"
                }`}
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" />
              </svg>
            </button>
          ))}
        </div>

        {/* Reserved height stops the card resizing the moment a star is picked. */}
        <p
          className={`text-xs mt-3 font-medium h-4 transition-colors ${
            displayRating >= 4 ? "text-emerald-400 light:text-emerald-600" : displayRating > 0 ? "text-amber-400 light:text-amber-600" : "text-transparent"
          }`}
          aria-live="polite"
        >
          {displayRating > 0 ? RATING_WORDS[displayRating - 1] : " "}
        </p>
      </div>

      {/* ── Tags ──────────────────────────────────────────────── */}
      {rating > 0 && (
        <div className="animate-fade-in">
          <h3 className="text-white/70 text-sm font-semibold light:text-gray-700 mb-3">
            {isPositive ? "What went well?" : "What went wrong?"}
            <span className="text-white/30 font-normal light:text-gray-400 ml-1.5">(pick at least one)</span>
          </h3>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isSelected = selectedTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onToggleTag(tag)}
                  // Solid neutral tags; CHATCO Blue marks a picked one, the
                  // same for praise or complaints (no green/red coding).
                  className={`min-h-10 px-4 rounded-md text-xs border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#62A0EA] focus-visible:ring-offset-2 focus-visible:ring-offset-[#050F1A] light:focus-visible:ring-offset-white ${
                    isSelected
                      ? "bg-[#1A5FB4] border-[#1A5FB4] text-white font-semibold"
                      : "bg-[#0B223A] border-[#1E3A56] text-white/80 font-medium hover:border-white/30 hover:text-white light:bg-white light:border-gray-200 light:text-gray-700 light:hover:bg-gray-50 light:hover:text-gray-900"
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Comment ───────────────────────────────────────────── */}
      {rating > 0 && selectedTags.length > 0 && (
        <div className="space-y-2 animate-fade-in">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-white/70 text-sm font-semibold light:text-gray-700">
              Additional comments{" "}
              <span className="text-white/30 font-normal light:text-gray-400">(optional)</span>
            </h3>
            {/* Only surfaces near the cap — a counter on an empty box is noise. */}
            {comment.length > COMMENT_MAX_LENGTH * 0.8 && (
              <span
                className={`text-[11px] font-medium tabular-nums ${
                  comment.length >= COMMENT_MAX_LENGTH ? "text-red-400 light:text-red-600" : "text-white/40 light:text-gray-500"
                }`}
              >
                {comment.length}/{COMMENT_MAX_LENGTH}
              </span>
            )}
          </div>
          <textarea
            rows={3}
            value={comment}
            maxLength={COMMENT_MAX_LENGTH}
            onChange={(e) => onCommentChange(e.target.value)}
            placeholder={commentPlaceholder}
            className="w-full bg-[#071A2E] border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-[#62A0EA] light:bg-white light:border-gray-200 light:text-gray-900 light:placeholder:text-gray-400 light:focus:border-[#1A5FB4] transition-colors resize-none"
          />
        </div>
      )}
    </div>
  );
}
