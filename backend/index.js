require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pdfParse = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleGenAI } = require("@google/genai");
const config = require("./src/config");
const { comparePassword } = require("./src/security/passwords");
const objectStorage = require("./src/storage/objectStorage");
const ocrService = require("./src/ocr/ocrService");
const {
  buildContextPack,
  buildGroundedPrompt,
  confidenceFromSources,
  verifyAnswerGrounding
} = require("./src/rag/advancedRag");
const {
  analyzeQuery,
  buildRetrievalPlan,
  buildRetrievalStats,
  diversifyByMmr,
  scoreHybridCandidate
} = require("./src/rag/retrievalEngine");
const { buildApprovedChunkIndex, cosineSimilarity } = require("./src/vector/vectorIndex");
const vectorRepository = require("./src/repositories/postgresRepository");

const app = express();
app.use(express.json({ limit: "20mb" }));

const rateLimitBuckets = new Map();
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  "application/octet-stream"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = config.corsOrigin
    ? config.corsOrigin.split(",").map(item => item.trim()).filter(Boolean)
    : [];

  if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*");
  next();
});

function clientKey(req, scope) {
  return `${scope}:${req.ip || req.socket.remoteAddress || "unknown"}`;
}

function rateLimit(scope, maxRequests) {
  return (req, res, next) => {
    const now = Date.now();
    const key = clientKey(req, scope);
    const bucket = rateLimitBuckets.get(key) || {
      count: 0,
      resetAt: now + config.rateLimitWindowMs
    };

    if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + config.rateLimitWindowMs;
    }

    bucket.count += 1;
    rateLimitBuckets.set(key, bucket);

    res.setHeader("RateLimit-Limit", String(maxRequests));
    res.setHeader("RateLimit-Remaining", String(Math.max(maxRequests - bucket.count, 0)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > maxRequests) {
      return res.status(429).json({
        error: "Too many requests. Please retry shortly."
      });
    }

    next();
  };
}

const frontendDir = fs.existsSync(config.frontendDir)
  ? config.frontendDir
  : path.resolve(__dirname, "..", "frontend");

app.use(express.static(frontendDir));

const STORE_PATH = path.join(__dirname, "data", "knowledge-store.json");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_SECRET = process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD || "admin123";
const REVIEWER_USER = process.env.REVIEWER_USER || "reviewer";
const REVIEWER_SECRET = process.env.REVIEWER_PASSWORD_HASH || process.env.REVIEWER_PASSWORD || "reviewer123";
const VIEWER_USER = process.env.VIEWER_USER || "viewer";
const VIEWER_SECRET = process.env.VIEWER_PASSWORD_HASH || process.env.VIEWER_PASSWORD || "viewer123";
const sessions = new Map();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingAI = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
let geminiAvailable = process.env.ENABLE_GEMINI === "true" && Boolean(process.env.GEMINI_API_KEY);
let semanticRagAvailable = config.enableSemanticRag && Boolean(process.env.GEMINI_API_KEY);
let embeddingCache = {};

// Demo storage: seed docs come from data/*.txt, uploaded docs persist in data/knowledge-store.json.
let documents = [];
let chunkIndex = [];
let retrievalStats = buildRetrievalStats([]);
let auditLog = [];

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map(cookie => cookie.trim())
      .filter(Boolean)
      .map(cookie => {
        const index = cookie.indexOf("=");
        return [
          decodeURIComponent(cookie.slice(0, index)),
          decodeURIComponent(cookie.slice(index + 1))
        ];
      })
  );
}

function sessionCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `SameSite=${config.sessionCookieSameSite}`,
    "Path=/"
  ];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (config.sessionCookieSecure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  req.user = sessions.get(cookies.session) || null;
  next();
});

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(401).json({
      error: "Admin login required"
    });
  }

  next();
}

function requireReviewerOrAdmin(req, res, next) {
  if (!req.user || !["admin", "reviewer"].includes(req.user.role)) {
    return res.status(401).json({
      error: "Reviewer or admin login required"
    });
  }

  next();
}

async function authenticateLocalUser(username, password) {
  const candidates = [
    { username: ADMIN_USER, secret: ADMIN_SECRET, role: "admin" },
    { username: REVIEWER_USER, secret: REVIEWER_SECRET, role: "reviewer" },
    { username: VIEWER_USER, secret: VIEWER_SECRET, role: "viewer" }
  ];

  for (const candidate of candidates) {
    if (username === candidate.username && await comparePassword(password, candidate.secret)) {
      return {
        username: candidate.username,
        role: candidate.role
      };
    }
  }

  return null;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "can",
  "do", "does", "for", "from", "how", "if", "in", "is", "it", "of", "on",
  "or", "per", "the", "their", "to", "up", "what", "when", "where", "which",
  "who", "why", "with", "year", "employee", "employees", "company", "policy", "code"
]);

