import { NextRequest, NextResponse } from "next/server";
import { generateSearchInit, ParsedQuery, FollowUpQuestion } from "../lib/gemini";

const TEST_PARSED: ParsedQuery = {
  garment_types: ["anarkali", "lehenga", "salwar"],
  colors: [],
  fabrics: [],
  embellishments: [],
  keywords: [],
  max_price: null,
  min_price: null,
  gender_hint: null,
};

const TEST_QUESTIONS: FollowUpQuestion[] = [
  {
    id: "budget",
    question: "What's your budget?",
    suggestions: ["Under ₹5,000", "₹5,000–₹20,000", "₹20,000+"],
  },
  {
    id: "color",
    question: "Any colour preference?",
    suggestions: ["Open to anything", "Pastels & soft tones", "Bold & vibrant"],
  },
];

// POST /api/search-init
// Returns follow-up questions AND a base ParsedQuery (as sessionToken) in ONE Gemini call.
// The client sends sessionToken back with /api/search to skip a second Gemini call.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const occasion: string = body.occasion ?? "";
  const gender: string | undefined = body.gender;

  if (!occasion) {
    return NextResponse.json({ ok: false, error: "occasion is required" }, { status: 400 });
  }

  // Test short-circuit — no Gemini call
  if (occasion.trim().toLowerCase() === "test prompt") {
    const sessionToken = Buffer.from(JSON.stringify(TEST_PARSED)).toString("base64");
    return NextResponse.json({ ok: true, questions: TEST_QUESTIONS, sessionToken });
  }

  try {
    const result = await generateSearchInit(occasion, gender);
    const sessionToken = Buffer.from(JSON.stringify(result.parsed)).toString("base64");
    return NextResponse.json({ ok: true, questions: result.questions, sessionToken });
  } catch {
    // Never fail the client — return empty questions so it falls back to direct search
    return NextResponse.json({ ok: true, questions: [], sessionToken: null });
  }
}
