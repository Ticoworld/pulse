# Phase 10B: Premium landing page

Landing page for the Telegram-first Bags Alpha Intelligence product. Single React SPA, Tailwind, dark premium aesthetic. No dashboard, no fake metrics, no payments, no backend logic.

---

## Run and build

From repo root:

- **Dev:** `npm run dev:landing` (Vite dev server; default port 5173)
- **Build:** `npm run build --workspace=@pulse/landing`  
  Output is written to `apps/landing/dist`. Do not append anything after the command.

To serve the built site from the existing API (optional), point Express at `apps/landing/dist` for static files and add a catch-all route for SPA fallback.

---

## Files created

| Path | Purpose |
|------|--------|
| `apps/landing/package.json` | Workspace package: React 18, Vite 5, Tailwind 3 |
| `apps/landing/vite.config.ts` | Vite + React plugin |
| `apps/landing/tsconfig.json` | TS config for src |
| `apps/landing/tsconfig.node.json` | TS config for Vite |
| `apps/landing/tailwind.config.js` | Tailwind content + custom theme (surface, accent, border) |
| `apps/landing/postcss.config.js` | PostCSS Tailwind + autoprefixer |
| `apps/landing/index.html` | Entry HTML, Inter font preconnect |
| `apps/landing/src/index.css` | Tailwind directives + html/body base |
| `apps/landing/src/main.tsx` | React mount |
| `apps/landing/src/App.tsx` | Root component composing sections |
| `apps/landing/src/config.ts` | **Telegram and GitHub link placeholders** |
| `apps/landing/src/sections/Hero.tsx` | Hero + primary/secondary CTA |
| `apps/landing/src/sections/WhatItDoes.tsx` | 4 feature blocks |
| `apps/landing/src/sections/WhyUseful.tsx` | Operator-focused copy |
| `apps/landing/src/sections/HowItWorks.tsx` | 3-step flow |
| `apps/landing/src/sections/ProductPreview.tsx` | HIGH_INTEREST + followed-mint mock |
| `apps/landing/src/sections/FinalCTA.tsx` | Bottom CTA |
| `apps/landing/src/sections/Footer.tsx` | Product name, Telegram, GitHub, copyright |

## File changed (root)

- `package.json` — added script: `"dev:landing": "npm run dev --workspace=@pulse/landing"`

---

## Where to replace Telegram and GitHub links

**Single place:** `apps/landing/src/config.ts`

```ts
export const LINKS = {
  telegram: "https://t.me/YourBotUsername",
  github: "https://github.com/your-org/pulse",
} as const;
```

Replace:

- `telegram`: your bot’s t.me link (e.g. `https://t.me/YourActualBotName`).
- `github`: your repo or org URL, or remove the GitHub link from `Footer.tsx` if you do not want it.

All CTAs and the footer use this config; no other link constants.

---

## Assets (V2)

Place these in `public` so they are served at `/`:

- **Logo:** `apps/landing/public/brand/logo-primary.png` (and optionally `logo-mark.png`)
- **Hero visual:** `apps/landing/public/hero/hero-signal-premium.png`

If `logo-primary.png` is missing, the hero falls back to text "Bags Alpha Intelligence". If the hero image is missing, its space remains; add the file to remove the gap.

To add a favicon: put `favicon.ico` in `apps/landing/public/` and reference it in `index.html`.

---

## V2 redesign summary

**Design:** No header/navbar. No section eyebrow labels (What it does, How it works, etc.). Communication via hierarchy, spacing, and copy density. Premium dark, typography-led, restrained.

**Logo:** Used once in the hero (`Hero.tsx`), top-left of the hero content block. Source: `/brand/logo-primary.png`. Fallback on load error: text "Bags Alpha Intelligence".

**Hero image:** Used once in the hero (`Hero.tsx`), right side on desktop, below copy on mobile. Source: `/hero/hero-signal-premium.png`. Served from `apps/landing/public/hero/`.

**Files changed in V2:**

| File | Changes |
|------|--------|
| `tailwind.config.js` | Added `brand.DEFAULT` and `brand.muted` (restrained green). |
| `src/sections/Hero.tsx` | Logo + hero image, tighter copy, single prominent CTA + quieter secondary, logo fallback. |
| `src/sections/WhatItDoes.tsx` | Removed "What it does" and subline. Shorter feature copy. No section title. |
| `src/sections/WhyUseful.tsx` | Removed "Why it feels useful". One short paragraph. |
| `src/sections/HowItWorks.tsx` | Removed "How it works" and subline. Tighter step copy, 3-col grid. |
| `src/sections/ProductPreview.tsx` | Removed "Product preview" and subline. Framed panel with header bar and subtle green accent. |
| `src/sections/FinalCTA.tsx` | Removed "Try the bot" heading. One line of copy + CTA. |
| `src/sections/Footer.tsx` | Simpler: name, Telegram, GitHub, year. Softer text. |
| `public/brand/.gitkeep`, `public/hero/.gitkeep` | Placeholder dirs for assets. |

**Copy shortened (examples):**

- Hero: One-line value prop + one supporting line; "Fast and operational. Not a research toy" removed.
- Features: Each block 1 short sentence (e.g. "Follow mints. When one hits high-interest, you get an alert. No manual checking.").
- Why useful: Three paragraphs merged into one.
- How it works: Step text reduced to one line each.
- Final CTA: "Open Telegram. Start the bot. Use /top_candidates or /mint." + button only.
- Footer: "All rights reserved" removed; year only under links.
