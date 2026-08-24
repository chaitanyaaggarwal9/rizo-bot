# Backend API Taste

The Web Design Taste counterpart for the other half of the stack: an API is judged on consistency and honesty about its contract, not on any single endpoint looking clever.

### 1. Read the brief first

Who's the consumer — an internal service you also control, a mobile app shipped alongside it, or a public third party you'll never talk to before they integrate? That answer decides how strict versioning and backwards-compatibility need to be. An internal-only API can break fast with a heads-up in Slack; a public one can't break without a version bump, ever.

### 2. Naming and shape conventions, held consistent across the whole API

- Resources are nouns, not verbs: `POST /orders`, not `POST /createOrder`.
- Plural collection names, consistent casing (pick one of camelCase/snake_case and never mix it within a response body).
- Dates/times in ISO 8601, always in the same field shape, always with a timezone.
- Nesting depth capped — if a client needs 4 levels of `include` to render one screen, that's a sign that's the wrong shape.

### 3. One error envelope, everywhere

Every endpoint returns errors in the same shape — a stable `code`, a human `message`, and field-level detail where relevant. A client should never need per-endpoint logic just to parse an error.

| Weak | Strong |
|---|---|
| `200 OK` with `{ "error": "bad request" }` in the body | Real status code (`400`/`422`) + consistent error envelope |
| Raw DB error string or stack trace in the response | A stable error `code` the client can branch on, message for humans |
| A different error shape per endpoint | One envelope shared by the entire API |

### 4. Pagination

Cursor-based by default for anything that can grow unbounded — offset/limit drifts and duplicates/skips rows under concurrent writes. Offset/limit is fine only for small, bounded collections. Always return page info explicitly (`next_cursor`, `has_more`) rather than making the client infer "more exists" from a magic page size.

### 5. Versioning and idempotency

- Pick one versioning strategy (URI or header) and stay consistent — don't mix.
- Additive changes (new optional field) don't need a version bump; anything that changes or removes existing behavior always does.
- Mutating endpoints that are safe to retry (payment, resource creation) accept an idempotency key. `GET` never mutates state, full stop.

### 6. Status codes mean something

Use `201` for created, `204` for no content, `400` for malformed input, `422` for valid-but-semantically-wrong input, `401` for missing auth, `403` for present-but-insufficient auth, `404` vs `410` for gone-but-once-existed. A `200` with an error payload inside defeats every client's status-code-based error handling.

### 7. Refuse by default

- Verbs in URLs (`/getUser`, `/updateOrder`).
- Leaking internal implementation in errors — stack traces, raw DB messages, internal IDs a client shouldn't see.
- Breaking a shipped response shape without a version bump, even for "just one extra required field."
- An endpoint shaped so every client must N+1 it (a list endpoint that forces a follow-up call per item to get data that should've been embeddable).
