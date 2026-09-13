"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Fulfillment = "FBA" | "FBM";

type Product = {
  sku: string;
  asin: string;
  fulfillment: Fulfillment;
  current: number;
  min: number;
  max: number;
  status: string;
  repricing: boolean;
};

export default function Home() {
  const [products, setProducts] = useState<Product[]>([
    {
      sku: "GAME-001",
      asin: "B000A1B2C3",
      fulfillment: "FBA",
      current: 99.99,
      min: 79.99,
      max: 119.99,
      status: "Active",
      repricing: true,
    },
    {
      sku: "CD-022",
      asin: "B000D4E5F6",
      fulfillment: "FBA",
      current: 48.5,
      min: 39.99,
      max: 64.99,
      status: "Active",
      repricing: true,
    },
    {
      sku: "DVD-104",
      asin: "B000G7H8I9",
      fulfillment: "FBM",
      current: 149.99,
      min: 84.99,
      max: 129.99,
      status: "Price Error",
      repricing: true,
    },
    {
      sku: "BOOK-210",
      asin: "B000J1K2L3",
      fulfillment: "FBM",
      current: 34.99,
      min: 28.99,
      max: 44.99,
      status: "Active",
      repricing: false,
    },
  ]);

  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const [search, setSearch] = useState("");
  const [fulfillmentFilter, setFulfillmentFilter] = useState<
    "ALL" | Fulfillment
  >("ALL");

  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [bulkMinPercent, setBulkMinPercent] = useState("20");
  const [bulkMaxPercent, setBulkMaxPercent] = useState("50");

  function openEdit(product: Product) {
    setEditingProduct(product);
    setMinPrice(product.min.toString());
    setMaxPrice(product.max.toString());
  }

  function savePricing() {
    if (!editingProduct) return;

    const newMin = Number(minPrice);
    const newMax = Number(maxPrice);

    if (
      Number.isNaN(newMin) ||
      Number.isNaN(newMax) ||
      newMin < 0 ||
      newMax < 0 ||
      newMin > newMax
    ) {
      return;
    }

    setProducts((currentProducts) =>
      currentProducts.map((product) =>
        product.sku === editingProduct.sku
          ? {
              ...product,
              min: newMin,
              max: newMax,
            }
          : product,
      ),
    );

    setEditingProduct(null);
  }

  function toggleRepricing(sku: string) {
    setProducts((currentProducts) =>
      currentProducts.map((product) =>
        product.sku === sku
          ? {
              ...product,
              repricing: !product.repricing,
            }
          : product,
      ),
    );
  }

  function toggleSelected(sku: string) {
    setSelectedSkus((current) =>
      current.includes(sku)
        ? current.filter((item) => item !== sku)
        : [...current, sku],
    );
  }

  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();

    return products.filter((product) => {
      const matchesSearch =
        product.sku.toLowerCase().includes(term) ||
        product.asin.toLowerCase().includes(term);

      const matchesFulfillment =
        fulfillmentFilter === "ALL" ||
        product.fulfillment === fulfillmentFilter;

      return matchesSearch && matchesFulfillment;
    });
  }, [products, search, fulfillmentFilter]);

  const allVisibleSelected =
    filteredProducts.length > 0 &&
    filteredProducts.every((product) => selectedSkus.includes(product.sku));

  function toggleSelectAllVisible() {
    const visibleSkus = filteredProducts.map((product) => product.sku);

    if (allVisibleSelected) {
      setSelectedSkus((current) =>
        current.filter((sku) => !visibleSkus.includes(sku)),
      );
    } else {
      setSelectedSkus((current) => [
        ...new Set([...current, ...visibleSkus]),
      ]);
    }
  }

  const previewProducts = products
    .filter((product) => selectedSkus.includes(product.sku))
    .map((product) => {
      const minPercent = Number(bulkMinPercent) || 0;
      const maxPercent = Number(bulkMaxPercent) || 0;

      const newMin = product.current * (1 - minPercent / 100);
      const newMax = product.current * (1 + maxPercent / 100);

      return {
        ...product,
        newMin,
        newMax,
      };
    });

  function applyBulkChanges() {
    const minPercent = Number(bulkMinPercent) || 0;
    const maxPercent = Number(bulkMaxPercent) || 0;

    setProducts((currentProducts) =>
      currentProducts.map((product) => {
        if (!selectedSkus.includes(product.sku)) {
          return product;
        }

        return {
          ...product,
          min: Number(
            (product.current * (1 - minPercent / 100)).toFixed(2),
          ),
          max: Number(
            (product.current * (1 + maxPercent / 100)).toFixed(2),
          ),
        };
      }),
    );

    setPreviewOpen(false);
    setBulkOpen(false);
    setSelectedSkus([]);
  }

  const activeCount = products.filter((product) => product.repricing).length;

  const errorCount = products.filter(
    (product) => product.status === "Price Error",
  ).length;

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
              className="block rounded-xl bg-white/10 px-4 py-3 text-sm font-medium"
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
              <h1 className="text-2xl font-semibold">Dashboard</h1>
              <p className="mt-1 text-sm text-slate-500">
                Amazon pricing overview
              </p>
            </div>

            <div className="text-right">
              <div className="text-sm font-medium">Amazon Account</div>
              <div className="mt-1 text-xs text-slate-500">
                Last sync: 2 minutes ago
              </div>
            </div>
          </header>

          <div className="p-8">
            <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                title="Active SKUs"
                value={activeCount.toString()}
                subtitle="Repricing enabled"
              />

              <StatCard
                title="Price Errors"
                value={errorCount.toString()}
                subtitle="Need attention"
              />

              <StatCard
                title="Changes Today"
                value="43"
                subtitle="Price updates"
              />

              <StatCard
                title="Repricing Status"
                value="Running"
                subtitle="Automatic pricing active"
              />
            </section>

            <section className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-6 py-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">Products</h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Manage prices and repricing status
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <select
                      value={fulfillmentFilter}
                      onChange={(event) =>
                        setFulfillmentFilter(
                          event.target.value as "ALL" | Fulfillment,
                        )
                      }
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-slate-500"
                    >
                      <option value="ALL">All</option>
                      <option value="FBA">FBA</option>
                      <option value="FBM">FBM</option>
                    </select>

                    <input
                      type="text"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search SKU or ASIN"
                      className="w-64 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-slate-500"
                    />

                    <button
                      type="button"
                      disabled={selectedSkus.length === 0}
                      onClick={() => setBulkOpen(true)}
                      className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      Bulk Edit
                    </button>
                  </div>
                </div>

                {selectedSkus.length > 0 && (
                  <div className="mt-4 text-sm font-medium text-slate-600">
                    {selectedSkus.length} product
                    {selectedSkus.length === 1 ? "" : "s"} selected
                  </div>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="w-12 px-6 py-4">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          className="h-4 w-4"
                        />
                      </th>

                      <th className="px-6 py-4 font-medium">SKU</th>
                      <th className="px-6 py-4 font-medium">ASIN</th>
                      <th className="px-6 py-4 font-medium">Type</th>
                      <th className="px-6 py-4 font-medium">Current</th>
                      <th className="px-6 py-4 font-medium">Min</th>
                      <th className="px-6 py-4 font-medium">Max</th>
                      <th className="px-6 py-4 font-medium">Status</th>
                      <th className="px-6 py-4 font-medium">Repricing</th>
                      <th className="px-6 py-4 font-medium">Action</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-200">
                    {filteredProducts.map((product) => (
                      <tr
                        key={product.sku}
                        className="transition hover:bg-slate-50"
                      >
                        <td className="px-6 py-4">
                          <input
                            type="checkbox"
                            checked={selectedSkus.includes(product.sku)}
                            onChange={() => toggleSelected(product.sku)}
                            className="h-4 w-4"
                          />
                        </td>

                        <td className="px-6 py-4 font-medium">
                          {product.sku}
                        </td>

                        <td className="px-6 py-4 text-slate-500">
                          {product.asin}
                        </td>

                        <td className="px-6 py-4">
                          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium">
                            {product.fulfillment}
                          </span>
                        </td>

                        <td className="px-6 py-4">
                          ${product.current.toFixed(2)}
                        </td>

                        <td className="px-6 py-4 text-slate-600">
                          ${product.min.toFixed(2)}
                        </td>

                        <td className="px-6 py-4 text-slate-600">
                          ${product.max.toFixed(2)}
                        </td>

                        <td className="px-6 py-4">
                          <StatusBadge status={product.status} />
                        </td>

                        <td className="px-6 py-4">
                          <button
                            type="button"
                            onClick={() => toggleRepricing(product.sku)}
                            className={`relative h-7 w-12 rounded-full transition ${
                              product.repricing
                                ? "bg-slate-950"
                                : "bg-slate-300"
                            }`}
                          >
                            <span
                              className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${
                                product.repricing ? "left-6" : "left-1"
                              }`}
                            />
                          </button>
                        </td>

                        <td className="px-6 py-4">
                          <button
                            onClick={() => openEdit(product)}
                            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium transition hover:bg-slate-50"
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </main>
      </div>

      {editingProduct && (
        <Modal>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">Edit Pricing</h2>
              <p className="mt-1 text-sm text-slate-500">
                {editingProduct.sku}
              </p>
            </div>

            <button
              onClick={() => setEditingProduct(null)}
              className="text-2xl leading-none text-slate-400 hover:text-slate-700"
            >
              ×
            </button>
          </div>

          <div className="mt-6 space-y-4">
            <PriceField
              label="Current Price"
              value={`$${editingProduct.current.toFixed(2)}`}
              disabled
            />

            <PriceField
              label="Min Price"
              value={minPrice}
              onChange={setMinPrice}
            />

            <PriceField
              label="Max Price"
              value={maxPrice}
              onChange={setMaxPrice}
            />
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => setEditingProduct(null)}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50"
            >
              Cancel
            </button>

            <button
              onClick={savePricing}
              className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Save
            </button>
          </div>
        </Modal>
      )}

      {bulkOpen && !previewOpen && (
        <Modal>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">Bulk Edit</h2>
              <p className="mt-1 text-sm text-slate-500">
                {selectedSkus.length} products selected
              </p>
            </div>

            <button
              onClick={() => setBulkOpen(false)}
              className="text-2xl leading-none text-slate-400 hover:text-slate-700"
            >
              ×
            </button>
          </div>

          <div className="mt-6 space-y-5">
            <div>
              <label className="mb-2 block text-sm font-medium">
                Minimum Price
              </label>

              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-500">
                  Current Price -
                </span>

                <input
                  type="number"
                  min="0"
                  value={bulkMinPercent}
                  onChange={(event) =>
                    setBulkMinPercent(event.target.value)
                  }
                  className="w-24 rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none"
                />

                <span className="text-sm text-slate-500">%</span>
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                Maximum Price
              </label>

              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-500">
                  Current Price +
                </span>

                <input
                  type="number"
                  min="0"
                  value={bulkMaxPercent}
                  onChange={(event) =>
                    setBulkMaxPercent(event.target.value)
                  }
                  className="w-24 rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none"
                />

                <span className="text-sm text-slate-500">%</span>
              </div>
            </div>
          </div>

          <div className="mt-7 flex justify-end gap-3">
            <button
              onClick={() => setBulkOpen(false)}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50"
            >
              Cancel
            </button>

            <button
              onClick={() => setPreviewOpen(true)}
              className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
            >
              Preview Changes
            </button>
          </div>
        </Modal>
      )}

      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
              <div>
                <h2 className="text-lg font-semibold">Preview Changes</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Review before applying bulk pricing changes
                </p>
              </div>

              <button
                onClick={() => setPreviewOpen(false)}
                className="text-2xl text-slate-400 hover:text-slate-700"
              >
                ×
              </button>
            </div>

            <div className="max-h-[55vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-6 py-4">SKU</th>
                    <th className="px-6 py-4">Current</th>
                    <th className="px-6 py-4">Old Min</th>
                    <th className="px-6 py-4">New Min</th>
                    <th className="px-6 py-4">Old Max</th>
                    <th className="px-6 py-4">New Max</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-200">
                  {previewProducts.map((product) => (
                    <tr key={product.sku}>
                      <td className="px-6 py-4 font-medium">
                        {product.sku}
                      </td>

                      <td className="px-6 py-4">
                        ${product.current.toFixed(2)}
                      </td>

                      <td className="px-6 py-4 text-slate-500">
                        ${product.min.toFixed(2)}
                      </td>

                      <td className="px-6 py-4 font-medium">
                        ${product.newMin.toFixed(2)}
                      </td>

                      <td className="px-6 py-4 text-slate-500">
                        ${product.max.toFixed(2)}
                      </td>

                      <td className="px-6 py-4 font-medium">
                        ${product.newMax.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-5">
              <button
                onClick={() => setPreviewOpen(false)}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50"
              >
                Back
              </button>

              <button
                onClick={applyBulkChanges}
                className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
              >
                Apply Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        {children}
      </div>
    </div>
  );
}

function PriceField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium">{label}</label>

      <input
        type={disabled ? "text" : "number"}
        step="0.01"
        min="0"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.value)}
        className={`w-full rounded-xl border px-4 py-3 text-sm outline-none ${
          disabled
            ? "border-slate-200 bg-slate-100 text-slate-500"
            : "border-slate-300 bg-white focus:border-slate-500"
        }`}
      />
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-sm font-medium text-slate-500">{title}</div>
      <div className="mt-3 text-3xl font-semibold tracking-tight">{value}</div>
      <div className="mt-2 text-sm text-slate-400">{subtitle}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isError = status === "Price Error";

  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
        isError
          ? "bg-red-50 text-red-700"
          : "bg-emerald-50 text-emerald-700"
      }`}
    >
      {status}
    </span>
  );
}