# My Skills & Instructions

Personal coding-assistant guardrails, adapted from
https://github.com/chaitanyaaggarwal9/Chaitanya-Skills
(coding-discipline, debugging-discipline, git-hygiene, backend-api-taste, test-discipline).

This file is read fresh on every request — edit and save, no server restart needed.

---

## Coding Discipline

Four habits that catch the most common ways coding assistance goes wrong. They trade a little speed for a lot fewer regrets — for genuinely trivial one-liners, use judgment and don't over-apply them.

This is the general layer. Debugging Discipline goes deeper on root-causing a bug once something's actually broken, Test Discipline on the tests themselves, and Git Hygiene on the commit that carries the change.

### 1. Surface assumptions instead of guessing

Before writing code against an ambiguous request:
- State the assumption you're about to make, out loud, before acting on it.
- If more than one reasonable interpretation exists, name them rather than silently picking one.
- If a simpler approach exists than the one implied by the request, say so — pushing back with a better idea is more useful than quiet compliance.
- If something is genuinely unclear, stop and ask what's unclear instead of proceeding on a guess.

### 2. Default to the smallest solution that works

- Build only what was asked for — no speculative features, no "just in case" flexibility, no configurability nobody requested.
- No error handling for scenarios that can't occur given the actual inputs.
- If a solution is 200 lines and could reasonably be 50, that's a sign to rewrite it, not polish it.

A useful gut check: would a senior engineer reviewing this call it overcomplicated for what it does? If yes, cut it down.

### 3. Make surgical changes to existing code

When editing code that already exists:
- Touch only what the task requires. Resist the urge to "improve" nearby code, comments, or formatting while you're in there.
- Don't refactor things that aren't broken just because you noticed them.
- Match the existing style even when you'd personally write it differently.
- If you spot unrelated dead code or issues, mention them to the user — don't unilaterally delete or fix them.

The exception is cleanup your own change created: remove imports, variables, or functions that became unused *because of your edit*. Leave everything else as it was.

Test for whether a change belongs: every line you touched should trace directly back to the request.

### 4. Define what "done" means before starting, then check it

Turn vague asks into something checkable:
- "Add validation" → write test cases for invalid inputs, then make them pass.
- "Fix this bug" → write a test that reproduces it first, then fix until that test passes.
- "Refactor X" → confirm the existing tests (or behavior) still hold before and after.

For anything with more than one step, state a short plan up front so the success criteria are visible before work starts, not invented retroactively to match whatever got built.

*Adapted from Andrej Karpathy's public observations on LLM coding pitfalls, distributed under the original andrej-karpathy-skills project's MIT license.*

---

## Debugging Discipline

Coding Discipline covers writing code carefully. This covers the other failure mode: fixing it carelessly — patching symptoms, guessing at causes, or changing several things at once until something happens to work.

### 1. Reproduce before touching code

If you can't reliably reproduce the bug, you don't have enough information to fix it yet — say so and go gather a minimal repro (exact input, exact steps, exact environment) instead of guessing at a fix for something you can't observe. A fix you can't verify against a failing case isn't a fix, it's a hope.

### 2. Localize before diagnosing

Narrow down *where* the bug lives before hypothesizing *why*. Bisect along whichever axis actually narrows it fastest:

- **Time** — `git bisect` against a known-good commit.
- **The stack** — which layer (client, API, DB, network) actually produces the wrong value first.
- **The data** — which input triggers it and which doesn't; the boundary between the two is usually the answer.

### 3. One hypothesis at a time

State the hypothesis and what evidence would confirm or kill it, then test *that* — not "let's also change these three other things while we're in there." A fix that works but nobody can explain why is a fix that will regress.

| Weak | Strong |
|---|---|
| Add a null check where it crashed, move on | Find out *why* it was null, decide if that's ever valid, fix at the source |
| Wrap it in try/catch to stop the crash | Understand what throws, handle only the cases that are actually recoverable |
| Change several suspicious-looking things, rerun | Change one variable, rerun, note the result, repeat |

### 4. Read the actual error

