import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/firebase-admin";

const MARKETPLACE_ID = "ATVPDKIKX0DER";
const SP_API_BASE = "https://sellingpartnerapi-na.amazon.com";

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function getAccessToken() {
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

  return data.access_token as string;
}

function amazonHeaders(accessToken: string) {
  return {
    Accept: "application/json",
    "x-amz-access-token": accessToken,
    "x-amz-date": new Date()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, ""),
    "user-agent": "SBM-Repricer/0.1 (Language=TypeScript)",
  };
}

async function amazonGet(
  url: string,
  accessToken: string,
  maxRetries = 4,
) {
  let lastError = "Amazon API request failed.";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "GET",
      headers: amazonHeaders(accessToken),
      cache: "no-store",
    });

    let data: any = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.ok) {
      return data;
    }

    lastError = `Amazon API ${response.status}: ${JSON.stringify(
      data,
    )}`;

    // Retry rate limits and temporary Amazon errors.
    if (
      response.status === 429 ||
      response.status === 500 ||
      response.status === 503
    ) {
      const retryAfter = Number(
        response.headers.get("retry-after"),
      );

      const waitMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 5000);

      await sleep(waitMs);
      continue;
    }

    throw new Error(lastError);
  }

  throw new Error(lastError);
}

async function getAllBuyableListings(
  accessToken: string,
  sellerId: string,
) {
  const allItems: any[] = [];

  let pageToken: string | null = null;
  let totalBuyableListings = 0;
  let pagesFetched = 0;

  do {
    const params = new URLSearchParams({
      marketplaceIds: MARKETPLACE_ID,
      includedData:
        "summaries,offers,fulfillmentAvailability",
      withStatus: "BUYABLE",
      pageSize: "20",
      sortBy: "createdDate",
      sortOrder: "DESC",
    });

    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const url =
      `${SP_API_BASE}/listings/2021-08-01/items/` +
      `${encodeURIComponent(sellerId)}?${params.toString()}`;

    const data = await amazonGet(url, accessToken);

    const pageItems = data?.items || [];

    allItems.push(...pageItems);

    if (pagesFetched === 0) {
      totalBuyableListings =
        Number(data?.numberOfResults) || 0;
    }

    pageToken = data?.pagination?.nextToken || null;

    pagesFetched++;

    // Amazon default usage plan is 5 requests/sec.
    if (pageToken) {
      await sleep(225);
    }

    // Safety guard.
    if (pagesFetched > 200) {
      throw new Error(
        "Listings pagination exceeded safety limit.",
      );
    }
  } while (pageToken);

  return {
    items: allItems,
    totalBuyableListings,
    pagesFetched,
  };
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

async function getFbaInventoryForSkus(
  accessToken: string,
  sellerSkus: string[],
) {
  const inventoryMap = new Map<string, any>();

  if (sellerSkus.length === 0) {
    return {
      inventoryMap,
      batchesFetched: 0,
    };
  }

  const uniqueSkus = [...new Set(sellerSkus)];

  // Amazon allows up to 50 sellerSkus per request.
  const batches = chunkArray(uniqueSkus, 50);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const params = new URLSearchParams({
      details: "true",
      granularityType: "Marketplace",
      granularityId: MARKETPLACE_ID,
      marketplaceIds: MARKETPLACE_ID,

      // SP-API array query parameter.
      sellerSkus: batch.join(","),
    });

    const url =
      `${SP_API_BASE}/fba/inventory/v1/summaries?` +
      params.toString();

    const data = await amazonGet(url, accessToken);

    const summaries =
      data?.payload?.inventorySummaries || [];

    for (const inventory of summaries) {
      if (inventory?.sellerSku) {
        inventoryMap.set(
          inventory.sellerSku,
          inventory,
        );
      }
    }

    // Amazon default usage plan is 2 requests/sec.
    if (i < batches.length - 1) {
      await sleep(550);
    }
  }

  return {
    inventoryMap,
    batchesFetched: batches.length,
  };
}

