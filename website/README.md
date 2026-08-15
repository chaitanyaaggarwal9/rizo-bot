# Rizo website

The marketing site for Rizo — static HTML/CSS/JS, no build step, no
framework. Deploys as-is.

```
website/
├── index.html
├── styles.css
├── script.js
├── favicon.png          square R+chevron mark, browser tab icon
└── assets/
    ├── logo-full.png        source lockup as provided (unused directly)
    ├── logo-word-light.png  "Rizo}_" wordmark, transparent bg, for light backgrounds
    └── logo-word-dark.png   same, ink recolored light, for dark backgrounds
```

## Local preview

No build step — just serve the folder:

```bash
cd website
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Deploy to Vercel

1. [vercel.com/new](https://vercel.com/new) → import the `rizo-bot` GitHub repo
2. **Root Directory**: set to `website` (this is the one setting that
   matters — the repo root is a monorepo with the extension source too,
   and Vercel needs to know to only serve this folder)
3. **Framework Preset**: "Other" (plain static site, no build command needed)
4. Deploy

## Custom domain (rizobot.com)

In the Vercel project → **Settings → Domains** → add `rizobot.com`.
Vercel shows the exact DNS records to add at your registrar (an `A`
record to Vercel's IP, or `CNAME` if using a subdomain) — follow what
it displays there rather than guessing, since Vercel's anycast IP can
change.

## Updating content

Everything is hand-written, grounded in the actual extension source
(`vscode-extension/src/`) — the routing table, pricing, and destructive-
command list on the page are meant to match reality, not aspirational
copy. If those change in the extension, update this page in the same PR
per Git Hygiene's doc-check rule.