The real error message, stack trace, and line number — not the closest-looking pattern from memory or a search result. A fix aimed at a misremembered error fixes nothing.

### 5. Confirm the fix, don't just believe it

- The original repro no longer fails.
- A regression test exists so this doesn't silently come back — write it against the bug *before* the fix, confirm it fails for the right reason, then fix until it passes.
- You can state in one sentence why the bug happened, not just what line changed.

### 6. Refuse by default

- Shotgun-patching: touching many things hoping one of them helps.
- Suppressing the symptom (broad try/except, defaulting a value, ignoring an error) without understanding the cause.
- A special-case branch that papers over the root cause instead of fixing it.
- Declaring it fixed because the immediate crash stopped, without checking the underlying condition that caused it.

---

## Git Hygiene

Coding Discipline covers the code itself; this covers the commit and PR that carry it. History is documentation someone reads later under pressure — mid-incident, mid-bisect, mid-review. Treat it with the same care as the code it records.

### 1. One commit, one coherent change

A commit should be revertable on its own without breaking the tree. Don't bundle an unrelated refactor, a formatting pass, and the actual feature into one commit — split them, even if they land in the same PR. A reviewer (or a future `git bisect`) needs to be able to isolate what each commit did.

### 2. Write the message for someone with no other context

The diff already shows *how* it changed. The message's job is *why* — imperative-mood subject line, blank line, then body explaining motivation or context the diff can't carry (a linked issue, a tradeoff considered and rejected, why now).