const SYNONYMS = {
  timing: ["hours", "working"],
  time: ["hours"],
  timings: ["hours", "working"],
  remote: ["remotely", "work"],
  wfh: ["remote", "remotely", "work"],
  leave: ["leaves"],
  leaves: ["leave"],
  salary: ["revision"],
  appraisal: ["review", "performance"],
  appraisals: ["review", "performance"],
  holiday: ["holidays"],
  holidays: ["holiday"],
  late: ["login"],
  device: ["devices"],
  devices: ["device"],
  issue: ["issues"],
  issues: ["issue"],
  sla: ["response", "resolution"]
};

const DOCUMENT_METADATA = {
  "doc.txt": {
    name: "Solvagence Employee Handbook.txt",
    department: "Human Resources",
    version: "v2.1",
    owner: "People Operations",
    reviewedAt: "2026-04-10",
    approvalStatus: "Approved",
    useCase: "HR Assistant"
  },
  "it-security-policy.txt": {
    name: "Solvagence Data Security & NDA Policy.txt",
    department: "Information Technology",
    version: "v1.4",
    owner: "Security Office",
    reviewedAt: "2026-04-12",
    approvalStatus: "Approved",
    useCase: "Support Assistant"
  },
  "expense-policy.txt": {
    name: "Solvagence Expense Reimbursement Policy.txt",
    department: "Finance",
    version: "v1.2",
    owner: "Finance Operations",
    reviewedAt: "2026-04-09",
    approvalStatus: "Approved",
    useCase: "HR Assistant"
  },
  "code-of-conduct.txt": {
    name: "Solvagence Code of Conduct.txt",
    department: "Legal",
    version: "v1.3",
    owner: "Legal & Compliance",
    reviewedAt: "2026-04-11",
    approvalStatus: "Approved",
    useCase: "HR Assistant"
  },
  "client-delivery-sop.txt": {
    name: "Solvagence Client Delivery SOP.txt",
    department: "Client Delivery",
    version: "v1.6",
    owner: "Delivery Excellence",
    reviewedAt: "2026-04-18",
    approvalStatus: "Approved",
    useCase: "Client Delivery Assistant"
  },
  "lead-qualification-playbook.txt": {
    name: "Solvagence Lead Qualification Playbook.txt",
    department: "Sales",
    version: "v1.5",
    owner: "Revenue Operations",
    reviewedAt: "2026-04-15",
    approvalStatus: "Approved",
    useCase: "Sales Assistant"
  },
  "project-escalation-matrix.txt": {
    name: "Solvagence Project Escalation Matrix.txt",
    department: "Project Management",
    version: "v1.3",
    owner: "PMO",
    reviewedAt: "2026-04-16",
    approvalStatus: "Approved",
    useCase: "Client Delivery Assistant"
  },
  "support-sla-policy.txt": {
    name: "Solvagence Support SLA Policy.txt",
    department: "Support",
    version: "v1.7",
    owner: "Support Operations",
    reviewedAt: "2026-04-19",
    approvalStatus: "Approved",
    useCase: "Support Assistant"
  }
};

function tokenize(text) {
  const normalized = text
    .toLowerCase()
    .replace(/\bp\s*1\b/g, "priority1")
    .replace(/\bp\s*2\b/g, "priority2")
    .replace(/\bp\s*3\b/g, "priority3")
    .replace(/\bpriority\s+1\b/g, "priority1")
    .replace(/\bpriority\s+2\b/g, "priority2")
    .replace(/\bpriority\s+3\b/g, "priority3");

  const tokens = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(token => token && !STOP_WORDS.has(token));

  const expanded = [];
  for (const token of tokens) {
    expanded.push(token);
    if (SYNONYMS[token]) {
      expanded.push(...SYNONYMS[token]);
    }
  }

  return expanded;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

function tokenMatches(queryToken, chunkToken) {
  if (queryToken === chunkToken) {
    return true;
  }

  if (queryToken.length >= 5 && chunkToken.length >= 5) {
    return editDistance(queryToken, chunkToken) <= 1;
  }

  return false;
}

function extractEntityTerms(text) {
  return (text.match(/\b[A-Z][A-Za-z0-9]{3,}\b/g) || [])
    .map(term => tokenize(term)[0])
    .filter(Boolean)
    .filter(term => !STOP_WORDS.has(term));
}

function splitIntoSearchableChunks(content) {
  const normalized = content
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  const blocks = normalized
    .split(/\n{2,}|\n/)
    .map(block => block.trim())
    .filter(Boolean);

  const chunks = [];

  for (const block of blocks) {
    if (block.length <= 420) {
      chunks.push(block);
      continue;
    }

    const sentences = block
      .split(/(?<=[.!?])\s+/)
      .map(sentence => sentence.trim())
      .filter(Boolean);

    let current = "";
    for (const sentence of sentences) {
      if ((current + " " + sentence).trim().length > 420 && current) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current = `${current} ${sentence}`.trim();
      }
    }

    if (current) {
      chunks.push(current.trim());
    }
  }

  return chunks;
}

