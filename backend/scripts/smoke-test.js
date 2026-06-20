const { spawn } = require("child_process");

const port = Number(process.env.SMOKE_PORT || 4107);
const baseUrl = `http://127.0.0.1:${port}`;

function startServer() {
  return spawn(process.execPath, ["backend/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      ENABLE_GEMINI: "false",
      ENABLE_SEMANTIC_RAG: "false",
      ENABLE_VECTOR_DB: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForHealth(timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        return res.json();
      }
    } catch (err) {
      // Server is still starting.
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error("Timed out waiting for /health");
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { res, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const server = startServer();
  let output = "";

  server.stdout.on("data", chunk => {
    output += chunk.toString();
  });
  server.stderr.on("data", chunk => {
    output += chunk.toString();
  });

  try {
    const health = await waitForHealth();
    assert(health.documents === 8, "Expected 8 seed documents");
    assert(health.retrievalMode === "keyword-bm25", "Expected keyword-bm25 mode");

    const status = await request("/api/status");
    assert(status.body.retrieval === "keyword-bm25", "Status should expose keyword-bm25 retrieval");

    const known = await request("/ask", {
      method: "POST",
      body: JSON.stringify({
        question: "What is the SLA for a P1 support issue?",
        useCase: "Support Assistant"
      })
    });
    assert(known.body.answer.includes("[S1]"), "Known answer should include citation");
    assert(known.body.grounding.grounded === true, "Known answer should be grounded");

    const unknown = await request("/ask", {
      method: "POST",
      body: JSON.stringify({
        question: "What is the company policy for flying to Mars?",
        useCase: "All"
      })
    });
    assert(unknown.body.answer === "I don't know based on the document.", "Unknown answer should refuse");

    const upload = await request("/documents", {
      method: "POST",
      body: JSON.stringify({
        name: "blocked.txt",
        content: "This should not upload anonymously.",
        mimeType: "text/plain"
      })
    });
    assert(upload.res.status === 401, "Anonymous upload should be blocked");

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" })
    });
    assert(login.ok, "Default admin login should work in smoke mode");
    const cookie = login.headers.get("set-cookie");
    assert(cookie && cookie.includes("HttpOnly"), "Login should set an HttpOnly cookie");

    const me = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: cookie }
    });
    const meBody = await me.json();
    assert(meBody.user && meBody.user.role === "admin", "Session should authenticate admin");

    console.log("Smoke test passed");
  } finally {
    server.kill("SIGINT");
    setTimeout(() => {
      if (!server.killed) {
        server.kill("SIGKILL");
      }
    }, 1000);
  }

  if (process.env.SMOKE_DEBUG === "true") {
    console.log(output);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
