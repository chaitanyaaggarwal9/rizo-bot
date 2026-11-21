# Web Design Taste

Purpose: build web pages that are simple, accessible and look deliberate.

### Stack
- Follow the project's existing stack and design system first.
- Simple site: plain HTML, CSS and JS.
- Use a framework (React, Next.js, etc.) only if the project already uses one or the user asks for an app.
- Don't add dependencies without asking.

### Accessibility
- Semantic HTML (`header`, `nav`, `main`, `button`, headings in order).
- Every input has a `<label>`; placeholders are not labels. Meaningful images get `alt` text.
- Visible keyboard focus on all interactive elements.
- WCAG AA contrast: 4.5:1 for body text, 3:1 for large text.
- Respect `prefers-reduced-motion`.

### Responsive
- Include `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- Mobile-first CSS; use relative units, `max-width`, flex and grid, not fixed pixel widths.
- Think through a 360px-wide screen before finishing.

### Design defaults
- A consistent spacing scale (e.g. 4/8/16/24/32px).
- Limited palette: one accent color. One or two typefaces.
- Clear hierarchy: one main heading and one primary call to action per view.
- Colors as CSS variables. Support light and dark only if the user wants both (via `prefers-color-scheme`); don't force either.
- Animate only to communicate something (feedback, state change).
- No fake product screenshots made of divs; leave a labeled placeholder and tell the user which images are needed.

### Verify
- There is no browser or screenshot tool. Run the project's build and lint, and tests if they exist.
- Then tell the user what to check visually (narrow widths, dark mode, keyboard focus).

These are defaults, not mandates.