function classifyEvidence(text = "") {
  const lower = text.toLowerCase();

  if (/\b(priority|sla|response|resolution|incident)\b/.test(lower)) return "sla";
  if (/\b(escalat|risk|blocker|breach)\b/.test(lower)) return "escalation";
  if (/\b(approve|approval|required|must|prohibited|mandatory)\b/.test(lower)) return "policy-control";
  if (/\b(within|every|before|after|days|hours|deadline|cutoff)\b/.test(lower)) return "timeline";
  if (/\b(manager|owner|team|head|sponsor|responsible)\b/.test(lower)) return "ownership";
  return "general";
}

function chunkDocument(document) {
  return splitIntoSearchableChunks(document.content)
    .map((text, index) => ({
      id: `${document.id}-${index + 1}`,
      documentId: document.id,
      documentName: document.name,
      department: document.department,
      version: document.version,
      updatedAt: document.updatedAt,
      owner: document.owner,
      reviewedAt: document.reviewedAt,
      approvalStatus: document.approvalStatus,
      useCase: document.useCase,
      page: index + 1,
      text,
      evidenceType: classifyEvidence(text),
      contentHash: crypto.createHash("sha256").update(`${document.id}:${document.version}:${index + 1}:${text}`).digest("hex"),
      tokens: tokenize(text)
    }));
}

function loadEmbeddingCache() {
  if (!fs.existsSync(config.embeddingCachePath)) {
    embeddingCache = {};
    return;
  }

  try {
    const raw = fs.readFileSync(config.embeddingCachePath, "utf-8");
    embeddingCache = JSON.parse(raw);
  } catch (err) {
    console.error("Could not load embedding cache:", err.message);
    embeddingCache = {};
  }
}

function saveEmbeddingCache() {
  if (!semanticRagAvailable) {
    return;
  }

  fs.mkdirSync(path.dirname(config.embeddingCachePath), { recursive: true });
  fs.writeFileSync(config.embeddingCachePath, JSON.stringify(embeddingCache, null, 2));
}

function embeddingCacheKey(type, text, title = "") {
  return crypto
    .createHash("sha256")
    .update(`${config.embeddingModel}:${type}:${title}:${text}`)
    .digest("hex");
}

async function embedText(text, taskType, title = "") {
  if (!semanticRagAvailable || !text.trim()) {
    return null;
  }

  const key = embeddingCacheKey(taskType, text, title);
  if (embeddingCache[key]) {
    return embeddingCache[key];
  }

  try {
    if (!embeddingAI) {
      throw new Error("GEMINI_API_KEY is required for semantic RAG.");
    }

    const result = await withTimeout(embeddingAI.models.embedContent({
      model: config.embeddingModel,
      contents: text,
      taskType
    }), 10000);

    const firstEmbedding = Array.isArray(result.embeddings)
      ? result.embeddings[0]
      : result.embedding;
    const values = firstEmbedding && firstEmbedding.values;
    if (!Array.isArray(values) || !values.length) {
      throw new Error("Embedding response did not include values.");
    }

    embeddingCache[key] = values;
    return values;
  } catch (err) {
    semanticRagAvailable = false;
    console.error(`Semantic RAG disabled after embedding failure (${config.embeddingModel}):`, err.message);
    return null;
  }
}

async function hydrateChunkEmbeddings(chunks) {
  if (!semanticRagAvailable) {
    return chunks;
  }

  for (const chunk of chunks) {
    chunk.embedding = await embedText(
      chunk.text,
      "RETRIEVAL_DOCUMENT",
      chunk.documentName
    );
  }

  saveEmbeddingCache();
  return chunks;
}

async function rebuildIndex() {
  chunkIndex = buildApprovedChunkIndex(documents, chunkDocument);
  retrievalStats = buildRetrievalStats(chunkIndex);
  await hydrateChunkEmbeddings(chunkIndex);

  if (config.enableVectorDb && semanticRagAvailable) {
    try {
      await vectorRepository.replaceRagVectorChunks(chunkIndex, config.embeddingModel);
      console.log(`Vector DB indexed ${chunkIndex.filter(chunk => chunk.embedding).length} approved chunks`);
    } catch (err) {
      console.error("Vector DB indexing failed, using in-process retrieval:", err.message);
    }
  }
}

function loadStoredDocuments() {
  if (!fs.existsSync(STORE_PATH)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.documents) ? parsed.documents : [];
  } catch (err) {
    console.error("Could not load persisted knowledge store:", err.message);
    return [];
  }
}

function saveStoredDocuments() {
  const uploadedDocuments = documents.filter(document => document.source === "uploaded");
  fs.writeFileSync(STORE_PATH, JSON.stringify({ documents: uploadedDocuments }, null, 2));
}

function createVersionSnapshot(document, actor, note) {
  document.versions = document.versions || [];
  document.versions.unshift({
    versionId: `${Date.now()}-${document.versions.length + 1}`,
    name: document.name,
    department: document.department,
    owner: document.owner,
    useCase: document.useCase,
    approvalStatus: document.approvalStatus,
    content: document.content,
    createdAt: new Date().toISOString(),
    actor: actor || "system",
    note: note || "Document changed"
  });
}

