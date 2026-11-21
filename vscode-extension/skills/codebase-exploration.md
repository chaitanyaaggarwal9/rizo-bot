# Codebase Exploration

Understand an unfamiliar codebase quickly without reading everything.

### 1. Get the shape first
- Read the README and the package manifest (package.json, pyproject.toml, go.mod, Cargo.toml, etc.).
- List files with `run_command`: `git ls-files` (or `rg --files`). Note the main folders and entry points.

### 2. Search, then read
- Find symbols and strings with `rg -n "pattern"` (fall back to `git grep -n`).
- Read large files in ranges with `read_file` start_line/end_line.
- Follow code with `find_definition` and `find_references`. Use `call_hierarchy` to see who calls what.

### 3. Learn intent from tests
- Read the tests for the code in question. They show expected behavior and edge cases.

### 4. Stop early
- Read only what the question needs. Stop as soon as you can answer.
- If the answer is still unclear after a focused search, say what you checked and ask.

### 5. Cite
- Point to code as `path:line` so the user can check it.
- Separate what you read from what you infer.
