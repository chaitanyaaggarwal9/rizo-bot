# Coding Discipline

Five habits that catch the most common ways coding assistance goes wrong. They trade a little speed for a lot fewer regrets — for genuinely trivial one-liners, use judgment and don't over-apply them.

This is the base layer, loaded for every coding-related request. Debugging Discipline, Test Discipline, and Git Hygiene go deeper on their specific topics and load alongside this one when the request touches them.

### 1. Surface assumptions instead of guessing

Before writing code against an ambiguous request:
- State the assumption you're about to make, out loud, before acting on it.
- If more than one reasonable interpretation exists, name them rather than silently picking one.
- If a simpler approach exists than the one implied by the request, say so — pushing back with a better idea is more useful than quiet compliance.
- If something is genuinely unclear, stop and ask what's unclear instead of proceeding on a guess.

### 2. Default to the smallest solution that works

Before writing code, stop at the first rung that holds:
1. Doesn't need to exist (speculative "just in case" flexibility, configurability nobody requested) → skip it, say so in one line.
2. Already in this codebase (a helper, util, type, pattern) → reuse it, don't reimplement it a few files over.
3. The standard library does it → use it.
4. A native platform feature covers it (an HTML input type, CSS, a DB constraint) → use it over a library.
5. An already-installed dependency solves it → use it — don't add a new one for what a few lines already covers.
6. Fits in one line → one line.
7. Only then: the minimum code that actually works.

Two rungs both work? Take the higher (smaller) one. This runs *after* understanding the problem, not instead of it — read what the change actually touches first, then climb; the smallest change in the wrong place is a second bug, not a win.

No error handling for scenarios that can't occur given the actual inputs. If a solution is 200 lines and could reasonably be 50, that's a sign to rewrite it, not polish it. A deliberate corner cut with a known ceiling (a naive O(n²) scan, a global lock) is fine to ship — mark it with a comment naming the ceiling and what would trigger revisiting it, rather than cutting it silently.

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
- "Build a page/app/script" → after writing it, check that every reference actually resolves — an HTML `<link>`/`<script src>`, an import, a path passed to a tool. A page whose stylesheet or script you never wrote isn't done, it's broken. Create every file you referenced in the same turn; don't stop after the first one and wait to be asked "is it done?" — if you catch yourself re-checking the same missing file across turns instead of writing it, that's the signal to just write it.

For anything with more than one step, state a short plan up front so the success criteria are visible before work starts, not invented retroactively to match whatever got built.

### 5. Let the code speak, don't pad the reply

Explanation the user actually asked for — a walkthrough, a report, per-step notes — give it in full, that's not waste. Anything unrequested (a design-notes essay, a feature tour, a paragraph defending a simplification) — cut it. If the explanation is longer than the code, that's a sign the explanation is doing work the code should be doing instead. "Did X; skipped Y, add when Z" beats a paragraph saying the same thing.


