import { NextRequest, NextResponse } from "next/server";
import { findOccasionWearURLs } from "@/lib/gemini";

export const maxDuration = 25;

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
    }, 20);

    // Return cards immediately without images — iOS fetches each screenshot separately
    const cards = results.map((r) => ({
      id: crypto.randomUUID(),
      brand: extractBrand(r.domain),
      name: cleanTitle(r.title, r.domain),
      price: null,
      occasion: null,
      tags: [] as string[],
      image_base64: null,
      thumbnail_url: r.thumbnail,
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
  "perniaspopupshop.com": "Pernia's Pop-Up Shop",
  "indiancultr.com": "Indiancultr",
  "tfrstore.com": "TFR Store",
};

/**
 * Strip brand suffixes and site names from a page title to get a cleaner product name.
 * e.g. "Buy Blue Anarkali Suit | Anita Dongre" → "Blue Anarkali Suit"
 */
function cleanTitle(title: string, domain: string): string {
  if (!title) return "Outfit";
  // Strip everything after the last | or – or -
  let clean = title.split(/\s*[|–—]\s*/).shift() ?? title;
  // Strip trailing " - Brand Name" pattern
  const brandName = extractBrand(domain);
  clean = clean.replace(new RegExp(`\\s*-?\\s*${brandName}\\s*$`, "i"), "").trim();
  // Strip common e-commerce prefixes like "Buy", "Shop"
  clean = clean.replace(/^(buy|shop|order|get)\s+/i, "").trim();
  return clean || "Outfit";
}

function extractBrand(domain: string): string {
  for (const [key, brand] of Object.entries(BRAND_MAP)) {
    if (domain.includes(key)) return brand;
  }
  // Auto-extract: strip www., take name before TLD, title-case
  const name = domain.replace(/^www\./, "").split(".")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}
