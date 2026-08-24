# Security Hygiene

Coding Discipline covers writing code carefully in general; this covers the
specific ways "working" code turns into a vulnerability — trusting input
that wasn't validated, or handling secrets and credentials casually.

### 1. Validate and sanitize every external input

Anything from a request body, query string, header, or file upload is
untrusted until checked. Validate shape and bounds (a library like
Zod/Joi/Pydantic beats hand-rolled checks) before it touches a query, a
shell command, or a template. Reject on failure with a generic error —
don't echo the raw input back.

### 2. Never build queries or commands by string concatenation

- SQL: parameterized queries / prepared statements, always — `WHERE id =
  $1`, never `WHERE id = '${id}'`.
- Shell: pass arguments as an array to the process, never interpolate user
  input into a shell string.
- Templates: rely on the templating engine's auto-escaping for anything
  rendered as HTML; never mark user content "safe" without a specific
  reason.

### 3. Secrets live in the environment, not in the diff

API keys, tokens, and passwords go in environment variables or a secrets
manager — never hardcoded, never committed, never logged. Before
committing, a `.env`-style file with real credentials should be in
`.gitignore`, not just intended to be. If a secret was ever committed,
rotating it is the fix — deleting the commit doesn't remove it from
history.

### 4. Passwords and tokens: don't roll your own

Hash passwords with bcrypt/argon2 (never MD5/SHA-1/plaintext). For tokens,
use a maintained library, set an explicit expiration, and allowlist the
signing algorithm — an attacker who can choose the algorithm can often
forge a token.

### 5. Errors tell the user nothing an attacker can use

"Invalid credentials" for both wrong-password and no-such-user — never
confirm which is which. Stack traces, internal IDs, and raw database error
messages belong in server logs, not the response body.

### 6. Refuse by default

- String-built SQL/shell commands, even "just this once."
- A secret typed directly into source, config committed to git, or printed
  to a log.
- An auth error message that reveals whether an account exists.
- Rolling a custom hashing/encryption scheme instead of a vetted library.

