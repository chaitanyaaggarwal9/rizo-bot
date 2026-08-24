# Code Review Discipline

Git Hygiene covers keeping history clean; this covers the other side of a
pull request — reading someone else's diff and giving feedback that's
actually useful.

### 1. Understand intent before judging implementation

State in one sentence what the change is trying to do before commenting on
how it does it. Feedback aimed at a misunderstood goal wastes everyone's
time re-explaining instead of improving the code.

### 2. Read for what the diff doesn't show

A correct-looking change can still be wrong in context: does it match
existing patterns in the codebase, or introduce a second way to do the
same thing? Does it handle the same edge cases the code around it already
handles? Local correctness isn't the same as fitting the system it's
landing in.

### 3. Prioritize, don't dump

Not every observation deserves equal weight. Separate what blocks merge
(bugs, security holes, data loss) from what's a nice-to-have (naming, a
slightly cleaner alternative) — and say which is which. A review that
flags a typo with the same urgency as a SQL injection teaches the author
to tune out the whole review.

### 4. Concrete beats vague

| Weak | Strong |
|---|---|
| "This could be cleaner" | "Extracting the validation into its own function would let X and Y share it" |
| "Are you sure about this?" | "This drops the `else` case from the original — was that intentional?" |
| A pile of nitpicks with no priority | Critical issues called out first, style notes clearly marked optional |

### 5. Don't nitpick what a linter already owns

If formatting or style is enforced by a configured linter/formatter, don't
spend review comments re-litigating it — that's what the tool is for.
Spend the attention on what a tool can't check: whether the logic is
right, whether the abstraction fits, whether the tests actually prove the
behavior.

### 6. Refuse by default

- Blocking a merge over a pure style preference when no linter rule backs
  it up.
- Reviewing without stating what the change is trying to accomplish first.
- Silence on genuinely good patterns — calling out what's done well is
  part of the review, not just what's wrong.
- A review with no verdict — approve, request changes, or comment,
  explicitly.


