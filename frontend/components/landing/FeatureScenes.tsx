"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Bell,
  Bus,
  Check,
  Gift,
  Megaphone,
  Share2,
  Search,
  TriangleAlert,
} from "lucide-react";
import { QR } from "./HowItWorks";

/**
 * Small live product scenes that fill the landing feature panels, so each
 * panel shows the feature doing its job instead of an icon on a tinted box.
 * Looping scenes only run while they are on screen and hold a still frame
 * under prefers-reduced-motion; the rest respond to a tap or a drag.
 */

export type Tone = "light" | "dark";

// Tone tokens as CSS variables so a scene is written once and reads on both
// the white features panel and the navy safety panel.
const TONES: Record<Tone, CSSProperties> = {
  light: {
    "--ink": "#111827",
    "--mute": "#6B7280",
    "--line": "#C9DDF5",
    "--fill": "#FFFFFF",
    "--brand": "#1A5FB4",
  } as CSSProperties,
  dark: {
    "--ink": "#FFFFFF",
    "--mute": "rgba(255,255,255,0.55)",
    "--line": "rgba(255,255,255,0.16)",
    "--fill": "rgba(255,255,255,0.07)",
    "--brand": "#62A0EA",
  } as CSSProperties,
};

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));

/**
 * Drives a looping 0..1 progress value, only while the scene is visible.
 * Reduced motion gets the fixed `still` frame instead of a running loop.
 */
function useLoop(ms: number, still: number, hold = 1400) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(still);

  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    let raf = 0;
    let t0 = 0;
    let live = false;
    const tick = (now: number) => {
      if (!t0) t0 = now;
      setT(Math.min(((now - t0) % (ms + hold)) / ms, 1));
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !live) {
        live = true;
        t0 = 0;
        raf = requestAnimationFrame(tick);
      } else if (!e.isIntersecting && live) {
        live = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ms, hold, reduce]);

  return { ref, t: reduce ? still : t };
}

function Frame({ tone, className = "", children }: { tone: Tone; className?: string; children: ReactNode }) {
  return (
    <div style={TONES[tone]} className={`relative w-full h-full flex items-center ${className}`}>
      {children}
    </div>
  );
}

/* ── Shared map ────────────────────────────────────────────────────── */

// Two cubic segments along the corridor; `routePoint` evaluates them
// directly so a marker always sits exactly on the drawn line.
const ROUTE = "M16 168 C 96 160, 118 70, 196 76 S 330 50, 384 18";
const SEGMENTS: [number, number][][] = [
  [[16, 168], [96, 160], [118, 70], [196, 76]],
  [[196, 76], [274, 82], [330, 50], [384, 18]],
];

function routePoint(p: number): { x: number; y: number } {
  const s = p < 0.5 ? 0 : 1;
  const u = clamp(s === 0 ? p * 2 : (p - 0.5) * 2);
  const [a, b, c, d] = SEGMENTS[s];
  const m = 1 - u;
  const f = (i: 0 | 1) =>
    m * m * m * a[i] + 3 * m * m * u * b[i] + 3 * m * u * u * c[i] + u * u * u * d[i];
  return { x: f(0), y: f(1) };
}

function MapBase({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 400 200" className="w-full h-auto" role="img" aria-hidden>
      <defs>
        <pattern id="scene-grid" width="25" height="25" patternUnits="userSpaceOnUse">
          <path d="M25 0H0V25" fill="none" stroke="var(--line)" strokeWidth="1" opacity="0.5" />
        </pattern>
      </defs>
      <rect width="400" height="200" fill="url(#scene-grid)" />
      <path d={ROUTE} fill="none" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round" opacity="0.25" />
      <path d={ROUTE} fill="none" stroke="var(--brand)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 7" />
      {children}
    </svg>
  );
}

