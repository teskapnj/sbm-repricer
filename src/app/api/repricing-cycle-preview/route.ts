import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

import {
    AMAZON_RATE_LIMITS,
    amazonFetchWithRetry,
    sleep,
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

  fulfillmentType:
    | string
    | null;

  subCondition?:
    | string
    | null;

  isBuyBoxWinner?: boolean;
};

function chunkArray<T>(
  items: T[],
  size: number,
) {
  const chunks: T[][] = [];

  for (
    let index = 0;
    index < items.length;
    index += size
  ) {
    chunks.push(
      items.slice(
        index,
        index + size,
      ),
    );
  }

  return chunks;
}

function normalizeCondition(
  condition: unknown,
): Condition | null {
  const value = String(
    condition || "",
  ).toLowerCase();

  if (
    value.startsWith("new")
  ) {
    return "New";
  }

  if (
    value.startsWith("used")
  ) {
    return "Used";
  }

  return null;
}

function numberOrNull(
  value: unknown,
) {
  const number =
    Number(value);

  return Number.isFinite(
    number,
  )
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

  return numberOrNull(
    defaultShipping
      ?.price?.amount,
  ) ?? 0;
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

      body:
        new URLSearchParams({
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

  return data
    .access_token as string;
}

// ============================================================
// NEW BUY BOX — BATCH
// ============================================================

async function getNewBuyBoxes(
    asins: string[],
    accessToken: string,
  ) {
    const result = new Map<string, BuyBox>();
  
    const batches = chunkArray(
      [...new Set(asins)],
      20,
    );
  
    for (
      let batchIndex = 0;
      batchIndex < batches.length;
      batchIndex++
    ) {
      const batch = batches[batchIndex];
  
      const {
        response,
        rateLimitRps,
        nextDelayMs,
      } = await amazonFetchWithRetry(
        `${SP_API_BASE}/batches/products/pricing/2022-05-01/items/competitiveSummary`,
        {
          method: "POST",
  
          headers: {
            Accept: "application/json",
            "Content-Type":
              "application/json",
            "x-amz-access-token":
              accessToken,
            "user-agent":
              "SBM-Repricer/0.1 (Language=TypeScript)",
          },
  
          body: JSON.stringify({
            requests: batch.map(
              (asin) => ({
                asin,
  
                marketplaceId:
                  MARKETPLACE_ID,
  
                includedData: [
                  "featuredBuyingOptions",
                ],
  
                method: "GET",
  
                uri:
                  "/products/pricing/2022-05-01/items/competitiveSummary",
              }),
            ),
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
          `NEW Buy Box batch failed: ${JSON.stringify(
            data,
          )}`,
        );
      }
  
      console.log(
        `[NEW] Batch ${
          batchIndex + 1
        }/${batches.length} | ` +
          `${batch.length} ASIN | ` +
          `rate=${rateLimitRps} rps`,
      );
  
      const responses =
        Array.isArray(
          data?.responses,
        )
          ? data.responses
          : [];
  
      responses.forEach(
        (
          responseItem: any,
          index: number,
        ) => {
          const asin =
            responseItem
              ?.body?.asin ??
            responseItem
              ?.request?.asin ??
            batch[index];
  
          if (!asin) {
            return;
          }
  
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
  
          if (
            offers.length === 0
          ) {
            return;
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
                ?.listingPrice
                ?.amount,
            );
  
          if (
            listingPrice === null
          ) {
            return;
          }
  
          const shippingPrice =
            getDefaultShippingPrice(
              selectedOffer,
            );
  
          result.set(
            asin,
            {
              source:
                "COMPETITIVE_SUMMARY",
  
              sellerId:
                selectedOffer
                  ?.sellerId ||
                null,
  
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
            },
          );
        },
      );
  
      // Same Amazon operation:
      // respect its own rate limit before next batch.
      if (
        batchIndex <
        batches.length - 1
      ) {
        await sleep(nextDelayMs);
      }
    }
  
    return result;
  }

// ============================================================
// USED — LOWEST LANDED OFFER BATCH
// listing price + shipping
// ============================================================

async function getUsedBuyBoxes(
  asins: string[],
  accessToken: string,
) {
  const result =
    new Map<
      string,
      BuyBox
    >();

  const batches =
    chunkArray(
      [...new Set(asins)],
      20,
    );

  for (
    const batch of batches
  ) {
    const response =
      await fetch(
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

          body:
            JSON.stringify({
              requests:
                batch.map(
                  (asin) => ({
                    uri:
                      `/products/pricing/v0/items/${encodeURIComponent(
                        asin,
                      )}/offers`,

                    method:
                      "GET",

                    MarketplaceId:
                      MARKETPLACE_ID,

                    ItemCondition:
                      "Used",

                    CustomerType:
                      "Consumer",
                  }),
                ),
            }),

          cache: "no-store",
        },
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        `USED offers batch failed: ${JSON.stringify(
          data,
        )}`,
      );
    }

    const responses =
      Array.isArray(
        data?.responses,
      )
        ? data.responses
        : [];

    responses.forEach(
      (
        responseItem: any,
        index: number,
      ) => {
        const payload =
          responseItem
            ?.body?.payload ??
          responseItem
            ?.body?.Payload ??
          null;

        if (!payload) {
          return;
        }

        const responseAsin =
          payload
            ?.Identifier
            ?.ASIN ??
          payload
            ?.identifier
            ?.asin ??
          batch[index];

        if (!responseAsin) {
          return;
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
            .map(
              (offer: any) => {
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
              },
            )
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
          return;
        }

        const lowestOffer =
          lowest.offer;

        result.set(
          responseAsin,
          {
            source:
              "ITEM_OFFERS",

            sellerId:
              lowestOffer
                ?.SellerId ??
              lowestOffer
                ?.sellerId ??
              null,

            condition:
              "Used",

            subCondition:
              lowestOffer
                ?.SubCondition ??
              lowestOffer
                ?.subCondition ??
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

            isBuyBoxWinner:
              false,
          },
        );
      },
    );
  }

  return result;
}

// ============================================================
// DRY-RUN CYCLE
// ============================================================

export async function GET() {
  try {
    const snapshot =
      await db
        .collection(
          "sbm_repricer_products",
        )
        .where(
          "repricingEnabled",
          "==",
          true,
        )
        .get();

    const activeProducts =
      snapshot.docs
        .map((doc) =>
          doc.data(),
        )
        .filter(
          (product) =>
            product
              ?.pricingRule ===
            "BUY_BOX",
        );

    if (
      activeProducts.length ===
      0
    ) {
      return NextResponse.json({
        success: true,
        dryRun: true,

        activeProducts: 0,

        message:
          "No active BUY_BOX products.",
        amazonUpdated: false,
      });
    }

    const newAsins:
      string[] = [];

    const usedAsins:
      string[] = [];

    for (
      const product of
        activeProducts
    ) {
      const asin =
        typeof product
          ?.asin === "string"
          ? product.asin
          : "";

      const condition =
        normalizeCondition(
          product?.condition,
        );

      if (
        !asin ||
        !condition
      ) {
        continue;
      }

      if (
        condition === "New"
      ) {
        newAsins.push(asin);
      } else {
        usedAsins.push(
          asin,
        );
      }
    }

    const accessToken =
      await getAccessToken();

      const [
        newBuyBoxes,
        usedBuyBoxes,
      ] = await Promise.all([
        newAsins.length > 0
          ? getNewBuyBoxes(
              newAsins,
              accessToken,
            )
          : Promise.resolve(
              new Map<string, BuyBox>(),
            ),
      
        usedAsins.length > 0
          ? getUsedBuyBoxes(
              usedAsins,
              accessToken,
            )
          : Promise.resolve(
              new Map<string, BuyBox>(),
            ),
      ]);

    const ourSellerId =
      process.env
        .AMAZON_SELLER_ID;

    const items =
      activeProducts.map(
        (product) => {
          const sku =
            product?.sku ??
            null;

          const asin =
            product?.asin ??
            null;

          const condition =
            normalizeCondition(
              product
                ?.condition,
            );

          const fulfillment =
            product
              ?.fulfillment ??
            null;

          const currentPrice =
            numberOrNull(
              product
                ?.currentPrice,
            );
            const fulfillableQty =
  numberOrNull(
    product?.fulfillableQty,
  );

const lastPriceSubmitted =
  numberOrNull(
    product?.lastPriceSubmitted,
  );

          const minPrice =
            numberOrNull(
              product
                ?.minPrice,
            );

          const maxPrice =
            numberOrNull(
              product
                ?.maxPrice,
            );

          if (
            !sku ||
            !asin ||
            !condition ||
            minPrice === null ||
            maxPrice === null
          ) {
            return {
              sku,
              asin,

              action:
                "INVALID_SETUP",

              reason:
                "Missing SKU, ASIN, condition, Min, or Max.",

              amazonUpdated:
                false,
            };
          }

          const buyBox =
            condition ===
            "New"
              ? newBuyBoxes.get(
                  asin,
                )
              : usedBuyBoxes.get(
                  asin,
                );

          if (!buyBox) {
            return {
              sku,
              asin,
              condition,
              fulfillment,

              currentPrice,
              minPrice,
              maxPrice,

              buyBoxAvailable:
                false,

              action:
                "SKIP",

              reason:
                `No ${condition} Buy Box.`,

              amazonUpdated:
                false,
            };
          }

          const buyBoxIsOurs =
            condition === "New" &&
            Boolean(
              ourSellerId &&
                buyBox
                  .sellerId ===
                  ourSellerId,
            );

          const referenceTarget =
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

          const target =
            Number(
              Math.min(
                maxPrice,

                Math.max(
                  minPrice,
                  referenceTarget,
                ),
              ).toFixed(2),
            );

          const clampReason =
            condition === "New"
              ? referenceTarget <
                minPrice
                ? "BUY_BOX_BELOW_MIN"
                : referenceTarget >
                    maxPrice
                  ? "BUY_BOX_ABOVE_MAX"
                  : "BUY_BOX_WITHIN_RANGE"
              : referenceTarget <
                  minPrice
                ? "USED_LOWEST_BELOW_MIN"
                : referenceTarget >
                    maxPrice
                  ? "USED_LOWEST_ABOVE_MAX"
                  : "USED_LOWEST_WITHIN_RANGE";

          if (
            fulfillment !==
            "FBA"
          ) {
            return {
              sku,
              asin,
              condition,
              fulfillment,

              currentPrice,
              minPrice,
              maxPrice,

              buyBoxAvailable:
                true,

              buyBox,

              buyBoxIsOurs,

              targetLandedPrice:
                target,

              clampReason,

              action:
                "FBM_NEEDS_OWN_SHIPPING",

              amazonUpdated:
                false,
            };
          }
          if (
            fulfillableQty === null ||
            fulfillableQty <= 0
          ) {
            return {
              sku,
              asin,
              condition,
              fulfillment,
          
              currentPrice,
              minPrice,
              maxPrice,
          
              fulfillableQty,
          
              buyBoxAvailable:
                true,
          
              buyBox,
          
              buyBoxIsOurs,
          
              targetLandedPrice:
                target,
          
              clampReason,
          
              action:
                "SKIP",
          
              reason:
                "No fulfillable FBA inventory.",
          
              amazonUpdated:
                false,
            };
          }

          const sameCurrentPrice =
  currentPrice !==
    null &&
  Number(
    currentPrice.toFixed(2),
  ) === target;

const sameLastSubmittedPrice =
  lastPriceSubmitted !==
    null &&
  Number(
    lastPriceSubmitted.toFixed(2),
  ) === target;

const samePrice =
  sameCurrentPrice ||
  sameLastSubmittedPrice;

          return {
            sku,
            asin,
            condition,
            fulfillment,

            currentPrice,
            minPrice,
            maxPrice,

            buyBoxAvailable:
              true,

            buyBox,

            buyBoxIsOurs,

            targetLandedPrice:
              target,

            clampReason,

            action:
              samePrice
                ? "NO_CHANGE"
                : "WOULD_UPDATE",

            amazonUpdated:
              false,
          };
        },
      );

    const counts = {
      wouldUpdate:
        items.filter(
          (item) =>
            item.action ===
            "WOULD_UPDATE",
        ).length,

      noChange:
        items.filter(
          (item) =>
            item.action ===
            "NO_CHANGE",
        ).length,

      skipped:
        items.filter(
          (item) =>
            item.action ===
            "SKIP",
        ).length,

      fbmNeedsShipping:
        items.filter(
          (item) =>
            item.action ===
            "FBM_NEEDS_OWN_SHIPPING",
        ).length,

      invalidSetup:
        items.filter(
          (item) =>
            item.action ===
            "INVALID_SETUP",
        ).length,
    };

    return NextResponse.json({
      success: true,

      dryRun: true,

      activeProducts:
        activeProducts.length,

      newProducts:
        newAsins.length,

      usedProducts:
        usedAsins.length,

      counts,

      items,

      amazonUpdated: false,
    });
  } catch (error) {
    console.error(
      "Repricing cycle preview failed:",
      error,
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Repricing cycle preview failed.",
      },
      {
        status: 500,
      },
    );
  }
}