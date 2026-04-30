export type Gender = "male" | "female" | "kids" | "unknown";

// Use regex patterns with word boundaries so "men" never matches inside "women"
const KIDS_PATTERNS = [
  /\bkids?\b/, /\bboys?\b/, /\bgirls?\b/, /\bbaby\b/, /\binfant\b/, /\btoddler\b/,
];
const MALE_PATTERNS = [
  /\bmen\b/, /\bmens\b/, /\bmen's\b/, /\bsherwani\b/, /\bkurta\s+for\s+men\b/,
  /\bpathani\b/, /\bnehru\b/, /\bbandhgala\b/,
];
const FEMALE_PATTERNS = [
  /\bwomen\b/, /\bwomens\b/, /\bwomen's\b/, /\bkurti\b/, /\blehenga\b/,
  /\bsaree\b/, /\bsari\b/, /\banarkali\b/, /\bsalwar\b/, /\bdupatta\b/,
];

const KIDS_URL_SEGMENTS = ["/kids", "/boys", "/girls", "/baby", "/infant"];
const MALE_URL_SEGMENTS = ["/men/", "/men-", "-men/", "/menswear", "/mens/"];
const FEMALE_URL_SEGMENTS = ["/women/", "/women-", "-women/", "/womenswear", "/womens/"];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function classifyProduct(product: {
  title?: string;
  product_url?: string;
}): { gender: Gender; exclude: boolean } {
  const url = (product.product_url || "").toLowerCase();
  const text = ((product.title || "") + " " + url).toLowerCase();

  // Kids: URL segment check first, then keyword
  if (KIDS_URL_SEGMENTS.some((seg) => url.includes(seg))) {
    return { gender: "kids", exclude: true };
  }
  if (matchesAny(text, KIDS_PATTERNS)) {
    return { gender: "kids", exclude: true };
  }

  // URL-based gender takes priority over title keywords
  if (FEMALE_URL_SEGMENTS.some((seg) => url.includes(seg))) {
    return { gender: "female", exclude: false };
  }
  if (MALE_URL_SEGMENTS.some((seg) => url.includes(seg))) {
    return { gender: "male", exclude: false };
  }

  // Title keyword fallback (word-boundary safe)
  if (matchesAny(text, MALE_PATTERNS)) {
    return { gender: "male", exclude: false };
  }
  if (matchesAny(text, FEMALE_PATTERNS)) {
    return { gender: "female", exclude: false };
  }

  return { gender: "unknown", exclude: false };
}
