"use client";

import Link from "next/link";
import { useState } from "react";

export default function RulesPage() {
  const [repricingEnabled, setRepricingEnabled] = useState(true);
  const [autoFixErrors, setAutoFixErrors] = useState(true);
  const [minMaxProtection, setMinMaxProtection] = useState(true);
  const [raiseWithoutCompetition, setRaiseWithoutCompetition] = useState(true);

  const [historyWindow, setHistoryWindow] = useState("90");
  const [maxChange, setMaxChange] = useState("5.00");

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="flex min-h-screen">
        <aside className="w-64 border-r border-slate-800 bg-slate-950 px-5 py-6 text-white">
          <div className="mb-10">
            <div className="text-2xl font-bold tracking-tight">SBM</div>
            <div className="text-sm text-slate-400">Repricer</div>
          </div>

          <nav className="space-y-2">
            <Link
              href="/"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Dashboard
            </Link>

            <Link
              href="/products"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Products
            </Link>

            <Link
              href="/price-errors"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Price Errors
            </Link>

            <Link
              href="/rules"
              className="block rounded-xl bg-white/10 px-4 py-3 text-sm font-medium"
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
          <header className="border-b border-slate-200 bg-white px-8 py-5">
            <h1 className="text-2xl font-semibold">Rules</h1>
            <p className="mt-1 text-sm text-slate-500">
              Global pricing behavior for SBM Repricer
            </p>
          </header>

          <div className="max-w-5xl p-8">
            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-6 py-5">
                <h2 className="text-lg font-semibold">Repricing</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Main pricing engine controls
                </p>
              </div>

              <div className="divide-y divide-slate-200">
                <RuleToggle
                  title="Automatic Repricing"
                  description="Allow SBM Repricer to automatically update Amazon prices."
                  enabled={repricingEnabled}
                  onChange={setRepricingEnabled}
                />

                <RuleToggle
                  title="Min / Max Protection"
                  description="Never allow a product price outside its calculated limits."
                  enabled={minMaxProtection}
                  onChange={setMinMaxProtection}
                />

                <RuleToggle
                  title="Automatic Price Error Fix"
                  description="Automatically correct Amazon high or low pricing errors."
                  enabled={autoFixErrors}
                  onChange={setAutoFixErrors}
                />

                <RuleToggle
                  title="Raise Price When Competition Drops"
                  description="Allow prices to move upward when competing offers disappear."
                  enabled={raiseWithoutCompetition}
                  onChange={setRaiseWithoutCompetition}
                />
              </div>
            </section>

            <section className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-6 py-5">
                <h2 className="text-lg font-semibold">Pricing Parameters</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Global limits used by the pricing engine
                </p>
              </div>

              <div className="grid gap-6 p-6 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Price History Window
                  </label>

                  <select
                    value={historyWindow}
                    onChange={(event) => setHistoryWindow(event.target.value)}
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-slate-500"
                  >
                    <option value="30">30 Days</option>
                    <option value="60">60 Days</option>
                    <option value="90">90 Days</option>
                    <option value="180">180 Days</option>
                    <option value="365">365 Days</option>
                  </select>

                  <p className="mt-2 text-xs text-slate-400">
                    Historical period used by the pricing algorithm.
                  </p>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Maximum Price Change Per Update
                  </label>

                  <div className="relative">
                    <span className="absolute left-4 top-3 text-sm text-slate-500">
                      $
                    </span>

                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={maxChange}
                      onChange={(event) => setMaxChange(event.target.value)}
                      className="w-full rounded-xl border border-slate-300 py-3 pl-8 pr-4 text-sm outline-none focus:border-slate-500"
                    />
                  </div>

                  <p className="mt-2 text-xs text-slate-400">
                    Prevents unusually large price movements in one cycle.
                  </p>
                </div>
              </div>
            </section>

            <div className="mt-6 flex justify-end">
              <button className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800">
                Save Rules
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function RuleToggle({
  title,
  description,
  enabled,
  onChange,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-6 py-5">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-sm text-slate-500">{description}</div>
      </div>

      <button
        type="button"
        onClick={() => onChange(!enabled)}
        className={`relative h-7 w-12 shrink-0 rounded-full transition ${
          enabled ? "bg-slate-950" : "bg-slate-300"
        }`}
      >
        <span
          className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${
            enabled ? "left-6" : "left-1"
          }`}
        />
      </button>
    </div>
  );
}