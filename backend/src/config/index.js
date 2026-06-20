const path = require("path");

const rootDir = path.resolve(__dirname, "..", "..");

const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "127.0.0.1",
  frontendDir: process.env.FRONTEND_DIR || path.resolve(rootDir, "..", "frontend"),
  corsOrigin: process.env.CORS_ORIGIN || "",
  enableSemanticRag: process.env.ENABLE_SEMANTIC_RAG === "true",
  enableVectorDb: process.env.ENABLE_VECTOR_DB === "true",
  embeddingModel: process.env.EMBEDDING_MODEL || "gemini-embedding-001",
  embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS || 3072),
  embeddingCachePath: process.env.EMBEDDING_CACHE_PATH || path.join(rootDir, "data", "embedding-cache.json"),
  vectorDbTopK: Number(process.env.VECTOR_DB_TOP_K || 5),
  retrievalCandidatePool: Number(process.env.RETRIEVAL_CANDIDATE_POOL || 16),
  contextMaxCharacters: Number(process.env.CONTEXT_MAX_CHARACTERS || 5200),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  maxDocumentCharacters: Number(process.env.MAX_DOCUMENT_CHARACTERS || 250000),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  askRateLimit: Number(process.env.ASK_RATE_LIMIT || 30),
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT || 20),
  semanticSimilarityThreshold: Number(process.env.SEMANTIC_SIMILARITY_THRESHOLD || 0.62),
  hybridKeywordWeight: Number(process.env.HYBRID_KEYWORD_WEIGHT || 0.35),
  hybridSemanticWeight: Number(process.env.HYBRID_SEMANTIC_WEIGHT || 0.65),
  databaseUrl: process.env.DATABASE_URL || "",
  enablePostgres: process.env.ENABLE_POSTGRES === "true",
  awsRegion: process.env.AWS_REGION || "us-east-1",
  objectStorageProvider: process.env.OBJECT_STORAGE_PROVIDER || "local",
  s3Bucket: process.env.S3_BUCKET || "",
  s3Prefix: process.env.S3_PREFIX || "rag-demo/originals",
  objectStorageDir: process.env.OBJECT_STORAGE_DIR || path.join(rootDir, "storage", "objects"),
  ocrEnabled: process.env.OCR_ENABLED === "true",
  tesseractBin: process.env.TESSERACT_BIN || "tesseract",
  sessionCookieSameSite: process.env.SESSION_COOKIE_SAMESITE || "Lax",
  sessionCookieSecure: process.env.SESSION_COOKIE_SECURE === "true",
  roles: {
    admin: "admin",
    reviewer: "reviewer",
    viewer: "viewer"
  }
};

module.exports = config;
