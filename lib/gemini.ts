import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export interface UserContext {
  gender?: string;
  topSize?: string;
  bottomSize?: string;
  bustIn?: number;
  waistIn?: number;
  hipsIn?: number;
  chestIn?: number;
  shouldersIn?: number;
  sleeveLengthIn?: number;
  inseamIn?: number;
}

export interface ProductResult {
  uri: string;   // Grounding redirect URL — Puppeteer follows it to the real page
  domain: string; // e.g. "ajio.com" — used for brand extraction
}

const TARGET_DOMAINS = [
  "sabyasachi.com",
  "anitadongre.com",
  "rawmango.in",
  "nykaa.com",
  "ajio.com",
  "manyavar.com",
  "manishmalhotra.in",
  "fabindia.com",
  "aza-fashions.com",
];

export async function findOccasionWearURLs(
  occasion: string,
  user: UserContext
): Promise<ProductResult[]> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: [{ googleSearch: {} } as any],
  });

  const userLines: string[] = [];
  if (user.gender) userLines.push(`Gender: ${user.gender}`);
  if (user.topSize) userLines.push(`Top size: ${user.topSize}`);
  if (user.bottomSize) userLines.push(`Bottom size: ${user.bottomSize}`);

  const clothingTypes =
    user.gender === "male"
      ? "kurta sets, sherwanis, bandhgalas, Indo-western suits"
      : "lehengas, anarkalis, sarees, sharara sets, salwar suits";

  const prompt = `Search for Indian occasion wear product pages for: "${occasion}".
Focus on ${clothingTypes}.
Target retailers: ${TARGET_DOMAINS.join(", ")}.
${userLines.length ? `\nUser profile:\n${userLines.join("\n")}` : ""}

Find specific product listing or category pages on those retailer websites.`;

  const result = await model.generateContent(prompt);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groundingChunks: any[] =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((result.response.candidates?.[0]?.groundingMetadata as any)?.groundingChunks ?? []);

  // Grounding URIs are vertexaisearch redirect links; the real domain is in `title`
  const seen = new Set<string>();
  const results: ProductResult[] = [];

  for (const chunk of groundingChunks) {
    const uri = chunk.web?.uri as string | undefined;
    const title = (chunk.web?.title ?? "") as string;
    const matchedDomain = TARGET_DOMAINS.find((d) =>
      title.toLowerCase().includes(d)
    );

    if (uri && matchedDomain && !seen.has(matchedDomain)) {
      seen.add(matchedDomain);
      results.push({ uri, domain: matchedDomain });
    }

    if (results.length >= 3) break;
  }

  return results;
}
