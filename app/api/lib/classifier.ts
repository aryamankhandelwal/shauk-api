export type Gender = "male" | "female" | "kids" | "unknown";

const KIDS_KEYWORDS = [
  "kids", "kid", "boy", "boys", "girl", "girls",
  "baby", "infant", "toddler",
];
const MALE_KEYWORDS = [
  "men", "mens", "men's", "kurta for men", "sherwani",
];
const FEMALE_KEYWORDS = [
  "women", "womens", "women's", "kurti", "lehenga", "saree",
];
const BLOCK_URL_SEGMENTS = ["/kids", "/boys", "/girls"];

export function classifyProduct(product: {
  title?: string;
  product_url?: string;
}): { gender: Gender; exclude: boolean } {
  const url = (product.product_url || "").toLowerCase();
  const text = ((product.title || "") + " " + url).toLowerCase();

  // Block by URL segment first
  if (BLOCK_URL_SEGMENTS.some((seg) => url.includes(seg))) {
    return { gender: "kids", exclude: true };
  }

  // Hard block: kids keywords
  if (KIDS_KEYWORDS.some((k) => text.includes(k))) {
    return { gender: "kids", exclude: true };
  }

  // Male signals
  if (MALE_KEYWORDS.some((k) => text.includes(k))) {
    return { gender: "male", exclude: false };
  }

  // Female signals
  if (FEMALE_KEYWORDS.some((k) => text.includes(k))) {
    return { gender: "female", exclude: false };
  }

  return { gender: "unknown", exclude: false };
}
