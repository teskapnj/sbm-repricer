import { db } from "@/lib/firebase-admin";
import { AMAZON_RATE_LIMITS } from "@/lib/amazon-rate-limit";

import {
  BuyBox,
  Condition,
  FetchError,
  computeTarget,
  getAccessToken,
  getNewBuyBoxes,
  getUsedBuyBoxes,
  mapWithConcurrency,
  normalizeCondition,
  numberOrNull,
  submitPrice,
} from "@/lib/amazon-pricing";

const PRODUCTS_COLLECTION = "sbm_repricer_products";
const REPORTS_COLLECTION = "sbm_repricer_repricing_reports";

// Amazon Listings Items PATCH is rate limited; keep this low.
const SUBMIT_CONCURRENCY = 4;

// A single invocation must finish inside the route's maxDuration (300 s).
// New Buy Box fetching is paced at ~30 s per 20 ASINs, so a chunk is capped at
// 100 products (5 batches, ~150 s) to leave room for the price submissions.
export const CYCLE_CHUNK_SIZE = 100;

// Same pacing the batch fetchers use between two calls (see
// getAmazonRequestDelayMs): one full rate-limit window plus a 250 ms margin.
const NEW_RATE_WINDOW_MS =
  Math.ceil(1000 / AMAZON_RATE_LIMITS.competitiveSummary) + 250;
const USED_RATE_WINDOW_MS =
  Math.ceil(1000 / AMAZON_RATE_LIMITS.itemOffersBatch) + 250;

export type CycleAction =
  | "WOULD_UPDATE"
  | "NO_CHANGE"
  | "SKIP"
  | "FBM_NEEDS_OWN_SHIPPING"
  | "INVALID_SETUP"
  | "PRICE_SUBMITTED"
  | "VALIDATION_FAILED"
  | "AMAZON_UPDATE_FAILED";

export type CycleItem = {
  sku: string | null;
  asin: string | null;
  condition: Condition | null;
  fulfillment: string | null;

  currentPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  fulfillableQty?: number | null;

  buyBoxAvailable: boolean;
  buyBox?: BuyBox;
  buyBoxIsOurs?: boolean;

  targetLandedPrice?: number;
  clampReason?: string;

  action: CycleAction;
  reason?: string;

  amazonUpdated: boolean;
  amazonStatusCode?: number;
  amazonResponse?: any;
};

export type CycleChunk = {
  // 0-based position of this chunk and how many the whole run needs.
  index: number;
  total: number;
  // Products that qualify for this run across all chunks.
  totalActive: number;
  // Pass back as `cursor` to get the next chunk; null when this was the last.
  nextCursor: string | null;
  // How long the caller should wait before requesting the next chunk so the
  // first New/Used batch does not hit Amazon's rate limit (a 429 still costs quota).
  waitBeforeNextMs: number;
};

export type CycleResult = {
  success: boolean;
  dryRun: boolean;
  live: boolean;

  chunk?: CycleChunk;

  activeProducts: number;
  newProducts: number;
  usedProducts: number;

  counts: Record<string, number>;

  liveSummary?: {
    candidates: number;
    submitted: number;
    failed: number;
  };

  fetchErrors: FetchError[];

  items: CycleItem[];

  amazonUpdated: boolean;

  durationMs: number;
};

function countActions(items: CycleItem[]) {
  const total = (action: CycleAction) =>
    items.filter((item) => item.action === action).length;

  // Keys kept in the shape the reports page already reads.
  return {
    wouldUpdate: total("WOULD_UPDATE"),
    noChange: total("NO_CHANGE"),
    skipped: total("SKIP"),
    fbmNeedsShipping: total("FBM_NEEDS_OWN_SHIPPING"),
    invalidSetup: total("INVALID_SETUP"),
    priceSubmitted: total("PRICE_SUBMITTED"),
    validationFailed: total("VALIDATION_FAILED"),
    amazonUpdateFailed: total("AMAZON_UPDATE_FAILED"),
  };
}

/**
 * Trimmed copy of the result so a report document stays well
 * under Firestore's 1 MB document limit.
 */
