const db = require("../db/postgres");

function vectorLiteral(values = []) {
  if (!Array.isArray(values) || !values.length) {
    throw new Error("Embedding vector is required.");
  }

  return `[${values.map(value => Number(value).toFixed(8)).join(",")}]`;
}

function rowToDocument(row) {
  return {
    id: row.id,
    name: row.name,
    department: row.department,
    owner: row.owner,
    useCase: row.use_case,
    version: `v${row.current_version}`,
    approvalStatus: row.approval_status,
    reviewedAt: row.approved_at ? row.approved_at.toISOString().slice(0, 10) : null,
    updatedAt: row.updated_at.toISOString().slice(0, 10),
    source: "postgres",
    objectKey: row.object_key,
    content: row.content_text
  };
}

async function listDocuments({ includeArchived = false } = {}) {
  const result = await db.query(
    `
      SELECT *
      FROM documents
      WHERE ($1::boolean OR approval_status <> 'Archived')
      ORDER BY updated_at DESC
    `,
    [includeArchived]
  );

  return result.rows.map(rowToDocument);
}

async function findUserByUsername(username) {
  const result = await db.query(
    `
      SELECT id, username, display_name, password_hash, role, is_active
      FROM users
      WHERE username = $1
      LIMIT 1
    `,
    [username]
  );

  return result.rows[0] || null;
}

async function upsertUser({ username, displayName, email, passwordHash, role }) {
  const result = await db.query(
    `
      INSERT INTO users (username, display_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        role = EXCLUDED.role,
        is_active = true,
        updated_at = now()
      RETURNING id, username, display_name, email, role, is_active
    `,
    [username, displayName, email || null, passwordHash, role]
  );

  return result.rows[0];
}

async function createAuditLog(entry) {
  const result = await db.query(
    `
      INSERT INTO audit_logs (
        user_id, user_label, user_department, use_case, question, answer,
        status, source_document_id, source_document_name
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
    [
      entry.userId || null,
      entry.userLabel,
      entry.userDepartment || null,
      entry.useCase || null,
      entry.question,
      entry.answer,
      entry.status,
      entry.sourceDocumentId || null,
      entry.sourceDocumentName || null
    ]
  );

  return result.rows[0];
}

async function createVersion(client, documentId, actorId, note) {
  await client.query(
    `
      INSERT INTO document_versions (
        document_id, version_no, name, department, owner, use_case,
        approval_status, content_text, change_note, created_by
      )
      SELECT id, current_version, name, department, owner, use_case,
        approval_status, content_text, $2, $3
      FROM documents
      WHERE id = $1
    `,
    [documentId, note || "Document changed", actorId || null]
  );
}

async function updateDocumentStatus(documentId, status, actorId, comment) {
  return db.withTransaction(async client => {
    await createVersion(client, documentId, actorId, `Status changed to ${status}`);

    const result = await client.query(
      `
        UPDATE documents
        SET approval_status = $2,
            approved_by = CASE WHEN $2 = 'Approved' THEN $3 ELSE approved_by END,
            approved_at = CASE WHEN $2 = 'Approved' THEN now() ELSE approved_at END,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [documentId, status, actorId || null]
    );

    if (comment) {
      await client.query(
        `
          INSERT INTO approval_comments (document_id, author_id, author_role, comment_type, comment_text)
          VALUES ($1, $2, 'admin', 'status', $3)
        `,
        [documentId, actorId || null, comment]
      );
    }

    return result.rows[0] ? rowToDocument(result.rows[0]) : null;
  });
}

async function replaceApprovedChunks(documentId, versionNo, chunks) {
  return db.withTransaction(async client => {
    const documentResult = await client.query(
      "SELECT approval_status FROM documents WHERE id = $1",
      [documentId]
    );
    const document = documentResult.rows[0];

    if (!document) {
      throw new Error("Document not found.");
    }

    if (document.approval_status !== "Approved") {
      throw new Error("Only approved documents can be indexed.");
    }

    await client.query("DELETE FROM document_chunks WHERE document_id = $1", [documentId]);

    for (const [index, chunk] of chunks.entries()) {
      await client.query(
        `
          INSERT INTO document_chunks (document_id, version_no, chunk_no, chunk_text, term_vector)
          VALUES ($1, $2, $3, $4, $5::jsonb)
        `,
        [
          documentId,
          versionNo,
          index + 1,
          chunk.text,
          JSON.stringify(chunk.termVector || {})
        ]
      );
    }
  });
}

