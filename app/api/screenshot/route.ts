import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 10;

// Fetch the best product image from a page and return it as base64.
// Priority: schema.org Product JSON-LD → og:image (portrait/square) → twitter:image
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
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(6000),
    });

    const html = await htmlRes.text();
    const imageUrl = extractProductImage(html);

    if (!imageUrl) {
      return NextResponse.json(
        { ok: false, error: "No product image found" },
        { status: 404 }
      );
    }

    const imgRes = await fetch(imageUrl, {
      signal: AbortSignal.timeout(4000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Referer: url,
      },
    });

    if (!imgRes.ok) {
      return NextResponse.json(
        { ok: false, error: "Failed to fetch image" },
        { status: 502 }
      );
    }

    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    return NextResponse.json({ ok: true, image_base64: base64 });
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

function extractProductImage(html: string): string | null {
  const candidates: ImageCandidate[] = [];

  // 1. schema.org Product JSON-LD (most reliable for actual product pages)
  const jsonLdImages = extractJsonLdProductImages(html);
  for (const imgUrl of jsonLdImages) {
    candidates.push({ url: imgUrl, score: 100 });
  }

  // 2. og:image + dimensions
  const og = extractOgImageWithDimensions(html);
  if (og.url) {
    const score = scoreImageUrl(og.url, og.width, og.height, 50);
    candidates.push({ url: og.url, score });
  }

  // 3. twitter:image
  const twitterImg = extractMetaContent(html, /name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    ?? extractMetaContent(html, /content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twitterImg?.startsWith("http")) {
    candidates.push({ url: twitterImg, score: scoreImageUrl(twitterImg, null, null, 30) });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  // Reject if score is negative (clearly a logo)
  return best.score < 0 ? null : best.url;
}

/**
 * Score an image URL candidate.
 * baseScore: starting score for this source.
 * Penalises landscape images and URLs that contain logo/icon/banner keywords.
 * Rewards portrait images.
 */
function scoreImageUrl(
  imgUrl: string,
  width: number | null,
  height: number | null,
  baseScore: number
): number {
  let score = baseScore;

  // URL path keywords that suggest a logo or banner
  const lower = imgUrl.toLowerCase();
  if (/\/(logo|icon|brand|banner|header|footer|sprite|favicon|watermark)/.test(lower)) {
    score -= 80;
  }

  // Dimensions embedded in the URL, e.g. "800x1000" or "w=800&h=1000"
  const dimMatch = lower.match(/[_\-x](\d{2,4})[x_\-](\d{2,4})/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1]);
    const h = parseInt(dimMatch[2]);
    if (w > h * 1.5) score -= 40; // landscape → likely banner/logo
    else if (h >= w) score += 20; // portrait or square → likely product photo
  }

  // Explicit og:image dimensions
  if (width && height) {
    if (width > height * 1.5) score -= 40; // landscape
    else if (height >= width) score += 20;  // portrait/square
  }

  return score;
}

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
    if (m?.[1]?.startsWith("http")) { url = m[1]; break; }
  }

  const widthStr = extractMetaContent(html, /property=["']og:image:width["'][^>]+content=["']([^"']+)["']/i)
    ?? extractMetaContent(html, /content=["']([^"']+)["'][^>]+property=["']og:image:width["']/i);
  const heightStr = extractMetaContent(html, /property=["']og:image:height["'][^>]+content=["']([^"']+)["']/i)
    ?? extractMetaContent(html, /content=["']([^"']+)["'][^>]+property=["']og:image:height["']/i);

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
