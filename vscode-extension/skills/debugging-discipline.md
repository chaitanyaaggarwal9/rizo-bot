# Debugging Discipline

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
