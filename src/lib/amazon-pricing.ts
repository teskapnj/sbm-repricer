// src/lib/amazon-pricing.ts
import {
  AMAZON_RATE_LIMITS,
  amazonFetchWithRetry,
  sleep,
} from "@/lib/amazon-rate-limit";

// ============================================================
// CONSTANTS
// ============================================================

export const MARKETPLACE_ID = "ATVPDKIKX0DER";

export const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";

export const USER_AGENT = "SBM-Repricer/0.1 (Language=TypeScript)";

// getCompetitiveSummary accepts a maximum of 20 ASINs per batch.
// (The 40 limit belongs to getFeaturedOfferExpectedPriceBatch,
// a different operation.) Rate is 0.033 rps, one call per ~30s.
export const NEW_BATCH_SIZE = 20;

// getItemOffersBatch accepts up to 20 requests per batch
// at 0.1 rps (one call per ~10s).
export const USED_BATCH_SIZE = 20;

// ============================================================
// TYPES
// ============================================================

export type Condition = "New" | "Used";

export type BuyBox = {
  source: "COMPETITIVE_SUMMARY" | "ITEM_OFFERS";
  sellerId: string | null;
  condition: Condition;
  listingPrice: number;
  shippingPrice: number;
  landedPrice: number;
  fulfillmentType: string | null;
  subCondition?: string | null;
  isBuyBoxWinner?: boolean;
};

export type FetchError = {
  scope: "NEW" | "USED";
  batchIndex: number;
  status: number;
  message: string;
};

export type BuyBoxFetchResult = {
  buyBoxes: Map<string, BuyBox>;
  errors: FetchError[];
};

// ============================================================
// SMALL HELPERS
// ============================================================

export function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export function normalizeCondition(condition: unknown): Condition | null {
  const value = String(condition || "").toLowerCase();

  if (value.startsWith("new")) {
    return "New";
  }

  if (value.startsWith("used")) {
    return "Used";
  }

  return null;
}

export function numberOrNull(value: unknown) {
  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

export function getDefaultShippingPrice(offer: any) {
  const shippingOptions = Array.isArray(offer?.shippingOptions)
    ? offer.shippingOptions
    : [];

  const defaultShipping = shippingOptions.find(
    (shipping: any) => shipping?.shippingOptionType === "DEFAULT",
  );

  return numberOrNull(defaultShipping?.price?.amount) ?? 0;
}

export function getOfferWeight(offer: any) {
  const segments = Array.isArray(offer?.featuredOfferSegments)
    ? offer.featuredOfferSegments
    : [];

  return segments.reduce(
    (total: number, segment: any) =>
      total +
      Number(segment?.segmentDetails?.glanceViewWeightPercentage || 0),
    0,
  );
}

/**
 * Runs an async worker over a list with a bounded number of
 * parallel workers, keeping the output in input order.
 */
export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);

  return results;
}

// ============================================================
// ACCESS TOKEN (cached per warm instance)
// ============================================================

let cachedToken: { value: string; expiresAtMs: number } | null = null;

export async function getAccessToken(forceRefresh = false) {
  const now = Date.now();

  if (
    !forceRefresh &&
    cachedToken &&
    cachedToken.expiresAtMs > now + 60_000
  ) {
    return cachedToken.value;
  }

  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Amazon environment variables are missing.");
  }

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",

    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded;charset=UTF-8",
    },

    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),

    cache: "no-store",
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Unable to get Amazon access token.");
  }

  const expiresInSeconds = Number(data.expires_in) || 3600;

  cachedToken = {
    value: data.access_token as string,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };

  return cachedToken.value;
}

// ============================================================
// NEW BUY BOX — BATCH
// ============================================================

