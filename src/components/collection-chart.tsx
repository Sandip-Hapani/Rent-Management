"use client";

import { useEffect, useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { eur, formatPeriod } from "@/lib/format";
import { StatusBadge, cx } from "./ui";
import { ResponsiveTable } from "./responsive-table";

export interface SeriesPoint {
  period: string;
  expected: number;
  confirmed: number;
  pending: number;
  outstanding: number;
  byMember: { membershipId: string; displayName: string; due: number; confirmed: number; pending: number; outstanding: number; status: string }[];
}

const COLORS = { expected: "#d6d3d1", confirmed: "#0f766e", pending: "#f59e0b", outstanding: "#b91c1c" };

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: SeriesPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const rate = p.expected > 0 ? Math.round((p.confirmed / p.expected) * 100) : null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-semibold">{formatPeriod(p.period)}</p>
      <table className="num">
        <tbody>
          {([["Expected", p.expected, COLORS.expected], ["Confirmed", p.confirmed, COLORS.confirmed], ["Pending verification", p.pending, COLORS.pending], ["Outstanding", p.outstanding, COLORS.outstanding]] as const).map(([l, v, c]) => (
            <tr key={l}>
              <td className="pr-3"><span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: c }} />{l}</td>
              <td className="text-right font-medium">{eur(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rate !== null && <p className="mt-1 text-muted">{rate}% collected</p>}
    </div>
  );
}

const RESIDENT_COLORS = ["#0f766e", "#2563eb", "#9333ea", "#db2777", "#ea580c", "#65a30d", "#0891b2", "#4b5563"];
const VIEW_KEY = "rent.chartView";

interface Slice {
  name: string;
  value: number;
  color: string;
}

/**
 * Donut with a centred headline and a legend beside it. Hovering a slice (or a legend row)
 * highlights that row and dims the other slices; nothing is drawn over the centre text.
 */
function Donut({ title, slices, center, centerHint, empty }: { title: string; slices: Slice[]; center: string; centerHint: string; empty: string }) {
  const [active, setActive] = useState<string | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const visible = slices.filter((s) => s.value > 0);
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-medium">{title}</figcaption>
      {total <= 0 ? (
        <p className="flex h-40 items-center justify-center text-sm text-muted">{empty}</p>
      ) : (
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
          <div className="relative h-52 w-52 shrink-0" role="img" aria-label={`${title}: ${visible.map((s) => `${s.name} ${eur(s.value)}`).join(", ")}`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={visible}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={62}
                  outerRadius={92}
                  paddingAngle={visible.length > 1 ? 2 : 0}
                  stroke="none"
                  isAnimationActive={false}
                  onMouseEnter={(_, i) => setActive(visible[i]?.name ?? null)}
                  onMouseLeave={() => setActive(null)}
                >
                  {visible.map((s) => <Cell key={s.name} fill={s.color} fillOpacity={active && active !== s.name ? 0.3 : 1} cursor="pointer" />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="num text-xl font-semibold">{center}</span>
              <span className="text-xs text-muted">{centerHint}</span>
            </div>
          </div>
          <div className="w-full max-w-sm min-w-0">
            <ul className="space-y-0.5 text-sm">
              {slices.map((s) => (
                <li
                  key={s.name}
                  onMouseEnter={() => s.value > 0 && setActive(s.name)}
                  onMouseLeave={() => setActive(null)}
                  className={cx("flex items-center gap-2 rounded-md px-2 py-1 whitespace-nowrap", active === s.name && "bg-accent-soft")}
                >
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="num font-medium">{eur(s.value)}</span>
                  <span className="num w-10 text-right text-xs text-muted">{pct(s.value)}%</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </figure>
  );
}

export function CollectionChart({ series, rejectedCount, showMembers }: { series: SeriesPoint[]; rejectedCount: number; showMembers: boolean }) {
  const [selected, setSelected] = useState<string>(series.at(-1)?.period ?? "");
  const [view, setView] = useState<"bar" | "pie">("bar");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(VIEW_KEY);
      if (v === "pie" || v === "bar") setView(v);
    } catch {
      /* storage unavailable: keep the default */
    }
  }, []);
  const choose = (v: "bar" | "pie") => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const sel = series.find((s) => s.period === selected);
  // The line shows money still owed; credits (negative outstanding) are listed in the table instead.
  const chartData = series.map((s) => ({ ...s, owed: Math.max(0, s.outstanding) }));
  const hasData = series.some((s) => s.expected > 0 || s.confirmed > 0 || s.pending > 0);

  if (!hasData) {
    return <p className="px-5 py-12 text-center text-sm text-muted">No finalised obligations in this range yet. Once the administrator finalises a month, collection appears here.</p>;
  }

  // Pie slices partition the month: confirmed + pending verification + still open = expected.
  const pendingPart = sel ? Math.min(sel.pending, Math.max(0, sel.outstanding)) : 0;
  const openPart = sel ? Math.max(0, sel.outstanding - pendingPart) : 0;
  const collectedPct = sel && sel.expected > 0 ? Math.round((sel.confirmed / sel.expected) * 100) : 0;
  const owing = sel ? sel.byMember.filter((m) => m.outstanding > 0) : [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="Chart type">
          {(["bar", "pie"] as const).map((v) => (
            <button key={v} type="button" onClick={() => choose(v)} aria-pressed={view === v} className={cx("rounded-md px-3 py-1 text-xs whitespace-nowrap", view === v ? "bg-accent text-white" : "text-muted hover:bg-canvas")}>
              {v === "bar" ? "Bars · by month" : "Pie · one month"}
            </button>
          ))}
        </div>
        {view === "pie" && sel && <span className="text-sm whitespace-nowrap text-muted">{formatPeriod(sel.period)} · {eur(sel.expected)} expected</span>}
      </div>

      {view === "bar" ? (
        <div className="h-72 px-2 pt-2 sm:px-4" role="img" aria-label="Bar chart comparing expected and confirmed collection per month. Details are in the table below.">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 0 }} onClick={(e) => { const p = (e as { activeLabel?: string } | null)?.activeLabel; if (p) setSelected(String(p)); }}>
              <CartesianGrid vertical={false} stroke="#ecebe8" />
              <XAxis dataKey="period" tickFormatter={(p: string) => formatPeriod(p, "short")} tick={{ fontSize: 11, fill: "#6b6560" }} tickLine={false} axisLine={false} />
              <YAxis domain={[0, "auto"]} tickFormatter={(v: number) => `${Math.round(v / 100)} €`} tick={{ fontSize: 11, fill: "#6b6560" }} tickLine={false} axisLine={false} width={60} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(15,118,110,0.06)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
              <Bar dataKey="expected" name="Expected" stackId="expected" fill={COLORS.expected} radius={[4, 4, 0, 0]} maxBarSize={28} cursor="pointer" />
              <Bar dataKey="confirmed" name="Confirmed" stackId="actual" fill={COLORS.confirmed} maxBarSize={28} cursor="pointer" />
              <Bar dataKey="pending" name="Pending verification" stackId="actual" fill={COLORS.pending} radius={[4, 4, 0, 0]} maxBarSize={28} cursor="pointer" />
              <Line dataKey="owed" name="Outstanding" stroke={COLORS.outstanding} strokeWidth={2} dot={{ r: 2.5 }} type="linear" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        sel && (
          <div className="grid gap-6 divide-y divide-line px-5 pt-4 pb-2 [&>*:not(:first-child)]:pt-5">
            <Donut
              title={showMembers ? "Where the month stands" : "Your month"}
              center={`${collectedPct}%`}
              centerHint="collected"
              empty="Nothing due this month."
              slices={[
                { name: "Confirmed", value: sel.confirmed, color: COLORS.confirmed },
                { name: "Pending verification", value: pendingPart, color: COLORS.pending },
                { name: "Still open", value: openPart, color: COLORS.outstanding },
              ]}
            />
            {showMembers && (
              <Donut
                title="Who still owes"
                center={eur(owing.reduce((a, m) => a + m.outstanding, 0))}
                centerHint={`${owing.length} resident${owing.length === 1 ? "" : "s"}`}
                empty="Everyone has paid this month."
                slices={owing.map((m, i) => ({ name: m.displayName, value: m.outstanding, color: RESIDENT_COLORS[i % RESIDENT_COLORS.length]! }))}
              />
            )}
          </div>
        )
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 pt-3 text-xs text-muted">
        <span>{view === "bar" ? "Click a month to see its breakdown." : "Pick a month below."}</span>
        <span>Pending payments are not counted as confirmed.</span>
        {rejectedCount > 0 && <span>{rejectedCount} rejected submission{rejectedCount === 1 ? "" : "s"} excluded.</span>}
      </div>

      <div className="mt-4 border-t border-line">
        {/* Month picker grouped by year: "2025 · Nov Dec", "2026 · Jan … Oct". */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 pt-5 pb-4" role="tablist" aria-label="Month">
          {[...new Set(series.map((s) => s.period.slice(0, 4)))].map((year) => (
            <div key={year} className="flex flex-wrap items-center gap-1">
              <span className="mr-1.5 text-xs font-semibold text-muted">{year}</span>
              {series.filter((s) => s.period.startsWith(year)).map((s) => (
                <button
                  key={s.period}
                  role="tab"
                  aria-selected={s.period === selected}
                  aria-label={formatPeriod(s.period)}
                  onClick={() => setSelected(s.period)}
                  className={cx("rounded-md px-2.5 py-1 text-xs whitespace-nowrap", s.period === selected ? "bg-accent font-medium text-white" : "text-muted hover:bg-canvas hover:text-ink")}
                >
                  {formatPeriod(s.period, "short").slice(0, 3)}
                </button>
              ))}
            </div>
          ))}
        </div>
        {sel && (
          <ResponsiveTable className="border-t border-line">
            <table className="w-full text-sm">
              <caption className="sr-only">Collection for {formatPeriod(sel.period)}</caption>
              <thead>
                <tr className="text-xs text-muted">
                  <th className="px-5 py-3 text-left font-medium">{showMembers ? "Resident" : formatPeriod(sel.period)}</th>
                  <th className="px-3 py-3 text-right font-medium">Expected</th>
                  <th className="px-3 py-3 text-right font-medium">Confirmed</th>
                  <th className="px-3 py-3 text-right font-medium">Pending</th>
                  <th className="px-3 py-3 text-right font-medium">Outstanding</th>
                  {showMembers && <th className="px-5 py-3 text-left font-medium">Status</th>}
                </tr>
              </thead>
              <tbody className="num">
                {showMembers && sel.byMember.map((m) => (
                  <tr key={m.membershipId} className="border-t border-line">
                    <td className="px-5 py-2.5" data-label="Resident">{m.displayName}</td>
                    <td className="px-3 py-2.5 text-right" data-label="Expected">{eur(m.due)}</td>
                    <td className="px-3 py-2.5 text-right" data-label="Confirmed">{eur(m.confirmed)}</td>
                    <td className="px-3 py-2.5 text-right" data-label="Pending">{m.pending ? eur(m.pending) : "—"}</td>
                    <td data-label="Outstanding" className={cx("px-3 py-2.5 text-right", m.outstanding > 0 && "font-medium text-bad")}>{eur(m.outstanding)}</td>
                    <td className="px-5 py-2.5" data-label="Status"><StatusBadge status={m.status} /></td>
                  </tr>
                ))}
                <tr className="border-t border-line font-semibold">
                  <td className="px-5 py-2.5">{showMembers ? "Total" : "Apartment total"}</td>
                  <td className="px-3 py-2.5 text-right" data-label="Expected">{eur(sel.expected)}</td>
                  <td className="px-3 py-2.5 text-right" data-label="Confirmed">{eur(sel.confirmed)}</td>
                  <td className="px-3 py-2.5 text-right" data-label="Pending">{sel.pending ? eur(sel.pending) : "—"}</td>
                  <td data-label="Outstanding" className={cx("px-3 py-2.5 text-right", sel.outstanding > 0 && "text-bad")}>{eur(sel.outstanding)}</td>
                  {showMembers && <td />}
                </tr>
              </tbody>
            </table>
          </ResponsiveTable>
        )}
      </div>
    </div>
  );
}
