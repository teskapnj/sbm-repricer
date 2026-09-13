"use client";

import Link from "next/link";
import { useState } from "react";

export default function SettingsPage() {
  const [amazonConnected, setAmazonConnected] = useState(false);
  const [keepaConnected, setKeepaConnected] = useState(false);

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
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Rules
            </Link>

            <Link
              href="/settings"
              className="block rounded-xl bg-white/10 px-4 py-3 text-sm font-medium"
            >
              Settings
            </Link>
          </nav>
        </aside>

        <main className="flex-1">
          <header className="border-b border-slate-200 bg-white px-8 py-5">
            <h1 className="text-2xl font-semibold">Settings</h1>
            <p className="mt-1 text-sm text-slate-500">
              Manage account connections and system settings
            </p>
          </header>

          <div className="max-w-5xl p-8">
            <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-6 py-5">
                <h2 className="text-lg font-semibold">Connections</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Connect the services used by SBM Repricer
                </p>
              </div>

              <div className="divide-y divide-slate-200">
                <ConnectionRow
                  title="Amazon Seller Central"
                  description="Connect your Amazon seller account for inventory and pricing."
                  connected={amazonConnected}
                  onClick={() => setAmazonConnected(!amazonConnected)}
                />

                <ConnectionRow
                  title="Keepa"
                  description="Connect Keepa for historical pricing and market data."
                  connected={keepaConnected}
                  onClick={() => setKeepaConnected(!keepaConnected)}
                />
              </div>
            </section>

            <section className="mt-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-6 py-5">
                <h2 className="text-lg font-semibold">System</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Basic SBM Repricer configuration
                </p>
              </div>

              <div className="grid gap-6 p-6 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Marketplace
                  </label>

                  <select className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-slate-500">
                    <option>Amazon.com - United States</option>
                  </select>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Currency
                  </label>

                  <select className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-slate-500">
                    <option>USD - US Dollar</option>
                  </select>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

function ConnectionRow({
  title,
  description,
  connected,
  onClick,
}: {
  title: string;
  description: string;
  connected: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-6 py-5">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-sm text-slate-500">{description}</div>
      </div>

      <div className="flex items-center gap-4">
        <span
          className={`text-xs font-semibold ${
            connected ? "text-emerald-700" : "text-slate-400"
          }`}
        >
          {connected ? "Connected" : "Not Connected"}
        </span>

        <button
          onClick={onClick}
          className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
            connected
              ? "border border-slate-300 bg-white hover:bg-slate-50"
              : "bg-slate-950 text-white hover:bg-slate-800"
          }`}
        >
          {connected ? "Disconnect" : "Connect"}
        </button>
      </div>
    </div>
  );
}