export async function getNewBuyBoxes(
  asins: string[],
  accessToken: string,
): Promise<BuyBoxFetchResult> {
  const buyBoxes = new Map<string, BuyBox>();
  const errors: FetchError[] = [];

  const batches = chunkArray([...new Set(asins)], NEW_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    const { response, rateLimitRps, nextDelayMs } =
      await amazonFetchWithRetry(
        `${SP_API_BASE}/batches/products/pricing/2022-05-01/items/competitiveSummary`,
        {
          method: "POST",

          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-amz-access-token": accessToken,
            "user-agent": USER_AGENT,
          },

          body: JSON.stringify({
            requests: batch.map((asin) => ({
              asin,
              marketplaceId: MARKETPLACE_ID,
              includedData: ["featuredBuyingOptions"],
              method: "GET",
              uri: "/products/pricing/2022-05-01/items/competitiveSummary",
            })),
          }),

          cache: "no-store",
        },

        AMAZON_RATE_LIMITS.competitiveSummary,
      );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      // Do NOT throw: one bad batch must not kill the whole cycle.
      errors.push({
        scope: "NEW",
        batchIndex,
        status: response.status,
        message: JSON.stringify(data ?? {}).slice(0, 500),
      });

      if (batchIndex < batches.length - 1) {
        await sleep(nextDelayMs);
      }

      continue;
    }

    console.log(
      `[NEW] Batch ${batchIndex + 1}/${batches.length} | ` +
        `${batch.length} ASIN | rate=${rateLimitRps} rps`,
    );

    const responses = Array.isArray(data?.responses) ? data.responses : [];

    responses.forEach((responseItem: any, index: number) => {
      const asin =
        responseItem?.body?.asin ??
        responseItem?.request?.asin ??
        batch[index];

      if (!asin) {
        return;
      }

      const options = Array.isArray(
        responseItem?.body?.featuredBuyingOptions,
      )
        ? responseItem.body.featuredBuyingOptions
        : [];

      const newOption = options.find(
        (option: any) =>
          String(option?.buyingOptionType || "").toLowerCase() === "new",
      );

      const offers = Array.isArray(newOption?.segmentedFeaturedOffers)
        ? newOption.segmentedFeaturedOffers
        : [];

      if (offers.length === 0) {
        return;
      }

      const selectedOffer = [...offers].sort(
        (a, b) => getOfferWeight(b) - getOfferWeight(a),
      )[0];

      const listingPrice = numberOrNull(selectedOffer?.listingPrice?.amount);

      if (listingPrice === null) {
        return;
      }

      const shippingPrice = getDefaultShippingPrice(selectedOffer);

      buyBoxes.set(asin, {
        source: "COMPETITIVE_SUMMARY",
        sellerId: selectedOffer?.sellerId || null,
        condition: "New",
        listingPrice,
        shippingPrice,
        landedPrice: Number((listingPrice + shippingPrice).toFixed(2)),
        fulfillmentType: selectedOffer?.fulfillmentType || null,
      });
    });

    if (batchIndex < batches.length - 1) {
      await sleep(nextDelayMs);
    }
  }

  return { buyBoxes, errors };
}

// ============================================================
// USED LOWEST OFFER — BATCH
// ============================================================

type PricedOffer = {
  offer: any;
  listingPrice: number;
  shippingPrice: number;
  landedPrice: number;
};

