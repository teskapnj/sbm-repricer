import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

import {
  computeTarget,
  getAccessToken,
  getNewBuyBoxes,
  getUsedBuyBoxes,
  normalizeCondition,
  numberOrNull,
  submitPrice,
} from "@/lib/amazon-pricing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PRODUCTS_COLLECTION = "sbm_repricer_products";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);

    const sku = typeof body?.sku === "string" ? body.sku.trim() : "";
    const confirm = body?.confirm === "LIVE";

    if (!sku) {
      return NextResponse.json(
        { success: false, error: "SKU is required." },
        { status: 400 },
      );
    }

    const documentId = Buffer.from(sku).toString("base64url");
    const productRef = db.collection(PRODUCTS_COLLECTION).doc(documentId);
    const snapshot = await productRef.get();

    if (!snapshot.exists) {
      return NextResponse.json(
        { success: false, error: "Product not found." },
        { status: 404 },
      );
    }

    const product = snapshot.data() || {};

    // --------------------------------------------------------
    // SAFETY
    // --------------------------------------------------------

    if (product.available !== true) {
      return NextResponse.json(
        { success: false, error: "Product is not available." },
        { status: 400 },
      );
    }

    if (product.repricingEnabled !== true) {
      return NextResponse.json(
        { success: false, error: "Repricing is OFF." },
        { status: 400 },
      );
    }

    if (product.pricingRule !== "BUY_BOX") {
      return NextResponse.json(
        { success: false, error: "Pricing rule is not BUY_BOX." },
        { status: 400 },
      );
    }

    // LIVE write is FBA only for now.
    if (product.fulfillment !== "FBA") {
      return NextResponse.json(
        {
          success: false,
          error: "Live BUY_BOX repricing is currently limited to FBA.",
        },
        { status: 400 },
      );
    }

    const asin = typeof product.asin === "string" ? product.asin : "";

    if (!asin) {
      return NextResponse.json(
        { success: false, error: "ASIN is missing." },
        { status: 400 },
      );
    }

    const condition = normalizeCondition(product.condition);

    if (!condition) {
      return NextResponse.json(
        { success: false, error: "Condition is not NEW or USED." },
        { status: 400 },
      );
    }

    const minPrice = numberOrNull(product.minPrice);
    const maxPrice = numberOrNull(product.maxPrice);

    if (minPrice === null || maxPrice === null || minPrice > maxPrice) {
      return NextResponse.json(
        { success: false, error: "Invalid SBM Min/Max." },
        { status: 400 },
      );
    }

    const productType =
      typeof product.productType === "string" &&
      product.productType.trim().length > 0
        ? product.productType
        : null;

    if (!productType) {
      return NextResponse.json(
        { success: false, error: "Amazon productType is missing." },
        { status: 400 },
      );
    }

    const currentPrice = numberOrNull(product.currentPrice);

    // --------------------------------------------------------
    // FRESH PRICE REFERENCE
    // --------------------------------------------------------

    const accessToken = await getAccessToken();

    const { buyBoxes, errors } =
      condition === "New"
        ? await getNewBuyBoxes([asin], accessToken)
        : await getUsedBuyBoxes([asin], accessToken);

    if (errors.length > 0) {
      return NextResponse.json(
        {
          success: false,
          sku,
          asin,
          action: "PRICING_LOOKUP_FAILED",
          amazonPriceUpdated: false,
          errors,
        },
        { status: 502 },
      );
    }

    const buyBox = buyBoxes.get(asin);

    if (!buyBox) {
      return NextResponse.json({
        success: true,
        sku,
        asin,
        condition,
        liveRequested: confirm,
        buyBoxAvailable: false,
        action: "SKIP",
        reason:
          condition === "New" ? "No New Buy Box." : "No Used offers.",
        amazonPriceUpdated: false,
      });
    }

    // --------------------------------------------------------
    // TARGET
    // --------------------------------------------------------

    const ourSellerId = process.env.AMAZON_SELLER_ID ?? null;

    const { buyBoxIsOurs, targetPrice, clampReason } = computeTarget({
      condition,
      buyBox,
      minPrice,
      maxPrice,
      ourSellerId,
    });

    const sameAsCurrent =
      currentPrice !== null &&
      Number(currentPrice.toFixed(2)) === targetPrice;

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
        buyBoxIsOurs,
        targetPrice,
        clampReason,
        action: "NO_CHANGE",
        liveRequested: confirm,
        amazonPriceUpdated: false,
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
        buyBoxIsOurs,
        targetPrice,
        clampReason,
        action: "WOULD_UPDATE",
        liveRequested: false,
        amazonPriceUpdated: false,
      });
    }

    // --------------------------------------------------------
    // LIVE AMAZON PRICE UPDATE
    //
    // merge sends ONLY our_price.
    // SBM Min/Max are NOT included.
    // --------------------------------------------------------

    const sellerId = process.env.AMAZON_SELLER_ID;

    if (!sellerId) {
      throw new Error("AMAZON_SELLER_ID is missing.");
    }

    const submission = await submitPrice({
      sku,
      sellerId,
      productType,
      targetPrice,
      accessToken,
    });

    if (!submission.ok) {
      return NextResponse.json(
        {
          success: false,
          sku,
          asin,
          action: submission.action,
          currentPrice,
          targetPrice,
          amazonPriceUpdated: false,
          amazonStatusCode: submission.statusCode,
          amazonResponse: submission.amazonResponse,
        },
        { status: submission.statusCode },
      );
    }

    // Do NOT overwrite currentPrice yet.
    // Amazon submission can be asynchronous.
    await productRef.set(
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

    return NextResponse.json({
      success: true,
      sku,
      asin,
      condition,
      currentPrice,
      minPrice,
      maxPrice,
      buyBox,
      buyBoxIsOurs,
      targetPrice,
      clampReason,
      validation: "VALID",
      action: "PRICE_SUBMITTED",
      sentToAmazon: {
        sellingPrice: targetPrice,
        sbmMinSent: false,
        sbmMaxSent: false,
      },
      amazonPriceUpdated: true,
      amazonResponse: submission.amazonResponse,
    });
  } catch (error) {
    console.error("Single SKU repricing failed:", error);

    return NextResponse.json(
      {
        success: false,
        amazonPriceUpdated: false,
        error:
          error instanceof Error ? error.message : "Repricing failed.",
      },
      { status: 500 },
    );
  }
}