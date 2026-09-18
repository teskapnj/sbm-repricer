import { db } from "@/lib/firebase-admin";

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

export type CycleResult = {
  success: boolean;
  dryRun: boolean;
  live: boolean;

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

export async function runRepricingCycle(options: {
  live: boolean;
  source: string;
}): Promise<CycleResult> {
  const startedAtMs = Date.now();
  const { live, source } = options;

  const snapshot = await db
    .collection(PRODUCTS_COLLECTION)
    .where("repricingEnabled", "==", true)
    .get();

  const activeProducts = snapshot.docs
    .map((doc) => doc.data())
    .filter((product) => product?.pricingRule === "BUY_BOX");

  if (activeProducts.length === 0) {
    const emptyResult: CycleResult = {
      success: true,
      dryRun: !live,
      live,
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