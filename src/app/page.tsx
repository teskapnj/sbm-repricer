"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Fulfillment = "FBA" | "FBM";

type Product = {
  sku: string;
  asin: string;
  title: string;
  fulfillment: Fulfillment;
  availableQty: number;
  createdDate: string | null;
  current: number | null;
  min: number | null;
  max: number | null;
  status: string;
  pricingRule: "BUY_BOX" | null;
  repricing: boolean;
};

type AmazonListing = {
  sku: string;
  asin: string | null;
  title: string | null;
  fulfillment: Fulfillment;
  createdDate: string | null;
  currentPrice: number | null;
  available: boolean;
  availableQty: number;
};

type AmazonListingsResponse = {
  success: boolean;
  amazonBuyableListings?: number;
  syncDurationMs?: number;
  items?: AmazonListing[];
  error?: string;
};

type StoredProduct = AmazonListing & {
  minPrice?: number | null;
  maxPrice?: number | null;
  pricingRule?: "BUY_BOX" | null;
  repricingEnabled?: boolean;
  amazonSyncedAt?: string | null;
};

type ProductsResponse = {
  success: boolean;
  total?: number;
  items?: StoredProduct[];
  error?: string;
};

type RepricingCycleLiveResponse = {
  success: boolean;
  activeProducts?: number;
  counts?: {
    wouldUpdate?: number;
    noChange?: number;
    skipped?: number;
    fbmNeedsShipping?: number;
    invalidSetup?: number;
  };
  liveSummary?: {
    candidates?: number;
    submitted?: number;
    failed?: number;
  };
  error?: string;
};

// Response of a chunked call to /api/repricing-cycle-live or -preview.
type CycleChunkResponse = RepricingCycleLiveResponse & {
  durationMs?: number;
  fetchErrors?: unknown[];
  chunk?: {
    index: number;
    total: number;
    totalActive: number;
    nextCursor: string | null;
    waitBeforeNextMs: number;
  };
};

type RepricingProgress = {
  step: number;
  steps: number;
  done: number;
  total: number;
  waiting: boolean;
};

// Wait before retrying a failed chunk: one full New Buy Box rate-limit window.
const CHUNK_RETRY_WAIT_MS = 31_000;
const MAX_CYCLE_STEPS = 500;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

type RepricingRunSummary = {
  mode: "PREVIEW" | "LIVE";
  checked: number;
  wouldUpdate: number;
  updated: number;
  noChange: number;
  skipped: number;
  failed: number;
  durationMs: number | null;
  fetchErrors: number;
};

async function fetchStoredProducts() {
  const response = await fetch("/api/products", {
    method: "GET",
    cache: "no-store",
  });

  const data = (await response.json()) as ProductsResponse;

  if (!response.ok || !data.success) {
    throw new Error(data.error || "Unable to load Firestore products.");
  }

  const items = data.items || [];

  const products: Product[] = items.map((item) => {
    const min =
      typeof item.minPrice === "number" ? item.minPrice : null;
    const max =
      typeof item.maxPrice === "number" ? item.maxPrice : null;
    const hasPricing = min !== null && max !== null;

    return {
      sku: item.sku,
      asin: item.asin || "",
      title: item.title || "",
      fulfillment: item.fulfillment,
      availableQty: item.availableQty || 0,
      createdDate: item.createdDate || null,
      current:
        typeof item.currentPrice === "number"
          ? item.currentPrice
          : null,
      min,
      max,
      status:
  typeof item.currentPrice !== "number"
    ? "Price Missing"
    : hasPricing
      ? "Ready"
      : "Needs Setup",

pricingRule:
  item.pricingRule === "BUY_BOX"
    ? "BUY_BOX"
    : null,

repricing:
  hasPricing &&
  item.pricingRule === "BUY_BOX" &&
  item.repricingEnabled === true,
    };
  });

  const latestSync =
    items
      .map((item) => item.amazonSyncedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) || null;

  return {
    products,
    latestSync,
  };
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);

  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const [minPercentInput, setMinPercentInput] = useState("");
  const [maxPercentInput, setMaxPercentInput] = useState("");

  const [search, setSearch] = useState("");
  const [fulfillmentFilter, setFulfillmentFilter] = useState<
    "ALL" | Fulfillment
  >("ALL");
  const [pageSize, setPageSize] = useState<50 | 100 | 500>(50);
  const [currentPage, setCurrentPage] = useState(1);
  const [dateSort, setDateSort] = useState<"NEWEST" | "OLDEST">("NEWEST");
  const [statFilter, setStatFilter] = useState<
    "ALL" | "FBA" | "FBM" | "REPRICING"
  >("ALL");

  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [bulkMinPercent, setBulkMinPercent] = useState("20");
  const [bulkMaxPercent, setBulkMaxPercent] = useState("50");

  const [bulkRepricing, setBulkRepricing] = useState<
  "KEEP" | "ON" | "OFF"
