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

Generate exactly 3 Google search queries that would find INDIVIDUAL PRODUCT PAGES (not brand homepages or category listings) on Indian fashion retailer websites like Ajio, Nykaa Fashion, Myntra, Pernia's Pop-Up Shop, Aza Fashions, Raw Mango, Anita Dongre, etc.

Each query should:
- Include the occasion context and a specific garment type
- Add "buy online" or a site: filter to target product pages
- Be optimised for Google search (concise, keyword-rich)
- NOT target brand homepages or generic category pages

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
  queries: string[]
): Promise<ProductResult[]> {
  const settled = await Promise.allSettled(
    queries.map((q) => braveSearch(q, 5))
  );

  const allItems: BraveSearchResult[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      allItems.push(...result.value);
    }
  }

  // Deduplicate by domain for variety across brands, keep only product-page URLs
  const seen = new Set<string>();
  const results: ProductResult[] = [];

  for (const item of allItems) {
    if (!seen.has(item.displayUrl) && isProductPageUrl(item.url)) {
      seen.add(item.displayUrl);
      results.push({ uri: item.url, domain: item.displayUrl, title: item.title });
    }
    if (results.length >= 6) break;
  }

  // If strict filtering left nothing, fall back to all unique-domain results
  if (results.length === 0) {
    const fallbackSeen = new Set<string>();
    for (const item of allItems) {
      if (!fallbackSeen.has(item.displayUrl)) {
        fallbackSeen.add(item.displayUrl);
        results.push({ uri: item.url, domain: item.displayUrl, title: item.title });
      }
      if (results.length >= 6) break;
    }
  }

  return results;
}

/**
 * Reject only true homepages and bare root paths.
 * Everything else (category pages, product pages) is allowed through —
 * image quality is handled in the screenshot route instead.
 */
function isProductPageUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const path = url.pathname.replace(/\/$/, "");
  // Only reject the bare root
  return path.length > 0;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function findOccasionWearURLs(
  occasion: string,
  user: UserContext
): Promise<ProductResult[]> {
  // 1. Cache hit — zero API calls
  const cached = await getCachedResults(occasion, user.gender);
  if (cached && cached.length > 0) return cached;

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

  // 3. Execute queries via Brave Search
  const results = await executeSearchQueries(queries);

  // 4. Cache result (fire-and-forget)
  if (results.length > 0) setCachedResults(occasion, user.gender, results);

  return results;
}