function BusMarker({ x, y, fill = "#1A5FB4" }: { x: number; y: number; fill?: string }) {
  return (
    <g>
      <rect x={x - 12} y={y - 12} width="24" height="24" rx="7" fill={fill} />
      <Bus x={x - 7} y={y - 7} width={14} height={14} color="#fff" strokeWidth={2.5} />
    </g>
  );
}

/* ── 1. GCash payment ──────────────────────────────────────────────── */

export function GcashScene({ tone = "light" }: { tone?: Tone }) {
  const { ref, t } = useLoop(3600, 0.8);
  const scan = seg(t, 0.05, 0.55);
  const paid = t >= 0.6;

  return (
    // lg: the desktop panel is far larger than this pair, so scale it up and center it instead of leaving it top-left.
    <Frame tone={tone} className="gap-8 md:gap-12 lg:justify-center lg:gap-16">
      <div ref={ref} className="relative shrink-0 w-32 h-32 md:w-36 md:h-36 lg:w-56 lg:h-56 lg:p-4 rounded-2xl bg-white p-3 shadow-lg shadow-black/10 border border-(--line)">
        <div className="grid grid-cols-7 gap-0.75 w-full h-full">
          {QR.map((v, i) => (
            <span key={i} className={`rounded-[1px] ${v ? "bg-[#071A2E]" : "bg-gray-100"}`} />
          ))}
        </div>
        {!paid && (
          <span
            aria-hidden
            className="absolute inset-x-2 h-0.5 rounded-full bg-[#1A5FB4]"
            style={{ top: `${8 + scan * 84}%` }}
          />
        )}
      </div>

      <div className="min-w-0">
        <p className="text-sm lg:text-base text-(--mute)">Fare to pay</p>
        <p className="mt-1 font-sans text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-(--ink) tabular-nums">₱15.00</p>
        <div className="mt-4 lg:mt-5 h-6">
          <AnimatePresence mode="wait" initial={false}>
            {paid ? (
              <motion.p
                key="paid"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 text-sm font-semibold text-emerald-600"
              >
                <Check size={16} strokeWidth={3} /> Paid with GCash. Receipt sent.
              </motion.p>
            ) : (
              <motion.p key="scan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-sm text-(--mute)">
                Conductor is scanning your QR
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Frame>
  );
}

/* ── 2. Live GPS ───────────────────────────────────────────────────── */

const RING_R = 64; // svg units that stand for 1 km around the commuter
const YOU = routePoint(0.5);

export function TrackingScene({ tone = "light" }: { tone?: Tone }) {
  const { ref, t } = useLoop(7000, 0.7);
  const jeep = routePoint(t * 0.5);
  const meters = Math.max(0, Math.round(((1 - t) * 3600) / 10) * 10);
  const near = meters <= 1000;

  return (
    <Frame tone={tone} className="gap-6 md:gap-10 flex-col md:flex-row">
      <div ref={ref} className="w-full md:flex-1 min-w-0">
        <MapBase>
          <circle cx={YOU.x} cy={YOU.y} r={RING_R} fill={near ? "var(--brand)" : "none"} fillOpacity="0.08" stroke="var(--brand)" strokeWidth="1.5" strokeDasharray="4 5" opacity={near ? 1 : 0.5} />
          <circle cx={YOU.x} cy={YOU.y} r="6" fill="#fff" stroke="var(--brand)" strokeWidth="3" />
          <BusMarker x={jeep.x} y={jeep.y} fill={near ? "#16A34A" : "#1A5FB4"} />
        </MapBase>
      </div>
      <div className="md:w-44 shrink-0 self-start md:self-center">
        <p className="text-sm text-(--mute)">Nearest jeepney</p>
        <p className="mt-1 font-sans text-4xl font-bold tracking-tight text-(--ink) tabular-nums">
          {meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`}
        </p>
        <p className={`mt-2 flex items-center gap-1.5 text-sm font-semibold ${near ? "text-emerald-600" : "text-(--mute)"}`}>
          {near ? (<><Bell size={14} /> Approaching, alert sounds</>) : "Out of range"}
        </p>
      </div>
    </Frame>
  );
}

/* ── 3. Point-area fare calculator (drag) ──────────────────────────── */

// The McArthur Highway corridor, Calumpit to the Meycauayan end.
const STOPS = [
  "Calumpit Poblacion", "Gatbuca", "San Miguel", "Paliwas", "Pulilan Poblacion", "Dampol", "Taal", "Abangan Norte",
  "Plaridel Poblacion", "Agnaya", "Banga 1st", "Banga 2nd", "Bustos Poblacion", "Bonga Mayor", "Tibagan",
  "Baliuag Poblacion", "Sabang", "Tangos", "Tinig", "Catulinan", "Pinaod", "Sta. Barbara", "Malamig", "Bagbaguin",
  "Mahangin", "Pulong Buhangin", "Meycauayan Poblacion", "Bahay Pari", "Bancal", "Caingin", "Calvario", "Lawa", "Banga",
];
const LAST = STOPS.length - 1;
const ANCHORS: [number, string][] = [[0, "Calumpit"], [4, "Pulilan"], [8, "Plaridel"], [12, "Bustos"], [15, "Baliuag"], [26, "Meycauayan"]];

// Same rule the fare service applies: the gap between the two stops' fares,
// never below the base fare. Sample rates, seeded from the pilot fare matrix.
function stopFare(i: number, discounted: boolean) {
  const n = i + 1;
  const base = discounted ? 13.6 : 17;
  return n <= 4 ? base : base + (n - 4) * (discounted ? 1.8 : 2.25);
}
function fareBetween(a: number, b: number, discounted: boolean) {
  return Math.max(Math.abs(stopFare(a, discounted) - stopFare(b, discounted)), discounted ? 13.6 : 17);
}

export function FareScene({ tone = "light" }: { tone?: Tone }) {
  const [on, setOn] = useState(0);
  const [off, setOff] = useState(26);
  const [discounted, setDiscounted] = useState(false);
  const fare = fareBetween(on, off, discounted).toFixed(2);
  const lo = Math.min(on, off);
  const hi = Math.max(on, off);
  const pct = (i: number) => (i / LAST) * 100;

  return (
    <Frame tone={tone} className="flex-col justify-center gap-6">
      <div className="w-full flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 sm:gap-6">
        <div className="min-w-0 grid grid-cols-2 gap-x-6 sm:gap-x-8 gap-y-1">
          <p className="text-xs text-(--mute)">Getting on</p>
          <p className="text-xs text-(--mute)">Getting off</p>
          <p className="text-base font-semibold text-(--ink) leading-snug">{STOPS[on]}</p>
          <p className="text-base font-semibold text-(--ink) leading-snug">{STOPS[off]}</p>
        </div>
        <div className="sm:text-right shrink-0">
          <div className="flex sm:justify-end gap-1 mb-1" role="group" aria-label="Fare type">
            {[false, true].map((d) => (
              <button
                key={String(d)}
                type="button"
                aria-pressed={discounted === d}
                onClick={() => setDiscounted(d)}
                className={`rounded-md px-2 py-1 text-xs font-semibold transition-colors ${
                  discounted === d ? "bg-(--brand) text-white" : "text-(--mute) hover:text-(--ink)"
                }`}
              >
                {d ? "Discounted" : "Regular"}
              </button>
            ))}
          </div>
          <motion.p
            key={fare}
            initial={{ opacity: 0.4, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="font-sans text-5xl md:text-6xl font-bold tracking-tight text-(--ink) tabular-nums leading-none"
          >
            ₱{fare}
          </motion.p>
        </div>
      </div>

      {/* Dual-thumb track: two native range inputs share one visual track, so
          keyboard, touch and screen readers all work without custom drag code. */}
      <div className="w-full">
        <div className="dual relative h-10">
          <div className="absolute inset-x-2.75 top-1/2 -translate-y-1/2 h-1 rounded-full bg-(--line)">
            <span className="absolute inset-y-0 rounded-full bg-(--brand)" style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }} />
            {STOPS.map((_, i) => (
              <span
                key={i}
                className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full ${i >= lo && i <= hi ? "bg-white" : "bg-(--mute)/40"}`}
                style={{ left: `${pct(i)}%` }}
              />
            ))}
          </div>
          <input type="range" min={0} max={LAST} value={on} onChange={(e) => setOn(+e.target.value)} aria-label="Stop where you get on" aria-valuetext={STOPS[on]} />
          <input type="range" min={0} max={LAST} value={off} onChange={(e) => setOff(+e.target.value)} aria-label="Stop where you get off" aria-valuetext={STOPS[off]} />
        </div>
        <div className="relative mx-2.75 h-4 hidden sm:block">
          {ANCHORS.map(([i, label]) => (
            <span key={label} className="absolute -translate-x-1/2 text-xs text-(--mute) whitespace-nowrap" style={{ left: `${pct(i)}%` }}>
              {label}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-(--mute)">Drag either end along the route. Sample rates.</p>
      </div>

      <style jsx>{`
        .dual input {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          margin: 0;
          background: transparent;
          appearance: none;
          pointer-events: none;
        }
        .dual input::-webkit-slider-thumb {
          appearance: none;
          pointer-events: auto;
          width: 22px;
          height: 22px;
          border-radius: 9999px;
          background: #fff;
          border: 4px solid var(--brand);
          box-shadow: 0 2px 8px rgba(7, 26, 46, 0.25);
          cursor: grab;
        }
        .dual input::-moz-range-thumb {
          pointer-events: auto;
          width: 14px;
          height: 14px;
          border-radius: 9999px;
          background: #fff;
          border: 4px solid var(--brand);
          box-shadow: 0 2px 8px rgba(7, 26, 46, 0.25);
          cursor: grab;
        }
        .dual input:active::-webkit-slider-thumb {
          cursor: grabbing;
        }
        .dual input:focus-visible::-webkit-slider-thumb {
          outline: 2px solid var(--brand);
          outline-offset: 3px;
        }
        .dual input:focus-visible::-moz-range-thumb {
          outline: 2px solid var(--brand);
          outline-offset: 3px;
        }
      `}</style>
    </Frame>
  );
}

/* ── 4. Pick Me Up (tap) ───────────────────────────────────────────── */

export function HailScene({ tone = "light" }: { tone?: Tone }) {
  const [sent, setSent] = useState(false);
  const reduce = useReducedMotion();
  const steps = ["Your location is sent", "The conductor is alerted", "A CHATCO unit heads your way"];

  return (
    <Frame tone={tone} className="gap-8 md:gap-12">
      <div className="relative shrink-0 w-36 h-36 grid place-items-center">
        {sent && !reduce &&
          [0, 0.25].map((d) => (
            <motion.span
              key={d}
              className="absolute inset-0 rounded-full border-2 border-[#FF6D3A]"
              initial={{ scale: 0.7, opacity: 0.6 }}
              animate={{ scale: 1.5, opacity: 0 }}
              transition={{ duration: 1.1, delay: d, ease: "easeOut" }}
            />
          ))}
        <button
          type="button"
          onClick={() => setSent((s) => !s)}
          aria-pressed={sent}
          className={`relative w-28 h-28 rounded-full flex flex-col items-center justify-center gap-1 text-white text-sm font-bold shadow-xl transition-colors duration-300 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#FF6D3A] ${
            sent ? "bg-emerald-500 shadow-black/20" : "bg-[#FF6D3A] hover:bg-[#E55A2B] shadow-black/20"
          }`}
        >
          {sent ? <Check size={26} strokeWidth={3} /> : <Megaphone size={26} />}
          {sent ? "Sent" : "Pick Me Up"}
        </button>
      </div>

      <div className="min-w-0">
        {sent ? (
          <ul className="space-y-2.5">
            {steps.map((s, i) => (
              <motion.li
                key={s}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: reduce ? 0 : 0.25 + i * 0.4 }}
                className="flex items-center gap-2 text-sm font-medium text-(--ink)"
              >
                <Check size={15} strokeWidth={3} className="text-emerald-600 shrink-0" /> {s}
              </motion.li>
            ))}
          </ul>
        ) : (
          <>
            <p className="font-sans text-2xl md:text-3xl font-bold tracking-tight text-(--ink)">Waiting in the dark or rain?</p>
            <p className="mt-2 text-sm text-(--mute)">Tap the button to try it.</p>
          </>
        )}
      </div>
    </Frame>
  );
}

