import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export interface ParsedQuery {
  garment_types: string[];
  colors: string[];
  max_price: number | null;
  min_price: number | null;
  fabrics: string[];
  embellishments: string[];
  keywords: string[];
  gender_hint: "male" | "female" | null;
}

// Must match the values stored in the DB (from metadata.ts EMBELLISHMENTS)
const VALID_EMBELLISHMENTS = [
  "zardozi", "gota patti", "mirror work", "thread work", "block print",
  "sequins", "resham", "embroidery", "crystals", "beads", "stone work",
  "printed", "floral", "striped",
];

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

STYLING PHILOSOPHY:
- CRITICAL: If the user's query already names a specific embellishment type (e.g. "mirror work", "zardozi", "gota patti", "sequins", "block print"), use ONLY that embellishment — do NOT add others. The user is searching for that specific craft; adding more dilutes the results.
- For celebratory or social occasions where NO embellishment is specified (weddings, sangeet, cocktail, mehndi, haldi, reception, diwali, eid, birthday, party), add at least one embellishment. Use one or two at most — not a long list. Prefer: embroidery for general; sequins for cocktail/party; zardozi or gota patti for bridal.
- For high-budget celebratory occasions (luxury keywords), prefer handcraft embellishments: zardozi, gota patti, resham, stone work, mirror work.
- For contemporary/party occasions (cocktail, birthday, modern bride), prefer sequins, crystals, thread work — and fabrics like georgette, organza, crepe.
- For casual, everyday, office, or puja/temple occasions, leave embellishments EMPTY — these occasions call for clean, understated choices.

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
  "embellishments": [],  // subset of: [${VALID_EMBELLISHMENTS.join(", ")}]
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
14. Prefer fabrics that signal quality even at accessible price points: silk, georgette, chiffon, velvet, organza, crepe — over synthetic or unspecified. Add these to fabrics[] when the occasion warrants it (e.g. wedding → ["silk", "georgette", "velvet", "chiffon"]).
15. EMBELLISHMENT ALIASES — when the query contains a style or craft term, map it to the exact stored value(s):
    - "mirrorwork", "mirror work", "shisha", "abla", "shisha work" → ["mirror work"]
    - "zardozi", "zari", "zardosi", "zari work" → ["zardozi"]
    - "gota", "gota patti", "gota work", "gotta patti" → ["gota patti"]
    - "sequin", "sequins", "sequence", "shimmer", "glitter", "disco" → ["sequins"]
    - "thread work", "threadwork", "kantha", "phulkari", "kasuti" → ["thread work"]
    - "block print", "blockprint", "hand block", "ajrakh", "dabu", "bagru" → ["block print"]
    - "embroidered", "embroidery", "chikankari", "lucknowi" → ["embroidery"]
    - "crystal", "crystals", "swarovski", "rhinestone" → ["crystals"]
    - "beaded", "beads", "moti", "pearl work" → ["beads"]
    - "stone work", "stonework", "kundan", "polki", "meenakari" → ["stone work"]
    - "resham", "silk thread", "resham work" → ["resham"]
    - "printed", "digital print", "screen print" → ["printed"]
    - "floral", "floral print", "flower print" → ["floral"]
    - "striped", "stripes", "stripe" → ["striped"]
    Style terms NOT in the above list (e.g. "bandhani", "banarasi", "ikat", "kalamkari", "patola", "chanderi", "mul mul") are NOT in embellishments — put them in keywords[] instead so they match product titles via text search.`;

// ── Follow-up questions ──────────────────────────────────────────────

export interface FollowUpQuestion {
  id: string          // "budget" | "role" | "color" | "style" | "fabric"
  question: string
  suggestions: string[] // always exactly 3
}

export interface SearchInitResult {
  questions: FollowUpQuestion[]
  parsed: ParsedQuery
}

const INIT_PROMPT_TEMPLATE = (occasion: string, gender?: string) => `Analyze this Indian ethnic wear search and return TWO things in one JSON response.

Search: "${occasion}"
${gender ? `User gender: ${gender}` : ""}

Return a JSON object with exactly these two top-level fields:
{
  "questions": [],
  "parsed": {}
}

━━━ QUESTIONS RULES ━━━
Generate 0–3 follow-up questions that would most improve search results.
Only ask about things NOT already specified in the search query.
If the search is already highly specific (garment + color + price all clear), return [].
Each question has exactly 3 suggestions. Order by impact (most important first).

Available question types (use these id values exactly):
- id "budget"              → suggestions: ["Under ₹5,000", "₹5,000–₹20,000", "₹20,000+"]
- id "role"                → for weddings/events: ["I'm the bride", "I'm a guest", "Part of the wedding party"]
- id "color"               → ["Open to anything", "Pastels & soft tones", "Bold & vibrant"]
- id "style"               → ["Traditional & classic", "Contemporary & fashion-forward", "Fusion & experimental"]
- id "fabric"              → ["Light & flowy", "Rich & structured", "Comfortable & breathable"]
- id "embellishment_level" → ["Minimal & understated", "Elegant with some detail", "Heavily embellished & statement"]
- id "occasion_formality"  → ["Grand & traditional", "Chic & contemporary", "Relaxed & intimate"]
- id "silhouette"          → ["Long & flowing (lehenga / anarkali / saree)", "Straight cut (kurta / salwar / suit)", "Draped or co-ordinated sets"]

