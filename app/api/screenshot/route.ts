import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const maxDuration = 10;

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ─── Gemini Vision image classification ──────────────────────────────────────

interface ClassifyResult {
  isProduct: boolean;
  confidence: number;
}

/**
 * Classify image using Gemini Vision to verify it is a product/clothing photo.
 * Returns { isProduct, confidence }. Never throws — returns { isProduct: true }
 * if Gemini is unavailable, so the pipeline is never blocked.
 */
async function classifyImage(imageBase64: string): Promise<ClassifyResult> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return { isProduct: true, confidence: 0.5 };

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

    const result = await Promise.race([
      model.generateContent([
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: imageBase64,
          },
        },
        "Is this image a product photo of a clothing or fashion item, or a model wearing clothing? Answer ONLY 'yes' or 'no'.",
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), 4000)
      ),
    ]);

    const text = result.response.text().trim().toLowerCase();
    const isProduct = text.startsWith("yes");
    return { isProduct, confidence: isProduct ? 0.8 : 0.2 };
  } catch {
    // Gemini unavailable or rate-limited — pass through
    return { isProduct: true, confidence: 0.5 };
  }
}

// Fetch the best product image from a page and return it as base64.
// Priority: schema.org Product JSON-LD → og:image → twitter:image → body <img> tags
// Validates fetched images by file size and pixel dimensions.
export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "url is required" },
        { status: 400 }
      );
    }

    const htmlRes = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": MOBILE_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(5000),
    });

    const html = await htmlRes.text();
    let candidates = extractProductImageCandidates(html);

    // Detect page type. Trust the URL itself first — many Shopify/JS-rendered PDPs
    // lack HTML signals (no JSON-LD, no static "Add to Cart" text) but have
    // clear PDP URL patterns like /products/, /p/, or SKU slugs.
    let resolvedUrl: string | null = null;
    const urlIsPdp = isProductPageUrl(url);
    const pageType = urlIsPdp ? 'pdp' : detectPageType(html);
    if (pageType !== 'pdp') {
      const productUrl = extractFirstProductLink(html, url);
      if (productUrl) {
        try {
          const pdpRes = await fetch(productUrl, {
            redirect: "follow",
            headers: { "User-Agent": MOBILE_UA, Accept: "text/html" },
            signal: AbortSignal.timeout(4000),
          });
          const pdpHtml = await pdpRes.text();
          const pdpCandidates = extractProductImageCandidates(pdpHtml);
          if (pdpCandidates.length > 0) {
            candidates = pdpCandidates; // prefer PDP images over category page images
            resolvedUrl = productUrl;   // track that we followed a PDP link
          }
        } catch {
          // PDP fetch failed — fall back to original candidates
        }
      } else {
        // Category page with no extractable PDP link.
        // Penalize og:image (typically a promotional banner) so body product
        // grid images outrank it.
        candidates = candidates
          .map((c) => {
            if (c.score >= 50 && !/\/(product|catalog|media\/catalog)\//.test(c.url.toLowerCase())) {
              return { ...c, score: c.score - 40 };
            }
            return c;
          })
          .sort((a, b) => b.score - a.score);
      }
    }

    if (candidates.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No product image found" },
        { status: 404 }
      );
    }

    // Try top candidates in score order until one passes validation
    for (const candidate of candidates.slice(0, 5)) {
      try {
        const imgRes = await fetch(candidate.url, {
          signal: AbortSignal.timeout(3000),
          headers: { "User-Agent": MOBILE_UA, Referer: url },
        });

        if (!imgRes.ok) continue;

        const buffer = await imgRes.arrayBuffer();

        // Reject tiny files — logos are typically < 5KB
        if (buffer.byteLength < 5000) continue;

        // Validate pixel dimensions from raw bytes
        const dims = getImageDimensions(buffer);
        if (dims) {
          if (dims.width < 100 || dims.height < 100) continue;
          if (dims.width > dims.height * 2.5) continue; // extreme landscape = banner
        }

        const base64 = Buffer.from(buffer).toString("base64");

        // Semantic validation: is this actually a product/clothing image?
        const classification = await classifyImage(base64);
        if (!classification.isProduct) continue; // try next candidate

        return NextResponse.json({
          ok: true,
          image_base64: base64,
          confidence: classification.confidence,
          ...(resolvedUrl ? { resolved_url: resolvedUrl } : {}),
        });
      } catch {
        // timeout or fetch error — try next candidate
        continue;
      }
    }

    return NextResponse.json(
      { ok: false, error: "No valid product image found" },
      { status: 404 }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error("[screenshot]", err?.message);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Internal error" },
      { status: 500 }
    );
  }
}

