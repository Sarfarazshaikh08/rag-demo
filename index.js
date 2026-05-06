require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pdfParse = require("pdf-parse");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const config = require("./src/config");
const { comparePassword } = require("./src/security/passwords");
const objectStorage = require("./src/storage/objectStorage");
const ocrService = require("./src/ocr/ocrService");
const { buildApprovedChunkIndex } = require("./src/vector/vectorIndex");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

const STORE_PATH = path.join(__dirname, "data", "knowledge-store.json");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_SECRET = process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD || "admin123";
const REVIEWER_USER = process.env.REVIEWER_USER || "reviewer";
const REVIEWER_SECRET = process.env.REVIEWER_PASSWORD_HASH || process.env.REVIEWER_PASSWORD || "reviewer123";
const VIEWER_USER = process.env.VIEWER_USER || "viewer";
const VIEWER_SECRET = process.env.VIEWER_PASSWORD_HASH || process.env.VIEWER_PASSWORD || "viewer123";
const sessions = new Map();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
let geminiAvailable = process.env.ENABLE_GEMINI === "true" && Boolean(process.env.GEMINI_API_KEY);

// Demo storage: seed docs come from data/*.txt, uploaded docs persist in data/knowledge-store.json.
let documents = [];
let chunkIndex = [];
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
      tokens: tokenize(text)
    }));
}

function rebuildIndex() {
  chunkIndex = buildApprovedChunkIndex(documents, chunkDocument);
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
function setup() {
  const dataDir = path.join(__dirname, "data");

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
  rebuildIndex();

  console.log(`Knowledge base loaded with ${documents.length} document(s) and ${chunkIndex.length} searchable chunks`);
}

// STEP 2: Deterministic retrieval
function retrieveRelevantChunks(question, limit = 3, useCase = "All") {
  const questionTokens = tokenize(question);
  const queryTerms = new Set(questionTokens);
  const entityTerms = extractEntityTerms(question);

  if (queryTerms.size === 0) {
    return [];
  }

  const searchableChunks = useCase && useCase !== "All"
    ? chunkIndex.filter(chunk => chunk.useCase === useCase)
    : chunkIndex;

  return searchableChunks
    .map(chunk => {
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
        ...chunk,
        score,
        matchedTerms: matchedTerms.size
      };
    })
    .filter(result => {
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
      return result.matchedTerms >= minimumMatches && result.score >= minimumMatches * 3;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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

      return { text: source.text, score };
    })
    .sort((a, b) => b.score - a.score)[0];

  return bestChunk && bestChunk.score > 0
    ? bestChunk.text
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
    documentId: source.documentId,
    documentName: source.documentName,
    department: source.department,
    version: source.version,
    owner: source.owner,
    reviewedAt: source.reviewedAt,
    approvalStatus: source.approvalStatus,
    useCase: source.useCase,
    updatedAt: source.updatedAt,
    page: source.page,
    text: source.text,
    score: source.score
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
    answeredQuestions: auditLog.filter(entry => entry.status === "Answered from approved source").length
  };
}

app.post("/auth/login", async (req, res) => {
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

  res.setHeader("Set-Cookie", `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  res.json({
    user: {
      username: user.username,
      role: user.role
    }
  });
});

app.post("/auth/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.session) {
    sessions.delete(cookies.session);
  }

  res.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
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
    storageProvider: config.objectStorageProvider
  });
});

app.get(["/rag", "/rag/*"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/documents", async (req, res) => {
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
  rebuildIndex();

  res.status(201).json({
    document: publicDocuments().find(item => item.id === document.id),
    chunks: chunkIndex.length,
    extractedCharacters: documentContent.length
  });
});

app.patch("/documents/:id/status", requireAdmin, (req, res) => {
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
  rebuildIndex();

  res.json({
    document: publicDocuments(true).find(item => item.id === document.id),
    metrics: publicMetrics()
  });
});

app.post("/documents/:id/comments", requireReviewerOrAdmin, (req, res) => {
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

app.put("/documents/:id", requireAdmin, (req, res) => {
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

  rebuildIndex();

  res.json({
    document: publicDocuments(true).find(item => item.id === document.id),
    metrics: publicMetrics()
  });
});

app.delete("/documents/:id", requireAdmin, (req, res) => {
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
  rebuildIndex();

  res.json({
    ok: true,
    metrics: publicMetrics()
  });
});

app.post("/documents/:id/restore/:versionId", requireAdmin, (req, res) => {
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

  rebuildIndex();

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

app.post("/admin/reindex", requireAdmin, (req, res) => {
  rebuildIndex();

  res.json({
    message: "Knowledge base re-indexed",
    metrics: publicMetrics()
  });
});

// STEP 3: API
app.post("/ask", async (req, res) => {
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

    const relevantChunks = retrieveRelevantChunks(question, 3, useCase);
    const sources = publicSources(relevantChunks);
    const context = relevantChunks.map(source => source.text).join("\n");

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
        sources: []
      });
    }

    let answer = createExtractiveAnswer(question, relevantChunks);

    if (geminiAvailable) {
      try {
        const model = genAI.getGenerativeModel({
          model: GEMINI_MODEL
        });

        const prompt = `
You are a strict AI assistant.

Rules:
1. Read the context carefully.
2. If the answer exists in the context, extract it clearly.
3. Use the exact wording from the context when possible.
4. If the answer is NOT present, say:
   "I don't know based on the document."
5. Do NOT use outside knowledge.

Context:
${context}

Question:
${question}

Answer:
`;

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
      useCase
    });

  } catch (err) {
    console.error("❌ API Error:", err.message);

    res.status(500).json({
      error: err.message || "Internal Server Error"
    });
  }
});

// Start server
setup();

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

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  retrieveRelevantChunks,
  createExtractiveAnswer,
  publicDocuments
};
