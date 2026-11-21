# Backend API Taste

Purpose: build APIs that are consistent, safe and honest about their contract.

### Match what exists first
- Follow the existing API's naming, casing, pagination, response envelope, error shape and versioning before applying these defaults.
- Resources are plural nouns (`POST /orders`, not `/createOrder`). Dates in ISO 8601 with timezone.

### Status codes
- 200 OK, 201 Created, 204 No Content.
- 400 malformed request; 422 valid syntax but failed validation.
- 401 not authenticated; 403 authenticated but not allowed.
- 404 not found; 410 existed and was permanently removed; 409 conflict (duplicate, version mismatch).
- 429 rate limited, with a `Retry-After` header.
- Never 5xx for client errors, and never 200 with an error in the body.

### Errors
- One consistent error shape everywhere: stable machine `code`, human message, field-level details.
- RFC 9457 Problem Details (`application/problem+json`) is a good default for new APIs.
- No stack traces, raw DB errors or internal IDs in responses.

### Safety
- Authorization check in every endpoint, including access to the specific record.
- Validate input at the boundary. Set request body size limits.
- `GET` never changes state.
- Idempotency keys make retries of non-idempotent requests (payments, creation) safe: POSTs that may be retried should accept an `Idempotency-Key` header and return the original result on repeat.

### Pagination and change
- Cursor pagination for large or live collections; return `next_cursor`/`has_more` explicitly. Offset is fine for small bounded lists.
- Additive changes (new optional field) are fine. Removing or changing behavior needs a new version; never break a shipped shape silently.
- Avoid shapes that force clients into N+1 calls.