function addDocumentComment(document, actor, role, comment, type = "review") {
  document.comments = document.comments || [];
  document.comments.unshift({
    id: `${Date.now()}-${document.comments.length + 1}`,
    actor: actor || "system",
    role: role || "system",
    comment,
    type,
    createdAt: new Date().toISOString()
  });
}

// STEP 1: Load approved knowledge base
async function setup() {
  const dataDir = path.join(__dirname, "data");
  loadEmbeddingCache();

  documents = fs
    .readdirSync(dataDir)
    .filter(file => file.endsWith(".txt"))
    .sort()
    .map(file => {
      const metadata = DOCUMENT_METADATA[file] || {
        name: file,
        department: "General",
        version: "v1.0",
        owner: "Knowledge Admin",
        reviewedAt: "2026-04-28",
        approvalStatus: "Approved",
        useCase: "General Assistant"
      };

      return {
        id: file.replace(/\.txt$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
        fileName: file,
        name: metadata.name,
        department: metadata.department,
        version: metadata.version,
        owner: metadata.owner,
        reviewedAt: metadata.reviewedAt,
        approvalStatus: metadata.approvalStatus,
        useCase: metadata.useCase,
        source: "seed",
        comments: [],
        versions: [],
        updatedAt: "2026-04-28",
        content: fs.readFileSync(path.join(dataDir, file), "utf-8")
      };
    });

  documents.push(...loadStoredDocuments());
  await rebuildIndex();

  console.log(`Knowledge base loaded with ${documents.length} document(s) and ${chunkIndex.length} searchable chunks`);
  console.log(`Retrieval mode: ${publicMetrics().retrievalMode}`);
}

function scoreChunkByKeywords(chunk, queryTerms) {
  let score = 0;
  const matchedTerms = new Set();

  for (const queryToken of queryTerms) {
    for (const chunkToken of chunk.tokens) {
      if (tokenMatches(queryToken, chunkToken)) {
        matchedTerms.add(queryToken);
        score += queryToken === chunkToken ? 2 : 1;
        break;
      }
    }
  }

  score += matchedTerms.size * 2;

  return {
    keywordScore: score,
    matchedTerms: matchedTerms.size
  };
}

function passesRetrievalGuards(result, queryTerms, entityTerms) {
  const minimumMatches = queryTerms.size === 1 ? 1 : 2;

  for (const entityTerm of entityTerms) {
    const hasEntity = result.tokens.some(token => tokenMatches(entityTerm, token));
    if (!hasEntity) {
      return false;
    }
  }

  for (const priority of ["priority1", "priority2", "priority3"]) {
    if (queryTerms.has(priority) && !result.tokens.includes(priority)) {
      return false;
    }
  }

  if (result.semanticScore >= config.semanticSimilarityThreshold) {
    return true;
  }

  return result.matchedTerms >= minimumMatches && result.keywordScore >= minimumMatches * 3;
}

// STEP 2: Hybrid semantic + deterministic retrieval
async function retrieveRelevantChunks(question, limit = 3, useCase = "All") {
  const query = analyzeQuery(question, tokenize, extractEntityTerms);
  const queryTerms = query.queryTerms;
  const entityTerms = query.entityTerms;

  if (queryTerms.size === 0) {
    return [];
  }

  const searchableChunks = useCase && useCase !== "All"
    ? chunkIndex.filter(chunk => chunk.useCase === useCase)
    : chunkIndex;

  const queryEmbedding = semanticRagAvailable
    ? await embedText(question, "QUESTION_ANSWERING")
    : null;

  const retrievalMode = config.enableVectorDb && queryEmbedding
    ? "pgvector-hybrid"
    : queryEmbedding ? "semantic-hybrid" : "keyword-bm25";
  const candidatePoolSize = Math.max(limit * 4, config.vectorDbTopK, config.retrievalCandidatePool);

  if (config.enableVectorDb && queryEmbedding) {
    try {
      const vectorResults = await vectorRepository.searchRagVectorChunks({
        embedding: queryEmbedding,
        embeddingModel: config.embeddingModel,
        useCase,
        limit: candidatePoolSize,
        threshold: config.semanticSimilarityThreshold
      });

      const rankedVectorResults = vectorResults
        .map(chunk => {
          const tokens = tokenize(chunk.text);
          const scored = scoreHybridCandidate({
            chunk: {
              ...chunk,
              tokens
            },
            query,
            stats: retrievalStats,
            semanticScore: chunk.semanticScore || 0,
            useCase,
            weights: {
              lexical: config.hybridKeywordWeight,
              semantic: config.hybridSemanticWeight,
              metadata: 0.12
            }
          });

          return {
            ...scored,
            tokens,
            retrievalMode: "pgvector-hybrid"
          };
        })
        .map(result => ({
          ...result,
          matchedTerms: scoreChunkByKeywords(result, queryTerms).matchedTerms
        }))
        .filter(result => passesRetrievalGuards(result, queryTerms, entityTerms))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidatePoolSize);

      if (rankedVectorResults.length) {
        const selected = diversifyByMmr(rankedVectorResults, limit);
        selected.retrievalPlan = buildRetrievalPlan({
          question,
          useCase,
          query,
          retrievalMode,
          candidateCount: rankedVectorResults.length,
          selectedCount: selected.length
        });
        return selected;
      }
    } catch (err) {
      console.error("Vector DB retrieval failed, using in-process retrieval:", err.message);
    }
  }

  const ranked = searchableChunks
    .map(chunk => {
      const semanticScore = queryEmbedding && chunk.embedding
        ? cosineSimilarity(queryEmbedding, chunk.embedding)
        : 0;
      const scored = scoreHybridCandidate({
        chunk,
        query,
        stats: retrievalStats,
        semanticScore,
        useCase,
        weights: {
          lexical: queryEmbedding ? config.hybridKeywordWeight : 0.82,
          semantic: queryEmbedding ? config.hybridSemanticWeight : 0,
          metadata: queryEmbedding ? 0.12 : 0.18
        }
      });
      const keyword = scoreChunkByKeywords(scored, queryTerms);

      return {
        ...scored,
        matchedTerms: keyword.matchedTerms,
        retrievalMode
      };
    })
    .filter(result => passesRetrievalGuards(result, queryTerms, entityTerms))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidatePoolSize);

  const selected = diversifyByMmr(ranked, limit);
  selected.retrievalPlan = buildRetrievalPlan({
    question,
    useCase,
    query,
    retrievalMode,
    candidateCount: ranked.length,
    selectedCount: selected.length
  });
  return selected;
}