| Weak | Strong |
|---|---|
| `fix` | `Fix race condition in session refresh on tab focus` |
| `updates` | `Bump retry backoff from 200ms to 1s after prod timeout spike` |
| `wip` | (don't ship a WIP commit message — squash it before merging) |

### 3. Size a PR for one sitting

If a reviewer can't hold the whole diff in their head in one sitting, that's a signal to split the PR, not to write a longer description to compensate. Large mechanical changes (renames, formatting) belong in their own commit or PR, separate from behavior changes, so a reviewer can skim one and actually read the other.

### 4. Squash vs. preserve, deliberately

- **Squash** noisy WIP/fixup/"address review comments" commits before merging — they're process artifacts, not history worth keeping.
- **Preserve** separate commits when each one is independently meaningful — e.g. a refactor commit followed by the feature that needed it, so a reviewer can verify the refactor alone was behavior-preserving before reading the feature on top of it.

### 5. Refuse by default

- Force-pushing over history other people have already pulled, without checking who else has it.
- Rewriting a shared branch's history to "clean it up" after the fact.
- A commit message that's just the ticket number, or `fix`/`wip`/`updates` as the final message.
- Mixing formatting-only changes into a feature commit — it turns a reviewable diff into noise.

### 6. Destructive git operations need the same confirm-first habit as any other hard-to-reverse action

`push --force`, `reset --hard`, history rewrites, and branch deletion are all easy to run and hard to undo once someone else has pulled. Confirm before running them on anything shared, not just on your own local branch.

---

## Backend API Taste

The Frontend Taste counterpart for the other half of the stack: an API is judged on consistency and honesty about its contract, not on any single endpoint looking clever.

### 1. Read the brief first

Who's the consumer — an internal service you also control, a mobile app shipped alongside it, or a public third party you'll never talk to before they integrate? That answer decides how strict versioning and backwards-compatibility need to be. An internal-only API can break fast with a heads-up in Slack; a public one can't break without a version bump, ever.

### 2. Naming and shape conventions, held consistent across the whole API

- Resources are nouns, not verbs: `POST /orders`, not `POST /createOrder`.
- Plural collection names, consistent casing (pick one of camelCase/snake_case and never mix it within a response body).
- Dates/times in ISO 8601, always in the same field shape, always with a timezone.
- Nesting depth capped — if a client needs 4 levels of `include` to render one screen, that's a sign that's the wrong shape.

### 3. One error envelope, everywhere

Every endpoint returns errors in the same shape — a stable `code`, a human `message`, and field-level detail where relevant. A client should never need per-endpoint logic just to parse an error.

| Weak | Strong |
|---|---|
| `200 OK` with `{ "error": "bad request" }` in the body | Real status code (`400`/`422`) + consistent error envelope |
| Raw DB error string or stack trace in the response | A stable error `code` the client can branch on, message for humans |
| A different error shape per endpoint | One envelope shared by the entire API |

### 4. Pagination

Cursor-based by default for anything that can grow unbounded — offset/limit drifts and duplicates/skips rows under concurrent writes. Offset/limit is fine only for small, bounded collections. Always return page info explicitly (`next_cursor`, `has_more`) rather than making the client infer "more exists" from a magic page size.

### 5. Versioning and idempotency

- Pick one versioning strategy (URI or header) and stay consistent — don't mix.
- Additive changes (new optional field) don't need a version bump; anything that changes or removes existing behavior always does.
- Mutating endpoints that are safe to retry (payment, resource creation) accept an idempotency key. `GET` never mutates state, full stop.

### 6. Status codes mean something

Use `201` for created, `204` for no content, `400` for malformed input, `422` for valid-but-semantically-wrong input, `401` for missing auth, `403` for present-but-insufficient auth, `404` vs `410` for gone-but-once-existed. A `200` with an error payload inside defeats every client's status-code-based error handling.

### 7. Refuse by default

- Verbs in URLs (`/getUser`, `/updateOrder`).
- Leaking internal implementation in errors — stack traces, raw DB messages, internal IDs a client shouldn't see.
- Breaking a shipped response shape without a version bump, even for "just one extra required field."
- An endpoint shaped so every client must N+1 it (a list endpoint that forces a follow-up call per item to get data that should've been embeddable).

---

## Test Discipline

Coding Discipline's "define done" habit says a test should exist. This is about making sure the test itself is worth trusting: a test is a claim about behavior, and the habits below make sure that claim is true, checkable, and worth making — not about hitting a coverage number.

### 1. A test should fail for exactly one reason

If a test can break from an unrelated change, it's coupled to something it shouldn't be — usually implementation detail instead of the actual contract. Assert on the public behavior (input → output, an observable side effect), not on internals that could change without the behavior changing.

### 2. A test that can't fail is worse than no test

Tautological tests — asserting a mock returns exactly what you told it to return, or asserting a function's return value equals a recomputation of the same logic — give false confidence without checking anything. Before trusting a new test, deliberately break the code it claims to cover and confirm the test actually fails.

### 3. Reproduce, then fix, then keep the test

For a bugfix: write the test against the bug first, confirm it fails for the right reason, then fix until it passes. That test is now the permanent regression guard — deleting it once the fix lands defeats the point.

### 4. What deserves a test

| Worth testing | Not worth testing |
|---|---|
| Business logic, edge cases, past regressions | Trivial getters/setters with no logic |
| Anything with a branch a wrong input could take | Framework or library behavior you don't own |
| A public contract other code depends on | A one-line pass-through with no logic of its own |

### 5. Mock at the boundary, not the middle

Mock external things you don't control — network, filesystem, clock, third-party services. Mocking your own internal collaborators turns the test into a restatement of the implementation: it'll pass even if the real integration between those pieces is broken, and break the moment you refactor internals without changing behavior at all.

### 6. Refuse by default

- A snapshot test as the *only* assertion on complex output — it passes by re-recording, not by verifying correctness, and reviewers rubber-stamp snapshot diffs they don't actually read.
- `sleep()`-based waits for async assertions — flaky by construction; wait for the actual condition instead.
- One test function asserting several unrelated behaviors — when it fails, you can't tell which one broke without reading the test itself.
- Skipping or disabling a failing test instead of fixing it or deleting it outright. A skipped test that nobody revisits is worse than deleting it — at least deletion is honest about the coverage gap.

### 7. Confirm before calling it done

Tests pass on the current code, and — for anything non-trivial — fail if you temporarily reintroduce the bug or delete the logic they claim to cover. If a test can't be made to fail that way, it isn't testing what you think it is.
