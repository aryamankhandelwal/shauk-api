import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { classifyProduct } from "../lib/classifier";
import { parseSearchQuery } from "../lib/gemini";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

interface Product {
  id: string;
  title: string;
  price: number | null;
  image_url: string;
  product_url: string;
  source: string;
  gender: string | null;
  garment_type: string | null;
  color: string | null;
  fabric: string | null;
  embellishments: string[];
  currency: string | null;
}

/** Map a Supabase product row into the OutfitCard shape the iOS app expects. */
function toOutfitCard(p: Product) {
  const parts = p.title.split(" ");
  const brand = parts[0] ?? p.source;
  const name = parts.slice(1).join(" ") || p.title;

  return {
    id: p.id,
    brand,
    name,
    price: p.price != null ? `₹${p.price.toLocaleString("en-IN")}` : null,
    price_numeric: p.price,
    currency: p.currency ?? "INR",
    occasion: null,
    tags: [p.source],
    garment_type: p.garment_type ?? null,
    color: p.color ?? null,
    fabric: p.fabric ?? null,
    embellishments: p.embellishments ?? [],
    thumbnail_url: p.image_url,
    image_url: p.image_url,
    sourceURL: p.product_url,
  };
}

// GET /api/search?q=<query> — raw product data
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q) {
    return NextResponse.json(
      { ok: false, error: "q parameter is required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("products")
    .select("*")
    .ilike("title", `%${q}%`)
    .limit(10);

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, products: data });
}

// POST /api/search — iOS app sends { occasion, gender, ... }, returns OutfitCard[]
export async function POST(req: NextRequest) {
  const body = await req.json();
  const occasion: string = body.occasion ?? "";
  const userGender: string | undefined = body.gender;

  if (!occasion) {
    return NextResponse.json(
      { ok: false, error: "occasion is required" },
      { status: 400 }
    );
  }

  // Parse occasion into structured filters via Gemini (pass gender so it can tailor garment suggestions)
  const parsed = await parseSearchQuery(occasion, userGender);

  // Determine effective gender — prefer explicit user profile gender over hint
  const effectiveUserGender = userGender ?? parsed.gender_hint ?? undefined;

  // ── Build Supabase query ──────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbQuery: any = supabase.from("products").select("*");

  // Price range filters (strict — always applied when present)
  if (parsed.max_price != null) {
    dbQuery = dbQuery.lte("price", parsed.max_price);
  }
  if (parsed.min_price != null) {
    dbQuery = dbQuery.gte("price", parsed.min_price);
  }

  // Garment/keyword filter — OR across garment_type column AND title text
  if (parsed.garment_types.length > 0) {
    // Match either the garment_type column OR the title text for each type
    const orParts = parsed.garment_types
      .flatMap((t) => [`garment_type.eq.${t}`, `title.ilike.%${t}%`])
      .join(",");
    dbQuery = dbQuery.or(orParts);
  } else if (parsed.keywords.length > 0) {
    // Keywords are words that actually appear in product titles (e.g. "silk", "embroidered")
    dbQuery = dbQuery.ilike("title", `%${parsed.keywords[0]}%`);
  }
  // If neither — occasion was mapped to nothing useful — return broad results
  // filtered only by price/color/fabric and gender (handled below)

  // Color filter — only apply when color is explicit (don't narrow unnecessarily)
  if (parsed.colors.length > 0) {
    dbQuery = dbQuery.in("color", parsed.colors);
  }

  // Fabric filter
  if (parsed.fabrics.length > 0) {
    dbQuery = dbQuery.in("fabric", parsed.fabrics);
  }

  dbQuery = dbQuery.limit(60);

  const { data, error } = await dbQuery;

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  // ── Gender filter (post-fetch, using classifier) ─────────────────
  const filtered = (data as Product[]).filter((p) => {
    const { gender: classified, exclude } = classifyProduct(p);
    if (exclude) return false;

    const resolvedGender: string =
      classified !== "unknown" ? classified : (p.gender ?? "unknown");

    if (effectiveUserGender === "male")
      return resolvedGender === "male" || resolvedGender === "unisex" || resolvedGender === "unknown";
    if (effectiveUserGender === "female")
      return resolvedGender === "female" || resolvedGender === "unisex" || resolvedGender === "unknown";
    return true;
  });

  const cards = filtered.map(toOutfitCard);
  return NextResponse.json({ ok: true, cards, _parsed: parsed });
}
