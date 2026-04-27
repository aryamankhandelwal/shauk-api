import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 10;

// Fetch the og:image from a product page and return it as base64.
// This replaces the Puppeteer approach entirely — no external screenshot
// service needed, runs comfortably within Vercel's 10s free-tier limit.
export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json(
        { ok: false, error: "url is required" },
        { status: 400 }
      );
    }

    // Step 1: fetch HTML (follows Gemini grounding redirects automatically)
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

    // Step 2: extract og:image URL (handles both attribute orderings)
    const imageUrl = extractOgImage(html);
    if (!imageUrl) {
      return NextResponse.json(
        { ok: false, error: "No product image found" },
        { status: 404 }
      );
    }

    // Step 3: fetch the image and convert to base64
    const imgRes = await fetch(imageUrl, {
      signal: AbortSignal.timeout(4000),
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

function extractOgImage(html: string): string | null {
  // Handles: property="og:image" content="..." and content="..." property="og:image"
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1].startsWith("http")) return match[1];
  }
  return null;
}
