import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

type PricingUpdate = {
  sku: string;
  minPrice: number;
  maxPrice: number;
};

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!Array.isArray(body.items)) {
      return NextResponse.json(
        {
          success: false,
          error: "Items array is required.",
        },
        { status: 400 },
      );
    }

    const repricingEnabled =
      typeof body.repricingEnabled === "boolean"
        ? body.repricingEnabled
        : null;

    const items: PricingUpdate[] = [];

    for (const item of body.items) {
      const sku =
        typeof item?.sku === "string"
          ? item.sku.trim()
          : "";

      const minPrice = Number(item?.minPrice);
      const maxPrice = Number(item?.maxPrice);

      if (
        !sku ||
        !Number.isFinite(minPrice) ||
        !Number.isFinite(maxPrice) ||
        minPrice < 0 ||
        maxPrice < 0 ||
        minPrice > maxPrice
      ) {
        return NextResponse.json(
          {
            success: false,
            error: `Invalid pricing data for SKU: ${sku || "unknown"}`,
          },
          { status: 400 },
        );
      }

      items.push({
        sku,
        minPrice,
        maxPrice,
      });
    }

    if (items.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No products to update.",
        },
        { status: 400 },
      );
    }

    const updatedAt = new Date().toISOString();
    const chunks = chunkArray(items, 400);

    for (const chunk of chunks) {
      const batch = db.batch();

      for (const item of chunk) {
        const documentId = Buffer.from(item.sku).toString(
          "base64url",
        );

        const ref = db
          .collection("sbm_repricer_products")
          .doc(documentId);

        const updateData: Record<string, unknown> = {
          minPrice: item.minPrice,
          maxPrice: item.maxPrice,
          pricingUpdatedAt: updatedAt,
        };

        if (repricingEnabled !== null) {
          updateData.repricingEnabled = repricingEnabled;
          updateData.repricingUpdatedAt = updatedAt;
        }

        batch.set(
          ref,
          updateData,
          {
            merge: true,
          },
        );
      }

      await batch.commit();
    }

    return NextResponse.json({
      success: true,
      updated: items.length,
      repricingUpdated: repricingEnabled !== null,
      repricingEnabled,
    });
  } catch (error) {
    console.error("Bulk pricing save error:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to save bulk pricing.",
      },
      { status: 500 },
    );
  }
}