function buildReportDocument(result: CycleResult, source: string) {
  const createdAtMs = Date.now();

  return {
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    source,

    result: {
      success: result.success,
      dryRun: result.dryRun,
      live: result.live,

      activeProducts: result.activeProducts,
      newProducts: result.newProducts,
      usedProducts: result.usedProducts,

      counts: result.counts,
      liveSummary: result.liveSummary ?? null,

      fetchErrors: result.fetchErrors.slice(0, 20),

      durationMs: result.durationMs,

      items: result.items.slice(0, 400).map((item) => ({
        sku: item.sku,
        asin: item.asin,
        condition: item.condition,
        fulfillment: item.fulfillment,

        currentPrice: item.currentPrice,
        minPrice: item.minPrice,
        maxPrice: item.maxPrice,

        buyBoxLandedPrice: item.buyBox?.landedPrice ?? null,
        buyBoxSellerId: item.buyBox?.sellerId ?? null,
        buyBoxIsOurs: item.buyBoxIsOurs ?? null,

        targetLandedPrice: item.targetLandedPrice ?? null,
        clampReason: item.clampReason ?? null,

        action: item.action,
        reason: item.reason ?? null,

        amazonUpdated: item.amazonUpdated,
        amazonStatusCode: item.amazonStatusCode ?? null,
      })),

      itemsTruncated: result.items.length > 400,

      // Compatibility shape for the per-SKU detail view.
      liveResults: result.items
        .filter(
          (item) =>
            item.action === "PRICE_SUBMITTED" ||
            item.action === "VALIDATION_FAILED" ||
            item.action === "AMAZON_UPDATE_FAILED",
        )
        .slice(0, 400)
        .map((item) => ({
          sku: item.sku,
          asin: item.asin,
          action: item.action,
          targetPrice: item.targetLandedPrice ?? null,
          success: item.action === "PRICE_SUBMITTED",
          httpStatus: item.amazonStatusCode ?? null,
        })),
    },
  };
}

export async function saveRepricingReport(
  result: CycleResult,
  source: string,
) {
  try {
    const reference = await db
      .collection(REPORTS_COLLECTION)
      .add(buildReportDocument(result, source));

    return reference.id;
  } catch (error) {
    // A failed report must never fail the cycle itself.
    console.error("Unable to save repricing report:", error);
    return null;
  }
}

/**
 * Picks the window of products for one chunk: products are ordered by SKU and
 * the window starts right after `cursor` (null = from the start). Exported for
 * testing; runRepricingCycle is the only production caller.
 */
export function planChunk<T extends { sku?: unknown }>(
  products: T[],
  cursor: string | null,
  size: number = CYCLE_CHUNK_SIZE,
) {
  const skuOf = (product: T | undefined) =>
    typeof product?.sku === "string" ? product.sku : "";

  const ordered = [...products].sort((a, b) =>
    skuOf(a) < skuOf(b) ? -1 : skuOf(a) > skuOf(b) ? 1 : 0,
  );

  const remaining =
    cursor === null
      ? ordered
      : ordered.filter((product) => skuOf(product) > cursor);

  const window = remaining.slice(0, size);

  return {
    products: window,
    plan: {
      index: Math.floor((ordered.length - remaining.length) / size),
      total: Math.max(1, Math.ceil(ordered.length / size)),
      totalActive: ordered.length,
      nextCursor:
        remaining.length > size ? skuOf(window[window.length - 1]) : null,
    },
  };
}

/**
 * Runs one repricing cycle.
 *
 * Without `chunk` every qualifying product is processed in this call (cron,
 * small catalogs). With `chunk` only the next CYCLE_CHUNK_SIZE products after
 * `cursor` (ordered by SKU) are processed and `result.chunk` says how to ask
 * for the following ones, so a caller can walk the whole inventory in several
 * invocations that each fit inside maxDuration. The cursor is a SKU rather
 * than an offset, so products toggled between chunks do not shift the window.
 */
