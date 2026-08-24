# UI Library Picks

Companion to Web Design Taste: once the design direction is set, don't
hand-roll what a maintained library already solves well. Check
`package.json` first — if the project already has a competitor to what's
listed here, flag the mismatch but don't churn the dependency unasked.

| Need | Reach for |
|---|---|
| Unstyled, accessible primitives (dialog, popover, menu, select) | base-ui, or Radix if the project already uses it |
| Toasts / notifications | Sonner |
| Command menu (⌘K palette) | cmdk |
| General animation (springs, layout, enter/exit) | Motion (`motion/react`) — plain CSS transitions for a simple hover/fade, don't pull in a library for that |
| Charts | Recharts for static/dashboard charts; a streaming-specific library only if data is genuinely live |
| Drag and drop | dnd-kit |
| Long lists / large tables | Virtuoso, before reaching for pagination hacks |
| State shared across components | Zustand — `useState`/`useReducer` first for anything local |
| Conditional `className` strings | clsx; cva instead once a component has real typed variants (size, intent, state) |
| Dark mode / theme switching | next-themes (no flash on load) |

### Common mismatches to catch

- A toast built by hand or with a modal library — Sonner exists for this.
- A `<div>`-based dropdown with manual focus handling — an accessible
  primitive library already solves focus trapping and dismissal.
- Rendering a 1,000-row list directly instead of virtualizing it.
- A prop-drilled web of `useState` for state three components actually
  share.


