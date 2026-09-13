import Link from "next/link";

export default function PriceErrorsPage() {
  const errors = [
    {
      sku: "DVD-104",
      asin: "B000G7H8I9",
      current: 149.99,
      min: 84.99,
      max: 129.99,
      error: "High Price",
    },
    {
      sku: "GAME-220",
      asin: "B000X2Y3Z4",
      current: 29.99,
      min: 39.99,
      max: 79.99,
      error: "Low Price",
    },
  ];

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
              className="block rounded-xl bg-white/10 px-4 py-3 text-sm font-medium"
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
          <header className="border-b border-slate-200 bg-white px-8 py-5">
            <h1 className="text-2xl font-semibold">Price Errors</h1>
            <p className="mt-1 text-sm text-slate-500">
              Amazon listings that need pricing attention
            </p>
          </header>

          <div className="p-8">
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-6 py-5">
                <h2 className="text-lg font-semibold">
                  {errors.length} Pricing Issues
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Products requiring a pricing correction
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-6 py-4 font-medium">SKU</th>
                      <th className="px-6 py-4 font-medium">ASIN</th>
                      <th className="px-6 py-4 font-medium">Current Price</th>
                      <th className="px-6 py-4 font-medium">Min Price</th>
                      <th className="px-6 py-4 font-medium">Max Price</th>
                      <th className="px-6 py-4 font-medium">Error</th>
                      <th className="px-6 py-4 font-medium">Action</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-200">
                    {errors.map((product) => (
                      <tr
                        key={product.sku}
                        className="transition hover:bg-slate-50"
                      >
                        <td className="px-6 py-4 font-medium">
                          {product.sku}
                        </td>
                        <td className="px-6 py-4 text-slate-500">
                          {product.asin}
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
                          <span className="inline-flex rounded-full bg-red-50 px-3 py-1 text-xs font-semibold text-red-700">
                            {product.error}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <button className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-medium text-white transition hover:bg-slate-800">
                            Review
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
    </div>
  );
}