export async function getUsedBuyBoxes(
  asins: string[],
  accessToken: string,
): Promise<BuyBoxFetchResult> {
  const buyBoxes = new Map<string, BuyBox>();
  const errors: FetchError[] = [];

  const batches = chunkArray([...new Set(asins)], USED_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    // Uses the same retry/backoff path as the NEW branch.
    const { response, rateLimitRps, nextDelayMs } =
      await amazonFetchWithRetry(
        `${SP_API_BASE}/batches/products/pricing/v0/itemOffers`,
        {
          method: "POST",

          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-amz-access-token": accessToken,
            "user-agent": USER_AGENT,
          },

          body: JSON.stringify({
            requests: batch.map((asin) => ({
              uri: `/products/pricing/v0/items/${encodeURIComponent(
                asin,
              )}/offers`,
              method: "GET",
              MarketplaceId: MARKETPLACE_ID,
              ItemCondition: "Used",
              CustomerType: "Consumer",
            })),
          }),

          cache: "no-store",
        },

        AMAZON_RATE_LIMITS.itemOffersBatch,
      );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      errors.push({
        scope: "USED",
        batchIndex,
        status: response.status,
        message: JSON.stringify(data ?? {}).slice(0, 500),
      });

      if (batchIndex < batches.length - 1) {
        await sleep(nextDelayMs);
      }

      continue;
    }

    console.log(
      `[USED] Batch ${batchIndex + 1}/${batches.length} | ` +
        `${batch.length} ASIN | rate=${rateLimitRps} rps`,
    );

    const responses = Array.isArray(data?.responses) ? data.responses : [];

    responses.forEach((responseItem: any, index: number) => {
      const payload =
        responseItem?.body?.payload ?? responseItem?.body?.Payload ?? null;

      if (!payload) {
        return;
      }

      const responseAsin =
        payload?.Identifier?.ASIN ??
        payload?.identifier?.asin ??
        batch[index];

      if (!responseAsin) {
        return;
      }

      const offers = Array.isArray(payload?.Offers)
        ? payload.Offers
        : Array.isArray(payload?.offers)
          ? payload.offers
          : [];

      const pricedOffers: PricedOffer[] = offers
        .map((offer: any): PricedOffer | null => {
          const listingPrice = numberOrNull(
            offer?.ListingPrice?.Amount ?? offer?.listingPrice?.amount,
          );

          if (listingPrice === null) {
            return null;
          }

          const shippingPrice =
            numberOrNull(
              offer?.Shipping?.Amount ?? offer?.shipping?.amount,
            ) ?? 0;

          return {
            offer,
            listingPrice,
            shippingPrice,
            landedPrice: Number(
              (listingPrice + shippingPrice).toFixed(2),
            ),
          };
        })
        .filter((item: PricedOffer | null): item is PricedOffer =>
          item !== null,
        )
        .sort(
          (a: PricedOffer, b: PricedOffer) => a.landedPrice - b.landedPrice,
        );

      const lowest = pricedOffers[0];

      if (!lowest) {
        return;
      }

      const lowestOffer = lowest.offer;

      buyBoxes.set(responseAsin, {
        source: "ITEM_OFFERS",

        sellerId: lowestOffer?.SellerId ?? lowestOffer?.sellerId ?? null,

        condition: "Used",

        subCondition:
          lowestOffer?.SubCondition ?? lowestOffer?.subCondition ?? null,

        listingPrice: lowest.listingPrice,
        shippingPrice: lowest.shippingPrice,
        landedPrice: lowest.landedPrice,

        fulfillmentType:
          lowestOffer?.IsFulfilledByAmazon === true ||
          lowestOffer?.isFulfilledByAmazon === true
            ? "FBA"
            : "FBM",

        isBuyBoxWinner: false,
      });
    });

    if (batchIndex < batches.length - 1) {
      await sleep(nextDelayMs);
    }
  }

  return { buyBoxes, errors };
}

// ============================================================
// TARGET PRICE
//
// NEW:
// - Competitor owns Buy Box -> 1% below landed Buy Box.
// - We own Buy Box          -> keep the same landed price.
//
// USED:
// - Ignore Buy Box, match the lowest USED landed price.
//
// Then clamp to SBM Min/Max.
// ============================================================

export function computeTarget(input: {
  condition: Condition;
  buyBox: BuyBox;
  minPrice: number;
  maxPrice: number;
  ourSellerId: string | null;
}) {
  const { condition, buyBox, minPrice, maxPrice, ourSellerId } = input;

  const buyBoxIsOurs =
    condition === "New" &&
    Boolean(ourSellerId && buyBox.sellerId === ourSellerId);

  const referenceTargetPrice = Number(
    (condition === "New"
      ? buyBoxIsOurs
        ? buyBox.landedPrice
        : buyBox.landedPrice * 0.99
      : buyBox.landedPrice
    ).toFixed(2),
  );

  const targetPrice = Number(
    Math.min(
      maxPrice,
      Math.max(minPrice, referenceTargetPrice),
    ).toFixed(2),
  );

  const clampReason =
    condition === "New"
      ? referenceTargetPrice < minPrice
        ? "BUY_BOX_BELOW_MIN"
        : referenceTargetPrice > maxPrice
          ? "BUY_BOX_ABOVE_MAX"
          : "BUY_BOX_WITHIN_RANGE"
      : referenceTargetPrice < minPrice
        ? "USED_LOWEST_BELOW_MIN"
        : referenceTargetPrice > maxPrice
          ? "USED_LOWEST_ABOVE_MAX"
          : "USED_LOWEST_WITHIN_RANGE";

  return {
    buyBoxIsOurs,
    referenceTargetPrice,
    targetPrice,
    clampReason,
  };
}

