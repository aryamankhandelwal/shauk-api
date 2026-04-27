import { supabaseAdmin } from "@/lib/supabase";
import type { ProductResult } from "@/lib/gemini";

const TTL_HOURS = 24;

// Bump this version string to invalidate all cached results globally.
const CACHE_VERSION = "v2";

function makeCacheKey(occasion: string, gender?: string): string {
  return `${CACHE_VERSION}__${occasion.toLowerCase().trim()}__${(gender ?? "unknown").toLowerCase()}`;
}

export async function getCachedResults(
  occasion: string,
  gender?: string
): Promise<ProductResult[] | null> {
  const since = new Date(Date.now() - TTL_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("search_cache")
    .select("results")
    .eq("cache_key", makeCacheKey(occasion, gender))
    .gte("created_at", since)
    .maybeSingle();
  if (error) {
    console.error("[cache] read", error.message);
    return null;
  }
  return data?.results ?? null;
}

export async function setCachedResults(
  occasion: string,
  gender: string | undefined,
  results: ProductResult[]
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("search_cache")
    .upsert(
      {
        cache_key: makeCacheKey(occasion, gender),
        results,
        created_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" }
    );
  if (error) console.error("[cache] write", error.message);
}
