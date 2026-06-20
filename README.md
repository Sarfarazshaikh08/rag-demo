# Solvagence KnowledgeOps RAG

Enterprise knowledge assistant with a separate backend API and frontend app.

## Run Locally

Terminal 1:

```bash
npm run backend:dev
```

Terminal 2:

```bash
npm run frontend:start
```

Open:

```text
http://127.0.0.1:5173
```

The frontend dev server points at `http://127.0.0.1:3000` by default. Override with:

```bash
FRONTEND_API_BASE=http://localhost:3000 npm run frontend:start
```

## Production Run

```bash
npm start
```

The backend serves `frontend/` as static assets and exposes the API from the same origin.

## Verification

Run the end-to-end smoke test:

```bash
npm run test:smoke
```

It starts the backend on a temporary local port and verifies health, RAG answer citation, unknown-question refusal, anonymous upload blocking, and login/session behavior.

## AWS Deployment

For S3 frontend + EC2 backend deployment, use:

```text
docs/aws-s3-ec2-deployment.md
```

Frontend build for S3:

```bash
FRONTEND_API_BASE=https://api.example.com npm run frontend:build
```

Upload to S3:

```bash
S3_FRONTEND_BUCKET=<bucket-name> FRONTEND_API_BASE=https://api.example.com npm run frontend:deploy:s3
```

## Real RAG Mode

The app supports three retrieval modes:

- `keyword-bm25`: local fallback with BM25 lexical scoring, metadata boosts, and diversity reranking.
- `semantic-hybrid`: Gemini embeddings with in-process retrieval.
- `pgvector-hybrid`: Gemini embeddings stored and searched in PostgreSQL + pgvector.

## Hardening Included

- Anonymous document uploads are blocked.
- Upload UI is shown only to admin/reviewer sessions.
- Auth, ask, and write routes have lightweight rate limits.
- Session cookies are configurable with `SESSION_COOKIE_SAMESITE` and `SESSION_COOKIE_SECURE`.
- Security headers are applied by the backend.
- Upload size and extracted text size are capped.

Enable full RAG:

```bash
ENABLE_GEMINI=true
ENABLE_SEMANTIC_RAG=true
ENABLE_VECTOR_DB=true
GEMINI_API_KEY=<your-key>
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db>
npm run db:init
npm start
```

## Structure

- `backend/index.js`: Express API implementation and production static host.
- `backend/src/index.js`: backend API entrypoint.
- `backend/src/rag/advancedRag.js`: citation context packing and confidence metadata.
- `backend/src/vector/vectorIndex.js`: approved chunk indexing and cosine helper.
- `backend/src/repositories/postgresRepository.js`: PostgreSQL and pgvector repository.
- `backend/data/*.txt`: approved seed knowledge assets.
- `backend/scripts/`: database and password helper scripts.
- `frontend/`: standalone browser app and dev static server.
