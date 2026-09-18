import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";
import {
  AMAZON_RATE_LIMITS,
  amazonFetchWithRetry,
} from "@/lib/amazon-rate-limit";

const MARKETPLACE_ID = "ATVPDKIKX0DER";
const SP_API_BASE =
  "https://sellingpartnerapi-na.amazon.com";

type Condition = "New" | "Used";

type BuyBox = {
  source:
    | "COMPETITIVE_SUMMARY"
    | "ITEM_OFFERS";
  sellerId: string | null;
  condition: Condition;
  listingPrice: number;
  shippingPrice: number;
  landedPrice: number;
  fulfillmentType: string | null;
  subCondition?: string | null;
};

function normalizeCondition(
  condition: unknown,
): Condition | null {
  const value = String(
    condition || "",
  ).toLowerCase();

  if (value.startsWith("new")) {
    return "New";
  }

  if (value.startsWith("used")) {
    return "Used";
  }

  return null;
}

function numberOrNull(
  value: unknown,
) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function getDefaultShippingPrice(
  offer: any,
) {
  const shippingOptions =
    Array.isArray(
      offer?.shippingOptions,
    )
      ? offer.shippingOptions
      : [];

  const defaultShipping =
    shippingOptions.find(
      (shipping: any) =>
        shipping
          ?.shippingOptionType ===
        "DEFAULT",
    );

  return (
    numberOrNull(
      defaultShipping
        ?.price?.amount,
    ) ?? 0
  );
}

function getOfferWeight(
  offer: any,
) {
  const segments =
    Array.isArray(
      offer
        ?.featuredOfferSegments,
    )
      ? offer
          .featuredOfferSegments
      : [];

  return segments.reduce(
    (
      total: number,
      segment: any,
    ) =>
      total +
      Number(
        segment
          ?.segmentDetails
          ?.glanceViewWeightPercentage ||
          0,
      ),
    0,
  );
}

async function getAccessToken() {
  const clientId =
    process.env
      .AMAZON_LWA_CLIENT_ID;

  const clientSecret =
    process.env
      .AMAZON_LWA_CLIENT_SECRET;

  const refreshToken =
    process.env
      .AMAZON_REFRESH_TOKEN;

  if (
    !clientId ||
    !clientSecret ||
    !refreshToken
  ) {
    throw new Error(
      "Amazon environment variables are missing.",
    );
  }

  const response = await fetch(
    "https://api.amazon.com/auth/o2/token",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded;charset=UTF-8",
      },

      body: new URLSearchParams({
        grant_type:
          "refresh_token",
        refresh_token:
          refreshToken,
        client_id:
          clientId,
        client_secret:
          clientSecret,
      }),

      cache: "no-store",
    },
  );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    throw new Error(
      "Unable to get Amazon access token.",
    );
  }

  return data.access_token as string;
}

// ============================================================
// NEW BUY BOX
// ============================================================

