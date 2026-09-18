import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";

const COLLECTION = "sbm_repricer_repricing_reports";

export async function GET() {
  try {
    const snapshot = await db
      .collection(COLLECTION)
      .orderBy("createdAtMs", "desc")
      .limit(50)
      .get();

    const reports = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({
      success: true,
      reports,
    });
  } catch (error) {
    console.error("Unable to load repricing reports:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to load repricing reports.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = body?.result;

    if (!result || typeof result !== "object") {
      return NextResponse.json(
        {
          success: false,
          error: "Repricing result is required.",
        },
        { status: 400 },
      );
    }

    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();

    const document = {
      createdAt,
      createdAtMs,
      source:
        typeof body?.source === "string"
          ? body.source
          : "manual",
      result,
    };

    const ref = await db
      .collection(COLLECTION)
      .add(document);

    return NextResponse.json({
      success: true,
      id: ref.id,
      createdAt,
    });
  } catch (error) {
    console.error("Unable to save repricing report:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to save repricing report.",
      },
      { status: 500 },
    );
  }
}
