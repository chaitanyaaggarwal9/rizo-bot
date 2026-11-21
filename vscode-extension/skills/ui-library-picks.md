# UI Library Picks

Purpose: pick a maintained library instead of hand-rolling common UI pieces.

These picks are for React projects. For Vue, Svelte, Angular etc., use that ecosystem's established equivalent. Always prefer what the project already uses (check `package.json`), and never install anything without asking the user.

### One pick per need
- Accessible primitives (dialog, popover, menu, select): `@base-ui/react`, or `radix-ui` if the project already uses Radix.
- Toasts: `sonner`.
- Command menu (Ctrl/Cmd+K): `cmdk`.
- Drag and drop: `@dnd-kit/core`.
- Long lists and large tables: `@tanstack/react-virtual`.
- Charts: `recharts`.
- Forms and validation: `react-hook-form` + `zod` (bridge with `@hookform/resolvers`).
- Data fetching and server cache: `@tanstack/react-query`.
- Shared client state: `zustand`, only after `useState`/`useReducer`/context stop being enough.
- Theme switching in Next.js: `next-themes`.

### Mismatches to catch
- A hand-built toast or dropdown with manual focus handling: use the picks above.
- Rendering thousands of rows directly instead of virtualizing.
- `useEffect` + `fetch` with manual loading/error state where the project has React Query.
- Simple hover or fade: plain CSS transitions, no library.

If the project already has a competing library, keep it and don't swap unasked.
