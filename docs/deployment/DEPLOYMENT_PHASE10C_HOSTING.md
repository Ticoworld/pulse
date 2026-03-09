# Phase 10C: Hosting readiness (Vercel + Railway)

**Scope:** Document how to deploy the landing page and the Telegram bot. No new product features, no payment or queue work.

---

## Recommended split

| App      | Host    | Why |
|----------|---------|-----|
| **Landing** | Vercel  | Static SPA; Vercel is built for that. No server env needed at build time; links are in code. |
| **Bot**     | Railway | Long-lived process with polling; needs Postgres (Supabase) and Telegram env. Railway runs Node and persists the process. |

The API (`apps/api`) is health-only and not required for the current demo; you can deploy it later if needed (e.g. same Railway service or a second one).

---

## 1. Landing page → Vercel

### Build and output

- **Build command:** `npm run build --workspace=@pulse/landing`  
  Or, if Vercel root is set to `apps/landing`: `npm run build` (runs `vite build`).
- **Output directory:** `dist`  
  When repo root is the Vercel project root, the output is under the app: `apps/landing/dist`. So either:
  - Set **Root Directory** to `apps/landing`, **Build Command** to `npm run build`, **Output Directory** to `dist`; or
  - Keep root as repo root, **Build Command** to `npm run build --workspace=@pulse/landing`, **Output Directory** to `apps/landing/dist`.

### Where links are configured

- **Single place:** `apps/landing/src/config.ts`
- `LINKS.telegram` → t.me bot link (e.g. `https://t.me/Pulse_alphaBot`)
- `LINKS.github` → GitHub repo or org
- Change these before or after deploy; rebuild/redeploy to see changes.

### Vercel dashboard settings (recommended)

1. **Root Directory:** `apps/landing`
2. **Framework Preset:** Vite (or None)
3. **Build Command:** `npm run build`
4. **Output Directory:** `dist`
5. **Install Command:** `npm install` (from repo root Vercel may run install at root; if root is `apps/landing`, install runs there — ensure dependencies are in `apps/landing/package.json`; they are)
6. No env vars required for the landing app (static site)

If you leave Root Directory at repo root instead:

1. **Build Command:** `npm run build --workspace=@pulse/landing`
2. **Output Directory:** `apps/landing/dist`
3. **Install Command:** `npm install`

### Likely first-deploy issues

- **Output not found:** Wrong Output Directory (e.g. `dist` when root is repo → must be `apps/landing/dist`).
- **Build fails:** Missing Node version (set Node 18+ in Vercel project settings) or install not finding workspace deps (use root install and build command above).

No `vercel.json` is required for this setup; dashboard settings are enough.

---

## 2. Telegram bot → Railway

### Start command (hosted)

From **repo root** (recommended so workspaces resolve):

- **Build:** `npm install && npm run build --workspace=@pulse/tg-bot`
- **Start:** `npm run start --workspace=@pulse/tg-bot`

Alternative (if Railway is set to use `apps/tg-bot` as root):

- **Build:** `npm install && npm run build`
- **Start:** `npm start`  
  (Both run in `apps/tg-bot`; `npm start` runs `node dist/index.js`.)

### Required env vars for the bot

| Variable | Required | Notes |
|----------|----------|--------|
| `TELEGRAM_BOT_TOKEN` | Yes | From [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_OWNER_CHAT_ID` | Yes | Numeric chat ID for owner-only commands and notifications |
| `DATABASE_URL` | Yes | Supabase Postgres connection string (pooler URI, e.g. port 6543 with `?sslmode=require`) |

Optional:

| Variable | Default | Notes |
|----------|---------|--------|
| `TG_PUBLIC_COMMAND_COOLDOWN_SECONDS` | `30` | Cooldown for `/top_candidates` and `/mint` |

The bot loads `dotenv/config`; on Railway, set the vars in the project dashboard so they are in `process.env`. No `.env` file is needed on the server.

### Behaviour and assumptions

- **Polling:** The bot uses Telegram long-polling. It must run as a **persistent process**. Railway runs it as a web process or background worker; keep it always-on.
- **DB:** All command and follow logic use Postgres (Supabase). Run migrations **before** first deploy: `npm run db:migrate` (from your machine or a one-off script) with the same `DATABASE_URL`.
- **No health endpoint:** The bot does not expose HTTP. Railway may still mark the service as healthy if the process stays up; if Railway expects a port, you may need to use a dummy HTTP server or mark the service as “no port” if the platform allows it.

### Likely first-deploy breakpoints

1. **Missing env**
   - Bot exits immediately if `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, or `DATABASE_URL` is missing. Check logs for `[tg-bot] ... is not set. Exiting.`
2. **DATABASE_URL / Supabase**
   - Wrong port (e.g. 5432 vs 6543), missing `?sslmode=require`, or wrong password. Run `npm run supabase:smoke` locally with the same URL to confirm.
3. **Telegram token / chat ID**
   - Invalid token or non-numeric `TELEGRAM_OWNER_CHAT_ID`. Use a real bot token and the numeric chat ID (e.g. from [@userinfobot](https://t.me/userinfobot)).
4. **Build/start assumptions**
   - If Railway runs from repo root, use the root build/start commands above so `@pulse/db` and other workspaces resolve. If build runs from `apps/tg-bot`, ensure `npm install` at root has run so `node_modules` and workspace links exist, or run install from root in the build step.

No Railway-specific config file is required for this setup; document the build and start commands and env in the project.

---

## 3. What is still not production-grade

- **Observability:** No metrics or tracing; console logging only.
- **Auth:** No auth layer on the API; bot uses Telegram’s identity only.
- **Migrations:** Applied manually or via one-off script; no automated migration step in deploy.
- **Rate limits:** Bot cooldown is per-user in DB; Bags/Helius rate limits are enforced in code but not externally visible.
- **Execution:** Trading/execution is stubbed; no live Solana tx send.
- **Landing:** Static only; no analytics or A/B tooling added here.

This phase is **hosting readiness** so the repo can be deployed for hackathon and demo use, not full production hardening.
