import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

export async function POST(
  request: Request,
) {
  try {
    const body = await request.json();

    const sku =
      typeof body?.sku === "string"
        ? body.sku.trim()
        : "";

    const repricingEnabled =
      body?.repricingEnabled;

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

    if (
      typeof repricingEnabled !==
      "boolean"
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            "repricingEnabled must be boolean.",
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

    const product =
      snapshot.data() || {};

    // --------------------------------------------------
    // Turning OFF is always allowed
    // --------------------------------------------------

    if (!repricingEnabled) {
      await productRef.set(
        {
          repricingEnabled: false,
          repricingUpdatedAt:
            new Date().toISOString(),
        },
        {
          merge: true,
        },
      );

      return NextResponse.json({
        success: true,
        sku,
        repricingEnabled: false,
      });
    }

    // --------------------------------------------------
    // Turning ON requires Min + Max
    // --------------------------------------------------

    const minPrice =
      typeof product.minPrice ===
      "number"
        ? product.minPrice
        : null;

    const maxPrice =
      typeof product.maxPrice ===
      "number"
        ? product.maxPrice
        : null;

    if (
      minPrice === null ||
      maxPrice === null
    ) {
      await productRef.set(
        {
          repricingEnabled: false,
          repricingUpdatedAt:
            new Date().toISOString(),
        },
        {
          merge: true,
        },
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Set Min and Max before enabling repricing.",
          sku,
          repricingEnabled: false,
        },
        {
          status: 400,
        },
      );
    }

    // --------------------------------------------------
    // Turning ON requires pricing rule
    // --------------------------------------------------

    const pricingRule =
      product.pricingRule;

    if (
      pricingRule !== "BUY_BOX"
    ) {
      // IMPORTANT:
      // No rule = force repricing OFF.
      await productRef.set(
        {
          repricingEnabled: false,
          repricingUpdatedAt:
            new Date().toISOString(),
        },
        {
          merge: true,
        },
      );

      return NextResponse.json(
        {
          success: false,
          error:
            "Select a pricing rule before enabling repricing.",
          sku,
          pricingRule:
            pricingRule ?? null,
          repricingEnabled: false,
        },
        {
          status: 400,
        },
      );
    }

    // --------------------------------------------------
    // Safe to turn ON
    // --------------------------------------------------

    await productRef.set(
      {
        repricingEnabled: true,
        repricingUpdatedAt:
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
      repricingEnabled: true,
    });
  } catch (error) {
    console.error(
      "Repricing update failed:",
      error,
    );

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Unable to update repricing.",
      },
      {
        status: 500,
      },
    );
  }
}