export async function runRepricingCycle(options: {
  live: boolean;
  source: string;
  chunk?: { cursor: string | null };
}): Promise<CycleResult> {
  const startedAtMs = Date.now();
  const { live, chunk } = options;

  const snapshot = await db
    .collection(PRODUCTS_COLLECTION)
    .where("repricingEnabled", "==", true)
    .get();

  const qualifyingProducts = snapshot.docs
    .map((doc) => doc.data())
    .filter((product) => product?.pricingRule === "BUY_BOX");

  let activeProducts = qualifyingProducts;
  let chunkPlan: Omit<CycleChunk, "waitBeforeNextMs"> | null = null;

  if (chunk) {
    const planned = planChunk(qualifyingProducts, chunk.cursor);

    activeProducts = planned.products;
    chunkPlan = planned.plan;
  }

  // Tell a multi-chunk run apart in the reports list.
  const source = chunkPlan
    ? `${options.source} (part ${chunkPlan.index + 1}/${chunkPlan.total})`
    : options.source;

  if (activeProducts.length === 0) {
    const emptyResult: CycleResult = {
      success: true,
      dryRun: !live,
      live,
      chunk: chunkPlan ? { ...chunkPlan, waitBeforeNextMs: 0 } : undefined,
      activeProducts: 0,
      newProducts: 0,
      usedProducts: 0,
      counts: {},
      fetchErrors: [],
      items: [],
      amazonUpdated: false,
      durationMs: Date.now() - startedAtMs,
    };

    await saveRepricingReport(emptyResult, source);

    return emptyResult;
  }

  const newAsins: string[] = [];
  const usedAsins: string[] = [];

  for (const product of activeProducts) {
    const asin = typeof product?.asin === "string" ? product.asin : "";
    const condition = normalizeCondition(product?.condition);

    if (!asin || !condition) {
      continue;
    }

    if (condition === "New") {
      newAsins.push(asin);
    } else {
      usedAsins.push(asin);
    }
  }

  const accessToken = await getAccessToken();

  const [newResult, usedResult] = await Promise.all([
    newAsins.length > 0
      ? getNewBuyBoxes(newAsins, accessToken)
      : Promise.resolve({
          buyBoxes: new Map<string, BuyBox>(),
          errors: [] as FetchError[],
        }),

    usedAsins.length > 0
      ? getUsedBuyBoxes(usedAsins, accessToken)
      : Promise.resolve({
          buyBoxes: new Map<string, BuyBox>(),
          errors: [] as FetchError[],
        }),
  ]);

  const fetchDoneAtMs = Date.now();

  // The next chunk starts with a fresh burst-of-1 call, so it must not go out
  // before the rate-limit window of the last call in this chunk has passed.
  // Time spent submitting prices below already counts towards that window.
  const rateWindowMs =
    newAsins.length > 0
      ? NEW_RATE_WINDOW_MS
      : usedAsins.length > 0
        ? USED_RATE_WINDOW_MS
        : 0;

  const chunkResult = (): CycleChunk | undefined =>
    chunkPlan
      ? {
          ...chunkPlan,
          waitBeforeNextMs: chunkPlan.nextCursor
            ? Math.max(0, rateWindowMs - (Date.now() - fetchDoneAtMs))
            : 0,
        }
      : undefined;

  const newBuyBoxes = newResult.buyBoxes;
  const usedBuyBoxes = usedResult.buyBoxes;
  const fetchErrors = [...newResult.errors, ...usedResult.errors];

  const ourSellerId = process.env.AMAZON_SELLER_ID ?? null;

  // ----------------------------------------------------------
  // DECISION
  // ----------------------------------------------------------

  const items: CycleItem[] = activeProducts.map((product) => {
    const sku = product?.sku ?? null;
    const asin = product?.asin ?? null;
    const condition = normalizeCondition(product?.condition);
    const fulfillment = product?.fulfillment ?? null;

    const currentPrice = numberOrNull(product?.currentPrice);
    const fulfillableQty = numberOrNull(product?.fulfillableQty);
    const lastPriceSubmitted = numberOrNull(product?.lastPriceSubmitted);
    const minPrice = numberOrNull(product?.minPrice);
    const maxPrice = numberOrNull(product?.maxPrice);

    if (!sku || !asin || !condition || minPrice === null || maxPrice === null) {
      return {
        sku,
        asin,
        condition,
        fulfillment,
        currentPrice,
        minPrice,
        maxPrice,
        buyBoxAvailable: false,
        action: "INVALID_SETUP",
        reason: "Missing SKU, ASIN, condition, Min, or Max.",
        amazonUpdated: false,
      };
    }

    const buyBox =
      condition === "New" ? newBuyBoxes.get(asin) : usedBuyBoxes.get(asin);

    if (!buyBox) {
      return {
        sku,
        asin,
        condition,
        fulfillment,
        currentPrice,
        minPrice,
        maxPrice,
        buyBoxAvailable: false,
        action: "SKIP",
        reason: `No ${condition} Buy Box.`,
        amazonUpdated: false,
      };
    }

    const { buyBoxIsOurs, targetPrice, clampReason } = computeTarget({
      condition,
      buyBox,
      minPrice,
      maxPrice,
      ourSellerId,
    });

    const base = {
      sku,
      asin,
      condition,
      fulfillment,
      currentPrice,
      minPrice,
      maxPrice,
      fulfillableQty,
      buyBoxAvailable: true as const,
      buyBox,
      buyBoxIsOurs,
      targetLandedPrice: targetPrice,
      clampReason,
      amazonUpdated: false,
    };

    if (fulfillment !== "FBA") {
      return {
        ...base,
        action: "FBM_NEEDS_OWN_SHIPPING",
      };
    }

    if (fulfillableQty === null || fulfillableQty <= 0) {
      return {
        ...base,
        action: "SKIP",
        reason: "No fulfillable FBA inventory.",
      };
    }

    const sameCurrentPrice =
      currentPrice !== null &&
      Number(currentPrice.toFixed(2)) === targetPrice;

    const sameLastSubmittedPrice =
      lastPriceSubmitted !== null &&
      Number(lastPriceSubmitted.toFixed(2)) === targetPrice;

    return {
      ...base,
      action:
        sameCurrentPrice || sameLastSubmittedPrice
          ? "NO_CHANGE"
          : "WOULD_UPDATE",
    };
  });

  // ----------------------------------------------------------
  // PREVIEW STOPS HERE
  // ----------------------------------------------------------

  if (!live) {
    const previewResult: CycleResult = {
      success: fetchErrors.length === 0,
      dryRun: true,
      live: false,
      chunk: chunkResult(),
      activeProducts: activeProducts.length,
      newProducts: newAsins.length,
      usedProducts: usedAsins.length,
      counts: countActions(items),
      fetchErrors,
      items,
      amazonUpdated: false,
      durationMs: Date.now() - startedAtMs,
    };

    await saveRepricingReport(previewResult, source);

    return previewResult;
  }

  // ----------------------------------------------------------
  // LIVE SUBMISSION
  //
  // The buy-box data was already fetched in batch above, so each
  // SKU costs only the Listings PATCH calls. No self-HTTP hop,
  // no repeated token request, no repeated pricing lookup.
  // ----------------------------------------------------------

  const sellerId = process.env.AMAZON_SELLER_ID;

  if (!sellerId) {
    throw new Error("AMAZON_SELLER_ID is missing.");
  }

  const productBySku = new Map<string, any>();

  for (const product of activeProducts) {
    if (typeof product?.sku === "string") {
      productBySku.set(product.sku, product);
    }
  }

  const candidates = items.filter(
    (item) => item.action === "WOULD_UPDATE" && item.sku,
  );

  await mapWithConcurrency(candidates, SUBMIT_CONCURRENCY, async (item) => {
    const sku = item.sku as string;
    const product = productBySku.get(sku);

    const productType =
      typeof product?.productType === "string" &&
      product.productType.trim().length > 0
        ? product.productType
        : null;

    if (!productType) {
      item.action = "VALIDATION_FAILED";
      item.reason = "Amazon productType is missing.";
      return;
    }

    if (product?.available !== true) {
      item.action = "SKIP";
      item.reason = "Product is not available.";
      return;
    }

    const targetPrice = item.targetLandedPrice as number;

    try {
      const submission = await submitPrice({
        sku,
        sellerId,
        productType,
        targetPrice,
        accessToken,
      });

      if (!submission.ok) {
        item.action = submission.action;
        item.amazonStatusCode = submission.statusCode;
        item.amazonResponse = submission.amazonResponse;
        return;
      }

      item.action = "PRICE_SUBMITTED";
      item.amazonUpdated = true;
      item.amazonResponse = submission.amazonResponse;

      // currentPrice is intentionally not overwritten:
      // Amazon submissions are asynchronous.
      const documentId = Buffer.from(sku).toString("base64url");

      await db
        .collection(PRODUCTS_COLLECTION)
        .doc(documentId)
        .set(
          {
            lastPriceSubmitted: targetPrice,
            lastPriceSubmissionId:
              submission.amazonResponse?.submissionId ?? null,
            lastPriceSubmissionStatus:
              submission.amazonResponse?.status ?? null,
            lastPriceSubmittedAt: new Date().toISOString(),
          },
          { merge: true },
        );
    } catch (error) {
      item.action = "AMAZON_UPDATE_FAILED";
      item.reason =
        error instanceof Error ? error.message : "Submission failed.";
    }
  });

  const submitted = items.filter(
    (item) => item.action === "PRICE_SUBMITTED",
  ).length;

  const failed = items.filter(
    (item) =>
      item.action === "VALIDATION_FAILED" ||
      item.action === "AMAZON_UPDATE_FAILED",
  ).length;

  const liveResult: CycleResult = {
    success: failed === 0 && fetchErrors.length === 0,
    dryRun: false,
    live: true,

    chunk: chunkResult(),

    activeProducts: activeProducts.length,
    newProducts: newAsins.length,
    usedProducts: usedAsins.length,

    counts: countActions(items),

    liveSummary: {
      candidates: candidates.length,
      submitted,
      failed,
    },

    fetchErrors,
    items,

    amazonUpdated: submitted > 0,

    durationMs: Date.now() - startedAtMs,
  };

  await saveRepricingReport(liveResult, source);

  return liveResult;
}