function createExtractiveAnswer(question, relevantChunks) {
  const questionTokens = new Set(tokenize(question));

  if (questionTokens.size === 0 || relevantChunks.length === 0) {
    return "I don't know based on the document.";
  }

  const bestChunk = relevantChunks
    .map(source => {
      const chunkTerms = new Set(tokenize(source.text));
      let score = 0;

      for (const queryToken of questionTokens) {
        const matched = [...chunkTerms].some(chunkToken => tokenMatches(queryToken, chunkToken));
        if (matched) {
          score += 1;
        }
      }

      return { text: source.text, score, citationLabel: source.citationLabel };
    })
    .sort((a, b) => b.score - a.score)[0];

  return bestChunk && bestChunk.score > 0
    ? `${bestChunk.text}${bestChunk.citationLabel ? ` [${bestChunk.citationLabel}]` : ""}`
    : "I don't know based on the document.";
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function publicDocuments(includeContent = false) {
  return documents.map(document => {
    const publicDocument = {
    id: document.id,
    name: document.name,
    department: document.department,
    version: document.version,
    owner: document.owner,
    reviewedAt: document.reviewedAt,
    approvalStatus: document.approvalStatus,
    useCase: document.useCase,
    source: document.source,
    searchable: document.approvalStatus === "Approved",
    updatedAt: document.updatedAt,
    chunks: chunkDocument(document).length,
    characters: document.content.length,
    originalObject: document.originalObject || null,
    ocrStatus: document.ocrStatus || "not_required",
    comments: document.comments || [],
    versionCount: (document.versions || []).length
    };

    if (includeContent) {
      publicDocument.content = document.content;
      publicDocument.versions = document.versions || [];
    }

    return publicDocument;
  });
}

function publicSources(sources) {
  return sources.map(source => ({
    citationLabel: source.citationLabel,
    documentId: source.documentId,
    documentName: source.documentName,
    department: source.department,
    version: source.version,
    owner: source.owner,
    reviewedAt: source.reviewedAt,
    approvalStatus: source.approvalStatus,
    useCase: source.useCase,
    evidenceType: source.evidenceType || "general",
    updatedAt: source.updatedAt,
    page: source.page,
    text: source.text,
    score: source.score,
    bm25Score: source.bm25Score || 0,
    semanticScore: source.semanticScore || 0,
    keywordScore: source.keywordScore || 0,
    exactBoost: source.exactBoost || 0,
    metadataBoost: source.metadataBoost || 0,
    mmrScore: source.mmrScore || 0,
    retrievalMode: source.retrievalMode || "keyword-bm25"
  }));
}

function publicMetrics() {
  const citedResponses = auditLog.filter(entry => entry.source && entry.source !== "None").length;

  return {
    documents: documents.length,
    chunks: chunkIndex.length,
    approvedDocuments: documents.filter(document => document.approvalStatus === "Approved").length,
    citedResponses,
    refusedQuestions: auditLog.filter(entry => entry.status === "No source found").length,
    citationRate: auditLog.length ? Math.round((citedResponses / auditLog.length) * 100) : 100,
    hallucinatedAnswers: 0,
    answeredQuestions: auditLog.filter(entry => entry.status === "Answered from approved source").length,
    retrievalMode: config.enableVectorDb && semanticRagAvailable
      ? "pgvector-hybrid"
      : semanticRagAvailable ? "semantic-hybrid" : "keyword-bm25",
    vectorDbEnabled: config.enableVectorDb
  };
}

app.post("/auth/login", rateLimit("auth", config.authRateLimit), async (req, res) => {
  const { username, password } = req.body;
  const user = await authenticateLocalUser(username, password);

  if (!user) {
    return res.status(401).json({
      error: "Invalid credentials"
    });
  }

  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    username: user.username,
    role: user.role,
    createdAt: new Date().toISOString()
  });

  res.setHeader("Set-Cookie", sessionCookie("session", token, { maxAge: 28800 }));
  res.json({
    user: {
      username: user.username,
      role: user.role
    }
  });
});

