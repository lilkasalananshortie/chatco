import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, FileText, ShieldCheck } from "lucide-react";
import logo from "../../assets/logo-transparent.png";
import Footer from "./Footer";
import { POLICY_EFFECTIVE_DATE } from "@/lib/legal/registration-policies";

export interface LegalSection {
  id: string;
  title: string;
  paragraphs: string[];
}

export default function LegalPage({ kind, description, sections }: {
  kind: "privacy" | "terms";
  description: string;
  sections: LegalSection[];
}) {
  const title = kind === "privacy" ? "Privacy Policy" : "Terms of Service";
  const Icon = kind === "privacy" ? ShieldCheck : FileText;
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#62A0EA]";

  return (
    <div className="min-h-screen bg-[#F0F7FF] font-sans text-gray-900">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#071A2E]/95 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between gap-4 px-5 md:px-8">
          <Link href="/" aria-label="E-CHATCO home" className={`flex items-center gap-3 rounded-md ${focus}`}>
            <Image src={logo} alt="" width={40} height={40} />
            <span className="text-lg font-bold tracking-tight text-white">E-CHATCO</span>
          </Link>
          <Link href="/" className={`inline-flex items-center gap-2 rounded-md text-sm font-medium text-white/70 transition-colors hover:text-white ${focus}`}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to home
          </Link>
        </div>
      </header>

      <main>
        <div className="bg-[#071A2E] text-white">
          <div className="mx-auto max-w-7xl px-5 pb-14 pt-14 md:px-8 md:pb-20 md:pt-20">
            <span className="mb-6 grid h-16 w-16 place-items-center rounded-full border border-[#1C3350] bg-[#0E2440] text-white">
              <Icon size={32} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#62A0EA]">Riding with E-CHATCO</p>
            <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight sm:text-4xl md:text-5xl">{title}</h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/60 md:text-lg">{description}</p>
            <p className="mt-4 text-sm text-white/60">Effective date: {POLICY_EFFECTIVE_DATE}</p>
            <nav aria-label="Policies" className="mt-8 flex flex-wrap gap-3">
              {[
                { label: "Privacy Policy", href: "/privacy-policy", active: kind === "privacy" },
                { label: "Terms of Service", href: "/terms-of-service", active: kind === "terms" },
              ].map((policy) => (
                <Link key={policy.href} href={policy.href} aria-current={policy.active ? "page" : undefined}
                  className={`rounded-full border px-4 py-2.5 text-sm font-semibold transition-colors ${focus} ${policy.active
                    ? "border-[#1A5FB4] bg-[#1A5FB4] text-white"
                    : "border-white/15 text-white/70 hover:border-white/30 hover:text-white"}`}>
                  {policy.label}
                </Link>
              ))}
            </nav>
          </div>
        </div>

        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-12 md:px-8 md:py-16 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16">
          <aside className="min-w-0">
            <nav aria-label="On this page" className="lg:sticky lg:top-28">
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.1em] text-[#1A5FB4]">On this page</p>
              <ol className="flex flex-wrap gap-2 lg:block lg:space-y-1">
                {sections.map((section, i) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`} className={`inline-flex items-center gap-2 rounded-lg border border-[#DAEEFF] bg-white px-3 py-2 text-sm text-gray-600 transition-colors hover:text-[#1A5FB4] lg:flex lg:border-transparent lg:bg-transparent ${focus}`}>
                      <span className="text-xs font-semibold text-[#1A5FB4]/60">{String(i + 1).padStart(2, "0")}</span>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </aside>

          <article aria-label={title} className="min-w-0 rounded-3xl border border-[#DAEEFF] bg-white p-6 shadow-xl shadow-black/5 md:p-10">
            {sections.map((section, i) => (
              <section key={section.id} id={section.id} className="scroll-mt-28 border-b border-[#DAEEFF] py-7 first:pt-0 last:border-0 last:pb-0">
                <div className="flex items-baseline gap-3">
                  <span aria-hidden="true" className="text-sm font-bold text-[#1A5FB4]">{String(i + 1).padStart(2, "0")}</span>
                  <h2 className="text-lg font-semibold tracking-tight md:text-xl">{section.title}</h2>
                </div>
                <div className="mt-4 space-y-3 text-sm leading-7 text-gray-600 md:text-base">
                  {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                </div>
              </section>
            ))}
            <div className="mt-8 rounded-2xl bg-[#F0F7FF] p-5">
              <p className="font-semibold text-[#071A2E]">Have a question?</p>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">Contact CHATCO for help with your account, rides, or these policies.</p>
              <a href="mailto:eric.chatco@gmail.com" className={`mt-3 inline-flex items-center gap-1.5 break-all rounded-sm text-sm font-semibold text-[#1A5FB4] hover:text-[#164A8F] ${focus}`}>
                eric.chatco@gmail.com <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            </div>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}