// ─── Image extraction ─────────────────────────────────────────────────────────

interface ImageCandidate {
  url: string;
  score: number; // higher = better
}

function extractProductImageCandidates(html: string): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  // 1. schema.org Product JSON-LD (most reliable for actual product pages)
  const jsonLdImages = extractJsonLdProductImages(html);
  for (const imgUrl of jsonLdImages) {
    candidates.push({ url: imgUrl, score: scoreImageUrl(imgUrl, null, null, 100) });
  }

  // 2. og:image + dimensions
  const og = extractOgImageWithDimensions(html);
  if (og.url) {
    candidates.push({ url: og.url, score: scoreImageUrl(og.url, og.width, og.height, 50) });
  }

  // 3. twitter:image
  const twitterImg =
    extractMetaContent(html, /name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ??
    extractMetaContent(html, /content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twitterImg?.startsWith("http")) {
    candidates.push({ url: twitterImg, score: scoreImageUrl(twitterImg, null, null, 30) });
  }

  // 4. Body <img> tags as fallback
  const bodyImages = extractBodyImages(html);
  for (const img of bodyImages) {
    candidates.push({ url: img.url, score: scoreImageUrl(img.url, img.width, img.height, 25) });
  }

  // Deduplicate by URL, keeping highest score
  const seen = new Map<string, ImageCandidate>();
  for (const c of candidates) {
    const existing = seen.get(c.url);
    if (!existing || c.score > existing.score) {
      seen.set(c.url, c);
    }
  }

  return Array.from(seen.values())
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Score an image URL candidate.
 * Penalises landscape images and URLs containing logo/icon/banner keywords.
 * Rewards portrait images and product-related URL paths.
 */
function scoreImageUrl(
  imgUrl: string,
  width: number | null,
  height: number | null,
  baseScore: number
): number {
  let score = baseScore;
  const lower = imgUrl.toLowerCase();

  // URL path keywords that suggest a logo or banner
  if (
    /\/(logo|icon|brand|banner|header|footer|sprite|favicon|watermark|site-logo|brand-logo)/.test(
      lower
    )
  ) {
    score -= 80;
  }

  // Bonus for product-related URL paths
  if (/\/(product|catalog|media\/catalog|item|pdp)\//.test(lower)) {
    score += 15;
  }

  // Dimensions embedded in the URL, e.g. "800x1000"
  const dimMatch = lower.match(/[_\-x](\d{2,4})[x_\-](\d{2,4})/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1]);
    const h = parseInt(dimMatch[2]);
    if (w < 200 && h < 200) score -= 60; // tiny = likely icon/logo
    else if (w > h * 1.5) score -= 40; // landscape → likely banner
    else if (h >= w) score += 20; // portrait or square → product photo
  }

  // Explicit dimensions (from og:image or <img> attributes)
  if (width && height) {
    if (width < 200 && height < 200) score -= 60;
    else if (width > height * 1.5) score -= 40;
    else if (height >= width) score += 20;
  }

  return score;
}

// ─── Tier 4: Body <img> extraction ───────────────────────────────────────────

interface BodyImage {
  url: string;
  width: number | null;
  height: number | null;
}

