# app-agentiz-site

The public project site: a landing page at `/` and the English user documentation under `/docs`.
React pages rendered on the server by `@nodeknit/app-inertiajs` and hydrated in the browser —
the same arrangement as restoapp-marketplace's storefront (`layers/app-marketplace-frontend`
there). The layer reads nothing from the database and depends on no other layer.

```
index.ts               routes → page components, props
lib/docs.ts            markdown → HTML (markdown-it, raw HTML off, ids on h2/h3)
content/docs/*.md      one file per documentation page
web/vite.config.ts     the site's own Vite build (client + SSR), separate from the root one
web/src/app.tsx        client entry (hydration)
web/src/ssr.tsx        server renderer, loaded by app-inertiajs
web/src/pages/         Home.tsx, Docs.tsx
web/src/components/    Layout.tsx — header, footer, <Head>
web/src/index.css      the only stylesheet: black, white, nothing else; plain CSS, no Tailwind
web/src/assets/        screenshots and the favicon (imported, so Vite hashes them)
```

## Running

- Locally `npm run dev` is enough: with `NODE_ENV` unset `VITE_ENV` defaults to `dev`, and the
  root `index.ts` attaches a Vite dev server after `lift()`. Open `http://localhost:17280/`.
- `npm run build:site` produces `web/dist/client` and `web/dist/server/ssr.js`. Any `VITE_ENV`
  other than `dev` (production leaves it unset) serves those instead. `web/dist` is gitignored;
  the Dockerfile builds it.

## Writing a documentation page

A page is a markdown file with front matter:

```markdown
---
title: Workers
order: 40
description: One sentence; shown under the title, in the docs index and in <meta name="description">.
---
```

The file name is the slug (`workers.md` → `/docs/workers`, `index.md` → `/docs`), `order` sorts
the sidebar, and the pager follows the same order. Headings `##`/`###` get an id from their text;
`## Connect a worker {#worker}` sets it explicitly. Link between pages with absolute paths:
`[Workers](/docs/workers#push-rights)`. In production pages are read once; locally they are
re-read on every request, so editing one needs only a reload.

These pages describe what a user sees and configures, not how it works inside — that belongs in
`docs/` and `AGENTS.md`. When a feature changes something a user configures, check the matching
page here.

## Screenshots

Taken from a throwaway instance seeded with neutral demo data (`seeds/mobile-screenshots.seed.ts`,
recipe in `mobile-client/screenshots/README.md`), never from a real deployment. Panel shots are
1440×900 at 2× scale, saved as WebP 1920 px wide
(`convert in.png -resize 1920x -strip -quality 82 out.webp`), and imported from `Home.tsx`. The
page shows them in grayscale and in colour on hover and click.