async function replaceRagVectorChunks(chunks, embeddingModel) {
  return db.withTransaction(async client => {
    await client.query(
      "DELETE FROM rag_vector_chunks WHERE embedding_model = $1",
      [embeddingModel]
    );

    for (const chunk of chunks) {
      if (!chunk.embedding || chunk.approvalStatus !== "Approved") {
        continue;
      }

      await client.query(
        `
          INSERT INTO rag_vector_chunks (
            external_document_id, document_name, department, owner_name,
            use_case, document_version, approval_status, reviewed_at,
            updated_at, chunk_no, chunk_text, content_hash, embedding_model,
            embedding, term_vector, metadata
          )
          VALUES (
            $1, $2, $3, $4,
            $5, $6, 'Approved', $7,
            $8, $9, $10, $11, $12,
            $13::vector, $14::jsonb, $15::jsonb
          )
          ON CONFLICT (external_document_id, document_version, chunk_no, embedding_model)
          DO UPDATE SET
            document_name = EXCLUDED.document_name,
            department = EXCLUDED.department,
            owner_name = EXCLUDED.owner_name,
            use_case = EXCLUDED.use_case,
            approval_status = EXCLUDED.approval_status,
            reviewed_at = EXCLUDED.reviewed_at,
            updated_at = EXCLUDED.updated_at,
            chunk_text = EXCLUDED.chunk_text,
            content_hash = EXCLUDED.content_hash,
            embedding = EXCLUDED.embedding,
            term_vector = EXCLUDED.term_vector,
            metadata = EXCLUDED.metadata,
            created_at = now()
        `,
        [
          chunk.documentId,
          chunk.documentName,
          chunk.department,
          chunk.owner,
          chunk.useCase,
          chunk.version,
          chunk.reviewedAt || null,
          chunk.updatedAt || null,
          chunk.page,
          chunk.text,
          chunk.contentHash,
          embeddingModel,
          vectorLiteral(chunk.embedding),
          JSON.stringify(chunk.termVector || {}),
          JSON.stringify({
            sourcePage: chunk.page,
            sourceChunkId: chunk.id
          })
        ]
      );
    }
  });
}

async function searchRagVectorChunks({ embedding, embeddingModel, useCase = "All", limit = 5, threshold = 0.62 }) {
  const result = await db.query(
    `
      SELECT
        external_document_id,
        document_name,
        department,
        owner_name,
        use_case,
        document_version,
        approval_status,
        reviewed_at,
        updated_at,
        chunk_no,
        chunk_text,
        1 - (embedding <=> $1::vector) AS semantic_score
      FROM rag_vector_chunks
      WHERE embedding_model = $2
        AND ($3 = 'All' OR use_case = $3)
        AND 1 - (embedding <=> $1::vector) >= $5
      ORDER BY embedding <=> $1::vector
      LIMIT $4
    `,
    [
      vectorLiteral(embedding),
      embeddingModel,
      useCase,
      limit,
      threshold
    ]
  );

  return result.rows.map(row => ({
    id: `${row.external_document_id}-${row.chunk_no}`,
    documentId: row.external_document_id,
    documentName: row.document_name,
    department: row.department,
    owner: row.owner_name,
    useCase: row.use_case,
    version: row.document_version,
    approvalStatus: row.approval_status,
    reviewedAt: row.reviewed_at,
    updatedAt: row.updated_at,
    page: row.chunk_no,
    text: row.chunk_text,
    semanticScore: Number(row.semantic_score || 0),
    keywordScore: 0,
    matchedTerms: 0,
    score: Number(row.semantic_score || 0),
    retrievalMode: "pgvector"
  }));
}

module.exports = {
  createAuditLog,
  findUserByUsername,
  listDocuments,
  replaceApprovedChunks,
  replaceRagVectorChunks,
  searchRagVectorChunks,
  updateDocumentStatus,
  upsertUser
};
