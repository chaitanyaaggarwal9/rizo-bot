# TypeScript Taste

The type-system counterpart to Coding Discipline: a TypeScript codebase is
judged on whether its types actually prevent bugs, not on how clever the
generics look.

### 1. Strict mode, no exceptions

`strict: true` in tsconfig, non-negotiable. `noUncheckedIndexedAccess` too
— without it, `arr[i]` is typed as if it can never be `undefined`, which
is the single most common source of "impossible" runtime crashes in TS
code.

### 2. Let inference do the work; annotate the boundary

Don't annotate every local variable — the compiler already knows. Do
annotate every exported function's parameters and return type explicitly,
since that's the contract other code relies on, and inference can silently
drift as the implementation changes underneath an unannotated signature.

### 3. Narrow with the type system, not casts

| Weak | Strong |
|---|---|
| `data as User` | A type predicate (`function isUser(x): x is User`) or a validation library that actually checks the shape |
| `value!` to silence a null check | Handle the `null`/`undefined` case, or prove to the compiler it can't happen |
| `catch (e: any)` | `catch (e)`, narrow with `e instanceof Error` before touching `.message` |

`as` and `!` don't make something true — they tell the compiler to stop
checking. Reach for them only when you can state *why* the compiler's
information is wrong (e.g., a value already validated one function up).

### 4. Model states as a union, not a pile of booleans

`{ status: "loading" } | { status: "success", data } | { status: "error",
error }` makes impossible states (`loading: true` and `error: "x"` at the
same time) unrepresentable. A switch over the union's discriminant, with a
`never` check in the default case, means the compiler flags it the moment
a new state is added and a handler is missing.

### 5. Refuse by default

- `any` without a comment explaining why a real type wasn't possible.
- A non-null assertion (`!`) or `as` cast in place of an actual null check
  or validation.
- Widening an exported function's parameter type "to make the caller
  happy" instead of fixing the caller.
- Enums where a `const` object + `as const` union would do the same job
  with less runtime footprint.