>("KEEP");

  const [syncing, setSyncing] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [syncError, setSyncError] = useState("");
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [amazonBuyableCount, setAmazonBuyableCount] = useState(0);
  const [syncDurationMs, setSyncDurationMs] = useState<number | null>(null);

  const [repricingRunning, setRepricingRunning] = useState(false);
  const [repricingError, setRepricingError] = useState("");
  const [repricingResult, setRepricingResult] =
    useState<RepricingRunSummary | null>(null);
  const [repricingProgress, setRepricingProgress] =
    useState<RepricingProgress | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialProducts() {
      setLoadingProducts(true);
      setSyncError("");

      try {
        const {
          products: storedProducts,
          latestSync,
        } = await fetchStoredProducts();

        if (cancelled) return;

        setProducts(storedProducts);

        if (latestSync) {
          setLastSync(
            new Date(latestSync).toLocaleTimeString(),
          );
        }
      } catch (error) {
        if (cancelled) return;

        setSyncError(
          error instanceof Error
            ? error.message
            : "Unable to load Firestore products.",
        );
      } finally {
        if (!cancelled) {
          setLoadingProducts(false);
        }
      }
    }

    void loadInitialProducts();

    return () => {
      cancelled = true;
    };
  }, []);

  async function syncAmazon() {
    if (syncing) return;

    setSyncing(true);
    setSyncError("");

    try {
      const response = await fetch("/api/amazon-listings", {
        method: "GET",
        cache: "no-store",
      });

      const data = (await response.json()) as AmazonListingsResponse;

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Amazon sync failed.");
      }

      // Amazon sync writes the fresh Amazon data to Firestore.
      // Read the dashboard back from Firestore so Firestore remains
      // the single source of truth for the UI.
      const {
        products: storedProducts,
        latestSync,
      } = await fetchStoredProducts();

      setProducts(storedProducts);
      setSelectedSkus([]);
      setCurrentPage(1);
      setAmazonBuyableCount(data.amazonBuyableListings || 0);
      setSyncDurationMs(data.syncDurationMs ?? null);
      setLastSync(
        latestSync
          ? new Date(latestSync).toLocaleTimeString()
          : new Date().toLocaleTimeString(),
      );
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : "Amazon sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  async function postCycleChunk(
    endpoint: string,
    cursor: string | null,
    source: string,
    confirmLive: boolean,
  ) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source,
        chunked: true,
        cursor,
        ...(confirmLive ? { confirm: "LIVE" } : {}),
      }),
      cache: "no-store",
    });

    const data = (await response
      .json()
      .catch(() => null)) as CycleChunkResponse | null;

    if (!response.ok || !data) {
      throw new Error(
        data?.error || `Request failed (HTTP ${response.status}).`,
      );
    }

    return data;
  }

  // Walks every product with Repricing ON, one chunk per request, so each
  // request fits the server's time limit however large the inventory is.
  async function runCycleInChunks(mode: "PREVIEW" | "LIVE") {
    const endpoint =
      mode === "LIVE"
        ? "/api/repricing-cycle-live"
        : "/api/repricing-cycle-preview";
    const source = mode === "LIVE" ? "ui-live" : "ui-preview";

    setRepricingRunning(true);
    setRepricingError("");
    setRepricingResult(null);
    setRepricingProgress(null);

    const startedAtMs = Date.now();
    const totals = {
      checked: 0,
      wouldUpdate: 0,
      updated: 0,
      noChange: 0,
      skipped: 0,
      failed: 0,
      fetchErrors: 0,
    };

    let step = 0;

    try {
      let cursor: string | null = null;
      let hasMore = true;

      while (hasMore) {
        let data: CycleChunkResponse;

        try {
          data = await postCycleChunk(endpoint, cursor, source, mode === "LIVE");
        } catch {
          // Retry a failed chunk once, after Amazon's rate-limit window.
          setRepricingProgress((previous) =>
            previous ? { ...previous, waiting: true } : previous,
          );
          await sleep(CHUNK_RETRY_WAIT_MS);
          data = await postCycleChunk(endpoint, cursor, source, mode === "LIVE");
        }

        const counts = data.counts || {};

        totals.checked += data.activeProducts ?? 0;
        totals.wouldUpdate += counts.wouldUpdate ?? 0;
        totals.updated += data.liveSummary?.submitted ?? 0;
        totals.noChange += counts.noChange ?? 0;
        totals.skipped +=
          (counts.skipped ?? 0) +
          (counts.fbmNeedsShipping ?? 0) +
          (counts.invalidSetup ?? 0);
        totals.failed += data.liveSummary?.failed ?? 0;
        totals.fetchErrors += Array.isArray(data.fetchErrors)
          ? data.fetchErrors.length
          : 0;

        step += 1;

        const chunk = data.chunk;
        const nextCursor = chunk?.nextCursor ?? null;

        setRepricingProgress({
          step,
          steps: chunk?.total ?? step,
          done: totals.checked,
          total: chunk?.totalActive ?? totals.checked,
          waiting: false,
        });

        hasMore = nextCursor !== null;

        if (hasMore) {
          if (nextCursor === cursor || step >= MAX_CYCLE_STEPS) {
            throw new Error("The chunk cursor stopped advancing.");
          }

          cursor = nextCursor;

          const waitMs = chunk?.waitBeforeNextMs ?? 0;

          if (waitMs > 0) {
            setRepricingProgress((previous) =>
              previous ? { ...previous, waiting: true } : previous,
            );
            await sleep(waitMs);
          }
        }
      }

      setRepricingResult({
        mode,
        ...totals,
        durationMs: Date.now() - startedAtMs,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Repricing failed.";

      setRepricingError(
        step > 0
          ? `Stopped after ${totals.checked} products (step ${step}): ${message} ` +
              "Products already processed keep their result."
          : message,
      );
    } finally {
      setRepricingRunning(false);
      setRepricingProgress(null);
    }
  }

  async function runPreview() {
    if (repricingRunning || syncing) return;

    await runCycleInChunks("PREVIEW");
  }

  async function runReprice() {
    if (repricingRunning || syncing) return;

    const enabledCount = products.filter((product) => product.repricing).length;

    if (enabledCount === 0) {
      alert("No products have Repricing ON.");
      return;
    }

    // Worst case (every product is New): 20 ASINs per ~31 s Amazon window.
    const estimatedMinutes = Math.max(
      1,
      Math.ceil((Math.ceil(enabledCount / 20) * 31) / 60),
    );

    const confirmed = window.confirm(
      `Run LIVE repricing for ${enabledCount} product${
        enabledCount === 1 ? "" : "s"
      } with Repricing ON? Amazon prices may change.\n\n` +
        `This can take up to ~${estimatedMinutes} min because of Amazon's rate limits. ` +
        "Keep this tab open until it finishes.",
    );

    if (!confirmed) return;

    await runCycleInChunks("LIVE");
  }

  function openEdit(product: Product) {
    setEditingProduct(product);
  
    const minValue = product.min;
    const maxValue = product.max;
    const currentPrice = product.current;
  
    setMinPrice(minValue?.toString() ?? "");
    setMaxPrice(maxValue?.toString() ?? "");
  
    if (
      currentPrice !== null &&
      currentPrice > 0 &&
      minValue !== null
    ) {
      const minPercent =
        ((currentPrice - minValue) / currentPrice) * 100;
  
      setMinPercentInput(minPercent.toFixed(1));
    } else {
      setMinPercentInput("");
    }
  
    
    if (
      currentPrice !== null &&
      currentPrice > 0 &&
      maxValue !== null
    ) {
      const maxPercent =
        ((maxValue - currentPrice) / currentPrice) * 100;
  
      setMaxPercentInput(maxPercent.toFixed(1));
    } else {
      setMaxPercentInput("");
    }
  }


  function handleMinPriceChange(value: string) {
    setMinPrice(value);

    const currentPrice = editingProduct?.current;
    const newMin = Number(value);

    if (
      value === "" ||
      currentPrice === null ||
      currentPrice === undefined ||
      currentPrice <= 0 ||
      !Number.isFinite(newMin)
    ) {
      setMinPercentInput("");
      return;
    }

    const percent =
      ((currentPrice - newMin) / currentPrice) * 100;

    setMinPercentInput(percent.toFixed(1));
  }

  function handleMaxPriceChange(value: string) {
    setMaxPrice(value);

    const currentPrice = editingProduct?.current;
    const newMax = Number(value);

    if (
      value === "" ||
      currentPrice === null ||
      currentPrice === undefined ||
      currentPrice <= 0 ||
      !Number.isFinite(newMax)
    ) {
      setMaxPercentInput("");
      return;
    }

    const percent =
      ((newMax - currentPrice) / currentPrice) * 100;

    setMaxPercentInput(percent.toFixed(1));
  }

  function handleMinPercentChange(value: string) {
    setMinPercentInput(value);

    const currentPrice = editingProduct?.current;
    const percent = Number(value);

    if (
      value === "" ||
      currentPrice === null ||
      currentPrice === undefined ||
      currentPrice <= 0 ||
      !Number.isFinite(percent)
    ) {
      return;
    }

    const calculatedMin =
      currentPrice * (1 - percent / 100);

    setMinPrice(Math.max(0, calculatedMin).toFixed(2));
  }

  function handleMaxPercentChange(value: string) {
    setMaxPercentInput(value);

    const currentPrice = editingProduct?.current;
    const percent = Number(value);

    if (
      value === "" ||
      currentPrice === null ||
      currentPrice === undefined ||
      currentPrice <= 0 ||
      !Number.isFinite(percent)
    ) {
      return;
    }

    const calculatedMax =
      currentPrice * (1 + percent / 100);

    setMaxPrice(Math.max(0, calculatedMax).toFixed(2));
  }

  async function savePricing() {
    if (!editingProduct) return;
  
    if (minPrice.trim() === "" || maxPrice.trim() === "") {
      return;
    }
  
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
  
    try {
      const response = await fetch("/api/product-pricing", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sku: editingProduct.sku,
          minPrice: newMin,
          maxPrice: newMax,
        }),
      });
  
      const data = await response.json();

        if (!response.ok || !data.success) {
        throw new Error(data.error || "Unable to save pricing.");
      }
  
      setProducts((currentProducts) =>
        currentProducts.map((product) =>
          product.sku === editingProduct.sku
            ? {
                ...product,
                min: newMin,
                max: newMax,
                status: "Ready",
              }
            : product,
        ),
      );
  
      setEditingProduct(null);
    } catch (error) {
      console.error("Pricing save failed:", error);
  
      alert(
        error instanceof Error
          ? error.message
          : "Unable to save pricing.",
      );
    }
  }

  async function updatePricingRule(
    sku: string,
    pricingRule: "BUY_BOX",
  ) {
    try {
      const response = await fetch(
        "/api/product-pricing-rule",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sku,
            pricingRule,
          }),
        },
      );
  
      const data = await response.json();
  
      if (!response.ok || !data.success) {
        throw new Error(
          data.error ||
            "Unable to update pricing rule.",
        );
      }
  
      setProducts((currentProducts) =>
        currentProducts.map((product) =>
          product.sku === sku
            ? {
                ...product,
                pricingRule,
              }
            : product,
        ),
      );
    } catch (error) {
      console.error(
        "Pricing rule update failed:",
        error,
      );
  
      alert(
        error instanceof Error
          ? error.message
          : "Unable to update pricing rule.",
      );
    }
  }

  async function toggleRepricing(sku: string) {
    const product = products.find(
      (item) => item.sku === sku,
    );
  
    if (!product) return;
  
    if (
      product.min === null ||
      product.max === null ||
      product.pricingRule === null
    ) {
      return;
    }
  
    const newValue = !product.repricing;
  
    try {
      const response = await fetch(
        "/api/product-repricing",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sku,
            repricingEnabled: newValue,
          }),
        },
      );
  
      const data = await response.json();
  
      if (!response.ok || !data.success) {
        throw new Error(
          data.error ||
            "Unable to update repricing.",
        );
      }
  
      setProducts((currentProducts) =>
        currentProducts.map((item) =>
          item.sku === sku
            ? {
                ...item,
                repricing: newValue,
              }
            : item,
        ),
      );
    } catch (error) {
      console.error(
        "Repricing update failed:",
        error,
      );
  
      alert(
        error instanceof Error
          ? error.message
          : "Unable to update repricing.",
      );
    }
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

    return products
      .filter((product) => {
        const matchesSearch =
          product.sku.toLowerCase().includes(term) ||
          product.asin.toLowerCase().includes(term) ||
          product.title.toLowerCase().includes(term);

        const matchesFulfillment =
          fulfillmentFilter === "ALL" ||
          product.fulfillment === fulfillmentFilter;

        const matchesStatFilter =
          statFilter === "ALL" ||
          (statFilter === "FBA" &&
            product.fulfillment === "FBA") ||
          (statFilter === "FBM" &&
            product.fulfillment === "FBM") ||
          (statFilter === "REPRICING" &&
            product.repricing);

        return (
          matchesSearch &&
          matchesFulfillment &&
          matchesStatFilter
        );
      })
      .sort((a, b) => {
        const aTime = a.createdDate ? new Date(a.createdDate).getTime() : 0;
        const bTime = b.createdDate ? new Date(b.createdDate).getTime() : 0;

        return dateSort === "NEWEST" ? bTime - aTime : aTime - bTime;
      });
  }, [
    products,
    search,
    fulfillmentFilter,
    dateSort,
    statFilter,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStart = (safeCurrentPage - 1) * pageSize;
  const visibleProducts = filteredProducts.slice(pageStart, pageStart + pageSize);

  const allVisibleSelected =
    visibleProducts.length > 0 &&
    visibleProducts.every((product) => selectedSkus.includes(product.sku));

  function toggleSelectAllVisible() {
    const visibleSkus = visibleProducts.map((product) => product.sku);

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

      const newMin =
        product.current === null
          ? null
          : product.current * (1 - minPercent / 100);
      const newMax =
        product.current === null
          ? null
          : product.current * (1 + maxPercent / 100);

      const newRepricing =
        bulkRepricing === "KEEP"
          ? product.repricing
          : bulkRepricing === "ON";

      return {
        ...product,
        newMin,
        newMax,
        newRepricing,
      };
    });

    async function applyBulkChanges() {
      const minPercent = Number(bulkMinPercent) || 0;
      const maxPercent = Number(bulkMaxPercent) || 0;
    
      const updates = products
        .filter(
          (product) =>
            selectedSkus.includes(product.sku) &&
            product.current !== null,
        )
        .map((product) => ({
          sku: product.sku,
    
          minPrice: Number(
            (
              product.current! *
              (1 - minPercent / 100)
            ).toFixed(2),
          ),
    
          maxPrice: Number(
            (
              product.current! *
              (1 + maxPercent / 100)
            ).toFixed(2),
          ),
        }));
    
      if (updates.length === 0) {
        return;
      }
    
      try {
        const response = await fetch(
          "/api/product-pricing-bulk",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              items: updates,
              repricingEnabled:
                bulkRepricing === "KEEP"
                  ? null
                  : bulkRepricing === "ON",
            }),
          },
        );
    
        const data = await response.json();
    
        if (!response.ok || !data.success) {
          throw new Error(
            data.error ||
              "Unable to save bulk pricing.",
          );
        }
    
        const updateMap = new Map(
          updates.map((item) => [item.sku, item]),
        );
    
        setProducts((currentProducts) =>
          currentProducts.map((product) => {
            const update = updateMap.get(product.sku);
    
            if (!update) {
              return product;
            }
    
            return {
              ...product,
              min: update.minPrice,
              max: update.maxPrice,
              status: "Ready",
              pricingRule:
                bulkRepricing === "ON"
                  ? "BUY_BOX"
                  : product.pricingRule,
              repricing:
                bulkRepricing === "KEEP"
                  ? product.repricing
                  : bulkRepricing === "ON",
            };
          }),
        );
    
        const {
          products: refreshedProducts,
          latestSync,
        } = await fetchStoredProducts();

        setProducts(refreshedProducts);

        if (latestSync) {
          setLastSync(
            new Date(latestSync).toLocaleTimeString(),
          );
        }

        setPreviewOpen(false);
        setBulkOpen(false);
        setSelectedSkus([]);
        setBulkRepricing("KEEP");
      } catch (error) {
        console.error(
          "Bulk pricing update failed:",
          error,
        );
    
        alert(
          error instanceof Error
            ? error.message
            : "Unable to save bulk pricing.",
        );
      }
    }

  const activeCount = products.filter((product) => product.repricing).length;
  const fbaCount = products.filter((product) => product.fulfillment === "FBA").length;
  const fbmCount = products.filter((product) => product.fulfillment === "FBM").length;
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
              href="/reports"
              className="block rounded-xl px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
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
              <h1 className="text-2xl font-semibold">Dashboard</h1>
              <p className="mt-1 text-sm text-slate-500">
                Amazon pricing overview
              </p>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-sm font-medium">Amazon Account</div>
                <div className="mt-1 text-xs text-slate-500">
                  {lastSync ? `Last sync: ${lastSync}` : "Not synced yet"}
                </div>
              </div>

              <button
                type="button"
                onClick={runPreview}
                disabled={repricingRunning || syncing}
                title="Dry run: calculates target prices without sending anything to Amazon"
                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              >
                {repricingRunning ? "Working..." : "Preview (Dry Run)"}
              </button>

              <button
                type="button"
                onClick={runReprice}
                disabled={repricingRunning || syncing || activeCount === 0}
                title={
                  activeCount === 0
                    ? "Turn Repricing ON for at least one product first"
                    : "Run live repricing for all products with Repricing ON"
                }
                className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              >
                {repricingRunning ? "Running Reprice..." : "Run Reprice"}
              </button>

              <button
                type="button"
                onClick={syncAmazon}
                disabled={syncing}
                className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                {syncing ? "Syncing Amazon..." : "Sync Amazon"}
              </button>
            </div>
          </header>

          <div className="p-8">
            <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              <StatCard
                title="Available SKUs"
                value={products.length.toString()}
                subtitle="Synced from Amazon"
                active={statFilter === "ALL"}
                onClick={() => {
                  setStatFilter("ALL");
                  setFulfillmentFilter("ALL");
                  setCurrentPage(1);
                }}
              />

              <StatCard
                title="FBA Available"
                value={fbaCount.toString()}
                subtitle="Amazon fulfilled"
                active={statFilter === "FBA"}
                onClick={() => {
                  setStatFilter("FBA");
                  setFulfillmentFilter("ALL");
                  setCurrentPage(1);
                }}
              />

              <StatCard
                title="FBM Available"
                value={fbmCount.toString()}
                subtitle="Merchant fulfilled"
                active={statFilter === "FBM"}
                onClick={() => {
                  setStatFilter("FBM");
                  setFulfillmentFilter("ALL");
                  setCurrentPage(1);
                }}
              />

              <StatCard
                title="Repricing Enabled"
                value={activeCount.toString()}
                subtitle="Currently active"
                active={statFilter === "REPRICING"}
                onClick={() => {
                  setStatFilter("REPRICING");
                  setFulfillmentFilter("ALL");
                  setCurrentPage(1);
                }}
              />
            </section>

            {(loadingProducts || syncing || syncError || lastSync) && (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm shadow-sm">
                {loadingProducts && !syncing && (
                  <div className="font-medium text-slate-700">
                    Loading products from Firestore...
                  </div>
                )}

                {syncing && (
                  <div className="font-medium text-slate-700">
                    Checking Amazon listings and inventory...
                  </div>
                )}

                {!loadingProducts && !syncing && syncError && (
                  <div className="font-medium text-red-700">
                    {syncError}
                  </div>
                )}

                {!loadingProducts && !syncing && !syncError && lastSync && (
                  <div className="text-slate-600">
                    {products.length} available listings loaded from Firestore
                    {amazonBuyableCount > 0
                      ? ` • ${amazonBuyableCount} Amazon BUYABLE listings checked`
                      : ""}
                    {syncDurationMs !== null
                      ? ` • ${(syncDurationMs / 1000).toFixed(1)} sec Amazon sync`
                      : ""}
                  </div>
                )}
              </div>
            )}

            {(repricingRunning || repricingError || repricingResult) && (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm shadow-sm">
                {repricingRunning && (
                  <div>
                    <div className="font-medium text-slate-700">
                      {repricingProgress
                        ? `Step ${repricingProgress.step} of ${repricingProgress.steps} • ` +
                          `${repricingProgress.done} of ${repricingProgress.total} products` +
                          (repricingProgress.waiting
                            ? " • waiting for Amazon rate limit..."
                            : "")
                        : "Working on products with Repricing ON..."}
                    </div>

                    {repricingProgress && (
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-slate-900 transition-all"
                          style={{
                            width: `${
                              repricingProgress.total > 0
                                ? Math.min(
                                    100,
                                    Math.round(
                                      (repricingProgress.done /
                                        repricingProgress.total) *
                                        100,
                                    ),
                                  )
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                    )}

                    <div className="mt-2 text-xs text-slate-500">
                      Keep this tab open until it finishes.
                    </div>
                  </div>
                )}

                {!repricingRunning && repricingError && (
                  <div className="font-medium text-red-700">
                    Repricing failed: {repricingError}
                  </div>
                )}

                {!repricingRunning && !repricingError && repricingResult && (
                  <div className="text-slate-700">
                    <span className="font-semibold">
                      {repricingResult.mode === "PREVIEW"
                        ? "Preview complete (nothing sent to Amazon)"
                        : "Repricing complete"}
                    </span>
                    {` • Checked: ${repricingResult.checked}`}
                    {repricingResult.mode === "PREVIEW"
                      ? ` • Would update: ${repricingResult.wouldUpdate}`
                      : ` • Updated: ${repricingResult.updated}`}
                    {` • No change: ${repricingResult.noChange}`}
                    {` • Skipped: ${repricingResult.skipped}`}
                    {repricingResult.mode === "LIVE" &&
                      ` • Failed: ${repricingResult.failed}`}
                    {repricingResult.durationMs !== null &&
                      ` • Took: ${(repricingResult.durationMs / 1000).toFixed(1)}s`}

                    {repricingResult.fetchErrors > 0 && (
                      <div className="mt-2 font-medium text-amber-700">
                        {`${repricingResult.fetchErrors} Amazon pricing batch(es) failed — see the report for details.`}
                      </div>
                    )}

                    <div className="mt-2">
                      <a
                        href="/reports"
                        className="text-sm font-medium text-slate-900 underline"
                      >
                        Open report
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}

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
                      onChange={(event) => {
                        setFulfillmentFilter(
                          event.target.value as "ALL" | Fulfillment,
                        );
                        setCurrentPage(1);
                      }}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-slate-500"
                    >
                      <option value="ALL">All</option>
                      <option value="FBA">FBA</option>
                      <option value="FBM">FBM</option>
                    </select>

                    <select
                      value={dateSort}
                      onChange={(event) => {
                        setDateSort(event.target.value as "NEWEST" | "OLDEST");
                        setCurrentPage(1);
                      }}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-slate-500"
                    >
                      <option value="NEWEST">Newest first</option>
                      <option value="OLDEST">Oldest first</option>
                    </select>

                    <select
                      value={pageSize}
                      onChange={(event) => {
                        setPageSize(Number(event.target.value) as 50 | 100 | 500);
                        setCurrentPage(1);
                      }}
                      className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-slate-500"
                    >
                      <option value={50}>50 / page</option>
                      <option value={100}>100 / page</option>
                      <option value={500}>500 / page</option>
                    </select>

                    <input
                      type="text"
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setCurrentPage(1);
                      }}
                      placeholder="Search SKU, ASIN or title"
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
                      <th className="px-6 py-4 font-medium">Created</th>
                      <th className="px-6 py-4 font-medium">Type</th>
                      <th className="px-6 py-4 font-medium">Qty</th>
                      <th className="px-6 py-4 font-medium">Current</th>
                      <th className="px-6 py-4 font-medium">Min</th>
                      <th className="px-6 py-4 font-medium">Max</th>
                      <th className="px-6 py-4 font-medium">Status</th>
<th className="px-6 py-4 font-medium">Rule</th>
<th className="px-6 py-4 font-medium">Repricing</th>
                      <th className="px-6 py-4 font-medium">Action</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-200">
                    {filteredProducts.length === 0 && (
                      <tr>
                        <td colSpan={13} className="px-6 py-12 text-center text-sm text-slate-500">
                          {loadingProducts
                            ? "Loading products from Firestore..."
                            : products.length === 0
                              ? "No available products found in Firestore."
                              : "No products match the current filters."}
                        </td>
                      </tr>
                    )}

                    {visibleProducts.map((product) => (
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

                        <td className="px-6 py-4">
  {product.asin ? (
    <a
      href={`https://www.amazon.com/dp/${product.asin}`}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-blue-600 hover:underline"
    >
      {product.asin}
    </a>
  ) : (
    <span className="text-slate-400">—</span>
  )}
</td>

                        <td className="whitespace-nowrap px-6 py-4 text-slate-500">
                          {formatDate(product.createdDate)}
                        </td>

                        <td className="px-6 py-4">
                          <span className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium">
                            {product.fulfillment}
                          </span>
                        </td>

                        <td className="px-6 py-4 text-slate-600">
                          {product.availableQty}
                        </td>

                        <td className="px-6 py-4">
                          {formatPrice(product.current)}
                        </td>

                        <td className="px-6 py-4 text-slate-600">
                          {formatPrice(product.min)}
                        </td>

                        <td className="px-6 py-4 text-slate-600">
                          {formatPrice(product.max)}
                        </td>

                        <td className="px-6 py-4">
                          <StatusBadge status={product.status} />
                        </td>

                        <td className="px-6 py-4">
  <select
    value={product.pricingRule ?? ""}
    onChange={(event) => {
      if (event.target.value === "BUY_BOX") {
        void updatePricingRule(
          product.sku,
          "BUY_BOX",
        );
      }
    }}
    className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium outline-none focus:border-slate-500"
  >
    <option value="" disabled>
      Select rule
    </option>

    <option value="BUY_BOX">
      Buy Box
    </option>
  </select>
</td>

                        <td className="px-6 py-4">
                        <button
  type="button"
  onClick={() => toggleRepricing(product.sku)}
  disabled={
    product.min === null ||
    product.max === null ||
    product.pricingRule === null
  }
  title={
    product.min === null || product.max === null
      ? "Set Min and Max before enabling repricing"
      : product.pricingRule === null
        ? "Select a pricing rule before enabling repricing"
        : undefined
  }
  className={`relative h-7 w-12 rounded-full transition ${
    product.repricing
      ? "bg-slate-950"
      : "bg-slate-300"
  } disabled:cursor-not-allowed disabled:opacity-50`}
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

              <div className="flex flex-col gap-3 border-t border-slate-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm text-slate-500">
                  {filteredProducts.length === 0
                    ? "0 products"
                    : `${pageStart + 1}-${Math.min(pageStart + pageSize, filteredProducts.length)} of ${filteredProducts.length} products`}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    disabled={safeCurrentPage <= 1}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>

                  <span className="px-2 text-sm text-slate-600">
                    Page {safeCurrentPage} of {totalPages}
                  </span>

                  <button
                    type="button"
                    onClick={() =>
                      setCurrentPage((page) => Math.min(totalPages, page + 1))
                    }
                    disabled={safeCurrentPage >= totalPages}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
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
              value={formatPrice(editingProduct.current)}
              disabled
            />


            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Min Price
              </label>

              <div className="grid grid-cols-[1fr_120px] gap-3">
                <div>
                  <div className="mb-1 text-xs text-slate-400">
                    Dollar amount
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={minPrice}
                    onChange={(event) =>
                      handleMinPriceChange(event.target.value)
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-slate-500"
                  />
                </div>

                <div>
                  <div className="mb-1 text-xs text-slate-400">
                    % below current
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={minPercentInput}
                      disabled={
                        editingProduct.current === null ||
                        editingProduct.current <= 0
                      }
                      onChange={(event) =>
                        handleMinPercentChange(event.target.value)
                      }
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 pr-8 text-sm outline-none focus:border-slate-500 disabled:bg-slate-100 disabled:text-slate-400"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                      %
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Max Price
              </label>

              <div className="grid grid-cols-[1fr_120px] gap-3">
                <div>
                  <div className="mb-1 text-xs text-slate-400">
                    Dollar amount
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={maxPrice}
                    onChange={(event) =>
                      handleMaxPriceChange(event.target.value)
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-slate-500"
                  />
                </div>

                <div>
                  <div className="mb-1 text-xs text-slate-400">
                    % above current
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={maxPercentInput}
                      disabled={
                        editingProduct.current === null ||
                        editingProduct.current <= 0
                      }
                      onChange={(event) =>
                        handleMaxPercentChange(event.target.value)
                      }
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 pr-8 text-sm outline-none focus:border-slate-500 disabled:bg-slate-100 disabled:text-slate-400"
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                      %
                    </span>
                  </div>
                </div>
              </div>
            </div>
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

            <div>
              <label className="mb-2 block text-sm font-medium">
                Repricing
              </label>

              <select
                value={bulkRepricing}
                onChange={(event) =>
                  setBulkRepricing(
                    event.target.value as "KEEP" | "ON" | "OFF",
                  )
                }
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none focus:border-slate-500"
              >
                <option value="KEEP">Keep current setting</option>
                <option value="ON">Turn repricing ON</option>
                <option value="OFF">Turn repricing OFF</option>
              </select>

              <div className="mt-1.5 text-xs text-slate-400">
                Applies to all selected products that have a current price.
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
                    <th className="px-6 py-4">Old Repricing</th>
                    <th className="px-6 py-4">New Repricing</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-200">
                  {previewProducts.map((product) => (
                    <tr key={product.sku}>
                      <td className="px-6 py-4 font-medium">
                        {product.sku}
                      </td>

                      <td className="px-6 py-4">
                        {formatPrice(product.current)}
                      </td>

                      <td className="px-6 py-4 text-slate-500">
                        {formatPrice(product.min)}
                      </td>

                      <td className="px-6 py-4 font-medium">
                        {formatPrice(product.newMin)}
                      </td>

                      <td className="px-6 py-4 text-slate-500">
                        {formatPrice(product.max)}
                      </td>

                      <td className="px-6 py-4 font-medium">
                        {formatPrice(product.newMax)}
                      </td>

                      <td className="px-6 py-4 text-slate-500">
                        {product.repricing ? "ON" : "OFF"}
                      </td>

                      <td className="px-6 py-4 font-medium">
                        {product.newRepricing ? "ON" : "OFF"}
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

function formatDate(value: string | null) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatPrice(value: number | null) {
  return value === null ? "—" : `$${value.toFixed(2)}`;
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
  active,
  onClick,
}: {
  title: string;
  value: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border p-6 text-left shadow-sm transition ${
        active
          ? "border-slate-950 bg-slate-950 text-white"
          : "border-slate-200 bg-white hover:border-slate-400 hover:shadow-md"
      }`}
    >
      <div
        className={`text-sm font-medium ${
          active ? "text-slate-300" : "text-slate-500"
        }`}
      >
        {title}
      </div>

      <div className="mt-3 text-3xl font-semibold tracking-tight">
        {value}
      </div>

      <div
        className={`mt-2 text-sm ${
          active ? "text-slate-400" : "text-slate-400"
        }`}
      >
        {subtitle}
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const className =
    status === "Price Error" || status === "Price Missing"
      ? "bg-red-50 text-red-700"
      : status === "Needs Setup"
        ? "bg-amber-50 text-amber-700"
        : "bg-emerald-50 text-emerald-700";

  return (
    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${className}`}>
      {status}
    </span>
  );
}