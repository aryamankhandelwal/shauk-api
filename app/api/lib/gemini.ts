import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export interface ParsedQuery {
  garment_types: string[];
  colors: string[];
  max_price: number | null;
  min_price: number | null;
  fabrics: string[];
  keywords: string[];
  gender_hint: "male" | "female" | null;
}

// Must match the values stored in the DB (from metadata.ts GARMENT_TYPES)
const VALID_GARMENTS = [
  "kurta", "lehenga", "saree", "sherwani", "anarkali", "salwar", "palazzo",
  "bandhgala", "pathani", "kurti", "dupatta", "co-ord", "gown", "dress",
  "suit", "sharara", "gharara",
];

// Must match the values stored in the DB (from metadata.ts COLORS)
const VALID_COLORS = [
  "pink", "red", "blue", "green", "yellow", "orange", "purple", "black",
  "white", "grey", "gold", "silver", "beige", "nude", "navy", "teal",
  "mint", "violet", "lavender", "mustard", "peach", "coral", "blush",
  "rust", "maroon", "mauve", "ivory", "cream", "khaki", "cobalt",
  "charcoal", "fuchsia", "magenta", "plum", "camel", "taupe", "copper",
  "bronze", "ochre", "saffron", "marigold", "terracotta", "olive",
  "sage", "amber", "turquoise", "aqua", "indigo", "burgundy", "wine",
  "lilac", "ecru", "champagne", "fawn", "dusty rose", "rose gold",
  "off-white", "olive green", "sage green", "sky blue", "royal blue",
  "powder blue",
];

const SYSTEM_PROMPT = `You are a senior stylist at a luxury Indian fashion house — think Manish Malhotra or Anita Dongre. You are helping curate outfit suggestions for discerning clients who have high aesthetic standards even on a budget.

Your job is to translate any search query — including vague occasions — into concrete garment types and filters that will surface polished, well-crafted pieces. Prioritise results that look elegant and intentional, not cheap or generic — even if the price is low, it should look like something worth wearing.

Only return valid JSON — no markdown, no explanation.`;

