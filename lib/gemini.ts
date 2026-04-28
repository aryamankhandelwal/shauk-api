import { GoogleGenerativeAI } from "@google/generative-ai";
import { getCachedResults, setCachedResults } from "@/lib/cache";
import { braveSearch, BraveSearchResult } from "@/lib/braveSearch";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export interface UserContext {
  gender?: string;
  topSize?: string;
  bottomSize?: string;
  bustIn?: number;
  waistIn?: number;
  hipsIn?: number;
  chestIn?: number;
  shouldersIn?: number;
  sleeveLengthIn?: number;
  inseamIn?: number;
}

export interface ProductResult {
  uri: string;    // product page URL
  domain: string; // e.g. "ajio.com" — used for brand extraction
  title: string;  // page title from search result, used as product name
}

// ─── Step 1: Gemini generates search queries (pure text, no grounding) ───────

async function generateSearchQueries(
  occasion: string,
  user: UserContext
): Promise<string[]> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-lite",
  });

  const clothingTypes =
    user.gender === "male"
      ? "kurta sets, sherwanis, bandhgalas, Indo-western suits"
      : "lehengas, anarkalis, sarees, sharara sets, salwar suits";

  const prompt = `You are a search query generator for Indian occasion wear shopping.

Given this occasion: "${occasion}"
Gender: ${user.gender ?? "unspecified"}
Clothing types to focus on: ${clothingTypes}

Generate exactly 3 search queries that find INDIVIDUAL PRODUCT DETAIL PAGES (PDPs) — not brand homepages, category listings, or "shop all" pages.

A PDP URL looks like:
- ajio.com/p/460908467
- perniaspopupshop.com/designers/anita-dongre/blue-silk-anarkali-12345
- manyavar.com/men/kurta-set-kpmc02782

A CATEGORY page (AVOID):
- ajio.com/men/kurtas
- nykaa.com/women/lehengas

Rules for each query:
- Use SPECIFIC product descriptors: include colour, fabric, or style (e.g. "navy blue raw silk sherwani" not just "sherwani")
- Add "buy online" or "price" to bias toward product listings
- At least one query MUST include inurl:product OR inurl:/p/
- Target Indian fashion retailers: Ajio, Nykaa Fashion, Myntra, Pernia's Pop-Up Shop, Aza Fashions, Raw Mango, Anita Dongre, Manyavar, etc.
- NEVER use words like "collection", "shop all", "browse", "explore", "trending"

Respond with ONLY the 3 queries, one per line. No numbering, no bullets, no extra text.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  const queries = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);

  if (queries.length === 0) {
    throw new Error("Gemini returned no search queries");
  }

  return queries;
}

// ─── Step 2: Execute queries via Google CSE (parallel) ───────────────────────

async function executeSearchQueries(
  queries: string[],
  maxResults: number = 6,
): Promise<ProductResult[]> {
  const settled = await Promise.allSettled(
    queries.map((q) => braveSearch(q, 7))
  );

  const allItems: BraveSearchResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      allItems.push(...result.value);
    }
  }

  // Score and rank all URLs by PDP confidence, deduplicate by domain
  const scored: { item: BraveSearchResult; score: number }[] = [];
  for (const item of allItems) {
    const score = scoreUrlPdpConfidence(item.url, item.displayUrl);
    if (score >= 0) { // only accept URLs with at least neutral PDP confidence
      scored.push({ item, score });
    }
  }

  // Sort by score descending, then deduplicate by domain
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const results: ProductResult[] = [];
  for (const { item } of scored) {
    if (seen.has(item.displayUrl)) continue;
    seen.add(item.displayUrl);
    results.push({ uri: item.url, domain: item.displayUrl, title: item.title });
    if (results.length >= maxResults) break;
  }

  return results;
}

// ─── Domain-specific PDP patterns ───────────────────────────────────────────

const DOMAIN_PDP_PATTERNS: Record<string, RegExp> = {
  "ajio.com": /\/p\//,
  "myntra.com": /\/\d{5,}/,
  "nykaa.com": /\/p\//,
  "perniaspopupshop.com": /\/designers\/.*\/[a-z0-9-]+-\d+/,
  "manyavar.com": /[A-Z]{2,5}\d{3,}/,
  "tfrstore.com": /\/products\//,
  "anitadongre.com": /\/products\//,
  "rawmango.in": /\/products\//,
  "sabyasachi.com": /\/products\//,
  "fabindia.com": /\/p\//,
  "indiancultr.com": /\/products\//,
};

/**
 * Score a URL's likelihood of being a product detail page (PDP).
 * Higher = more likely PDP. Negative = likely category or non-product page.
 */
function scoreUrlPdpConfidence(rawUrl: string, domain: string): number {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return -100;
  }
  const path = url.pathname.replace(/\/$/, "").toLowerCase();

  // Hard reject: bare root (homepages)
  if (path.length === 0) return -100;

  // Hard reject: non-fashion pages
  if (/^\/(search|login|cart|account|about|contact|faq|help|blog|privacy|terms)(\/|$)/.test(path)) {
    return -100;
  }

  let score = 0;

  // Strong PDP signals in URL path
  if (/\/(products?|p|dp|buy|item)\//.test(path)) score += 30;

  // Numeric product ID at end of slug (5+ digits to avoid year matches like -2026)
  if (/\/[a-z0-9-]+-\d{5,}(\/|$)/.test(path)) score += 25;

  // Alphanumeric SKU pattern (e.g. KPMC02782)
  if (/[A-Z]{2,5}\d{3,}/.test(url.pathname)) score += 25;

  // Domain-specific PDP pattern match
  const domainKey = Object.keys(DOMAIN_PDP_PATTERNS).find((d) => domain.includes(d));
  if (domainKey && DOMAIN_PDP_PATTERNS[domainKey].test(url.pathname)) score += 25;

  // Path depth: deeper paths more likely to be PDPs
  const segments = path.split("/").filter(Boolean);
  if (segments.length >= 3) score += 10;

  // Query params that suggest a PDP (size selector, color picker)
  const search = url.search.toLowerCase();
  if (/[?&](size|color|variant|sku)=/.test(search)) score += 10;

  // Category/listing signals — match anywhere in path (not just root segment)
  if (/\/(collections?|categories?)(\/|$)/.test(path)) score -= 100; // hard reject
  if (/^\/(c|s|shop|browse|sale|new-arrivals|best-sellers)(\/|$)/.test(path)) score -= 60;

  // Gender-only category pages: /men, /women, /men/kurtas, /women/lehengas
  if (/^\/(men|women)\/?$/.test(path)) score -= 60;
  if (/^\/(men|women)\/[a-z-]+\/?$/.test(path) && segments.length <= 2) score -= 30;

  // Single-segment path with no digits = almost always a category
  if (segments.length === 1 && !/\d/.test(segments[0])) score -= 60;

  return score;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function findOccasionWearURLs(
  occasion: string,
  user: UserContext,
  maxResults: number = 10,
): Promise<ProductResult[]> {
  // 1. Cache hit — zero API calls
  const cached = await getCachedResults(occasion, user.gender);
  if (cached && cached.length > 0) return cached.slice(0, maxResults);

  // 2. Generate search queries via Gemini (pure text, no grounding)
  let queries: string[];
  try {
    queries = await generateSearchQueries(occasion, user);
  } catch (err) {
    console.error("[gemini] query generation failed:", err);
    const clothingTypes =
      user.gender === "male"
        ? "sherwani kurta set"
        : "lehenga saree anarkali";
    queries = [`${occasion} ${clothingTypes} buy online India`];
  }

  // 3. Execute queries via Brave Search (over-fetch for resilience)
  const results = await executeSearchQueries(queries, maxResults);

  // 4. Cache result (fire-and-forget)
  if (results.length > 0) setCachedResults(occasion, user.gender, results);

  return results;
}
