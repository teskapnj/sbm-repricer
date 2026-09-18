import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const sku =
      typeof body.sku === "string"
        ? body.sku.trim()
        : "";

    const minPrice = Number(body.minPrice);
    const maxPrice = Number(body.maxPrice);

    if (!sku) {
      return NextResponse.json(
        {
          success: false,
          error: "SKU is required.",
        },
        { status: 400 },
      );
    }

    if (
      !Number.isFinite(minPrice) ||
      !Number.isFinite(maxPrice) ||
      minPrice < 0 ||
      maxPrice < 0 ||
      minPrice > maxPrice
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid min or max price.",
        },
        { status: 400 },
      );
    }

    const documentId = Buffer.from(sku).toString("base64url");

    const ref = db
      .collection("sbm_repricer_products")
      .doc(documentId);

    const snapshot = await ref.get();

    if (!snapshot.exists) {
      return NextResponse.json(
        {
          success: false,
          error: "Product not found.",
        },
        { status: 404 },
      );
    }

    await ref.set(
      {
        minPrice,
        maxPrice,
        pricingUpdatedAt: new Date().toISOString(),
      },
      {
        merge: true,
      },
    );

    return NextResponse.json({
      success: true,
      sku,
      minPrice,
      maxPrice,
    });
  } catch (error) {
    console.error("Product pricing save error:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to save product pricing.",
      },
      { status: 500 },
    );
  }
}