# shauk-api — Next.js Backend

## Purpose
REST API for the Shauk iOS app. Deployed on Vercel free tier.

## Stack
- Next.js 14 with App Router
- TypeScript
- Supabase JS client (server-side, service role key)
- Vercel AI SDK + Gemini 2.5 Flash (Phase 2)

## Folder Structure
```
app/api/
  health/route.ts          — GET /api/health
  search/route.ts          — POST /api/search (Phase 2)
  results/[jobId]/route.ts — GET /api/results/:jobId (Phase 2)
lib/
  supabase.ts              — server Supabase admin client
  gemini.ts                — Gemini prompt parser (Phase 2)
  googleSearch.ts          — Google CSE wrapper (Phase 2)
```

## Environment Variables
Copy `.env.example` → `.env.local` for local dev.
Set all variables in Vercel Dashboard → Settings → Environment Variables.

## Vercel Free Tier Constraints
- Function timeout: 10 seconds
- For long-running operations (Puppeteer calls), return a jobId immediately
  and let the client poll /api/results/:jobId

## Conventions
- All routes return `{ ok: true, ...data }` on success
- All routes return `{ ok: false, error: "message" }` on error
- Never log sensitive data (API keys, user IDs) to console in production
- Service role key is server-only — never sent to the client