async function getNewBuyBox(
  asin: string,
  accessToken: string,
): Promise<BuyBox | null> {
  const {
    response,
  } =
    await amazonFetchWithRetry(
      `${SP_API_BASE}/batches/products/pricing/2022-05-01/items/competitiveSummary`,
      {
        method: "POST",

        headers: {
          Accept:
            "application/json",
          "Content-Type":
            "application/json",
          "x-amz-access-token":
            accessToken,
          "user-agent":
            "SBM-Repricer/0.1 (Language=TypeScript)",
        },

        body: JSON.stringify({
          requests: [
            {
              asin,

              marketplaceId:
                MARKETPLACE_ID,

              includedData: [
                "featuredBuyingOptions",
              ],

              method: "GET",

              uri:
                "/products/pricing/2022-05-01/items/competitiveSummary",
            },
          ],
        }),

        cache: "no-store",
      },

      AMAZON_RATE_LIMITS
        .competitiveSummary,
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `NEW Buy Box request failed: ${JSON.stringify(
        data,
      )}`,
    );
  }

  const responseItem =
    data?.responses?.[0];

  const options =
    Array.isArray(
      responseItem
        ?.body
        ?.featuredBuyingOptions,
    )
      ? responseItem
          .body
          .featuredBuyingOptions
      : [];

  const newOption =
    options.find(
      (option: any) =>
        String(
          option
            ?.buyingOptionType ||
            "",
        ).toLowerCase() ===
        "new",
    );

  const offers =
    Array.isArray(
      newOption
        ?.segmentedFeaturedOffers,
    )
      ? newOption
          .segmentedFeaturedOffers
      : [];

  if (offers.length === 0) {
    return null;
  }

  const selectedOffer =
    [...offers].sort(
      (a, b) =>
        getOfferWeight(b) -
        getOfferWeight(a),
    )[0];

  const listingPrice =
    numberOrNull(
      selectedOffer
        ?.listingPrice?.amount,
    );

  if (listingPrice === null) {
    return null;
  }

  const shippingPrice =
    getDefaultShippingPrice(
      selectedOffer,
    );

  return {
    source:
      "COMPETITIVE_SUMMARY",

    sellerId:
      selectedOffer
        ?.sellerId || null,

    condition: "New",

    listingPrice,

    shippingPrice,

    landedPrice:
      Number(
        (
          listingPrice +
          shippingPrice
        ).toFixed(2),
      ),

    fulfillmentType:
      selectedOffer
        ?.fulfillmentType ||
      null,
  };
}

// ============================================================
// USED — LOWEST LANDED OFFER
// listing price + shipping
// ============================================================

async function getUsedLowestOffer(
  asin: string,
  accessToken: string,
): Promise<BuyBox | null> {
  const {
    response,
  } =
    await amazonFetchWithRetry(
      `${SP_API_BASE}/batches/products/pricing/v0/itemOffers`,
      {
        method: "POST",

        headers: {
          Accept:
            "application/json",
          "Content-Type":
            "application/json",
          "x-amz-access-token":
            accessToken,
          "user-agent":
            "SBM-Repricer/0.1 (Language=TypeScript)",
        },

        body: JSON.stringify({
          requests: [
            {
              uri:
                `/products/pricing/v0/items/${encodeURIComponent(
                  asin,
                )}/offers`,

              method: "GET",

              MarketplaceId:
                MARKETPLACE_ID,

              ItemCondition:
                "Used",

              CustomerType:
                "Consumer",
            },
          ],
        }),

        cache: "no-store",
      },

      AMAZON_RATE_LIMITS
        .itemOffersBatch,
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `USED offers request failed: ${JSON.stringify(
        data,
      )}`,
    );
  }

  const responseItem =
    data?.responses?.[0];

  const payload =
    responseItem
      ?.body?.payload ??
    responseItem
      ?.body?.Payload ??
    null;

  if (!payload) {
    return null;
  }

  const offers =
    Array.isArray(
      payload?.Offers,
    )
      ? payload.Offers
      : Array.isArray(
            payload?.offers,
          )
        ? payload.offers
        : [];

  const pricedOffers =
    offers
      .map((offer: any) => {
        const listingPrice =
          numberOrNull(
            offer
              ?.ListingPrice
              ?.Amount ??
            offer
              ?.listingPrice
              ?.amount,
          );

        if (
          listingPrice ===
          null
        ) {
          return null;
        }

        const shippingPrice =
          numberOrNull(
            offer
              ?.Shipping
              ?.Amount ??
            offer
              ?.shipping
              ?.amount,
          ) ?? 0;

        const landedPrice =
          Number(
            (
              listingPrice +
              shippingPrice
            ).toFixed(2),
          );

        return {
          offer,
          listingPrice,
          shippingPrice,
          landedPrice,
        };
      })
      .filter(
        (
          item: {
            offer: any;
            listingPrice: number;
            shippingPrice: number;
            landedPrice: number;
          } | null,
        ): item is {
          offer: any;
          listingPrice: number;
          shippingPrice: number;
          landedPrice: number;
        } =>
          item !== null,
      )
      .sort(
        (
          a: {
            offer: any;
            listingPrice: number;
            shippingPrice: number;
            landedPrice: number;
          },
          b: {
            offer: any;
            listingPrice: number;
            shippingPrice: number;
            landedPrice: number;
          },
        ) =>
          a.landedPrice -
          b.landedPrice,
      );

  const lowest =
    pricedOffers[0];

  if (!lowest) {
    return null;
  }

  const lowestOffer =
    lowest.offer;

  return {
    source:
      "ITEM_OFFERS",

    sellerId:
      lowestOffer?.SellerId ??
      lowestOffer?.sellerId ??
      null,

    condition:
      "Used",

    subCondition:
      lowestOffer?.SubCondition ??
      lowestOffer?.subCondition ??
      null,

    listingPrice:
      lowest.listingPrice,

    shippingPrice:
      lowest.shippingPrice,

    landedPrice:
      lowest.landedPrice,

    fulfillmentType:
      lowestOffer
        ?.IsFulfilledByAmazon ===
        true ||
      lowestOffer
        ?.isFulfilledByAmazon ===
        true
        ? "FBA"
        : "FBM",
  };
}

