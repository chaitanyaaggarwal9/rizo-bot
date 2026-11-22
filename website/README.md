# rizobot.com

The website for Rizo and Rizo Lang. Static HTML, one stylesheet and one
small script: no framework and no build step. Vercel serves this folder
as-is.

```
website/
├── index.html           Home: both products
├── rizobot.html         /rizobot: Rizo for VS Code
├── rizolang.html        /rizolang: Rizo Lang
├── privacy.html         /privacy
├── terms.html           /terms
├── accessibility.html   /accessibility
├── 404.html
├── styles.css           Light and dark themes (follows the system setting)
├── site.js              Mobile menu, copy buttons, analytics consent
├── vercel.json          Security headers (CSP, HSTS), clean URLs, /lang redirect
├── robots.txt, sitemap.xml
├── favicon.png
└── assets/
    ├── logo-word-light.png, logo-word-dark.png, logo-full.png, mascot.png
    ├── rizo-agent.png       The chat panel during a task
    └── rizo-providers.png   The new-chat provider picker
```

## Rules for editing

- **Shared header and footer.** Every page has the same header, footer and
  consent notice. If you change one, change all of them.
- **No inline scripts or styles.** The Content-Security-Policy in
  `vercel.json` blocks them. Use `site.js` and the classes in `styles.css`
  (the `u-*` utilities cover small spacing tweaks).
- **No em dashes** in any text.
- **Claims must be true.** Model names, versions, feature lists and test
  counts must match the code and releases. Rizo is source-available
  (Apache 2.0 + Commons Clause); Rizo Lang is open source (Apache 2.0).
- **Screenshots are real.** `rizo-agent.png` and `rizo-providers.png` are
  renders of the extension's actual `media/chat.html`, `chat.css` and
  `chat.js` with a sample conversation. Retake them when the chat view
  changes.

## Analytics and privacy

Google Analytics 4 loads only after a visitor clicks **Accept** in the
consent notice, never when the browser sends Global Privacy Control or Do
Not Track, and with Google signals and ad personalization off. The choice
is stored in `localStorage` under `rizo-analytics-consent`. "Cookie
settings" in the footer reopens the notice.

The privacy policy states that GA4 data is kept for 2 months and that
Google signals and advertising features are off. Keep the GA4 property set
that way: **Admin → Data collection and modification → Data retention: 2
months**, Google signals off, and no Google Ads links.

If you add forms, accounts, ads or another tracker, update `/privacy` first.

## Local preview

```bash
cd website
python3 -m http.server 8000
```

Then open `http://localhost:8000/index.html`. Clean URLs (`/rizobot`) and
the security headers only apply on Vercel.

## Deploy

Vercel builds every push to `main` (production) and every pull request
(a preview URL in the PR). The project's Root Directory is `website`.
