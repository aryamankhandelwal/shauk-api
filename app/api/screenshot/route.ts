import { NextRequest, NextResponse } from "next/server";
import { extractProductImageFromHtml } from "@/lib/gemini";

export const runtime = "nodejs";
export const maxDuration = 60;

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string, timeoutMs = 4000): Promise<string> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": MOBILE_UA, Accept: "text/html" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.text();
}

// ─── Trusted fashion CDN check (Phase C) ──────────────────────────────────────

const TRUSTED_CDN_PATTERNS = [
  /^https?:\/\/cdn\.shopify\.com\/s\/files\/.+\/products\//i,
  /^https?:\/\/res\.cloudinary\.com\/.+\/image\/upload\//i,
  /^https?:\/\/assets\.ajio\.com\//i,
  /^https?:\/\/images\.ajio\.com\//i,
  /^https?:\/\/assets\.myntassets\.com\//i,
  /^https?:\/\/cdn\.perniaspopupshop\.com\//i,
  /^https?:\/\/media\.rawmango\.in\//i,
  /^https?:\/\/.+\.akamaized\.net\/.+\/(product|catalog|item)\//i,
];

function isTrustedCdnUrl(url: string): boolean {
  return TRUSTED_CDN_PATTERNS.some((p) => p.test(url));
}

// ─── Image URL upscaling ─────────────────────────────────────────────────────

