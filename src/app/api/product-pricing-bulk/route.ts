import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const items = Array.isArray(body?.items)
      ? body.items
      : [];

    const repricingEnabled =
      typeof body?.repricingEnabled === "boolean"
        ? body.repricingEnabled
        : null;

    if (items.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No products supplied.",
        },
        { status: 400 },
      );
    }

    if (items.length > 500) {
      return NextResponse.json(
        {
          success: false,
          error: "Maximum 500 products per bulk update.",
        },
        { status: 400 },
      );
    }

    const validatedItems = items.map((item: any) => {
      const sku =
        typeof item?.sku === "string"
          ? item.sku.trim()
          : "";

      const minPrice = Number(item?.minPrice);
      const maxPrice = Number(item?.maxPrice);

      if (!sku) {
        throw new Error("A product is missing SKU.");
      }

      if (
        !Number.isFinite(minPrice) ||
        !Number.isFinite(maxPrice) ||
        minPrice < 0 ||
        maxPrice < 0 ||
        minPrice > maxPrice
      ) {
        throw new Error(
          `Invalid Min/Max for SKU ${sku}.`,
        );
      }

      return {
        sku,
        minPrice: Number(minPrice.toFixed(2)),
        maxPrice: Number(maxPrice.toFixed(2)),
      };
    });

    const batch = db.batch();
    const now = new Date().toISOString();

    for (const item of validatedItems) {
      const documentId =
        Buffer.from(item.sku).toString("base64url");

      const ref = db
        .collection("sbm_repricer_products")
        .doc(documentId);

      const update: Record<string, unknown> = {
        minPrice: item.minPrice,
        maxPrice: item.maxPrice,
        pricingUpdatedAt: now,
      };

      if (repricingEnabled !== null) {
        update.repricingEnabled =
          repricingEnabled;

        // Repricing ON means this product must have
        // a valid pricing rule as well.
        if (repricingEnabled === true) {
          update.pricingRule = "BUY_BOX";
        }
      }

      batch.set(ref, update, {
        merge: true,
      });
    }

    await batch.commit();

    return NextResponse.json({
      success: true,
      updated: validatedItems.length,
      repricingEnabled,
      pricingRule:
        repricingEnabled === true
          ? "BUY_BOX"
          : null,
    });
  } catch (error) {
    console.error(
      "Bulk pricing save failed:",
      error,
    );

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