/* ── 6. Share my ride ──────────────────────────────────────────────── */

export function ShareScene({ tone = "light" }: { tone?: Tone }) {
  const { ref, t } = useLoop(9000, 0.6);
  const p = routePoint(t);
  return (
    <Frame tone={tone} className="gap-6 md:gap-10 flex-col md:flex-row">
      <div ref={ref} className="w-full md:flex-1 min-w-0">
        <MapBase>
          <circle cx={p.x} cy={p.y} r="16" fill="var(--brand)" opacity="0.16" />
          <circle cx={p.x} cy={p.y} r="7" fill="var(--brand)" stroke="#fff" strokeWidth="3" />
        </MapBase>
      </div>
      <div className="hidden md:block md:w-52 shrink-0 self-center">
        <span className="grid place-items-center w-10 h-10 rounded-xl bg-(--fill) border border-(--line) text-(--brand)">
          <Share2 size={18} />
        </span>
        <p className="mt-3 text-base font-semibold text-(--ink)">Family sees your ride live</p>
        <p className="mt-1 text-sm text-(--mute)">One link. It stops when your ride does.</p>
      </div>
    </Frame>
  );
}

/* ── 7. Rewards ────────────────────────────────────────────────────── */

export function RewardsScene({ tone = "light" }: { tone?: Tone }) {
  const { ref, t } = useLoop(4400, 1);
  const rides = Math.round(seg(t, 0.05, 0.85) * 10);
  return (
    <Frame tone={tone} className="justify-center">
      <div ref={ref} className="w-full max-w-lg">
        <div className="flex items-baseline justify-between">
          <p className="font-sans text-5xl md:text-6xl font-bold tracking-tight text-(--ink) tabular-nums leading-none">
            {rides}
            <span className="text-2xl text-(--mute)"> / 10 rides</span>
          </p>
          <p className={`flex items-center gap-1.5 text-sm font-semibold transition-opacity duration-300 ${rides === 10 ? "text-emerald-600 opacity-100" : "opacity-0"}`}>
            <Gift size={15} /> Free ride unlocked
          </p>
        </div>
        <div className="mt-6 grid grid-cols-10 gap-2">
          {Array.from({ length: 10 }).map((_, i) => (
            <span
              key={i}
              className={`aspect-square rounded-full transition-all duration-300 ${i < rides ? "bg-(--brand) scale-100" : "border-2 border-dashed border-(--line) scale-90"}`}
            />
          ))}
        </div>
        <p className="mt-5 text-sm leading-relaxed text-(--mute)">
          GCash rides count automatically. Paid in cash? Scan your receipt QR from your account.
        </p>
      </div>
    </Frame>
  );
}

