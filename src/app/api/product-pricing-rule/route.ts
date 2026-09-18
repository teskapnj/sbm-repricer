import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

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

    const pricingRule =
      typeof body?.pricingRule ===
      "string"
        ? body.pricingRule.trim()
        : "";

    if (!sku) {
      return NextResponse.json(
        {
          success: false,
          error: "SKU is required.",
        },
        {
          status: 400,
        },
      );
    }

    // Şimdilik yalnızca BUY_BOX aktif.
    const allowedRules = [
      "BUY_BOX",
    ];

    if (
      !allowedRules.includes(
        pricingRule,
      )
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Invalid pricing rule.",
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

    const productRef = db
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
          sku,
        },
        {
          status: 404,
        },
      );
    }

    await productRef.set(
      {
        pricingRule,

        pricingRuleUpdatedAt:
          new Date().toISOString(),
      },
      {
        merge: true,
      },
    );

    return NextResponse.json({
      success: true,
      sku,
      pricingRule,
    });
  } catch (error) {
    console.error(
      "Pricing rule update failed:",
      error,
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Unable to update pricing rule.",
      },
      {
        status: 500,
      },
    );
  }
}