app.post("/auth/logout", rateLimit("auth", config.authRateLimit), (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session) {
    sessions.delete(cookies.session);
  }

  res.setHeader("Set-Cookie", sessionCookie("session", "", { maxAge: 0 }));
  res.json({
    ok: true
  });
});

app.get("/auth/me", (req, res) => {
  res.json({
    user: req.user
      ? {
          username: req.user.username,
          role: req.user.role
        }
      : null
  });
});

app.get("/documents", (req, res) => {
  res.json({
    documents: publicDocuments(Boolean(req.user && req.user.role === "admin")),
    chunks: chunkIndex.length,
    metrics: publicMetrics()
  });
});

app.get("/metrics", (req, res) => {
  res.json(publicMetrics());
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    documents: documents.length,
    chunks: chunkIndex.length,
    frontendDir,
    storageProvider: config.objectStorageProvider,
    retrievalMode: publicMetrics().retrievalMode,
    vectorDbEnabled: config.enableVectorDb,
    semanticRagEnabled: semanticRagAvailable,
    generationEnabled: geminiAvailable,
    embeddingModel: config.embeddingModel,
    generationModel: GEMINI_MODEL,
    retrievalCandidatePool: config.retrievalCandidatePool,
    contextMaxCharacters: config.contextMaxCharacters
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    name: "Solvagence KnowledgeOps API",
    architecture: "separate-frontend-backend",
    retrieval: publicMetrics().retrievalMode,
    documents: documents.length,
    chunks: chunkIndex.length,
    features: {
      geminiGeneration: geminiAvailable,
      semanticRag: semanticRagAvailable,
      vectorDb: config.enableVectorDb,
      objectStorage: config.objectStorageProvider,
      ocr: config.ocrEnabled
    },
    rag: {
      candidatePool: config.retrievalCandidatePool,
      contextMaxCharacters: config.contextMaxCharacters,
      semanticThreshold: config.semanticSimilarityThreshold,
      hybridWeights: {
        semantic: config.hybridSemanticWeight,
        keyword: config.hybridKeywordWeight
      }
    }
  });
});

