import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
) {
  try {
    const cronSecret =
      process.env.CRON_SECRET;

    if (!cronSecret) {
      return NextResponse.json(
        {
          success: false,
          error:
            "CRON_SECRET is not configured.",
        },
        {
          status: 500,
        },
      );
    }

    const authorization =
      request.headers.get(
        "authorization",
      );

    if (
      authorization !==
      `Bearer ${cronSecret}`
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized.",
        },
        {
          status: 401,
        },
      );
    }

    const liveUrl =
      new URL(
        "/api/repricing-cycle-live",
        request.url,
      );

    const response =
      await fetch(
        liveUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              confirm: "LIVE",
            }),

          cache: "no-store",
        },
      );

    const result =
      await response
        .json()
        .catch(() => ({
          success: false,
          error:
            "Invalid response from repricing cycle.",
        }));

    return NextResponse.json(
      {
        success:
          response.ok &&
          result?.success === true,

        cron: true,

        repricing:
          result,
      },
      {
        status:
          response.ok
            ? 200
            : response.status,
      },
    );
  } catch (error) {
    console.error(
      "Cron repricing failed:",
      error,
    );

    return NextResponse.json(
      {
        success: false,
        cron: true,
        error:
          error instanceof Error
            ? error.message
            : "Cron repricing failed.",
      },
      {
        status: 500,
      },
    );
  }
}