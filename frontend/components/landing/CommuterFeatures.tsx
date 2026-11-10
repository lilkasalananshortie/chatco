"use client";

import { useEffect, useRef, useState } from "react";
import Image, { type StaticImageData } from "next/image";
import gcashShot from "../../assets/landing-features/gcash.png";
import trackingShot from "../../assets/landing-features/tracking.png";
import fareShot from "../../assets/landing-features/fare.png";
import hailShot from "../../assets/landing-features/hail.png";
import shareShot from "../../assets/landing-features/share.png";
import rewardsShot from "../../assets/landing-features/rewards.png";

type Feature = {
  title: string;
  desc: string;
  shot: StaticImageData;
  alt: string;
};

// Screens are captured from the real commuter app, so each step shows the feature as riders see it.
const FEATURES: Feature[] = [
  {
    title: "GCash Cashless Payment",
    desc: "Scan the conductor's QR and pay your fare through GCash. No cash, no waiting for change.",
    shot: gcashShot,
    alt: "Commuter app confirming a successful GCash fare payment with its reference number",
  },
  {
    title: "Live GPS Tracking",
    desc: "See nearby jeepneys on the map when they're within 1km. Get a sound alert when one approaches.",
    shot: trackingShot,
    alt: "Commuter app map showing two jeepneys on the route, the nearest 397 m away with seats available",
  },
  {
    title: "Point-Area Fare Calculator",
    desc: "Fares based on 34 official CHATCO stop points — same rates whether you pay GCash or cash.",
    shot: fareShot,
    alt: "Commuter app fare calculator with Calumpit Crossing to BSU Xentromall selected and the fare shown",
  },
  {
    title: "Pick Me Up Signal",
    desc: "Waiting in the dark or rain? Press and hold to send an alert straight to the conductor.",
    shot: hailShot,
    alt: "Commuter app map with a hail sent to the nearest jeepney and a Cancel button to withdraw it",
  },
  {
    title: "Share My Ride",
    desc: "Generate a live tracking link for family and friends to ensure you arrive safely.",
    shot: shareShot,
    alt: "Commuter app share live location dialog with an active tracking link and countdown",
  },
  {
    title: "Ride & Earn Rewards",
    desc: "Earn a free ride after 10 paid rides. GCash payments through your account count automatically. For cash payments, sign in and scan the QR on your physical receipt to count the ride.",
    shot: rewardsShot,
    alt: "Commuter app rewards screen showing 7 of 10 rides and an available free ride voucher",
  },
];

function Phone({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative aspect-430/932 rounded-[2.25rem] bg-[#071A2E] p-2 shadow-2xl shadow-black/10 ${className}`}>
      <div className="relative h-full w-full overflow-hidden rounded-[1.75rem] bg-[#0B1120]">{children}</div>
    </div>
  );
}

export default function CommuterFeatures() {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);

  // The step crossing the middle of the viewport drives the pinned screen.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: "-50% 0px -50% 0px" }
    );
    stepRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <section id="features" className="relative isolate py-20 md:py-28 bg-[linear-gradient(180deg,#FFFFFF_0%,#F1F6FD_40%,#F4F8FE_75%,#FFFFFF_100%)]">
      {/* Faint brand-blue glows, the light-surface echo of the final CTA's backdrop. Radial gradients, not blur filters, so scrolling stays cheap. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        {/* Dot grid for texture, faded out toward the edges so it never reads as a hard pattern */}
        <div className="absolute inset-0 bg-[radial-gradient(rgba(26,95,180,0.16)_1.75px,transparent_2.25px)] bg-size-[26px_26px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_45%,#000_30%,transparent_100%)]" />
        <div className="absolute -top-56 -right-48 w-240 h-240 rounded-full bg-[radial-gradient(closest-side,rgba(26,95,180,0.14),transparent)]" />
        <div className="absolute top-1/3 -left-64 w-208 h-208 rounded-full bg-[radial-gradient(closest-side,rgba(98,160,234,0.16),transparent)]" />
        <div className="absolute -bottom-48 right-1/4 w-192 h-192 rounded-full bg-[radial-gradient(closest-side,rgba(26,95,180,0.10),transparent)]" />
      </div>

      <div className="max-w-7xl mx-auto px-5 md:px-8">
        <div className="grid lg:grid-cols-[1fr_22rem] gap-x-16 gap-y-4 items-end">
          <h2 className="font-sans font-bold text-3xl sm:text-4xl md:text-5xl tracking-tight text-gray-900 leading-[1.05]">
            Everything you need, <br />
            in one tap.
          </h2>
          <p className="text-lg text-gray-500 leading-relaxed">
            From hailing to payment to safety, every step of the ride is in the app. These are its real screens.
          </p>
        </div>

        {/* Desktop: the screen stays pinned while the features scroll past it */}
        <div className="hidden lg:grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-16 xl:gap-24">
          <div className="sticky top-16 h-[calc(100dvh-4rem)] flex flex-col items-center justify-center gap-5">
            <div className="relative">
              <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 -z-10 w-[200%] aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(26,95,180,0.18),transparent)]" />
              <Phone className="h-[min(76dvh,680px)]">
                {/* Screens sit side by side and slide left as the steps advance, like swiping through the app */}
                <div
                  className="flex h-full transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                  style={{ transform: `translateX(-${active * 100}%)` }}
                >
                  {FEATURES.map((f, i) => (
                    <div key={f.title} className="relative h-full w-full shrink-0" aria-hidden={active !== i}>
                      <Image src={f.shot} alt={f.alt} fill sizes="300px" placeholder="blur" className="object-cover object-top" />
                    </div>
                  ))}
                </div>
              </Phone>
            </div>
            <p className="text-xs text-gray-400" aria-live="polite">
              <span className="font-semibold text-gray-600 tabular-nums">{String(active + 1).padStart(2, "0")}</span>
              {" / "}
              {String(FEATURES.length).padStart(2, "0")} · {FEATURES[active].title}
            </p>
          </div>

          <ol className="border-l border-gray-200 py-[22dvh]">
            {FEATURES.map((f, i) => {
              const on = active === i;
              return (
                <li
                  key={f.title}
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                  data-index={i}
                  className="relative min-h-[50dvh] flex flex-col justify-center pl-10"
                >
                  <span
                    aria-hidden
                    className={`absolute -left-px top-1/2 h-24 -translate-y-1/2 w-0.5 bg-[#1A5FB4] transition-opacity duration-300 ${on ? "opacity-100" : "opacity-0"}`}
                  />
                  <div className={`transition-opacity duration-300 motion-reduce:transition-none ${on ? "opacity-100" : "opacity-35"}`}>
                    <span className={`text-sm font-semibold tabular-nums ${on ? "text-[#1A5FB4]" : "text-gray-400"}`}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="mt-3 font-sans font-bold text-3xl xl:text-4xl tracking-tight text-gray-900">{f.title}</h3>
                    <p className="mt-4 max-w-md text-base text-gray-500 leading-relaxed">{f.desc}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Mobile: each feature with its own screen */}
        <ol className="lg:hidden mt-12 space-y-16">
          {FEATURES.map((f, i) => (
            <li key={f.title}>
              <span className="text-sm font-semibold tabular-nums text-[#1A5FB4]">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="mt-2 font-sans font-bold text-2xl tracking-tight text-gray-900">{f.title}</h3>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">{f.desc}</p>
              <Phone className="mt-6 mx-auto w-full max-w-65">
                <Image src={f.shot} alt={f.alt} fill sizes="260px" placeholder="blur" className="object-cover object-top" />
              </Phone>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
