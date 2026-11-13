import { Bus } from "lucide-react";
import Section from "@/components/ui/Section";

const STOP_COUNT = 34; // official stop points on the route (route-coords.ts)

// Stepped down like stops along the route, so the story reads as a journey.
const CHAPTERS = [
  {
    title: "The route today",
    body: "Fares are paid in cash, rides are flagged down by hand, and commuters wait at the roadside without knowing when the next jeepney will come. It has carried the route for years, and it still does.",
    step: "",
  },
  {
    title: "What has changed",
    body: "More of daily life now runs through the phone. Commuters expect to pay without hunting for exact change, to know where their ride is, and to feel safe getting home.",
    step: "lg:mt-12",
  },
  {
    title: "What E-CHATCO adds",
    body: "Pay your fare by QR or GCash. See the units on the map and how soon one reaches you. Share your ride with someone who worries, and reach help in one tap. The people who run the route get clearer fare records and less paperwork, too.",
    step: "lg:mt-24",
  },
];

export default function About() {
  return (
    <Section id="about">
      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#1A5FB4]">About E-CHATCO</p>
      <h2 className="mt-5 max-w-4xl font-sans font-bold text-3xl sm:text-4xl md:text-5xl tracking-tight leading-[1.1]">
        The jeepney you know,
        <br />
        made easier to ride.
      </h2>

      {/* The route: Calumpit to Meycauayan, one tick per official stop point */}
      <div className="mt-16 md:mt-20" role="img" aria-label={`The Calumpit to Meycauayan route with ${STOP_COUNT} official stop points`}>
        <div className="relative h-8">
          <div className="absolute inset-x-0 top-1/2 h-px bg-gray-200" />
          <div className="absolute left-0 top-1/2 h-0.5 w-[58%] -translate-y-1/2 bg-[#1A5FB4]" />
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center justify-between">
            {Array.from({ length: STOP_COUNT }, (_, i) => {
              const end = i === 0 || i === STOP_COUNT - 1;
              return (
                <span
                  key={i}
                  className={end ? "w-3 h-3 rounded-full bg-[#1A5FB4] ring-4 ring-white" : "w-px h-2.5 bg-gray-300"}
                />
              );
            })}
          </div>
          <span className="absolute left-[58%] top-1/2 -translate-x-1/2 -translate-y-1/2 grid place-items-center w-8 h-8 rounded-lg bg-[#1A5FB4] text-white ring-4 ring-white">
            <Bus size={16} strokeWidth={2.4} />
          </span>
        </div>
        <div className="mt-4 flex justify-between sm:grid sm:grid-cols-[1fr_auto_1fr] items-center text-xs font-semibold uppercase tracking-[0.2em] text-gray-500">
          <span>Calumpit</span>
          <span className="hidden sm:inline text-gray-400">{STOP_COUNT} official stop points</span>
          <span className="sm:justify-self-end">Meycauayan</span>
        </div>
      </div>

      <div className="mt-16 md:mt-20 grid lg:grid-cols-3 gap-x-12 gap-y-12">
        {CHAPTERS.map((c, i) => (
          <div key={c.title} className={`border-t border-gray-200 pt-6 ${c.step}`}>
            <span className="font-sans font-bold text-4xl text-[#1A5FB4] leading-none">0{i + 1}</span>
            <h3 className="mt-5 text-lg font-semibold text-gray-900">{c.title}</h3>
            <p className="mt-3 text-gray-600 leading-relaxed">{c.body}</p>
          </div>
        ))}
      </div>

      <p className="mt-20 md:mt-28 max-w-4xl text-balance font-sans font-semibold text-2xl md:text-4xl tracking-tight leading-[1.2] text-gray-900">
        Going cashless doesn&apos;t replace the jeepney. It makes the ride{" "}
        <span className="text-[#1A5FB4]">better for everyone aboard</span>, a little more with each passing year.
      </p>
    </Section>
  );
}
