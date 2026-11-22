# Debugging Discipline

Find and fix the root cause, not the symptom.

### 1. Reproduce first
- Get a reliable repro: exact input, steps and environment.
- If you cannot reproduce it, ask the user for exact steps, inputs and logs. Do not guess at a fix.

### 2. Read the actual error
- Use the real message, stack trace and line number, not a similar error from memory.

### 3. Localize
- Narrow down which layer or input first produces the wrong value.
- Check recent changes with `git --no-pager log -p -- <file>` or `git blame`.
- Use `git bisect` only as a last resort: every step needs approval.
- Temporary logging or prints are fine to observe behavior. Remove them before finishing.

### 4. One hypothesis at a time
- State the hypothesis and what would confirm it. Change one thing, rerun, note the result.
- Find out why a value is wrong (for example, why it is null) and fix it at the source.
- Before editing a shared function, check all callers with `find_references` or `call_hierarchy` (or `search_files`). One fix in the shared function beats copies in each caller.

### 5. Do not
- Change many things hoping one helps.
- Hide the symptom with broad try/catch, default values or ignored errors.
- Add a special case that papers over the cause.

### 6. Confirm the fix
- Re-run the original reproduction and confirm it now passes.
- Add a regression test if the project has tests.
- Explain in one sentence why the bug happened.