// ============================================================
// PRICE SUBMISSION
// ============================================================

// Legacy product types that the Listings API rejects (error 4000003) even
// though the catalog still reports them. Amazon's Product Type Definitions
// API resolves ABIS_DVD to PRODUCT, and VALIDATION_PREVIEW accepts PRODUCT.
const LISTINGS_PRODUCT_TYPE_ALIASES: Record<string, string> = {
  ABIS_DVD: "PRODUCT",
};

export function resolveListingsProductType(productType: string) {
  return LISTINGS_PRODUCT_TYPE_ALIASES[productType] ?? productType;
}

export function buildPricePayload(
  productType: string,
  price: number,
  operation: "replace" | "merge",
) {
  return {
    productType: resolveListingsProductType(productType),

    patches: [
      {
        op: operation,
        path: "/attributes/purchasable_offer",
        value: [
          {
            marketplace_id: MARKETPLACE_ID,
            currency: "USD",
            audience: "ALL",
            our_price: [
              {
                schedule: [{ value_with_tax: price }],
              },
            ],
          },
        ],
      },
    ],
  };
}

export type SubmitPriceResult =
  | {
      ok: true;
      action: "PRICE_SUBMITTED";
      amazonResponse: any;
    }
  | {
      ok: false;
      action: "VALIDATION_FAILED" | "AMAZON_UPDATE_FAILED";
      statusCode: number;
      amazonResponse: any;
    };

/**
 * Validates with VALIDATION_PREVIEW (replace, non-persisting),
 * then submits the real price with merge so that only our_price
 * is sent. SBM Min/Max are never pushed to Amazon.
 */
export async function submitPrice(input: {
  sku: string;
  sellerId: string;
  productType: string;
  targetPrice: number;
  accessToken: string;
}): Promise<SubmitPriceResult> {
  const { sku, sellerId, productType, targetPrice, accessToken } = input;

  const baseUrl =
    `${SP_API_BASE}/listings/2021-08-01/items/` +
    `${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-amz-access-token": accessToken,
    "user-agent": USER_AGENT,
  };

  // ---------- 1. VALIDATION ----------

  const validationUrl = new URL(baseUrl);
  validationUrl.searchParams.set("marketplaceIds", MARKETPLACE_ID);
  validationUrl.searchParams.set("issueLocale", "en_US");
  validationUrl.searchParams.set("mode", "VALIDATION_PREVIEW");

  const { response: validationResponse } = await amazonFetchWithRetry(
    validationUrl.toString(),
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(
        buildPricePayload(productType, targetPrice, "replace"),
      ),
      cache: "no-store",
    },
    5,
  );

  const validationData = await validationResponse.json().catch(() => null);

  if (!validationResponse.ok || validationData?.status !== "VALID") {
    return {
      ok: false,
      action: "VALIDATION_FAILED",
      statusCode: validationResponse.status,
      amazonResponse: validationData,
    };
  }

  // ---------- 2. LIVE UPDATE ----------

  const liveUrl = new URL(baseUrl);
  liveUrl.searchParams.set("marketplaceIds", MARKETPLACE_ID);
  liveUrl.searchParams.set("issueLocale", "en_US");

  const { response: amazonResponse } = await amazonFetchWithRetry(
    liveUrl.toString(),
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(
        buildPricePayload(productType, targetPrice, "merge"),
      ),
      cache: "no-store",
    },
    5,
  );

  const amazonData = await amazonResponse.json().catch(() => null);

  if (!amazonResponse.ok) {
    return {
      ok: false,
      action: "AMAZON_UPDATE_FAILED",
      statusCode: amazonResponse.status,
      amazonResponse: amazonData,
    };
  }

  return {
    ok: true,
    action: "PRICE_SUBMITTED",
    amazonResponse: amazonData,
  };
}