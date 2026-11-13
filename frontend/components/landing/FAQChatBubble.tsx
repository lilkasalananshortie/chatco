"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import {
  ArrowLeft,
  Bus,
  ChevronRight,
  CircleHelp,
  Gift,
  MessageCircleQuestion,
  QrCode,
  Route,
  RotateCcw,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import logo from "../../assets/logo-transparent.png";
import {
  faqCategories as fallbackCategories,
  FAQ_CATEGORIES,
  type FAQItem,
  type FAQCategory,
  type ApiFaqItem,
} from "@/lib/shared/data/faq-data";

// Category glyphs live here, not in the shared FAQ data: that data's `emoji`
// field is also read by the admin FAQ form, so the chat maps ids to icons itself.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  "getting-started": Route,
  payments: QrCode,
  riding: Bus,
  safety: ShieldCheck,
  rewards: Gift,
};

function CategoryIcon({ id, ...props }: { id: string; size?: number; strokeWidth?: number; className?: string }) {
  const Icon = CATEGORY_ICONS[id] ?? CircleHelp;
  return <Icon {...props} />;
}

const WELCOME =
  "Hi, I can answer common questions about riding, paying and staying safe. Pick a topic below.";

interface ChatMessage {
  id: number;
  type: "question" | "answer";
  text: string;
  category?: string;
}

