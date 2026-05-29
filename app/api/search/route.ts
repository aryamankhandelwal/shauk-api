import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { classifyProduct } from "../lib/classifier";
import { parseSearchQuery, ParsedQuery } from "../lib/gemini";

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
  available_sizes: string[] | null;
}

// Sources where the title belongs to a third-party seller — use the platform name as brand
const MARKETPLACE_SOURCES = new Set(["nykaa", "ajio", "tatacliq", "myntra", "azafashions", "kalkifashion", "fabindia"]);

/** Map a Supabase product row into the OutfitCard shape the iOS app expects. */
function toOutfitCard(p: Product) {
  const isMarketplace = MARKETPLACE_SOURCES.has(p.source);
  // Non-marketplace sources are single-brand direct scrapers — use the source as brand.
  // Avoids showing garment descriptors ("Cream", "Embroidered") as the brand name.
  const brand = isMarketplace ? p.source : p.source.replace(/_/g, " ");
  const name = p.title;

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
    available_sizes: p.available_sizes ?? [],
    thumbnail_url: p.image_url,
    image_url: p.image_url,
    sourceURL: p.product_url,
  };
}

// ── Deduplication helpers ─────────────────────────────────────────────

function normalizeImageUrl(url: string): string {
  let n = url.split("?")[0];
  n = n.replace(
    /_([\d]+x[\d]*|x[\d]+|grande|large|medium|small|compact|master|thumb|icon|pico|nano)(?=\.\w{3,4}$)/i,
    ""
  );
  n = n.replace(/\/[hwq]-\d+(?:,[hwq]-\d+)*\//g, "/");
  return n.toLowerCase();
}

function completenessScore(p: Product): number {
  return (p.garment_type != null ? 1 : 0) +
         (p.color        != null ? 1 : 0) +
         (p.fabric       != null ? 1 : 0);
}
function isSetProduct(p: Product): boolean {
  return /\b(pyjama|churidar|dupatta|set)\b| and /i.test(p.title);
}
function pickWinner(a: Product, b: Product): Product {
  const sa = completenessScore(a), sb = completenessScore(b);
  if (sa !== sb) return sa > sb ? a : b;
  if (isSetProduct(a) && !isSetProduct(b)) return a;
  if (isSetProduct(b) && !isSetProduct(a)) return b;
  return (a.price ?? Infinity) <= (b.price ?? Infinity) ? a : b;
}

/** 1a — dedupe by normalized image_url (same photo, different SKU) */
function deduplicateByImage(products: Product[]): Product[] {
  const seen = new Map<string, Product>();
  for (const p of products) {
    if (!p.image_url) { seen.set(p.id, p); continue; }
    const key = normalizeImageUrl(p.image_url);
    const existing = seen.get(key);
    seen.set(key, existing ? pickWinner(existing, p) : p);
  }
  return Array.from(seen.values());
}

const STOP_WORDS = new Set([
  "and","the","a","an","with","for","in","of","by","set","or","at","to","from",
]);
function wordSet(title: string): Set<string> {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
         .filter(w => w.length > 1 && !STOP_WORDS.has(w))
  );
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let n = 0; for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

/** 1b — dedupe by title Jaccard within same source (variants from same vendor) */
function deduplicateByTitle(products: Product[]): Product[] {
  const bySource = new Map<string, Product[]>();
  for (const p of products) {
    const g = bySource.get(p.source) ?? [];
    g.push(p); bySource.set(p.source, g);
  }
  const result: Product[] = [];
  for (const [, group] of bySource) {
    const ws = group.map(p => wordSet(p.title));
    const eliminated = new Set<number>();
    for (let i = 0; i < group.length; i++) {
      if (eliminated.has(i)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (eliminated.has(j)) continue;
        // Price guard: skip if prices differ by >40% (different products, not variants)
        const pi = group[i].price, pj = group[j].price;
        if (pi != null && pj != null && Math.max(pi, pj) / Math.min(pi, pj) > 1.4) continue;
        if (jaccard(ws[i], ws[j]) >= 0.65) {
          const winner = pickWinner(group[i], group[j]);
          if (winner === group[j]) { group[i] = group[j]; ws[i] = ws[j]; }
          eliminated.add(j);
        }
      }
      result.push(group[i]);
    }
  }
  return result;
}

function deduplicateProducts(products: Product[]): Product[] {
  return deduplicateByTitle(deduplicateByImage(products));
}

// ── Answer merger (deterministic — no Gemini call needed for known suggestions) ──

const KNOWN_SUGGESTIONS = new Set([
  "Under ₹5,000", "₹5,000–₹20,000", "₹20,000+",
  "I'm the bride", "I'm a guest", "Part of the wedding party",
  "Open to anything", "Pastels & soft tones", "Bold & vibrant", "Neutrals & nudes",
  "Traditional & classic", "Contemporary & fashion-forward", "Fusion & experimental",
  "Light & flowy", "Rich & structured", "Comfortable & breathable",
]);

function dedup<T>(arr: T[]): T[] { return [...new Set(arr)]; }

function mergeAnswers(
  base: ParsedQuery,
  answers: Array<{ question: string; answer: string }>
): ParsedQuery {
  let p: ParsedQuery = { ...base, colors: [...base.colors], fabrics: [...base.fabrics] };

  for (const { answer } of answers) {
    // Budget
    if (answer === "Under ₹5,000")          { p = { ...p, max_price: 5000 }; continue; }
    if (answer === "₹5,000–₹20,000")        { p = { ...p, min_price: 5000, max_price: 20000 }; continue; }
    if (answer === "₹20,000+")              { p = { ...p, min_price: 20000 }; continue; }
    // Role
    if (answer === "I'm the bride")         { p = { ...p, garment_types: ["lehenga"] }; continue; }
    if (answer === "I'm a guest")           { p = { ...p, garment_types: ["anarkali", "lehenga", "salwar"] }; continue; }
    if (answer === "Part of the wedding party") { p = { ...p, garment_types: ["anarkali", "sharara", "salwar"] }; continue; }
    // Color families
    if (answer === "Pastels & soft tones")  {
      p = { ...p, colors: dedup([...p.colors, "blush", "lavender", "mint", "ivory", "peach", "powder blue", "champagne", "lilac"]) };
      continue;
    }
    if (answer === "Bold & vibrant")        {
      p = { ...p, colors: dedup([...p.colors, "red", "maroon", "fuchsia", "cobalt", "royal blue", "saffron", "gold", "magenta"]) };
      continue;
    }
    if (answer === "Neutrals & nudes")      {
      p = { ...p, colors: dedup([...p.colors, "nude", "beige", "ivory", "cream", "taupe", "camel", "fawn"]) };
      continue;
    }
    // Style / fabric
    if (answer === "Traditional & classic") { p = { ...p, fabrics: dedup([...p.fabrics, "silk", "velvet", "brocade"]) }; continue; }
    if (answer === "Contemporary & fashion-forward") { p = { ...p, fabrics: dedup([...p.fabrics, "georgette", "crepe", "organza"]) }; continue; }
    if (answer === "Light & flowy")         { p = { ...p, fabrics: dedup([...p.fabrics, "georgette", "chiffon", "crepe"]) }; continue; }
    if (answer === "Rich & structured")     { p = { ...p, fabrics: dedup([...p.fabrics, "silk", "velvet", "brocade"]) }; continue; }
    // "Open to anything", "Comfortable & breathable", "Fusion & experimental" → no filter change
  }
  return p;
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

  const sessionToken: string | undefined = body.sessionToken;
  const followUpAnswers: Array<{ question: string; answer: string }> = body.followUpAnswers ?? [];

  // ── Test fixture short-circuit (no Gemini call) ───────────────────
  if (occasion.trim().toLowerCase() === "test prompt") {
    const { data: testData, error: testError } = await supabase
      .from("products")
      .select("*")
      .not("image_url", "is", null)
      .neq("image_url", "")
      .order("id")
      .limit(20);

    if (testError) {
      return NextResponse.json({ ok: false, error: testError.message }, { status: 500 });
    }

    const cards = (testData as Product[]).map(toOutfitCard);
    return NextResponse.json({ ok: true, cards, _parsed: { _test: true } });
  }

  // ── Resolve ParsedQuery — use sessionToken (no Gemini) or fall back to Gemini ──
  let parsed: ParsedQuery;
  if (sessionToken) {
    try {
      const base = JSON.parse(Buffer.from(sessionToken, "base64").toString("utf8")) as ParsedQuery;
      // If any answer is custom (not in our known suggestion set), re-parse with Gemini
      const hasCustom = followUpAnswers.some(a => a.answer && !KNOWN_SUGGESTIONS.has(a.answer) && a.answer !== "Open to anything");
      if (hasCustom) {
        const enriched = `${occasion}. ${followUpAnswers.map(a => a.answer).filter(Boolean).join(". ")}.`;
        parsed = await parseSearchQuery(enriched, userGender);
      } else {
        parsed = mergeAnswers(base, followUpAnswers);
      }
    } catch {
      // Token corrupt — fall back to Gemini
      parsed = await parseSearchQuery(occasion, userGender);
    }
  } else {
    // Legacy path (no token) — enrich occasion with any answers and parse
    const enriched = followUpAnswers.length > 0
      ? `${occasion}. ${followUpAnswers.map(a => a.answer).join(". ")}.`
      : occasion;
    parsed = await parseSearchQuery(enriched, userGender);
  }

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

  // Embellishments filter — OR: tagged in embellishments column OR appears in title
  // (catches products where the scraper extracted the tag AND ones where it's only in the title)
  if (parsed.embellishments.length > 0) {
    const orParts = parsed.embellishments
      .flatMap((e) => {
        const parts = [`embellishments.cs.{${e}}`, `title.ilike.%${e}%`];
        // Also try the no-space variant so "mirror work" matches "mirrorwork" in titles
        const noSpace = e.replace(/\s+/g, "");
        if (noSpace !== e) parts.push(`title.ilike.%${noSpace}%`);
        return parts;
      })
      .join(",");
    dbQuery = dbQuery.or(orParts);
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

    // DB gender is authoritative (set by the scraper for known-gender sources,
    // e.g. sojanya/tasva/jade_blue = male). Fall back to runtime classifier only
    // when the DB has no opinion, then to "unknown" as last resort.
    const dbGender = (p.gender && p.gender !== "unknown") ? p.gender : null;
    const resolvedGender: string = dbGender ?? (classified !== "unknown" ? classified : "unknown");

    if (effectiveUserGender === "male")
      return resolvedGender === "male" || resolvedGender === "unisex" || resolvedGender === "unknown";
    if (effectiveUserGender === "female")
      return resolvedGender === "female" || resolvedGender === "unisex" || resolvedGender === "unknown";
    return true;
  });

  const deduped = deduplicateProducts(filtered).sort(
    (a, b) => completenessScore(b) - completenessScore(a)
  );

  // ── Size filter (post-fetch) ──────────────────────────────────────
  const userSize = (body.top_size || body.bottom_size || "").toUpperCase();
  const sized = userSize
    ? deduped
        .filter((p) =>
          !p.available_sizes?.length ||
          p.available_sizes.map((s: string) => s.toUpperCase()).includes(userSize)
        )
        .sort((a, b) => {
          // Products with the user's size explicitly listed rank first
          const aHas = a.available_sizes?.map((s: string) => s.toUpperCase()).includes(userSize) ? 0 : 1;
          const bHas = b.available_sizes?.map((s: string) => s.toUpperCase()).includes(userSize) ? 0 : 1;
          return aHas - bHas;
        })
    : deduped;

  const cards = sized.map(toOutfitCard);
  return NextResponse.json({ ok: true, cards, _parsed: parsed });
}
