# Production Readiness

This demo now has a production-shaped backend path while keeping the local JSON demo runnable.

## Target Flow

1. Admin creates users in PostgreSQL with bcrypt password hashes.
2. Viewer can ask questions against approved knowledge only.
3. Reviewer can inspect draft documents and add approval comments.
4. Admin can approve, archive, edit, restore versions, and delete uploaded documents.
5. Original files are stored in object storage with checksum metadata.
6. PDF text is extracted first. If no text is found, OCR can be triggered for scanned assets.
7. Vector indexing runs only after a document reaches `Approved`.
8. Every answer and source decision is written to audit logs.

## Current Hardening

- Anonymous uploads are rejected by the backend.
- Upload controls are hidden until an admin or reviewer is logged in.
- Auth, ask, and write routes have lightweight in-memory rate limits.
- Session cookie `SameSite` and `Secure` flags are configurable.
- Basic browser security headers are set by Express.
- Upload byte size and extracted document text size are capped.
- `npm run test:smoke` verifies core health, RAG, refusal, upload blocking, and auth/session behavior.

## Real RAG Mode

The app can now run semantic retrieval with Gemini embeddings instead of only keyword/fuzzy matching.

```bash
ENABLE_SEMANTIC_RAG=true
ENABLE_VECTOR_DB=true
EMBEDDING_MODEL=gemini-embedding-001
SEMANTIC_SIMILARITY_THRESHOLD=0.62
```

Documents are embedded only after approval. With `ENABLE_VECTOR_DB=true`, approved chunk embeddings are stored in PostgreSQL + pgvector and searched with cosine similarity. Queries are embedded at ask time, then ranked with a hybrid score:

- semantic cosine similarity
- keyword/fuzzy score
- entity and priority guards

If embeddings fail or the API key is missing, the app falls back to keyword/fuzzy retrieval so the demo remains usable.

## Production Tables

- `users`: login identity, bcrypt hash, role, active flag.
- `documents`: current approved or draft document state.
- `document_versions`: immutable history before edits, restores, and status changes.
- `approval_comments`: reviewer/admin comments and approval notes.
- `document_chunks`: searchable chunks created only for approved documents.
- `audit_logs`: questions, answers, user context, status, and cited source.

## Setup

Create password hashes:

```bash
npm run password:hash -- StrongPassword123
```

Initialize PostgreSQL schema:

```bash
npm run db:init
```

Seed Admin, Reviewer, and Viewer users:

```bash
npm run db:seed-users
```

Use `ENABLE_POSTGRES=true` only after wiring the routes fully to `backend/src/repositories/postgresRepository.js`. Until then, the demo remains on local JSON storage but follows the same lifecycle.