Selection guidance:
- For weddings/sangeet with no role specified: ask "role" first
- For vague festive occasions: ask "occasion_formality" to set heaviness, then "budget"
- For searches missing color: ask "color"; missing fabric: ask "fabric" or "embellishment_level"
- Never ask "silhouette" AND "role" together — role is more specific
- Never ask "occasion_formality" AND "style" together — prefer "occasion_formality" when occasion is known
- Never ask more than 3 questions total

━━━ PARSED RULES ━━━
"parsed" must be an object with:
{
  "garment_types": [],   // subset of: [${VALID_GARMENTS.join(", ")}]
  "colors": [],          // subset of: [${VALID_COLORS.join(", ")}]
  "max_price": null,     // number in INR or null
  "min_price": null,     // number in INR or null
  "fabrics": [],
  "embellishments": [],  // subset of: [${VALID_EMBELLISHMENTS.join(", ")}]
  "keywords": [],
  "gender_hint": null
}

Apply ALL cultural and styling rules:
- wedding guest (female) → ["anarkali", "lehenga", "salwar"] NOT saree
- bride → ["lehenga"] only; sangeet → ["lehenga", "sharara", "gharara", "anarkali"]
- reception → ["lehenga", "gown", "saree"]; saree only for reception/puja/office/explicit
- Color families: "pink" → ["pink","blush","rose gold","dusty rose","mauve","peach","coral","fuchsia","magenta"], etc.
- Embellishment aliases: "mirrorwork"→["mirror work"], "kundan"→["stone work"], "sequin"→["sequins"], etc.
- Add quality fabrics for the occasion (wedding → ["silk","georgette","velvet","chiffon"])
- Embellishments: if the user already named a specific embellishment (mirror work, zardozi, sequins, etc.), use ONLY that — never add more. For celebratory occasions where none is named, add one or two at most: ["embroidery"] for general; ["sequins"] for cocktail/party; ["zardozi"] or ["gota patti"] for high-end bridal. For everyday/office/puja, leave embellishments empty.
- Price clues: "under 10k"→max_price:10000, "budget"→max_price:5000, "luxury"→min_price:20000`;

export async function generateSearchInit(occasion: string, gender?: string): Promise<SearchInitResult> {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM_PROMPT,
    });

    const result = await model.generateContent(INIT_PROMPT_TEMPLATE(occasion, gender));
    const text = result.response.text().trim();
    const json = text.replace(/^```(?:json)?\n?|\n?```$/g, "").trim();
    const raw = JSON.parse(json);

    // Sanitise parsed
    const rp = raw.parsed ?? {};
    const sanitisedParsed: ParsedQuery = {
      garment_types: (rp.garment_types ?? []).filter((g: string) => VALID_GARMENTS.includes(g)),
      colors: (rp.colors ?? []).filter((c: string) => VALID_COLORS.includes(c)),
      max_price: typeof rp.max_price === "number" ? rp.max_price : null,
      min_price: typeof rp.min_price === "number" ? rp.min_price : null,
      fabrics: Array.isArray(rp.fabrics) ? rp.fabrics : [],
      embellishments: (rp.embellishments ?? []).filter((e: string) => VALID_EMBELLISHMENTS.includes(e)),
      keywords: Array.isArray(rp.keywords) ? rp.keywords : [],
      gender_hint: rp.gender_hint === "male" || rp.gender_hint === "female" ? rp.gender_hint : null,
    };

    // Sanitise questions — max 3, each with id/question/suggestions
    const rawQs: unknown[] = Array.isArray(raw.questions) ? raw.questions : [];
    const sanitisedQuestions: FollowUpQuestion[] = rawQs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((q: any) => q && typeof q.id === "string" && typeof q.question === "string" && Array.isArray(q.suggestions))
      .slice(0, 3)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((q: any) => ({
        id: String(q.id),
        question: String(q.question),
        suggestions: (q.suggestions as unknown[]).slice(0, 3).map(String),
      }));

    return { questions: sanitisedQuestions, parsed: sanitisedParsed };
  } catch {
    return { questions: [], parsed: { ...EMPTY_PARSED, keywords: [occasion] } };
  }
}

const EMPTY_PARSED: ParsedQuery = {
  garment_types: [],
  colors: [],
  max_price: null,
  min_price: null,
  fabrics: [],
  embellishments: [],
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
      embellishments: (parsed.embellishments ?? []).filter((e: string) =>
        VALID_EMBELLISHMENTS.includes(e)
      ),
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