app.get(["/rag", "/rag/*"], (req, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

app.post("/documents", rateLimit("documents-write", config.authRateLimit), requireReviewerOrAdmin, async (req, res) => {
  const {
    name,
    content,
    fileBase64,
    mimeType,
    department,
    version,
    owner,
    useCase
  } = req.body;

  if (!name || (!content && !fileBase64)) {
    return res.status(400).json({
      error: "Document name and content are required"
    });
  }

  if (mimeType && !ALLOWED_UPLOAD_MIME_TYPES.has(mimeType) && !/^image\//.test(mimeType)) {
    return res.status(400).json({
      error: "Unsupported document type"
    });
  }

  if (fileBase64 && Buffer.byteLength(fileBase64, "base64") > config.maxUploadBytes) {
    return res.status(413).json({
      error: `Uploaded file exceeds ${config.maxUploadBytes} bytes`
    });
  }

  if (content && content.length > config.maxDocumentCharacters) {
    return res.status(413).json({
      error: `Document content exceeds ${config.maxDocumentCharacters} characters`
    });
  }

  let documentContent = content || "";
  let objectInfo = null;
  let ocrStatus = "not_required";

  if (fileBase64) {
    const buffer = Buffer.from(fileBase64, "base64");
    const isPdf = mimeType === "application/pdf" || name.toLowerCase().endsWith(".pdf");
    const isImage = /^image\//.test(mimeType || "");
    objectInfo = await objectStorage.putObject(buffer, {
      fileName: name,
      mimeType
    });

    if (isPdf) {
      try {
        const parsed = await pdfParse(buffer);
        documentContent = parsed.text;
      } catch (err) {
        documentContent = "";
      }
    } else if (isImage) {
      documentContent = "";
    } else {
      documentContent = buffer.toString("utf-8");
    }

    if (!documentContent.trim()) {
      const ocrResult = await ocrService.extractText({
        buffer,
        mimeType,
        fileName: name
      });
      documentContent = ocrResult.text || "";
      ocrStatus = ocrResult.status;
    }
  }

  if (!documentContent.trim()) {
    return res.status(400).json({
      error: "No readable text found in document"
    });
  }

  if (documentContent.length > config.maxDocumentCharacters) {
    return res.status(413).json({
      error: `Extracted document text exceeds ${config.maxDocumentCharacters} characters`
    });
  }

  const document = {
    id: `${Date.now()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    name,
    department: department || "General",
    version: version || "v1.0",
    owner: owner || "Knowledge Admin",
    reviewedAt: new Date().toISOString().slice(0, 10),
    approvalStatus: "Draft",
    useCase: useCase || "General Assistant",
    source: "uploaded",
    originalObject: objectInfo,
    ocrStatus,
    comments: [],
    versions: [],
    updatedAt: new Date().toISOString().slice(0, 10),
    content: documentContent
  };

  addDocumentComment(
    document,
    owner || "Knowledge Admin",
    "uploader",
    "Document uploaded as Draft.",
    "upload"
  );

  documents.push(document);
  saveStoredDocuments();
  await rebuildIndex();

  res.status(201).json({
    document: publicDocuments().find(item => item.id === document.id),
    chunks: chunkIndex.length,
    extractedCharacters: documentContent.length
  });
});

app.patch("/documents/:id/status", rateLimit("documents-write", config.authRateLimit), requireAdmin, async (req, res) => {
  const { status, comment } = req.body;
  const allowedStatuses = new Set(["Draft", "In Review", "Approved", "Archived"]);

  if (!allowedStatuses.has(status)) {
    return res.status(400).json({
      error: "Status must be Draft, In Review, Approved, or Archived"
    });
  }

  const document = documents.find(item => item.id === req.params.id);

  if (!document) {
    return res.status(404).json({
      error: "Document not found"
    });
  }

  if (document.source !== "uploaded") {
    return res.status(403).json({
      error: "Seed documents are managed by the approved repository"
    });
  }

  createVersionSnapshot(
    document,
    req.user.username,
    `Status changed from ${document.approvalStatus} to ${status}`
  );

  document.approvalStatus = status;
  document.reviewedAt = new Date().toISOString().slice(0, 10);
  document.updatedAt = new Date().toISOString().slice(0, 10);
  addDocumentComment(
    document,
    req.user.username,
    req.user.role,
    comment || `Status changed to ${status}.`,
    "status"
  );

  saveStoredDocuments();
  await rebuildIndex();

  res.json({
    document: publicDocuments(true).find(item => item.id === document.id),
    metrics: publicMetrics()
  });
});

app.post("/documents/:id/comments", rateLimit("documents-write", config.authRateLimit), requireReviewerOrAdmin, (req, res) => {
  const { comment } = req.body;
  const document = documents.find(item => item.id === req.params.id);

  if (!document) {
    return res.status(404).json({
      error: "Document not found"
    });
  }

  if (!comment || !comment.trim()) {
    return res.status(400).json({
      error: "Comment is required"
    });
  }

  addDocumentComment(document, req.user.username, req.user.role, comment.trim());

  if (document.source === "uploaded") {
    saveStoredDocuments();
  }

  res.json({
    document: publicDocuments(true).find(item => item.id === document.id)
  });
});

app.get("/documents/:id/versions", requireReviewerOrAdmin, (req, res) => {
  const document = documents.find(item => item.id === req.params.id);

  if (!document) {
    return res.status(404).json({
      error: "Document not found"
    });
  }

  res.json({
    versions: document.versions || []
  });
});

app.put("/documents/:id", rateLimit("documents-write", config.authRateLimit), requireAdmin, async (req, res) => {
  const document = documents.find(item => item.id === req.params.id);

  if (!document) {
    return res.status(404).json({
      error: "Document not found"
    });
  }

  const {
    name,
    department,
    version,
    owner,
    useCase,
    content
  } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({
      error: "Document content is required"
    });
  }

  createVersionSnapshot(document, req.user.username, "Content or metadata edited");

  document.name = name || document.name;
  document.department = department || document.department;
  document.version = version || document.version;
  document.owner = owner || document.owner;
  document.useCase = useCase || document.useCase;
  document.content = content;
  document.approvalStatus = "Draft";
  document.updatedAt = new Date().toISOString().slice(0, 10);

  if (document.source === "seed" && document.fileName) {
    fs.writeFileSync(path.join(__dirname, "data", document.fileName), content);
  } else {
    saveStoredDocuments();
  }

  addDocumentComment(
    document,
    req.user.username,
    req.user.role,
    "Document content or metadata updated. Approval reset to Draft.",
    "edit"
  );

  await rebuildIndex();

  res.json({
    document: publicDocuments(true).find(item => item.id === document.id),
    metrics: publicMetrics()
  });
});

app.delete("/documents/:id", rateLimit("documents-write", config.authRateLimit), requireAdmin, async (req, res) => {
  const document = documents.find(item => item.id === req.params.id);

  if (!document) {
    return res.status(404).json({
      error: "Document not found"
    });
  }

  if (document.source !== "uploaded") {
    return res.status(403).json({
      error: "Seed documents cannot be deleted from the demo UI. Archive or edit uploaded assets instead."
    });
  }

  documents = documents.filter(item => item.id !== req.params.id);
  saveStoredDocuments();
  await rebuildIndex();

  res.json({
    ok: true,
    metrics: publicMetrics()
  });
});

app.post("/documents/:id/restore/:versionId", rateLimit("documents-write", config.authRateLimit), requireAdmin, async (req, res) => {
  const document = documents.find(item => item.id === req.params.id);

  if (!document) {
    return res.status(404).json({
      error: "Document not found"
    });
  }

  const version = (document.versions || []).find(item => item.versionId === req.params.versionId);

  if (!version) {
    return res.status(404).json({
      error: "Version not found"
    });
  }

  createVersionSnapshot(document, req.user.username, "Before version restore");
  document.name = version.name;
  document.department = version.department;
  document.owner = version.owner;
  document.useCase = version.useCase;
  document.approvalStatus = "Draft";
  document.content = version.content;
  document.updatedAt = new Date().toISOString().slice(0, 10);
  document.reviewedAt = new Date().toISOString().slice(0, 10);
  addDocumentComment(document, req.user.username, req.user.role, "Restored a previous version as Draft.", "restore");

  if (document.source === "seed" && document.fileName) {
    fs.writeFileSync(path.join(__dirname, "data", document.fileName), document.content);
  } else {
    saveStoredDocuments();
  }

  await rebuildIndex();

  res.json({
    document: publicDocuments(true).find(item => item.id === document.id),
    metrics: publicMetrics()
  });
});

app.get("/audit", (req, res) => {
  res.json({
    entries: auditLog.slice(0, 25)
  });
});

app.get("/audit/export", requireAdmin, (req, res) => {
  const header = "createdAt,user,userDepartment,useCase,status,source,question,answer";
  const rows = auditLog.map(entry => [
    entry.createdAt,
    entry.user,
    entry.userDepartment,
    entry.useCase,
    entry.status,
    entry.source,
    entry.question,
    entry.answer
  ].map(value => `"${String(value || "").replace(/"/g, '""')}"`).join(","));

  res.type("text/csv").send([header, ...rows].join("\n"));
});

app.post("/admin/reindex", rateLimit("admin-write", config.authRateLimit), requireAdmin, async (req, res) => {
  await rebuildIndex();

  res.json({
    message: "Knowledge base re-indexed",
    metrics: publicMetrics()
  });
});

// STEP 3: API
app.post("/ask", rateLimit("ask", config.askRateLimit), async (req, res) => {
  try {
    const {
      question,
      useCase = "All",
      user = "HR Operations Demo User",
      userDepartment = "Human Resources"
    } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question is required"
      });
    }

    const relevantChunks = await retrieveRelevantChunks(question, 5, useCase);
    const contextPack = buildContextPack(relevantChunks, {
      maxCharacters: config.contextMaxCharacters
    });
    const sources = publicSources(contextPack.selected);
    const context = contextPack.context;
    const retrievalPlan = relevantChunks.retrievalPlan || null;

    // No context fallback
    if (!context.trim()) {
      auditLog.unshift({
        user,
        userDepartment,
        useCase,
        question,
        answer: "I don't know based on the document.",
        status: "No source found",
        source: "None",
        createdAt: new Date().toISOString()
      });

      return res.json({
        answer: "I don't know based on the document.",
        sources: [],
        confidence: "none",
        retrievalTrace: [],
        retrievalPlan
      });
    }

    let answer = createExtractiveAnswer(question, contextPack.selected);

    if (geminiAvailable) {
      try {
        const model = genAI.getGenerativeModel({
          model: GEMINI_MODEL
        });

        const prompt = buildGroundedPrompt({ context, question });

        const result = await withTimeout(model.generateContent(prompt), 10000);

        if (result && result.response) {
          const text = result.response.text();
          if (text && text.trim()) {
            answer = text.trim();
          }
        }
      } catch (err) {
        geminiAvailable = false;
        console.error(`Gemini generation disabled after failure (${GEMINI_MODEL}):`, err.message);
      }
    }

    const grounding = verifyAnswerGrounding(answer, sources);
    if (answer !== "I don't know based on the document." && !grounding.grounded) {
      answer = "I don't know based on the document.";
    }

    const status = answer === "I don't know based on the document."
      ? "No approved answer"
      : "Answered from approved source";

    auditLog.unshift({
      user,
      userDepartment,
      useCase,
      question,
      answer,
      status,
      source: sources[0] ? sources[0].documentName : "None",
      createdAt: new Date().toISOString()
    });

    res.json({
      answer,
      sources,
      status,
      useCase,
      confidence: confidenceFromSources(relevantChunks),
      retrievalTrace: contextPack.retrievalTrace,
      retrievalPlan,
      grounding,
      contextTokens: contextPack.estimatedTokens
    });

  } catch (err) {
    console.error("❌ API Error:", err.message);

    res.status(500).json({
      error: err.message || "Internal Server Error"
    });
  }
});

function startServer() {
  const port = config.port;
  const host = config.host;

  const server = app.listen(port, host, () => {
    console.log(`Server running at http://${host}:${port}`);
  });

  server.on("error", err => {
    console.error("Server failed to start:", err.message);
    process.exit(1);
  });
}

const ready = setup();

if (require.main === module) {
  ready
    .then(startServer)
    .catch(err => {
      console.error("Startup failed:", err.message);
      process.exit(1);
    });
}

module.exports = {
  app,
  ready,
  startServer,
  retrieveRelevantChunks,
  createExtractiveAnswer,
  publicDocuments
};
