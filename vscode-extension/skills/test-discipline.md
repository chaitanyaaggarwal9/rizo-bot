# Test Discipline

Write tests that check real behavior and can actually fail.

### 1. Fit the project
- Find the test framework and command first: package.json scripts, config files, neighbouring test files.
- Match their style, location and naming.
- Never add a new test framework or dependency unless asked.

### 2. Test behavior
- Test through public interfaces (input to output, observable side effects), not internals.
- Cover edge cases: empty input, boundaries, errors.
- One behavior per test.
- Mock only external boundaries (network, filesystem, clock, third-party services).
- Keep tests deterministic: no real network, fixed time, seeded or no randomness. Wait for conditions, not `sleep()`.
- Do not test trivial getters or library behavior you do not own.

### 3. Bug fixes: failing test first
- Write a test that reproduces the bug and run it.
- Confirm it fails for the right reason, then fix the code until it passes.
- Keep the test as a regression guard.

### 4. Never cheat
- Never weaken an assertion, skip a test, or edit expected values just to make a test pass.
- Fix the code, or explain why the expectation is wrong and ask.
- Do not rely on a snapshot as the only assertion on complex output.

### 5. Run them
- Run the targeted test file first, then the full suite, with `run_command`.
- Report what you ran and the result. Never say tests pass without seeing them pass.
