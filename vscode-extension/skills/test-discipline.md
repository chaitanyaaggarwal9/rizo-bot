# Test Discipline

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

"Done" is a PASS/FAIL check against something you actually ran, not a guess: if a test suite exists, run it (`run_command`) before saying the turn is finished — don't declare success on the strength of the code looking right. "I ran out of steps but this should work" and "the tests pass" are different claims; only make the second one after actually seeing it pass. A failing or skipped check you didn't mention is worse than admitting the turn isn't done yet.
