# Coding Discipline

Four habits that catch the most common ways coding assistance goes wrong. They trade a little speed for a lot fewer regrets — for genuinely trivial one-liners, use judgment and don't over-apply them.

This is the base layer, loaded for every coding-related request. Debugging Discipline, Test Discipline, and Git Hygiene go deeper on their specific topics and load alongside this one when the request touches them.

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
- "Build a page/app/script" → after writing it, check that every reference actually resolves — an HTML `<link>`/`<script src>`, an import, a path passed to a tool. A page whose stylesheet or script you never wrote isn't done, it's broken. Create every file you referenced in the same turn; don't stop after the first one and wait to be asked "is it done?" — if you catch yourself re-checking the same missing file across turns instead of writing it, that's the signal to just write it.

For anything with more than one step, state a short plan up front so the success criteria are visible before work starts, not invented retroactively to match whatever got built.

*Adapted from Andrej Karpathy's public observations on LLM coding pitfalls, distributed under the original andrej-karpathy-skills project's MIT license.*