export async function GET() {
  const startedAt = Date.now();

  try {
    const sellerId = process.env.AMAZON_SELLER_ID;

    if (!sellerId) {
      return NextResponse.json(
        {
          success: false,
          error: "AMAZON_SELLER_ID is missing.",
        },
        { status: 500 },
      );
    }

    const accessToken = await getAccessToken();

    // ============================================================
    // 1. Get ALL BUYABLE listings automatically.
    // Amazon returns maximum 20 per page.
    // ============================================================

    const {
      items: rawItems,
      totalBuyableListings,
      pagesFetched,
    } = await getAllBuyableListings(
      accessToken,
      sellerId,
    );

    // ============================================================
    // 2. Find all FBA SKUs.
    // ============================================================

    const fbaSkus = rawItems
      .filter((item: any) =>
        item.fulfillmentAvailability?.some(
          (f: any) =>
            f.fulfillmentChannelCode === "AMAZON_NA",
        ),
      )
      .map((item: any) => item.sku)
      .filter(Boolean);

    // ============================================================
    // 3. Get FBA inventory in batches of maximum 50 SKUs.
    // ============================================================

    const {
      inventoryMap: fbaInventoryMap,
      batchesFetched,
    } = await getFbaInventoryForSkus(
      accessToken,
      fbaSkus,
    );

    // ============================================================
    // 4. Convert listings and determine REAL availability.
    // ============================================================

    const processedItems = rawItems.map(
      (item: any) => {
        const summary = item.summaries?.[0] || {};
        const offer = item.offers?.[0] || {};

        const fulfillmentRows =
          item.fulfillmentAvailability || [];

        const isFba = fulfillmentRows.some(
          (f: any) =>
            f.fulfillmentChannelCode === "AMAZON_NA",
        );

        const fulfillment = isFba
          ? "FBA"
          : "FBM";

        const status: string[] =
          summary.status || [];

        const listingBuyable =
          status.includes("BUYABLE");

        let available = false;
        let availableQty = 0;

        let fulfillableQty = 0;
        let futureSupplyBuyableQty = 0;
        let inboundQty = 0;
        let reservedQty = 0;
        let unfulfillableQty = 0;

        if (isFba) {
          const inventory =
            fbaInventoryMap.get(item.sku);

          const details =
            inventory?.inventoryDetails || {};

          fulfillableQty =
            Number(
              details.fulfillableQuantity,
            ) || 0;

          futureSupplyBuyableQty =
            Number(
              details.futureSupplyQuantity
                ?.futureSupplyBuyableQuantity,
            ) || 0;

          inboundQty =
            (Number(
              details.inboundWorkingQuantity,
            ) || 0) +
            (Number(
              details.inboundShippedQuantity,
            ) || 0) +
            (Number(
              details.inboundReceivingQuantity,
            ) || 0);

          reservedQty =
            Number(
              details.reservedQuantity
                ?.totalReservedQuantity,
            ) || 0;

          unfulfillableQty =
            Number(
              details.unfulfillableQuantity
                ?.totalUnfulfillableQuantity,
            ) || 0;

          availableQty =
            fulfillableQty +
            futureSupplyBuyableQty;

          // IMPORTANT:
          // Inbound alone does NOT make it available.
          available =
            listingBuyable &&
            (fulfillableQty > 0 ||
              futureSupplyBuyableQty > 0);
        } else {
          const fbmRow =
            fulfillmentRows.find(
              (f: any) =>
                f.fulfillmentChannelCode ===
                "DEFAULT",
            );

          availableQty =
            Number(fbmRow?.quantity) || 0;

          available =
            listingBuyable &&
            availableQty > 0;
        }

        const createdDate =
          summary.createdDate || null;

        const listingAgeDays = createdDate
          ? Math.max(
              0,
              Math.floor(
                (Date.now() -
                  new Date(
                    createdDate,
                  ).getTime()) /
                  (1000 * 60 * 60 * 24),
              ),
            )
          : null;

        const currentPrice =
          offer?.price?.amount != null
            ? Number(offer.price.amount)
            : null;

        return {
          sku: item.sku,
          asin: summary.asin || null,
          fnSku: summary.fnSku || null,

          title:
            summary.itemName || null,

          image:
            summary.mainImage?.link || null,

          productType:
            summary.productType || null,

          condition:
            summary.conditionType || null,

          fulfillment,

          currentPrice,

          available,
          availableQty,

          fulfillableQty,
          futureSupplyBuyableQty,
          inboundQty,
          reservedQty,
          unfulfillableQty,

          createdDate,
          listingAgeDays,

          lastUpdatedDate:
            summary.lastUpdatedDate || null,
        };
      },
    );

    // ============================================================
    // 5. ONLY return products that can actually be purchased.
    // ============================================================

    const availableItems = processedItems.filter(
      (item: any) => item.available,
    );
    
    const fbaAvailable = availableItems.filter(
      (item: any) => item.fulfillment === "FBA",
    ).length;
    
    const fbmAvailable = availableItems.filter(
      (item: any) => item.fulfillment === "FBM",
    ).length;
    
    // ============================================================
    // 5. Save AVAILABLE products to Firestore
    // ============================================================
    
    const syncId = randomUUID();
    const syncedAt = new Date().toISOString();
    
    const firestoreChunks = chunkArray(availableItems, 400);
    
    for (const chunk of firestoreChunks) {
      const batch = db.batch();
    
      for (const product of chunk) {
        const documentId = Buffer.from(product.sku).toString("base64url");
    
        const ref = db
          .collection("sbm_repricer_products")
          .doc(documentId);
    
        batch.set(
          ref,
          {
            sku: product.sku,
            asin: product.asin,
            fnSku: product.fnSku,
            title: product.title,
            image: product.image,
            productType: product.productType,
            condition: product.condition,
            fulfillment: product.fulfillment,
    
            currentPrice: product.currentPrice,
    
            available: product.available,
            availableQty: product.availableQty,
    
            fulfillableQty: product.fulfillableQty,
            futureSupplyBuyableQty: product.futureSupplyBuyableQty,
            inboundQty: product.inboundQty,
            reservedQty: product.reservedQty,
            unfulfillableQty: product.unfulfillableQty,
    
            createdDate: product.createdDate,
            listingAgeDays: product.listingAgeDays,
            lastUpdatedDate: product.lastUpdatedDate,
    
            amazonSyncId: syncId,
            amazonSyncedAt: syncedAt,
          },
          {
            merge: true,
          },
        );
      }
    
      await batch.commit();
    }
    // ============================================================
// Mark products missing from this sync as unavailable.
// Keep SBM settings such as minPrice/maxPrice intact.
// ============================================================

const existingProductsSnapshot = await db
.collection("sbm_repricer_products")
.get();

const staleProducts = existingProductsSnapshot.docs.filter(
(doc) => doc.data().amazonSyncId !== syncId,
);

const staleChunks = chunkArray(staleProducts, 400);

for (const chunk of staleChunks) {
const batch = db.batch();

for (const doc of chunk) {
  batch.update(doc.ref, {
    available: false,
    availableQty: 0,
    fulfillableQty: 0,
    futureSupplyBuyableQty: 0,
    amazonSyncedAt: syncedAt,
  });
}

await batch.commit();
}
    // ============================================================
    // 6. Save sync summary
    // ============================================================
    
    await db
      .collection("sbm_repricer_meta")
      .doc("amazon_sync")
      .set(
        {
          syncId,
          syncedAt,
          amazonBuyableListings: totalBuyableListings,
          availableListings: availableItems.length,
          fbaAvailable,
          fbmAvailable,
        },
        {
          merge: true,
        },
      );
    
    // ============================================================
    // 7. Return result
    // ============================================================
    
    return NextResponse.json({
      success: true,
      marketplaceId: MARKETPLACE_ID,
    
      savedToFirestore: true,
      syncId,
    
      amazonBuyableListings: totalBuyableListings,
      buyableListingsChecked: rawItems.length,
      listingPagesFetched: pagesFetched,
      fbaInventoryBatchesFetched: batchesFetched,
    
      availableListings: availableItems.length,
      fbaAvailable,
      fbmAvailable,
    
      syncDurationMs: Date.now() - startedAt,
    
      items: availableItems,
    });

  } catch (error) {
    console.error(
      "Amazon full listings sync error:",
      error,
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to sync Amazon listings.",
      },
      { status: 500 },
    );
  }
}