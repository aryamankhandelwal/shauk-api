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

const SYSTEM_PROMPT = `You are a parser for an Indian occasion wear shopping app.
Your job is to translate any search query — including vague occasions — into concrete garment types and filters.
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
2. Occasion → garment mappings (adapt based on user gender if provided):
   - sangeet → ["lehenga", "anarkali", "sharara", "kurta", "salwar"] (female) / ["kurta", "sherwani"] (male)
   - wedding/shaadi → ["lehenga", "saree", "anarkali", "sherwani", "bandhgala"] — both genders
   - engagement/roka → ["lehenga", "anarkali", "salwar", "kurta"]
   - mehndi/haldi → ["salwar", "kurta", "anarkali", "lehenga"]
   - reception → ["lehenga", "saree", "gown", "sherwani"]
   - diwali/eid/festive → ["kurta", "salwar", "anarkali", "lehenga", "sherwani"]
   - party → ["kurta", "anarkali", "lehenga", "gown"]
   - casual/everyday → ["kurta", "salwar", "kurti"]
   - formal/office → ["kurta", "salwar", "suit"]
3. If gender is male, prefer: kurta, sherwani, bandhgala, pathani, nehru
4. If gender is female, prefer: lehenga, saree, anarkali, salwar, kurta, sharara
5. "kurta set", "suit set" → ["kurta", "salwar"]
6. "indo western" → no garment_type, add to keywords
7. Price clues: "under 10k"→max_price:10000, "budget"→max_price:5000, "affordable"→max_price:8000
8. "luxury", "designer", "couture" → min_price:20000
9. keywords should only contain words that literally appear in product titles (e.g. "silk", "embroidered") — NOT occasion words like "sangeet" or "wedding"
10. Only set gender_hint if the user explicitly says men/women/male/female`;

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