function extractBodyImages(html: string): BodyImage[] {
  const imgPattern = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const results: BodyImage[] = [];
  const rejectKeywords = /logo|icon|brand|banner|header|footer|sprite|favicon|watermark|social|share|tracking|pixel/i;
  let match: RegExpExecArray | null;

  while ((match = imgPattern.exec(html)) !== null) {
    const src = match[1];
    if (!src.startsWith("http")) continue;

    const tag = match[0];
    // Skip if src or alt contains reject keywords
    if (rejectKeywords.test(src)) continue;
    const altMatch = tag.match(/alt=["']([^"']*)/i);
    if (altMatch && rejectKeywords.test(altMatch[1])) continue;

    // Extract width/height attributes
    const wMatch = tag.match(/width=["']?(\d+)/i);
    const hMatch = tag.match(/height=["']?(\d+)/i);
    const w = wMatch ? parseInt(wMatch[1]) : null;
    const h = hMatch ? parseInt(hMatch[1]) : null;

    // Skip explicitly tiny images
    if (w !== null && w < 100) continue;
    if (h !== null && h < 100) continue;

    results.push({ url: src, width: w, height: h });
    if (results.length >= 5) break;
  }

  return results;
}

// ─── Image dimension parsing ─────────────────────────────────────────────────

function getImageDimensions(
  buffer: ArrayBuffer
): { width: number; height: number } | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 24) return null;

  // PNG: bytes 0-7 = signature, 16-19 = width, 20-23 = height
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(buffer);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: find SOF0 (0xFF 0xC0) or SOF2 (0xFF 0xC2) marker
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length - 9) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      // SOF0, SOF1, SOF2 markers
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const view = new DataView(buffer);
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return { width, height };
      }
      // Skip to next marker
      const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
      offset += 2 + segLen;
    }
  }

  // WebP: RIFF....WEBPVP8 header
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    // VP8 lossy
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      if (bytes.length >= 30) {
        const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
        const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
        return { width, height };
      }
    }
  }

  return null;
}

// ─── URL-based PDP detection ────────────────────────────────────────────────

/**
 * Quick URL-only check: does this URL look like a product detail page?
 * Used to short-circuit HTML analysis for JS-rendered sites (Shopify, etc.)
 * that won't have JSON-LD or Add-to-Cart text in static HTML.
 */
function isProductPageUrl(rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  const path = url.pathname.toLowerCase();

  // Clear PDP signals
  if (/\/(products?|p|dp|buy|item)\//.test(path)) return true;
  if (/\/[a-z0-9-]+-\d{5,}(\/|$)/.test(path)) return true; // slug-12345+ (not years)
  if (/[A-Z]{2,5}\d{3,}/.test(url.pathname)) return true;   // SKU like KPMC02782

  // Clear category signals
  if (/\/(collections?|categories?|c|s|shop|browse)(\/|$)/.test(path)) return false;
  if (/^\/(men|women)\/?$/.test(path)) return false;
  if (/^\/(men|women)\/[a-z-]+\/?$/.test(path) && path.split('/').filter(Boolean).length <= 2) return false;

  return false; // unknown — let HTML signals decide
}

// ─── Page type detection ────────────────────────────────────────────────────

/**
 * Detect whether a page is a product detail page (PDP) or a category/listing page.
 * Uses multiple signals beyond just JSON-LD schema.
 */
function detectPageType(html: string): 'pdp' | 'category' | 'unknown' {
  // Strong PDP signal: Product JSON-LD
  if (hasProductSchema(html)) return 'pdp';

  // Strong PDP signal: Add to Cart / Buy Now button text
  if (/add\s+to\s+(cart|bag|basket)|buy\s+now/i.test(html)) return 'pdp';

  // Strong category signal: multiple product links (listing page grid)
  const pdpLinkCount = (
    html.match(/<a[^>]+href=["'][^"']*\/(products?|p|dp)\//gi) || []
  ).length;
  if (pdpLinkCount >= 4) return 'category';

  // Category signal: title starts with listing keywords (not just contains — product pages
  // often include collection names like "Rewild 2026 Collection" in their titles)
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1].toLowerCase().trim();
    if (/^(shop all|browse|all products|collections?:)/.test(title)) {
      return 'category';
    }
  }

  return 'unknown';
}

// ─── Category → PDP extraction ──────────────────────────────────────────────

/** Check if the page has a schema.org Product JSON-LD block */
function hasProductSchema(html: string): boolean {
  const scriptPattern =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1]);
      if (containsProductType(json)) return true;
    } catch {
      // skip malformed JSON
    }
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function containsProductType(obj: any): boolean {
  if (!obj) return false;
  if (Array.isArray(obj)) return obj.some(containsProductType);
  if (Array.isArray(obj["@graph"])) return obj["@graph"].some(containsProductType);
  const type: string = obj["@type"] ?? "";
  return type === "Product" || type.includes("Product");
}

/**
 * Extract the first individual product link from a category/listing page.
 * Two-pass approach: first try explicit PDP URL patterns, then use a
 * depth-relative heuristic (links deeper than the current page are likely PDPs).
 */