export default function FAQChatBubble() {
  const [isOpen, setIsOpen] = useState(false);
  // Starts with the bundled fallback content, then swaps to the live DB-driven
  // FAQs once /api/faqs responds (so admin edits show up here).
  const [categories, setCategories] = useState<FAQCategory[]>(fallbackCategories);
  const [activeCategory, setActiveCategory] = useState<string>(
    fallbackCategories[0]?.id ?? ""
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showCategories, setShowCategories] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const categoryScrollRef = useRef<HTMLDivElement>(null);
  const msgIdRef = useRef(0);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const scrollLeft = useRef(0);

  // Auto-scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Mouse wheel → horizontal scroll on category tabs
  const handleCategoryWheel = useCallback((e: React.WheelEvent) => {
    const el = categoryScrollRef.current;
    if (!el) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY * 2;
  }, []);

  // Drag to scroll on category tabs
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    const el = categoryScrollRef.current;
    if (!el) return;
    isDragging.current = true;
    startX.current = e.pageX - el.offsetLeft;
    scrollLeft.current = el.scrollLeft;
  }, []);

  const handleDragMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const el = categoryScrollRef.current;
    if (!el) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    const walk = (x - startX.current) * 1.5;
    el.scrollLeft = scrollLeft.current - walk;
  }, []);

  const handleDragEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  // Load the live FAQ content from the DB (admin-managed). Groups the flat
  // list by category using the canonical FAQ_CATEGORIES metadata, keeping only
  // categories that actually have items. On any failure we keep the bundled
  // fallback content so the chat is never empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/faqs", { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const json = await res.json();
        const items: ApiFaqItem[] = json?.data ?? [];
        if (!items.length) return;

        const grouped: FAQCategory[] = FAQ_CATEGORIES.map((meta) => ({
          ...meta,
          items: items
            .filter((it) => it.category === meta.id)
            .sort((a, b) => a.display_order - b.display_order)
            .map((it) => ({ question: it.question, answer: it.answer })),
        })).filter((cat) => cat.items.length > 0);

        if (cancelled || grouped.length === 0) return;

        setCategories(grouped);
        setActiveCategory((prev) =>
          grouped.some((c) => c.id === prev) ? prev : grouped[0].id
        );
      } catch {
        // Keep the fallback content.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape closes the panel
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  // Welcome message on open
  useEffect(() => {
    if (isOpen && messages.length === 0) {
      const timer = setTimeout(() => {
        setMessages([{ id: msgIdRef.current++, type: "answer", text: WELCOME }]);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleQuestionClick = (item: FAQItem, categoryLabel: string) => {
    const qMsg: ChatMessage = {
      id: msgIdRef.current++,
      type: "question",
      text: item.question,
      category: categoryLabel,
    };
    const aMsg: ChatMessage = {
      id: msgIdRef.current++,
      type: "answer",
      text: item.answer,
    };

    setMessages((prev) => [...prev, qMsg]);
    setShowCategories(false);

    setTimeout(() => {
      setMessages((prev) => [...prev, aMsg]);
    }, 500);
  };

  const handleCategoryChange = (catId: string) => {
    setActiveCategory(catId);
    setShowCategories(true);
  };

  const handleClearChat = () => {
    setMessages([{ id: msgIdRef.current++, type: "answer", text: WELCOME }]);
    setShowCategories(true);
    setActiveCategory(categories[0]?.id ?? "");
  };

  const currentCategory = categories.find((c) => c.id === activeCategory);

  return (
    <>
      {/* Launcher */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-2xl bg-[#1A5FB4] text-white shadow-lg shadow-black/20 flex items-center justify-center transition-[background-color,transform] duration-200 hover:bg-[#164A8F] active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1A5FB4]"
        aria-label={isOpen ? "Close FAQ chat" : "Open FAQ chat"}
        aria-expanded={isOpen}
        aria-controls="faq-chat-panel"
      >
        {isOpen ? <X size={24} strokeWidth={2} /> : <MessageCircleQuestion size={26} strokeWidth={1.8} />}
      </button>

      {/* Chat panel */}
      <div
        id="faq-chat-panel"
        role="dialog"
        aria-label="E-CHATCO FAQ"
        inert={!isOpen}
        className={`fixed bottom-24 right-6 z-50 transition-all duration-300 ease-out origin-bottom-right ${
          isOpen ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-4 scale-95 pointer-events-none"
        }`}
        style={{ width: "400px", maxWidth: "calc(100vw - 3rem)" }}
      >
        <div
          className="bg-white rounded-2xl shadow-2xl shadow-[#071A2E]/25 border border-[#071A2E]/10 ring-1 ring-white/15 overflow-hidden flex flex-col"
          style={{ height: "580px", maxHeight: "calc(100vh - 8rem)" }}
        >
          {/* Header: the site's navy and the brand mark, not a generic help glyph */}
          <div className="bg-[#071A2E] px-5 py-4 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <Image src={logo} alt="" width={40} height={40} className="rounded-lg shrink-0" />
              <div className="min-w-0">
                <p className="font-sans font-bold text-lg leading-tight text-white">Ask E-CHATCO</p>
                <p className="text-xs text-white/55">Ready-made answers. Not a live agent.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleClearChat}
              aria-label="Clear chat"
              title="Clear chat"
              className="grid place-items-center w-9 h-9 rounded-lg text-white/60 hover:bg-white/10 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <RotateCcw size={16} />
            </button>
          </div>

          {/* Conversation */}
          <div className="flex-1 overflow-y-auto px-4 py-5 space-y-3" role="log" aria-live="polite">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.type === "question" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] px-4 py-2.5 text-sm leading-relaxed ${
                    msg.type === "question"
                      ? "bg-[#1A5FB4] text-white rounded-2xl rounded-br-sm"
                      : "bg-[#F0F7FF] border border-[#DAEEFF] text-gray-800 rounded-2xl rounded-bl-sm"
                  }`}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Topic and question tray */}
          <div className="shrink-0 border-t border-gray-100 bg-[#F8FAFC]">
            <div className="px-4 pt-3">
              <div
                ref={categoryScrollRef}
                onWheel={handleCategoryWheel}
                onMouseDown={handleDragStart}
                onMouseMove={handleDragMove}
                onMouseUp={handleDragEnd}
                onMouseLeave={handleDragEnd}
                role="tablist"
                aria-label="FAQ topics"
                className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide cursor-grab active:cursor-grabbing select-none"
                style={{ touchAction: "pan-x" }}
              >
                {categories.map((cat) => {
                  const on = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => handleCategoryChange(cat.id)}
                      className={`shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1A5FB4] ${
                        on
                          ? "bg-[#1A5FB4] border-[#1A5FB4] text-white"
                          : "bg-white border-gray-200 text-gray-600 hover:border-[#1A5FB4]/40 hover:text-[#1A5FB4]"
                      }`}
                    >
                      <CategoryIcon id={cat.id} size={14} strokeWidth={2} />
                      {cat.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {showCategories && currentCategory ? (
              <div className="px-4 pb-3 max-h-56 overflow-y-auto" style={{ touchAction: "pan-y" }}>
                <p className="flex items-center gap-1.5 py-2 text-xs font-semibold text-gray-500">
                  <CategoryIcon id={currentCategory.id} size={13} className="text-[#1A5FB4]" />
                  {currentCategory.label}
                </p>
                <ul className="divide-y divide-gray-200/70">
                  {currentCategory.items.map((item, idx) => (
                    <li key={idx}>
                      <button
                        type="button"
                        onClick={() => handleQuestionClick(item, currentCategory.label)}
                        className="group w-full flex items-center justify-between gap-3 py-2.5 text-left text-sm text-gray-700 hover:text-[#1A5FB4] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1A5FB4] rounded-md"
                      >
                        {item.question}
                        <ChevronRight size={16} className="shrink-0 text-gray-300 group-hover:text-[#1A5FB4] group-hover:translate-x-0.5 transition" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="px-4 pb-4 pt-1">
                <button
                  type="button"
                  onClick={() => setShowCategories(true)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-gray-200 bg-white text-sm font-semibold text-[#1A5FB4] hover:border-[#1A5FB4]/40 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1A5FB4]"
                >
                  <ArrowLeft size={15} />
                  More questions
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
