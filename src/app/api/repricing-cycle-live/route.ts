import { NextRequest, NextResponse } from "next/server";

import { runRepricingCycle } from "@/lib/repricing-cycle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);

    if (body?.confirm !== "LIVE") {
      return NextResponse.json(
        {
          success: false,
          error: 'Live confirmation required. Send {"confirm":"LIVE"}.',
          amazonUpdated: false,
        },
        { status: 400 },
      );
    }

    const source =
      typeof body?.source === "string" ? body.source : "manual-live";

    // {"chunked":true,"cursor":<last SKU of the previous chunk | null>} walks
    // the inventory one chunk per call; without it everything runs in one call.
    const chunk =
      body?.chunked === true
        ? { cursor: typeof body?.cursor === "string" ? body.cursor : null }
        : undefined;

    const result = await runRepricingCycle({ live: true, source, chunk });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Repricing cycle live failed:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Repricing cycle live failed.",
        amazonUpdated: false,
      },
      { status: 500 },
    );
  }
}