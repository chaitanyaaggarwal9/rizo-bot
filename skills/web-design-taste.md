# Web Design Taste

Backend API Taste covers judging a contract; this covers judging a
screen. Default stack for anything built from scratch: Next.js (Server
Components by default, `'use client'` only on interactive leaves),
Tailwind for styling, Motion for animation. Stay on that stack unless the
project already uses something else — match what's there.

### 1. Read the brief before generating anything

Identify the page kind (landing, portfolio, dashboard, redesign), the
audience, and any vibe words the user actually used ("minimalist",
"premium", "playful", "serious B2B"). State a one-line design read —
"reading this as a SaaS landing page for technical buyers, clean and
restrained" — before writing code. If the brief is genuinely ambiguous,
ask one specific question; don't silently default to a generic look.

### 2. Refuse the default AI look

These are the tells that make a page read as generated rather than
designed — reach past them deliberately:
- Purple/blue glow gradients as an unthinking default accent.
- A centered hero over a dark mesh background, followed by three equal
  feature cards.
- Inter as the display font by default; a beige/cream + brass/clay
  "premium artisan" palette for anything vaguely upscale.
- Serif type reached for because the brief sounds "creative" — that's not
  a reason on its own.

### 3. One theme, one accent, one corner-radius scale

Pick a light/dark mode and lock it for the whole page — no section
flipping into a different theme mid-scroll unless that's a deliberate,
singular device. Same for the accent color (one, used everywhere it
matters) and the corner-radius scale (all-sharp, all-soft, or a stated
per-component rule) — mixing either reads as unfinished, not eclectic.

### 4. Layout discipline

- The hero fits the initial viewport: headline max 2 lines, subtext under
  ~20 words, CTA visible without scrolling.
- Vary section layouts — the same left-image/right-text split more than
  twice in a row reads as templated. Break it with a full-width section,
  a grid, or a different composition.
- An "eyebrow" label (small uppercase text above a heading) on every
  single section is a tell, not a system — use it sparingly.

### 5. Motion needs a reason

Before adding an animation, name what it communicates — hierarchy,
sequence, feedback, or a state change. "It looked cool" isn't a reason.
A page that claims heavy motion but ships static, or that motion-fies
every card with an infinite loop regardless of content, are both wrong in
the same direction: motion decoupled from purpose.

### 6. Be honest about what's a placeholder

A hand-built "product preview" made of `<div>` rectangles pretending to be
a dashboard or terminal window is worse than no preview at all. If there's
no image-generation tool available and no real asset to use, leave a
clearly labeled placeholder (`<!-- TODO: hero product photo -->`) and say
explicitly what images the page still needs — don't fake it.

### 7. Refuse by default

- Shipping a button whose text fails contrast against its own background.
- A form with placeholder text standing in for a label.
- Two CTAs with the same intent on one page ("Get in touch" and "Contact
  us" and "Let's talk" — pick one label).
- Declaring a redesign "done" without checking it against the original
  brief's constraints (accessibility, brand assets, audience).

*Adapted from jeffallan/claude-skills' `design-taste-frontend` (taste-skill),
MIT license — condensed from ~1200 lines to the rules that hold regardless
of brief.*
