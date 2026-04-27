import { NextRequest, NextResponse } from "next/server";
import { findOccasionWearURLs } from "@/lib/gemini";

export const maxDuration = 10;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { occasion, gender, top_size, bottom_size } = body;

    if (!occasion) {
      return NextResponse.json(
        { ok: false, error: "occasion is required" },
        { status: 400 }
      );
    }

    // Gemini with Google Search grounding → product page URLs
    const results = await findOccasionWearURLs(occasion, {
      gender,
      topSize: top_size,
      bottomSize: bottom_size,
      bustIn: body.bust_in,
      waistIn: body.waist_in,
      hipsIn: body.hips_in,
      chestIn: body.chest_in,
      shouldersIn: body.shoulders_in,
      sleeveLengthIn: body.sleeve_length_in,
      inseamIn: body.inseam_in,
    });

    // Return cards immediately without images — iOS fetches each screenshot separately
    const cards = results.map((r) => ({
      id: crypto.randomUUID(),
      brand: extractBrand(r.domain),
      name: "Outfit",
      price: null,
      occasion: null,
      tags: [] as string[],
      image_base64: null,
      sourceURL: r.uri,
    }));

    return NextResponse.json({ ok: true, cards });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error("[search]", err?.message);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Internal error" },
      { status: 500 }
    );
  }
}

const BRAND_MAP: Record<string, string> = {
  "sabyasachi.com": "Sabyasachi",
  "anitadongre.com": "Anita Dongre",
  "rawmango.in": "Raw Mango",
  "nykaa.com": "Nykaa Fashion",
  "ajio.com": "AJIO",
  "manyavar.com": "Manyavar",
  "manishmalhotra.in": "Manish Malhotra",
  "fabindia.com": "Fabindia",
  "aza-fashions.com": "Aza Fashions",
};

function extractBrand(domain: string): string {
  for (const [key, brand] of Object.entries(BRAND_MAP)) {
    if (domain.includes(key)) return brand;
  }
  return domain.split(".")[0];
}
