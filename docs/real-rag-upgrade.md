# Real RAG Upgrade

This project has moved from demo retrieval to a real RAG flow:

1. Approved documents are chunked.
2. Chunks are embedded with Gemini embeddings.
3. Approved chunk embeddings can be stored in PostgreSQL + pgvector.
4. User questions are embedded at ask time.
5. Retrieval uses pgvector cosine search plus keyword/entity guards.
6. The backend builds a citation-labeled context pack from the top approved chunks.
7. The answer prompt receives only the packed approved context, not the full corpus.
8. The response includes citations, retrieval mode, semantic score, keyword score, confidence, retrieval trace, and estimated context tokens.

## Enable It

Add these environment variables:

```bash
ENABLE_GEMINI=true
ENABLE_SEMANTIC_RAG=true
ENABLE_VECTOR_DB=true
GEMINI_API_KEY=<your-key>
GEMINI_MODEL=gemini-2.5-flash
EMBEDDING_MODEL=gemini-embedding-001
EMBEDDING_DIMENSIONS=3072
SEMANTIC_SIMILARITY_THRESHOLD=0.62
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db>
```

Run the database migration:

```bash
npm run db:init
```

Your PostgreSQL database must have the `vector` extension available. The schema creates:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## Retrieval Modes

- `pgvector-hybrid`: real vector DB retrieval from PostgreSQL + pgvector.
- `semantic-hybrid`: in-process semantic retrieval if vector DB is disabled.
- `keyword-bm25`: fallback if embeddings are disabled or unavailable.

## Retrieval Pipeline

The backend now uses a multi-stage retrieval flow:

1. Analyze query intent, entity terms, priority terms, and quoted phrases.
2. Build a candidate pool from pgvector, in-process embeddings, or BM25 fallback.
3. Blend semantic similarity, BM25 lexical relevance, exact-match boosts, and metadata/use-case boosts.
4. Apply entity and priority guards to prevent broad-but-wrong matches.
5. Rerank with MMR-style diversity so the context pack is not filled with duplicate clauses.
6. Build a citation-labeled context pack with source IDs such as `[S1]`.
7. Verify the final answer is grounded in retrieved source text before returning it.

## Separate Frontend and Backend

Run the backend API:

```bash
npm run backend:dev
```

Run the standalone frontend:

```bash
npm run frontend:start
```

The frontend dev server reads `FRONTEND_API_BASE` and injects it into `config.js`.

## Production Next Step

This version uses PostgreSQL + pgvector as the production vector DB path. The local JSON embedding cache remains only as a speed-up/fallback for simple deployments.
