// components/landing/Navbar.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { Bus, Menu, X } from "lucide-react";
import logo from "../../assets/logo-transparent.png";

// In page order, so the active marker slides left to right as you read down.
const LINKS = [
  { label: "How It Works", id: "how-it-works" },
  { label: "Features", id: "features" },
  { label: "Why E-CHATCO", id: "platform" },
  { label: "Download", id: "download" },
  { label: "Contact", id: "contact" },
];

const MARKER = 18; // px, the jeepney marker's width

export default function Navbar({ onHomePage = true }: { onHomePage?: boolean }) {
  const navRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const reduce = useReducedMotion();

  // The ride line along the nav's bottom edge: the jeepney travels the page
  // the way it travels the route, so it doubles as the scroll-progress bar.
  const { scrollYProgress } = useScroll();
  const markerLeft = useTransform(scrollYProgress, (v) => `calc((100% - ${MARKER}px) * ${v})`);
  const fillWidth = useTransform(scrollYProgress, (v) => `calc((100% - ${MARKER}px) * ${v} + ${MARKER / 2}px)`);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const updatePosition = () => {
      const offset = window.matchMedia("(max-width: 1023px)").matches && viewport.scale === 1
        ? Math.max(0, viewport.offsetTop)
        : 0;
      navRef.current?.style.setProperty("top", `${offset}px`);
    };

    updatePosition();
    viewport.addEventListener("scroll", updatePosition, { passive: true });
    viewport.addEventListener("resize", updatePosition, { passive: true });
    window.addEventListener("resize", updatePosition, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", updatePosition);
      viewport.removeEventListener("resize", updatePosition);
      window.removeEventListener("resize", updatePosition);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    const getLinkedSections = () => {
      const anchors = navRef.current?.querySelectorAll<HTMLAnchorElement>('a[href^="#"]') ?? [];
      const ids = new Set(Array.from(anchors, (anchor) => anchor.hash.slice(1)).filter(Boolean));
      return Array.from(ids, (id) => document.getElementById(id))
        .filter((section): section is HTMLElement => section !== null);
    };
    const update = () => {
      raf = 0;
      setScrolled(window.scrollY > 40);
      // "Where you are" is the last linked section whose top has passed 40% of
      // the viewport. It stays lit through sections that have no nav link
      // (Rewards, Hailing), so the underline travels link to link instead of
      // vanishing and reappearing; it clears after the final section ends.
      const probe = window.innerHeight * 0.4;
      const sections = getLinkedSections();
      let passed = -1;
      sections.forEach((section, i) => {
        if (section.getBoundingClientRect().top <= probe) passed = i;
      });
      let current: string | null = passed >= 0 ? sections[passed].id : null;
      if (passed >= 0 && passed === sections.length - 1) {
        if (sections[passed].getBoundingClientRect().bottom <= probe) current = null;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    // Keep tracking the current links and sections, including streamed content.
    const layoutObserver = new ResizeObserver(onScroll);
    layoutObserver.observe(document.body);
    let observedSections = new Set<HTMLElement>();
    const syncSections = () => {
      const sections = new Set(getLinkedSections());
      observedSections.forEach((section) => {
        if (!sections.has(section)) layoutObserver.unobserve(section);
      });
      sections.forEach((section) => {
        if (!observedSections.has(section)) layoutObserver.observe(section);
      });
      observedSections = sections;
      onScroll();
    };
    const contentObserver = new MutationObserver(syncSections);
    contentObserver.observe(document.body, { childList: true, subtree: true });
    syncSections();
    const onRevealEnd = (event: TransitionEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && observedSections.has(target)) {
        onScroll();
      }
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    document.addEventListener("transitionend", onRevealEnd);
    return () => {
      layoutObserver.disconnect();
      contentObserver.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("transitionend", onRevealEnd);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    const onOutsideInteraction = (event: Event) => {
      if (event.target instanceof Node && !navRef.current?.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    const onScroll = () => setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["pointerdown", "wheel", "touchmove"] as const) {
      document.addEventListener(type, onOutsideInteraction, { capture: true, passive: true });
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
      for (const type of ["pointerdown", "wheel", "touchmove"] as const) {
        document.removeEventListener(type, onOutsideInteraction, true);
      }
    };
  }, [menuOpen]);

  const focus = "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#62A0EA]";

  return (
    <motion.nav
      ref={navRef}
      layoutRoot
      aria-label="Main"
      className={`fixed top-0 inset-x-0 z-50 pt-safe lg:pt-0 border-b transition-[background-color,border-color,box-shadow] duration-300 ease-out ${
        scrolled || menuOpen
          ? "bg-[#071A2E] border-white/10 shadow-lg shadow-black/20"
          : "bg-[#071A2E]/75 backdrop-blur-md border-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-5 md:px-8 flex items-center justify-between lg:grid lg:grid-cols-[auto_1fr_auto] xl:grid-cols-[1fr_auto_1fr] h-16">
        <a href={onHomePage ? "#" : "/"} className={`flex items-center gap-3 shrink-0 rounded-md ${focus}`} aria-label={onHomePage ? "E-CHATCO, back to top" : "E-CHATCO home"}>
          <Image src={logo} alt="" width={40} height={40} className="rounded-lg" priority />
          <span className="text-lg font-bold tracking-tight text-white">E-CHATCO</span>
        </a>

        <div className="hidden lg:flex items-center gap-1 lg:justify-self-center">
          {LINKS.map((l) => {
            const on = active === l.id;
            return (
              <a
                key={l.id}
                href={`${onHomePage ? "" : "/"}#${l.id}`}
                aria-current={on ? "location" : undefined}
                className={`relative px-2 xl:px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors rounded-md ${focus} ${
                  on ? "text-white" : "text-white/60 hover:text-white"
                }`}
              >
                {l.label}
                {on && (
                  <motion.span
                    layoutId="nav-active"
                    aria-hidden
                    initial={reduce ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-x-2 xl:inset-x-4 -bottom-0.5 h-0.5 rounded-full bg-[#62A0EA]"
                    transition={reduce ? { duration: 0 } : {
                      layout: { type: "spring", stiffness: 420, damping: 34 },
                      opacity: { duration: 0.2, ease: "easeOut" },
                    }}
                  />
                )}
              </a>
            );
          })}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 lg:justify-self-end">
          <Link
            href="/login"
            scroll={false}
            className={`hidden sm:inline-flex items-center whitespace-nowrap px-3 py-2 rounded-md text-sm font-medium text-white/70 hover:text-white hover:bg-white/5 transition-colors ${focus}`}
          >
            Log in
          </Link>
          <Link
            href="/signup" scroll={false}
            className={`hidden sm:inline-flex items-center whitespace-nowrap px-4 py-2 rounded-full text-sm font-semibold bg-[#1A5FB4] text-white hover:bg-[#164A8F] transition-colors ${focus}`}
          >
            Create Account
          </Link>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            className={`lg:hidden grid place-items-center w-10 h-10 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors ${focus}`}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
          >
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* Ride line: Calumpit at the left edge, Meycauayan at the right */}
      <div
        aria-hidden
        className={`absolute inset-x-0 bottom-0 h-px transition-opacity duration-300 ${scrolled ? "opacity-100" : "opacity-0"}`}
      >
        <motion.div className="absolute left-0 top-0 h-px bg-[#62A0EA]" style={{ width: fillWidth }} />
        <motion.span
          className="absolute -top-2 grid place-items-center rounded-md bg-[#62A0EA] text-[#071A2E] shadow-md shadow-black/30"
          style={{ left: markerLeft, width: MARKER, height: MARKER }}
        >
          <Bus size={11} strokeWidth={2.6} />
        </motion.span>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            id="mobile-nav"
            className="lg:hidden absolute inset-x-0 top-full overflow-hidden bg-[#071A2E] border-b border-white/10 shadow-2xl shadow-black/40"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <div className="px-5 pt-3 pb-6">
              <ul>
                {LINKS.map((l) => {
                  const on = active === l.id;
                  return (
                    <li key={l.id} className="border-b border-white/10 last:border-0">
                      <a
                        href={`${onHomePage ? "" : "/"}#${l.id}`}
                        onClick={() => setMenuOpen(false)}
                        aria-current={on ? "location" : undefined}
                        className={`flex items-center justify-between py-4 font-sans text-base sm:text-lg font-semibold tracking-tight transition-colors ${focus} ${
                          on ? "text-[#62A0EA]" : "text-white"
                        }`}
                      >
                        {l.label}
                        {on && <span className="text-xs font-sans font-medium text-white/50">You are here</span>}
                      </a>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-5 grid grid-cols-2 gap-3">
                <Link
                  href="/login"
                  scroll={false}
                  onClick={() => setMenuOpen(false)}
                  className={`text-center py-3.5 rounded-full border border-white/20 text-sm sm:text-base font-semibold text-white hover:bg-white/5 transition-colors ${focus}`}
                >
                  Log in
                </Link>
                <Link
                  href="/signup" scroll={false}
                  onClick={() => setMenuOpen(false)}
                  className={`text-center py-3.5 rounded-full bg-[#1A5FB4] text-sm sm:text-base font-bold text-white hover:bg-[#164A8F] transition-colors ${focus}`}
                >
                  Create Account
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