/* ── 8. Lost & Found ───────────────────────────────────────────────── */

const LF_STEPS = [
  { title: "You report it", sub: "Item and trip details" },
  { title: "The conductor logs a find", sub: "Logged separately, on board" },
  { title: "Admin matches both", sub: "Verified, then returned to you" },
];

export function LostFoundScene({ tone = "dark" }: { tone?: Tone }) {
  const { ref, t } = useLoop(5400, 1);
  const reached = t < 0.1 ? 0 : t < 0.4 ? 1 : t < 0.7 ? 2 : 3;
  return (
    <Frame tone={tone} className="gap-6">
      <div ref={ref} className="relative w-full max-w-md">
        <span aria-hidden className="absolute left-4.75 top-5 bottom-5 w-0.5 bg-(--line)" />
        <span
          aria-hidden
          className="absolute left-4.75 top-5 w-0.5 bg-(--brand) transition-[height] duration-700"
          style={{ height: `calc((100% - 2.5rem) * ${Math.max(0, reached - 1) / 2})` }}
        />
        <ul className="relative space-y-5">
          {LF_STEPS.map((s, i) => {
            const done = i < reached;
            return (
              <li key={s.title} className="flex items-center gap-4">
                <span
                  className={`grid place-items-center w-10 h-10 rounded-full shrink-0 border-2 transition-colors duration-500 ${
                    done ? "bg-(--brand) border-(--brand) text-[#071A2E]" : "bg-transparent border-(--line) text-(--mute)"
                  }`}
                >
                  {done ? <Check size={16} strokeWidth={3} /> : <Search size={15} />}
                </span>
                <div className={`transition-opacity duration-500 ${done ? "opacity-100" : "opacity-45"}`}>
                  <p className="text-sm font-semibold text-(--ink)">{s.title}</p>
                  <p className="text-xs text-(--mute)">{s.sub}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Frame>
  );
}

/* ── 9. Emergency SOS (double-tap, like the real app) ──────────────── */

export function SosScene({ tone = "dark" }: { tone?: Tone }) {
  const [phase, setPhase] = useState<"idle" | "armed" | "sent">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = (next: typeof phase, ms?: number) => {
    if (timer.current) clearTimeout(timer.current);
    setPhase(next);
    if (ms) timer.current = setTimeout(() => setPhase("idle"), ms);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const press = () => {
    if (phase === "idle") arm("armed", 1600);
    else if (phase === "armed") arm("sent", 5000);
  };

  const sentItems = ["Your location", "Vehicle and unit details", "Sent straight to the admin"];

  return (
    <Frame tone={tone} className="gap-8 md:gap-12">
      <button
        type="button"
        onClick={press}
        aria-label={phase === "armed" ? "Tap again to send SOS" : "Send SOS"}
        className={`shrink-0 w-28 h-28 rounded-full grid place-items-center text-white transition-all duration-300 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${
          phase === "sent" ? "bg-emerald-500 shadow-xl shadow-black/20" : "bg-[#EF4444] shadow-xl shadow-black/20"
        } ${phase === "armed" ? "ring-4 ring-white/70 ring-offset-4 ring-offset-transparent" : ""}`}
      >
        {phase === "sent" ? <Check size={40} strokeWidth={3} /> : <TriangleAlert size={40} />}
      </button>

      <div className="min-w-0 min-h-24 flex flex-col justify-center">
        {phase === "sent" ? (
          <ul className="space-y-2.5">
            {sentItems.map((s, i) => (
              <motion.li key={s} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.25 }} className="flex items-center gap-2 text-sm font-medium text-(--ink)">
                <Check size={15} strokeWidth={3} className="text-emerald-400 shrink-0" /> {s}
              </motion.li>
            ))}
          </ul>
        ) : (
          <>
            <p className="font-sans text-2xl md:text-3xl font-bold tracking-tight text-(--ink)">
              {phase === "armed" ? "Tap again to send" : "Tap twice to send"}
            </p>
            <p className="mt-2 text-sm text-(--mute)">
              {phase === "armed" ? "Sending needs a second tap, so it never fires by accident." : "Try it. This demo sends nothing."}
            </p>
          </>
        )}
      </div>
    </Frame>
  );
}
