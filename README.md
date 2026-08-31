# BloxStar — Vercel Production (Standalone)

Fully self-contained production deployment of the BloxStar storefront: static
frontend + TypeScript Vercel Functions + PostgreSQL (Neon-compatible). No
Lovable, Supabase, or PostgREST runtime dependency.

## Architecture

- **Frontend** — `public/index.html` (preserved production storefront, patched:
  MoonPay-only checkout with `lockAmount=true`, same-origin API bridge).
- **API** — Vercel Node functions under `api/`:
  - `api/public/auth/send-code.ts` — 6-digit OTP via Resend (hashed at rest, 10-min expiry, one-time, rate-limited)
  - `api/public/auth/verify-code.ts` — OTP verification (max 5 attempts) → 7-day session token
  - `api/public/auth/session.ts` — session validation; admin flag derived server-side only
  - `api/public/orders.ts` — authenticated order create/list/confirm/cancel
  - `api/public/email/send.ts` — template-only, authenticated email (no open relay)
  - `api/public/abandoned-cart.ts` — rate-limited abandoned-cart capture (server-recomputed totals)
  - `api/public/transak-widget-url.ts`, `api/public/nowpayments/create-invoice.ts` — HTTP 410 (providers disabled)
  - `api/health.ts` — safe health check
- **Database** — PostgreSQL (Neon works out of the box). Schema in `db/migrations/001_init.sql`; catalogue in `db/products.json` (341 items: 162 Adopt Me, 118 MM2, 61 Grow a Garden — all flagged on sale).

## Security model

- Prices, fees (4.5%, $3.99 min), stock, totals, and payment state are computed
  **server-side only**. Client-supplied price/total/paid/admin fields are ignored.
- Orders are created `pending_payment`; payment is confirmed **manually by a
  server-verified admin** after checking MoonPay. Stock is decremented atomically
  (`SELECT ... FOR UPDATE`) exactly once, and restored exactly once on cancel.
- Admin status comes only from the `admin_emails` table, re-checked per request.
- OTPs are SHA-256 hashed with `SESSION_SECRET`, single-use, 10-minute expiry,
  5-attempt lockout, plus DB-backed email/IP rate limits on all sensitive routes.
- CORS allowlist: `https://www.bloxistar.com`, `https://bloxistar.com` (no wildcard).
- Secrets (`DATABASE_URL`, `RESEND_API_KEY`, `SESSION_SECRET`) live only in
  server environment variables. Email sends are deduplicated and logged.

## Setup

```bash
bun install          # or npm install
cp .env.example .env # fill in values
```

Environment variables (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (Neon: `...?sslmode=require`) |
| `RESEND_API_KEY` | Resend API key — the only email provider |
| `SESSION_SECRET` | Random ≥16-char secret (`openssl rand -base64 48`) |
| `ADMIN_EMAILS` | Comma-separated admin emails seeded into `admin_emails` |
| `BLOXSTAR_SALE_DISCOUNT` | Optional uniform sale discount for GAG/Adopt Me/MM2 (0 = off) |

```bash
npm run migrate   # apply db/migrations
npm run seed      # load the 341-item catalogue + admin emails
npm test          # 40 tests: auth, OTP, orders, stock concurrency, IDOR, CORS
npm run typecheck
```

## Deploy to Vercel

1. Push this directory to a Git repo and import it in Vercel (framework: Other).
2. Add the environment variables above in Project Settings → Environment Variables.
3. Deploy. The site serves `public/` statically; `/api/*` runs as functions;
   the apex `bloxistar.com` 308-redirects to `www.bloxistar.com`.
4. Point DNS: `www` CNAME → `cname.vercel-dns.com`; apex A → `76.76.21.21`
   (or Vercel's current anycast IP).
5. Run `npm run migrate && npm run seed` once against the production `DATABASE_URL`.

## Payments

MoonPay is the only customer payment provider. Checkout URLs are built with
`lockAmount=true`; the customer pays on MoonPay's page; an admin verifies the
payment in MoonPay and confirms the order in the admin UI (order status → paid,
confirmation email sent automatically). Transak and NOWPayments endpoints return
410 Gone.

## Email

Resend only, sender `BloxStar <business@bloxistar.com>`. Verify the
`bloxistar.com` domain in Resend (SPF/DKIM) before go-live. Order-created,
order-status, welcome, and support emails are sent server-side with dedupe keys.

## Local verification

`scripts/local-server.ts` serves `public/` + the real API handlers against a
local PostgreSQL for end-to-end testing.