function upscaleImageUrl(imgUrl: string): string {
  try {
    // Shopify CDN: replace _NNxNN or _NNx with larger dimensions
    if (/cdn\.shopify\.com/i.test(imgUrl)) {
      return imgUrl
        .replace(/_\d{2,4}x\d{0,4}\./, '_1200x.')
        .replace(/&width=\d+/, '&width=1200');
    }

    // Cloudinary: insert w_1200,q_auto transform
    if (/res\.cloudinary\.com/i.test(imgUrl)) {
      // Replace existing w_NNN transform or insert before /v1/
      if (/\/w_\d+/.test(imgUrl)) {
        return imgUrl.replace(/\/w_\d+/, '/w_1200');
      }
      return imgUrl.replace(/(\/image\/upload\/)/, '$1w_1200,q_auto/');
    }

    // Ajio assets: replace w-NNN with w-1200
    if (/assets\.ajio\.com|images\.ajio\.com/i.test(imgUrl)) {
      return imgUrl.replace(/\/w-\d+\//, '/w-1200/');
    }

    // Myntra assets: replace h_NNN,q_NNN,w_NNN with larger
    if (/assets\.myntassets\.com/i.test(imgUrl)) {
      return imgUrl
        .replace(/\/h_\d+,/, '/h_1600,')
        .replace(/\/w_\d+,/, '/w_1200,')
        .replace(/\/q_\d+,/, '/q_95,');
    }

    // Pernia's Pop-Up Shop CDN
    if (/cdn\.perniaspopupshop\.com/i.test(imgUrl)) {
      return imgUrl.replace(/\/w\d+\//, '/w1200/');
    }

    // General: strip common thumbnail query params
    const url = new URL(imgUrl);
    let changed = false;
    for (const key of ['w', 'width', 'h', 'height', 'size', 'thumb']) {
      if (url.searchParams.has(key)) {
        const val = parseInt(url.searchParams.get(key)!);
        if (!isNaN(val) && val < 800) {
          url.searchParams.set(key, '1200');
          changed = true;
        }
      }
    }
    if (changed) return url.toString();
  } catch {
    // URL parsing failed — return original
  }
  return imgUrl;
}

// ─── Image URL validation via HEAD request ───────────────────────────────────

async function validateImageUrl(imgUrl: string): Promise<boolean> {
  try {
    const res = await fetch(imgUrl, {
      method: "HEAD",
      redirect: "follow",
      headers: { "User-Agent": MOBILE_UA },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return false;
    const contentLength = parseInt(res.headers.get("content-length") ?? "0");
    // Images < 15KB are almost always logos, icons, or placeholders
    if (contentLength > 0 && contentLength < 15000) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── SPA shell detection ──────────────────────────────────────────────────────

function detectSpaShell(html: string): boolean {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  const textContent = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (textContent.length < 500) return true;
  // Empty root div — dead giveaway of a JS-rendered SPA
  if (/<div[^>]+id=["'](__next|root)["'][^>]*>\s*<\/div>/i.test(html)) return true;
  return false;
}

// ─── Image extraction ─────────────────────────────────────────────────────────

interface ImageCandidate {
  url: string;
  score: number;
}

/**
 * Score an image URL.
 * @param isSpaOgImage - when true, cap score to 0 (SPA og:image is almost always a logo/social card)
 */
function scoreImageUrl(imgUrl: string, baseScore: number, isSpaOgImage = false): number {
  if (isSpaOgImage) return Math.min(baseScore, 0);

  let score = baseScore;
  const lower = imgUrl.toLowerCase();

  // Logo / UI element penalties
  if (
    /\/(logo|icon|brand|banner|header|footer|sprite|favicon|watermark|site-logo|brand-logo)/.test(lower)
  ) {
    score -= 80;
  }

  // Known product CDN paths — very reliable
  if (/cdn\.shopify\.com\/s\/files\/.+\/products\//.test(lower)) score += 50;
  if (/res\.cloudinary\.com\/.+\/image\/upload\//.test(lower)) score += 30;
  if (/\/(product|catalog|media\/catalog|item|pdp)\//.test(lower)) score += 15;

  // Dimensions embedded in URL: _800x1000, -800x1000
  const dimMatch = lower.match(/[_-](\d{2,4})x(\d{2,4})/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1]);
    const h = parseInt(dimMatch[2]);
    if (w < 200 && h < 200) score -= 60; // tiny → icon/pixel
    else if (w >= 200 && w <= 400 && Math.abs(w - h) < 60) score -= 30; // small square → logo
    else if (w > h * 1.5) score -= 40; // landscape → banner
    else if (h >= w * 1.2 && h >= 600) score += 40; // tall portrait + large → product photo
    else if (h >= w) score += 20; // portrait / square → likely product
  }

  return score;
}

function extractProductImageCandidates(html: string, isSpa: boolean): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];

  // 1. JSON-LD Product schema (most reliable on non-SPA pages)
  for (const imgUrl of extractJsonLdProductImages(html)) {
    candidates.push({ url: imgUrl, score: scoreImageUrl(imgUrl, 100) });
  }

  // 2. og:image — penalised hard when page is an SPA shell
  const ogUrl = extractOgImage(html);
  if (ogUrl) {
    candidates.push({ url: ogUrl, score: scoreImageUrl(ogUrl, 50, isSpa) });
  }

  // 3. twitter:image
  const twitterImg =
    extractMetaContent(html, /name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ??
    extractMetaContent(html, /content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twitterImg?.startsWith("http")) {
    candidates.push({ url: twitterImg, score: scoreImageUrl(twitterImg, 30) });
  }

  // 4. Body <img> tags (including data-src for lazy-loaded images)
  for (const img of extractBodyImages(html)) {
    candidates.push({ url: img, score: scoreImageUrl(img, 25) });
  }

  // Deduplicate by URL, keeping highest score
  const seen = new Map<string, ImageCandidate>();
  for (const c of candidates) {
    const ex = seen.get(c.url);
    if (!ex || c.score > ex.score) seen.set(c.url, c);
  }

  return Array.from(seen.values())
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score);
}

// ─── POST handler — 4-phase agentic loop ─────────────────────────────────────

/**
 * Helper: upscale + validate an image URL. Returns the URL if valid, null otherwise.
 */
async function tryImage(imgUrl: string): Promise<string | null> {
  const upscaled = upscaleImageUrl(imgUrl);
  if (await validateImageUrl(upscaled)) return upscaled;
  // If upscaling changed the URL and failed, try the original
  if (upscaled !== imgUrl && await validateImageUrl(imgUrl)) return imgUrl;
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const { url, thumbnail_url } = await req.json();
    if (!url) {
      return NextResponse.json({ ok: false, error: "url is required" }, { status: 400 });
    }

    // ── Phase A: Fast static extraction ──────────────────────────────────────
    let html = "";
    try {
      html = await fetchHtml(url, 4000);
    } catch {
      // fetch timed out or failed — proceed without HTML
    }

    const isSpa = html ? detectSpaShell(html) : false;
    const candidates = html ? extractProductImageCandidates(html, isSpa) : [];
    const best = candidates[0];

    // High-confidence static hit — validate before returning
    if (best && best.score >= 80) {
      const valid = await tryImage(best.url);
      if (valid) return NextResponse.json({ ok: true, image_url: valid });
      // Score was high but image invalid (logo/broken) — fall through to Gemini
    }

    // ── Phase B: Gemini agent ─────────────────────────────────────────────────
    if (html) {
      try {
        const geminiResult = await extractProductImageFromHtml(url, html);

        if (geminiResult) {
          if (geminiResult.page_type === "listing" && geminiResult.product_url) {
            try {
              const pdpHtml = await fetchHtml(geminiResult.product_url, 3000);
              const pdpResult = await extractProductImageFromHtml(
                geminiResult.product_url,
                pdpHtml,
              );
              if (pdpResult?.found && pdpResult.image_url) {
                const valid = await tryImage(pdpResult.image_url);
                if (valid) {
                  return NextResponse.json({
                    ok: true,
                    image_url: valid,
                    resolved_url: geminiResult.product_url,
                  });
                }
              }
            } catch {
              // PDP fetch failed — fall through
            }
          } else if (geminiResult.found && geminiResult.image_url) {
            const valid = await tryImage(geminiResult.image_url);
            if (valid) return NextResponse.json({ ok: true, image_url: valid });
          }
        }
      } catch (err) {
        console.error("[screenshot] gemini phase failed:", err);
      }
    }

    // ── Phase C: Brave thumbnail CDN trust check ──────────────────────────────
    if (thumbnail_url && isTrustedCdnUrl(thumbnail_url)) {
      const valid = await tryImage(thumbnail_url);
      if (valid) return NextResponse.json({ ok: true, image_url: valid });
    }

    // ── Phase D: Walk remaining candidates, validate each ────────────────────
    for (const candidate of candidates.slice(0, 5)) {
      const valid = await tryImage(candidate.url);
      if (valid) return NextResponse.json({ ok: true, image_url: valid });
    }

    // ── Phase E: Thumbnail fallback ──────────────────────────────────────────
    if (thumbnail_url) {
      const valid = await tryImage(thumbnail_url);
      if (valid) return NextResponse.json({ ok: true, image_url: valid });
    }

    return NextResponse.json({ ok: false, error: "No valid product image found" }, { status: 404 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal error";
    console.error("[screenshot]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ─── Meta tag helpers ─────────────────────────────────────────────────────────

function extractOgImage(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]?.startsWith("http")) return m[1];
  }
  return null;
}

function extractMetaContent(html: string, pattern: RegExp): string | null {
  return html.match(pattern)?.[1] ?? null;
}

// ─── Body <img> extraction ────────────────────────────────────────────────────

function extractBodyImages(html: string): string[] {
  // Match src AND data-src (lazy-loaded images)
  const imgPattern = /<img\s[^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;
  const results: string[] = [];
  const rejectKeywords =
    /logo|icon|brand|banner|header|footer|sprite|favicon|watermark|social|share|tracking|pixel/i;
  let match: RegExpExecArray | null;

  while ((match = imgPattern.exec(html)) !== null) {
    const src = match[1];
    if (!src.startsWith("http")) continue;
    const tag = match[0];
    if (rejectKeywords.test(src)) continue;
    const altMatch = tag.match(/alt=["']([^"']*)/i);
    if (altMatch && rejectKeywords.test(altMatch[1])) continue;
    results.push(src);
    if (results.length >= 5) break;
  }

  return results;
}

// ─── JSON-LD Product image extraction ────────────────────────────────────────

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
