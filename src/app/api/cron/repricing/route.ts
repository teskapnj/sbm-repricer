import { NextRequest, NextResponse } from "next/server";

import { runRepricingCycle } from "@/lib/repricing-cycle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      return NextResponse.json(
        { success: false, error: "CRON_SECRET is not configured." },
        { status: 500 },
      );
    }

    const authorization = request.headers.get("authorization");

    if (authorization !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { success: false, error: "Unauthorized." },
        { status: 401 },
      );
    }

    // Runs the cycle in-process: no self-HTTP hop, so the cron
    // function is no longer limited by a nested request timeout.
    const result = await runRepricingCycle({
      live: true,
      source: "cron",
    });

    return NextResponse.json({
      success: result.success,
      cron: true,
      repricing: result,
    });
  } catch (error) {
    console.error("Cron repricing failed:", error);

    return NextResponse.json(
      {
        success: false,
        cron: true,
        error:
          error instanceof Error ? error.message : "Cron repricing failed.",
      },
      { status: 500 },
    );
  }
}