const USER_PROMPT_TEMPLATE = (occasion: string, gender?: string) => `Translate this Indian ethnic wear search into shopping filters:
"${occasion}"
${gender ? `User gender: ${gender}` : ""}

Return a JSON object with these exact fields:
{
  "garment_types": [],   // subset of: [${VALID_GARMENTS.join(", ")}]
  "colors": [],          // subset of: [${VALID_COLORS.join(", ")}]
  "max_price": null,     // number in INR (convert "10k"→10000, "1 lakh"→100000) or null
  "min_price": null,     // number in INR or null
  "fabrics": [],         // e.g. ["silk", "georgette", "cotton", "chiffon", "velvet"]
  "keywords": [],        // only words that would literally appear in a product title
  "gender_hint": null    // "male", "female", or null — only if explicitly stated
}

CRITICAL RULES:
1. ALWAYS infer garment_types from the occasion — never leave it empty unless the query is completely unrelated to clothing.
2. Occasion → garment mappings based on what Indian middle and upper-class families actually wear (not outdated or overly traditional assumptions):
   - sangeet → ["lehenga", "sharara", "gharara", "anarkali"] (female) / ["kurta", "sherwani"] (male) — vibrant, celebratory
   - wedding/shaadi as a GUEST (female) → ["anarkali", "lehenga", "salwar"] — guests wear anarkalis and lighter lehengas; NOT saree unless explicitly asked
   - wedding/shaadi as a BRIDE (female) → ["lehenga"] — brides almost always wear lehenga, not saree
   - wedding/shaadi (male) → ["sherwani", "bandhgala", "kurta"]
   - engagement/roka → ["lehenga", "anarkali", "sharara"] (female) / ["kurta", "bandhgala"] (male) — semi-formal, elegant
   - mehndi → ["anarkali", "salwar", "lehenga"] in bright greens, yellows, oranges — festive and colourful
   - haldi → ["salwar", "kurti", "anarkali"] in yellows and pastels — casual-festive, expect stains
   - cocktail/pre-wedding party → ["gown", "lehenga", "anarkali"] — more contemporary and glamorous
   - reception → ["lehenga", "gown", "saree"] (female) / ["sherwani", "bandhgala"] (male) — saree is appropriate here for women who want to wear one
   - diwali/eid/festive → ["anarkali", "salwar", "lehenga", "kurta", "sherwani"] — celebratory but not as heavy as wedding
   - party/birthday → ["anarkali", "lehenga", "gown", "co-ord"] — stylish, fashion-forward
   - casual/everyday → ["kurta", "kurti", "salwar", "co-ord"] — comfortable but put-together
   - formal/office → ["kurta", "suit", "salwar"] — structured, professional
   - puja/temple → ["salwar", "kurta", "saree"] — modest, graceful
3. Saree is appropriate mainly for: reception, temple/puja, formal office, and when explicitly requested. Do NOT include saree for sangeet, wedding-as-guest, or casual occasions.
4. If gender is male, prefer: kurta, sherwani, bandhgala, pathani — in clean cuts and rich fabrics
5. If gender is female, prefer: lehenga, anarkali, sharara, salwar — with embellishment or fabric quality as a signal
6. "kurta set", "suit set" → ["kurta", "salwar"]
7. "indo western" → no garment_type, add to keywords
8. Price clues: "under 10k"→max_price:10000, "budget"→max_price:5000, "affordable"→max_price:8000
9. "luxury", "designer", "couture" → min_price:20000
10. keywords should only contain words that literally appear in product titles (e.g. "embroidered", "silk", "velvet", "sequin") — NOT occasion words like "sangeet" or "wedding"
11. Only set gender_hint if the user explicitly says men/women/male/female
12. COLOR FAMILIES — when a colour is mentioned, include all close shades from the valid list. Examples:
    - "pink" → ["pink", "blush", "rose gold", "dusty rose", "mauve", "peach", "coral", "fuchsia", "magenta"]
    - "red" → ["red", "maroon", "rust", "burgundy", "wine", "coral", "terracotta"]
    - "blue" → ["blue", "navy", "cobalt", "royal blue", "sky blue", "powder blue", "indigo", "teal", "aqua"]
    - "green" → ["green", "olive", "sage", "mint", "teal", "olive green", "sage green", "turquoise"]
    - "yellow" → ["yellow", "mustard", "saffron", "marigold", "amber", "ochre", "gold"]
    - "purple" → ["purple", "violet", "lavender", "lilac", "plum", "mauve", "indigo"]
    - "white/off-white" → ["white", "off-white", "ivory", "cream", "ecru", "champagne"]
    - "gold/champagne" → ["gold", "champagne", "rose gold", "copper", "bronze", "amber"]
    - "neutral/nude" → ["nude", "beige", "ivory", "cream", "taupe", "camel", "fawn", "ecru"]
13. When no colour is mentioned, leave colors empty — do NOT guess a colour from the occasion.
14. Prefer fabrics that signal quality even at accessible price points: silk, georgette, chiffon, velvet, organza, crepe — over synthetic or unspecified. Add these to fabrics[] when the occasion warrants it (e.g. wedding → ["silk", "georgette", "velvet", "chiffon"]).`;

const EMPTY_PARSED: ParsedQuery = {
  garment_types: [],
  colors: [],
  max_price: null,
  min_price: null,
  fabrics: [],
  keywords: [],
  gender_hint: null,
};

export async function parseSearchQuery(occasion: string, gender?: string): Promise<ParsedQuery> {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await model.generateContent(USER_PROMPT_TEMPLATE(occasion, gender));
    const text = result.response.text().trim();

    // Strip markdown code fences if present
    const json = text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
    const parsed = JSON.parse(json) as ParsedQuery;

    // Sanitise: ensure arrays are arrays, values are in valid sets
    return {
      garment_types: (parsed.garment_types ?? []).filter((g: string) =>
        VALID_GARMENTS.includes(g)
      ),
      colors: (parsed.colors ?? []).filter((c: string) =>
        VALID_COLORS.includes(c)
      ),
      max_price: typeof parsed.max_price === "number" ? parsed.max_price : null,
      min_price: typeof parsed.min_price === "number" ? parsed.min_price : null,
      fabrics: Array.isArray(parsed.fabrics) ? parsed.fabrics : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      gender_hint:
        parsed.gender_hint === "male" || parsed.gender_hint === "female"
          ? parsed.gender_hint
          : null,
    };
  } catch {
    // On any failure, fall back to empty — route.ts will use keyword search
    return { ...EMPTY_PARSED, keywords: [occasion] };
  }
}
