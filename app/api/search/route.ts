import { NextResponse } from "next/server";

export const maxDuration = 10;

export async function POST() {
  return NextResponse.json({ ok: false, error: "Not implemented" }, { status: 501 });
}