function extractFirstProductLink(html: string, baseUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  const baseSegments = base.pathname.replace(/\/$/, "").split("/").filter(Boolean).length;

  // Match <a> tags with href attributes
  const linkPattern = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  // PDP path patterns — these indicate individual product pages
  const pdpPatterns = [
    /\/products?\//i,
    /\/p\//i,
    /\/buy\//i,
    /\/item\//i,
    /\/dp\//i,                       // Amazon-style
    /\/[a-z0-9-]+-\d{5,}/i,         // slug ending with numeric product ID (5+ digits, avoids year matches)
    /[A-Z]{2,5}\d{3,}/,             // alphanumeric SKU like KPMC02782 (Manyavar, etc.)
    /\/[a-z0-9-]+-[a-z]{1,5}\d{3,}/i, // slug-kpmc02782 style IDs
  ];

  // Paths to skip even if they match
  const skipPatterns = [
    /\/cart/i,
    /\/account/i,
    /\/login/i,
    /\/wishlist/i,
    /\/review/i,
    /\/filter/i,
    /\/sort/i,
    /\/page\b/i,
    /\/collections?(\/|$)/i,  // never follow collection/category links
    /\/categor/i,
    /\/blog/i,
  ];

  const seen = new Set<string>();
  const candidateLinks: string[] = [];

  while ((match = linkPattern.exec(html)) !== null) {
    let href = match[1];

    // Resolve relative URLs
    try {
      const resolved = new URL(href, base.origin);
      // Only follow links on the same domain
      if (resolved.hostname !== base.hostname) continue;
      href = resolved.href;
    } catch {
      continue;
    }

    if (seen.has(href)) continue;
    seen.add(href);

    const path = new URL(href).pathname.toLowerCase();

    // Skip non-product paths
    if (skipPatterns.some((p) => p.test(path))) continue;

    // Pass 1: explicit PDP pattern match — return immediately
    if (pdpPatterns.some((p) => p.test(path))) {
      return href;
    }

    candidateLinks.push(href);
  }

  // Pass 2: depth heuristic — links deeper than the current category page
  // (e.g. /men/kurtas/product-slug has 3 segments vs /men/kurtas has 2)
  for (const href of candidateLinks) {
    const path = new URL(href).pathname.replace(/\/$/, "");
    const segments = path.split("/").filter(Boolean).length;
    if (segments > baseSegments && segments >= 3) {
      return href;
    }
  }

  return null;
}

// ─── Meta tag helpers ────────────────────────────────────────────────────────

function extractOgImageWithDimensions(
  html: string
): { url: string | null; width: number | null; height: number | null } {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  let url: string | null = null;
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]?.startsWith("http")) {
      url = m[1];
      break;
    }
  }

  const widthStr =
    extractMetaContent(html, /property=["']og:image:width["'][^>]+content=["']([^"']+)["']/i) ??
    extractMetaContent(html, /content=["']([^"']+)["'][^>]+property=["']og:image:width["']/i);
  const heightStr =
    extractMetaContent(html, /property=["']og:image:height["'][^>]+content=["']([^"']+)["']/i) ??
    extractMetaContent(html, /content=["']([^"']+)["'][^>]+property=["']og:image:height["']/i);

  return {
    url,
    width: widthStr ? parseInt(widthStr) : null,
    height: heightStr ? parseInt(heightStr) : null,
  };
}

function extractMetaContent(html: string, pattern: RegExp): string | null {
  return html.match(pattern)?.[1] ?? null;
}

function extractJsonLdProductImages(html: string): string[] {
  const images: string[] = [];
  const scriptPattern =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptPattern.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1]);
      collectProductImages(json, images);
    } catch {
      // skip malformed JSON
    }
  }
  return images;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectProductImages(schema: any, out: string[]): void {
  if (!schema) return;
  if (Array.isArray(schema["@graph"])) {
    for (const n of schema["@graph"]) collectProductImages(n, out);
    return;
  }
  if (Array.isArray(schema)) {
    for (const n of schema) collectProductImages(n, out);
    return;
  }
  const type: string = schema["@type"] ?? "";
  if (type !== "Product" && !type.includes("Product")) return;

  const image = schema["image"];
  if (typeof image === "string" && image.startsWith("http")) out.push(image);
  else if (Array.isArray(image)) {
    for (const img of image) {
      if (typeof img === "string" && img.startsWith("http")) out.push(img);
      else if (typeof img === "object" && img?.url?.startsWith("http")) out.push(img.url);
    }
  } else if (typeof image === "object" && image?.url?.startsWith("http")) {
    out.push(image.url);
  }
}
