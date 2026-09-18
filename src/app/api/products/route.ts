import { NextResponse } from "next/server";
import { db } from "@/lib/firebase-admin";

export async function GET() {
  try {
    const snapshot = await db
      .collection("sbm_repricer_products")
      .where("available", "==", true)
      .get();

    const items = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    items.sort((a: any, b: any) => {
      const aDate = a.createdDate
        ? new Date(a.createdDate).getTime()
        : 0;

      const bDate = b.createdDate
        ? new Date(b.createdDate).getTime()
        : 0;

      return bDate - aDate;
    });

    return NextResponse.json({
      success: true,
      total: items.length,
      items,
    });
  } catch (error) {
    console.error("Firestore products error:", error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to load products.",
      },
      { status: 500 },
    );
  }
}