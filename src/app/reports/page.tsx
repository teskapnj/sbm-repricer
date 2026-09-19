"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Report = {
  id: string;
  createdAt?: string;
  createdAtMs?: number;
  source?: string;
  result?: any;
};

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function money(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }

  return `$${value.toFixed(2)}`;
}

function formatDate(value?: string) {
  if (!value) return "Unknown time";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function getSummary(report: Report) {
  const result = report.result || {};
  const counts = result.counts || {};
  const liveSummary = result.liveSummary || {};

  return {
    checked: numberValue(result.activeProducts),
    updated: numberValue(liveSummary.submitted),
    noChange: numberValue(counts.noChange),
    skipped:
      numberValue(counts.skipped) +
      numberValue(counts.fbmNeedsShipping) +
      numberValue(counts.invalidSetup),
    failed: numberValue(liveSummary.failed),
  };
}

function getLiveResultMap(result: any) {
  const map = new Map<string, any>();

  const liveResults = Array.isArray(result?.liveResults)
    ? result.liveResults
    : [];

  for (const entry of liveResults) {
    const actual = entry?.result || entry;

    const sku =
      actual?.sku ||
      entry?.sku ||
      entry?.preview?.sku ||
      null;

    if (sku) {
      map.set(String(sku), actual);
    }
  }

  return map;
}

function resultLabel(item: any, liveResult: any) {
  if (item?.action === "NO_CHANGE") return "No Change";

  if (
    item?.action === "SKIP" ||
    item?.action === "INVALID_SETUP" ||
    item?.action === "FBM_NEEDS_OWN_SHIPPING"
  ) {
    return "Skipped";
  }

  // Reports written by the current cycle carry the outcome on the item itself.
  if (item?.action === "PRICE_SUBMITTED") return "Updated";

  if (
    item?.action === "VALIDATION_FAILED" ||
    item?.action === "AMAZON_UPDATE_FAILED"
  ) {
    return "Failed";
  }

  if (item?.action === "WOULD_UPDATE") {
    if (
      liveResult?.success === true &&
      (liveResult?.action === "PRICE_SUBMITTED" ||
        liveResult?.amazonPriceUpdated === true)
    ) {
      return "Updated";
    }

    if (liveResult?.success === false) {
      return "Failed";
    }

    return "Submitted";
  }

  return item?.action || "—";
}

function badgeClass(label: string) {
  if (label === "Updated") {
    return "bg-emerald-100 text-emerald-700";
  }

  if (label === "Failed") {
    return "bg-red-100 text-red-700";
  }

  if (label === "Skipped") {
    return "bg-amber-100 text-amber-700";
  }

  return "bg-slate-100 text-slate-700";
}

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadReports() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/repricing-reports", {
        cache: "no-store",
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Unable to load reports.",
        );
      }

      setReports(
        Array.isArray(data.reports)
          ? data.reports
          : [],
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load reports.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReports();
  }, []);

  const totals = useMemo(() => {
    return reports.reduce(
      (total, report) => {
        const summary = getSummary(report);

        total.checked += summary.checked;
        total.updated += summary.updated;
        total.failed += summary.failed;

        return total;
      },
      {
        checked: 0,
        updated: 0,
        failed: 0,
      },
    );
  }, [reports]);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="flex min-h-screen">
        <aside className="w-64 border-r border-slate-800 bg-slate-950 px-5 py-6 text-white">
          <div className="mb-10">
            <div className="text-2xl font-bold tracking-tight">
              SBM
            </div>
            <div className="text-sm text-slate-400">
              Repricer
            </div>
          </div>

          <nav className="space-y-2">
            <Link
              href="/"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Dashboard
            </Link>

            <Link
              href="/price-errors"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Price Errors
            </Link>

            <Link
              href="/reports"
              className="block rounded-xl bg-white/10 px-4 py-3 text-sm font-medium"
            >
              Reports
            </Link>

            <Link
              href="/rules"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Rules
            </Link>

            <Link
              href="/settings"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Settings
            </Link>
          </nav>
        </aside>

        <main className="flex-1">
          <header className="flex items-center justify-between border-b border-slate-200 bg-white px-8 py-5">
            <div>
              <h1 className="text-2xl font-semibold">
                Repricing Reports
              </h1>

              <p className="mt-1 text-sm text-slate-500">
                Price changes, results and repricing history
              </p>
            </div>

            <button
              type="button"
              onClick={() => void loadReports()}
              disabled={loading}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </header>

          <div className="p-8">
            <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                title="Repricing Runs"
                value={reports.length}
                subtitle="Last 50 runs"
              />

              <StatCard
                title="Products Checked"
                value={totals.checked}
                subtitle="Across saved reports"
              />

              <StatCard
                title="Prices Updated"
                value={totals.updated}
                subtitle="Submitted to Amazon"
              />

              <StatCard
                title="Failures"
                value={totals.failed}
                subtitle="Needs attention"
              />
            </section>

            {error && (
              <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
                {error}
              </div>
            )}

            {!loading && reports.length === 0 && !error && (
              <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
                <div className="text-lg font-semibold">
                  No repricing reports yet
                </div>

                <div className="mt-2 text-sm text-slate-500">
                  Run Reprice from the Dashboard and the result
                  will appear here.
                </div>
              </div>
            )}

            <div className="mt-8 space-y-5">
              {reports.map((report) => {
                const result = report.result || {};
                const summary = getSummary(report);
                const items = Array.isArray(result.items)
                  ? result.items
                  : [];

                const liveMap =
                  getLiveResultMap(result);

                return (
                  <details
                    key={report.id}
                    className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                  >
                    <summary className="cursor-pointer list-none px-6 py-5 hover:bg-slate-50">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                        <div>
                          <div className="font-semibold">
                            {formatDate(report.createdAt)}
                          </div>

                          <div className="mt-1 text-xs uppercase tracking-wide text-slate-400">
                            {report.source || "manual"} repricing
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2 text-sm">
                          <SummaryPill
                            label="Checked"
                            value={summary.checked}
                          />
                          <SummaryPill
                            label="Updated"
                            value={summary.updated}
                          />
                          <SummaryPill
                            label="No change"
                            value={summary.noChange}
                          />
                          <SummaryPill
                            label="Skipped"
                            value={summary.skipped}
                          />
                          <SummaryPill
                            label="Failed"
                            value={summary.failed}
                          />
                        </div>
                      </div>
                    </summary>

                    <div className="border-t border-slate-200">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="px-5 py-4">SKU</th>
                              <th className="px-5 py-4">Condition</th>
                              <th className="px-5 py-4">Before</th>
                              <th className="px-5 py-4">Market</th>
                              <th className="px-5 py-4">After</th>
                              <th className="px-5 py-4">Change</th>
                              <th className="px-5 py-4">Min</th>
                              <th className="px-5 py-4">Max</th>
                              <th className="px-5 py-4">Result</th>
                            </tr>
                          </thead>

                          <tbody className="divide-y divide-slate-200">
                            {items.map(
                              (item: any, index: number) => {
                                const liveResult =
                                  liveMap.get(
                                    String(
                                      item?.sku || "",
                                    ),
                                  );

                                const before =
                                  typeof item?.currentPrice ===
                                  "number"
                                    ? item.currentPrice
                                    : null;

                                // A submitted price is the new price too;
                                // failed submissions keep the old one.
                                const after =
                                  item?.action ===
                                    "WOULD_UPDATE" ||
                                  item?.action ===
                                    "PRICE_SUBMITTED"
                                    ? item?.targetLandedPrice
                                    : before;

                                // Stored reports keep the Buy Box price flat.
                                const market =
                                  item?.buyBox?.landedPrice ??
                                  item?.buyBoxLandedPrice;

                                const label =
                                  resultLabel(
                                    item,
                                    liveResult,
                                  );

                                const change =
                                  typeof before ===
                                    "number" &&
                                  typeof after ===
                                    "number"
                                    ? after - before
                                    : null;

                                return (
                                  <tr
                                    key={`${item?.sku || "row"}-${index}`}
                                    className="hover:bg-slate-50"
                                  >
                                    <td className="whitespace-nowrap px-5 py-4 font-medium">
                                      {item?.sku || "—"}
                                    </td>

                                    <td className="px-5 py-4 text-slate-600">
                                      {item?.condition ||
                                        "—"}
                                    </td>

                                    <td className="px-5 py-4">
                                      {money(before)}
                                    </td>

                                    <td className="px-5 py-4">
                                      <div>
                                        {money(market)}
                                      </div>

                                      <div className="mt-1 text-xs text-slate-400">
                                        {item?.condition ===
                                        "New"
                                          ? "Buy Box"
                                          : "Lowest Used"}
                                      </div>
                                    </td>

                                    <td className="px-5 py-4 font-medium">
                                      {money(after)}
                                    </td>

                                    <td className="px-5 py-4">
                                      {change === null
                                        ? "—"
                                        : `${change > 0 ? "+" : ""}${money(change)}`}
                                    </td>

                                    <td className="px-5 py-4 text-slate-600">
                                      {money(
                                        item?.minPrice,
                                      )}
                                    </td>

                                    <td className="px-5 py-4 text-slate-600">
                                      {money(
                                        item?.maxPrice,
                                      )}
                                    </td>

                                    <td className="px-5 py-4">
                                      <span
                                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${badgeClass(
                                          label,
                                        )}`}
                                      >
                                        {label}
                                      </span>

                                      {item?.reason && (
                                        <div className="mt-1 max-w-xs text-xs text-slate-400">
                                          {item.reason}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              },
                            )}

                            {items.length === 0 && (
                              <tr>
                                <td
                                  colSpan={9}
                                  className="px-6 py-8 text-center text-slate-500"
                                >
                                  No item details saved for
                                  this run.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: number;
  subtitle: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-500">
        {title}
      </div>

      <div className="mt-2 text-3xl font-semibold">
        {value}
      </div>

      <div className="mt-2 text-xs text-slate-400">
        {subtitle}
      </div>
    </div>
  );
}

function SummaryPill({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-slate-600">
      {label}:{" "}
      <strong className="text-slate-900">
        {value}
      </strong>
    </span>
  );
}
