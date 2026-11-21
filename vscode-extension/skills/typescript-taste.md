# TypeScript Taste

Purpose: write TypeScript whose types actually prevent bugs.

### Types
- Prefer `unknown` over `any`; narrow before use.
- Narrow with type guards, e.g. `function isUser(x: unknown): x is User`, or a validation library at boundaries.
- In `catch (e)`, check `e instanceof Error` before using `e.message`.
- Avoid non-null `!` and `as` casts except at proven boundaries (value already validated); say why in a comment.
- Use `satisfies` to check a literal against a type without widening it.
- Use `import type` for type-only imports.
- Annotate exported function parameters and return types; let inference handle locals.

### Modeling
- Model states as discriminated unions, e.g. `{ status: "loading" } | { status: "ok"; data: T } | { status: "error"; error: string }`, not a pile of booleans.
- Handle unions with an exhaustive `switch`; in `default`, assign to `never` so a new case fails to compile:
  `const _exhaustive: never = state;`
- Avoid `enum`. Use union types or an `as const` object. Enums fail under `erasableSyntaxOnly` and Node's type stripping.

### Compiler settings
- New projects: `strict: true` and `noUncheckedIndexedAccess: true`.
- Existing repos: don't change tsconfig flags unless the user asks.

### Verify
- Run the project's typecheck after changes: the package.json script if one exists (e.g. `npm run typecheck`), otherwise `npx tsc --noEmit`.
- Fix type errors properly; don't silence them with `any`, `!`, `as` or `@ts-ignore`.

Match the project's existing conventions first.