// ============================================================
// AMAZON PRICE PATCH
// ============================================================

function buildPricePayload(
  productType: string,
  price: number,
  operation:
    | "replace"
    | "merge",
) {
  return {
    productType,

    patches: [
      {
        op: operation,

        path:
          "/attributes/purchasable_offer",

        value: [
          {
            marketplace_id:
              MARKETPLACE_ID,

            currency: "USD",

            audience: "ALL",

            our_price: [
              {
                schedule: [
                  {
                    value_with_tax:
                      price,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// ============================================================
// POST
// ============================================================

export async function POST(
  request: Request,
) {
  try {
    const body =
      await request.json();

    const sku =
      typeof body?.sku === "string"
        ? body.sku.trim()
        : "";

    const confirm =
      body?.confirm === "LIVE";

    if (!sku) {
      return NextResponse.json(
        {
          success: false,
          error:
            "SKU is required.",
        },
        {
          status: 400,
        },
      );
    }

    const documentId =
      Buffer.from(sku).toString(
        "base64url",
      );

    const productRef =
      db
        .collection(
          "sbm_repricer_products",
        )
        .doc(documentId);

    const snapshot =
      await productRef.get();

    if (!snapshot.exists) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Product not found.",
        },
        {
          status: 404,
        },
      );
    }

    const product =
      snapshot.data() || {};

    // --------------------------------------------------------
    // SAFETY
    // --------------------------------------------------------

    if (
      product.available !==
      true
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Product is not available.",
        },
        {
          status: 400,
        },
      );
    }

    if (
      product
        .repricingEnabled !==
      true
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Repricing is OFF.",
        },
        {
          status: 400,
        },
      );
    }

    if (
      product.pricingRule !==
      "BUY_BOX"
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Pricing rule is not BUY_BOX.",
        },
        {
          status: 400,
        },
      );
    }

    // LIVE write is FBA only for now.
    if (
      product.fulfillment !==
      "FBA"
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Live BUY_BOX repricing is currently limited to FBA.",
        },
        {
          status: 400,
        },
      );
    }

    const asin =
      typeof product.asin ===
      "string"
        ? product.asin
        : "";

    if (!asin) {
      return NextResponse.json(
        {
          success: false,
          error:
            "ASIN is missing.",
        },
        {
          status: 400,
        },
      );
    }

    const condition =
      normalizeCondition(
        product.condition,
      );

    if (!condition) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Condition is not NEW or USED.",
        },
        {
          status: 400,
        },
      );
    }

    const minPrice =
      numberOrNull(
        product.minPrice,
      );

    const maxPrice =
      numberOrNull(
        product.maxPrice,
      );

    if (
      minPrice === null ||
      maxPrice === null ||
      minPrice > maxPrice
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid SBM Min/Max.",
        },
        {
          status: 400,
        },
      );
    }

    const productType =
      typeof product
        .productType ===
        "string" &&
      product.productType
        .trim()
        .length > 0
        ? product.productType
        : null;

    if (!productType) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Amazon productType is missing.",
        },
        {
          status: 400,
        },
      );
    }

    const currentPrice =
      numberOrNull(
        product.currentPrice,
      );

    // --------------------------------------------------------
    // FRESH PRICE REFERENCE
    // --------------------------------------------------------

    const accessToken =
      await getAccessToken();

    const buyBox =
      condition === "New"
        ? await getNewBuyBox(
            asin,
            accessToken,
          )
        : await getUsedLowestOffer(
            asin,
            accessToken,
          );

    if (!buyBox) {
      return NextResponse.json({
        success: true,

        sku,
        asin,
        condition,

        liveRequested:
          confirm,

        buyBoxAvailable:
          false,

        action: "SKIP",

        reason:
          condition === "New"
            ? "No New Buy Box."
            : "No Used offers.",

        amazonPriceUpdated:
          false,
      });
    }

    // --------------------------------------------------------
    // TARGET
    //
    // NEW:
    // - If competitor owns Buy Box -> 1% below landed Buy Box.
    // - If we own Buy Box -> keep the same landed price.
    //
    // USED:
    // - Ignore Buy Box.
    // - Match the lowest USED landed price
    //   (listing price + shipping).
    //
    // Then clamp to SBM Min/Max.
    // --------------------------------------------------------

    const ourSellerId =
      process.env
        .AMAZON_SELLER_ID ??
      null;

    const buyBoxIsOurs =
      condition === "New" &&
      ourSellerId !== null &&
      buyBox.sellerId ===
        ourSellerId;

    const referenceTargetPrice =
      Number(
        (
          condition === "New"
            ? buyBoxIsOurs
              ? buyBox.landedPrice
              : buyBox.landedPrice *
                0.99
            : buyBox.landedPrice
        ).toFixed(2),
      );

    const targetPrice =
      Number(
        Math.min(
          maxPrice,
          Math.max(
            minPrice,
            referenceTargetPrice,
          ),
        ).toFixed(2),
      );

    const clampReason =
      condition === "New"
        ? referenceTargetPrice <
          minPrice
          ? "BUY_BOX_BELOW_MIN"
          : referenceTargetPrice >
              maxPrice
            ? "BUY_BOX_ABOVE_MAX"
            : "BUY_BOX_WITHIN_RANGE"
        : referenceTargetPrice <
            minPrice
          ? "USED_LOWEST_BELOW_MIN"
          : referenceTargetPrice >
              maxPrice
            ? "USED_LOWEST_ABOVE_MAX"
            : "USED_LOWEST_WITHIN_RANGE";

    const sameAsCurrent =
      currentPrice !== null &&
      Number(
        currentPrice.toFixed(2),
      ) === targetPrice;

    if (sameAsCurrent) {
      return NextResponse.json({
        success: true,

        sku,
        asin,
        condition,

        currentPrice,

        minPrice,
        maxPrice,

        buyBox,

        targetPrice,

        clampReason,

        action:
          "NO_CHANGE",

        liveRequested:
          confirm,

        amazonPriceUpdated:
          false,
      });
    }

    // --------------------------------------------------------
    // NO CONFIRM = DRY RUN ONLY
    // --------------------------------------------------------

    if (!confirm) {
      return NextResponse.json({
        success: true,

        dryRun: true,

        sku,
        asin,
        condition,

        currentPrice,

        minPrice,
        maxPrice,

        buyBox,

        targetPrice,

        clampReason,

        action:
          "WOULD_UPDATE",

        liveRequested:
          false,

        amazonPriceUpdated:
          false,
      });
    }

    // --------------------------------------------------------
    // AMAZON SELLER ID
    // --------------------------------------------------------

    const sellerId =
      process.env
        .AMAZON_SELLER_ID;

    if (!sellerId) {
      throw new Error(
        "AMAZON_SELLER_ID is missing.",
      );
    }

    const baseUrl =
      `${SP_API_BASE}` +
      `/listings/2021-08-01/items/` +
      `${encodeURIComponent(
        sellerId,
      )}/` +
      `${encodeURIComponent(
        sku,
      )}`;

    // --------------------------------------------------------
    // SAFETY VALIDATION
    //
    // VALIDATION_PREVIEW does not allow merge,
    // so validate with replace.
    // This does NOT persist.
    // --------------------------------------------------------

    const validationUrl =
      new URL(baseUrl);

    validationUrl.searchParams.set(
      "marketplaceIds",
      MARKETPLACE_ID,
    );

    validationUrl.searchParams.set(
      "issueLocale",
      "en_US",
    );

    validationUrl.searchParams.set(
      "mode",
      "VALIDATION_PREVIEW",
    );

    const validationResponse =
      await fetch(
        validationUrl.toString(),
        {
          method: "PATCH",

          headers: {
            Accept:
              "application/json",

            "Content-Type":
              "application/json",

            "x-amz-access-token":
              accessToken,

            "user-agent":
              "SBM-Repricer/0.1 (Language=TypeScript)",
          },

          body: JSON.stringify(
            buildPricePayload(
              productType,
              targetPrice,
              "replace",
            ),
          ),

          cache: "no-store",
        },
      );

    let validationData: any =
      null;

    try {
      validationData =
        await validationResponse.json();
    } catch {
      validationData = null;
    }

    if (
      !validationResponse.ok ||
      validationData?.status !==
        "VALID"
    ) {
      return NextResponse.json(
        {
          success: false,

          sku,
          asin,

          action:
            "VALIDATION_FAILED",

          targetPrice,

          amazonPriceUpdated:
            false,

          validationStatusCode:
            validationResponse.status,

          validationResponse:
            validationData,
        },
        {
          status: 400,
        },
      );
    }

    // --------------------------------------------------------
    // LIVE AMAZON PRICE UPDATE
    //
    // IMPORTANT:
    // merge sends ONLY our_price.
    // SBM Min/Max are NOT included.
    // --------------------------------------------------------

    const liveUrl =
      new URL(baseUrl);

    liveUrl.searchParams.set(
      "marketplaceIds",
      MARKETPLACE_ID,
    );

    liveUrl.searchParams.set(
      "issueLocale",
      "en_US",
    );

    const amazonResponse =
      await fetch(
        liveUrl.toString(),
        {
          method: "PATCH",

          headers: {
            Accept:
              "application/json",

            "Content-Type":
              "application/json",

            "x-amz-access-token":
              accessToken,

            "user-agent":
              "SBM-Repricer/0.1 (Language=TypeScript)",
          },

          body: JSON.stringify(
            buildPricePayload(
              productType,
              targetPrice,
              "merge",
            ),
          ),

          cache: "no-store",
        },
      );

    let amazonData: any = null;

    try {
      amazonData =
        await amazonResponse.json();
    } catch {
      amazonData = null;
    }

    if (!amazonResponse.ok) {
      return NextResponse.json(
        {
          success: false,

          sku,
          asin,

          action:
            "AMAZON_UPDATE_FAILED",

          currentPrice,

          targetPrice,

          amazonPriceUpdated:
            false,

          amazonStatusCode:
            amazonResponse.status,

          amazonResponse:
            amazonData,
        },
        {
          status:
            amazonResponse.status,
        },
      );
    }

    // Do NOT overwrite currentPrice yet.
    // Amazon submission can be asynchronous.
    await productRef.set(
      {
        lastPriceSubmitted:
          targetPrice,

        lastPriceSubmissionId:
          amazonData
            ?.submissionId ??
          null,

        lastPriceSubmissionStatus:
          amazonData?.status ??
          null,

        lastPriceSubmittedAt:
          new Date().toISOString(),
      },
      {
        merge: true,
      },
    );

    return NextResponse.json({
      success: true,

      sku,
      asin,
      condition,

      currentPrice,

      minPrice,
      maxPrice,

      buyBox,

      targetPrice,

      clampReason,

      validation:
        "VALID",

      action:
        "PRICE_SUBMITTED",

      sentToAmazon: {
        sellingPrice:
          targetPrice,

        sbmMinSent:
          false,

        sbmMaxSent:
          false,
      },

      amazonPriceUpdated:
        true,

      amazonResponse:
        amazonData,
    });
  } catch (error) {
    console.error(
      "Single SKU repricing failed:",
      error,
    );

    return NextResponse.json(
      {
        success: false,

        amazonPriceUpdated:
          false,

        error:
          error instanceof Error
            ? error.message
            : "Repricing failed.",
      },
      {
        status: 500,
      },
    );
  }
}