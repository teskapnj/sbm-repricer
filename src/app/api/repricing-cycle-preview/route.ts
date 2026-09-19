import { NextRequest, NextResponse } from "next/server";

import { runRepricingCycle } from "@/lib/repricing-cycle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);

    const source =
      typeof body?.source === "string" ? body.source : "manual-preview";

    // See repricing-cycle-live: chunked=true processes one chunk per call.
    const chunk =
      body?.chunked === true
        ? { cursor: typeof body?.cursor === "string" ? body.cursor : null }
        : undefined;

    const result = await runRepricingCycle({ live: false, source, chunk });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Repricing cycle preview failed:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Repricing cycle preview failed.",
        amazonUpdated: false,
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const result = await runRepricingCycle({
      live: false,
      source: "manual-preview",
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Repricing cycle preview failed:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Repricing cycle preview failed.",
        amazonUpdated: false,
      },
      { status: 500 },
    );
  }
}