# Security Hygiene

Purpose: keep code secure and safe, so input, tokens and secrets can't leak or be abused.

### Input and output
- Validate input at the boundary: type, length, format, allowlists. Reject early.
- Encode output for its context: HTML escaping, SQL via parameterized queries only, shell via argument arrays (never string concatenation).
- File paths: resolve, then confirm the result stays inside the allowed directory (path traversal).
- Outbound URLs from users: allowlist hosts and block internal/private IPs (SSRF).

### Auth and permission
- Check authorization on every request and every object access: can this user access *that* record? (IDOR/BOLA is OWASP API #1.)
- Passwords: argon2id. bcrypt only in existing systems (it ignores bytes past 72). Never MD5/SHA or custom schemes.
- JWT: verify the signature with an explicit algorithm allowlist, reject `alg: none`, check `exp`, `aud`, `iss`. Keep tokens short-lived.
- Cookie auth needs CSRF protection. CORS: strict origin allowlist, never `*` with credentials.
- Rate limit login, signup and password-reset endpoints.
- Auth failures get a generic message ("Invalid credentials"), never revealing whether a user exists. Validation errors can be specific. No stack traces in responses.

### Secrets
- Never hardcode, commit, or log an api key, token or password; never paste one into chat.
- Use env vars or a secret manager. Don't print `.env` contents; keep `.env` in `.gitignore`.
- A committed secret must be rotated; deleting the commit is not enough.

### Dependencies
- Don't add packages without asking. Check the exact package name (typosquats).
- Keep lockfiles committed. Be wary of install scripts. Never run `curl | sh`.

Match the project's existing security libraries and conventions first.
