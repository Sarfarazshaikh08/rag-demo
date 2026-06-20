const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = __dirname;
const port = Number(process.env.FRONTEND_PORT || 5173);
const host = process.env.FRONTEND_HOST || "127.0.0.1";
const apiBase = process.env.FRONTEND_API_BASE || "http://127.0.0.1:3000";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

  if (url.pathname === "/config.js") {
    send(
      res,
      200,
      `window.KNOWLEDGEOPS_API_BASE = ${JSON.stringify(apiBase)};\n`,
      "application/javascript; charset=utf-8"
    );
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(rootDir, `.${requested}`);

  if (!filePath.startsWith(rootDir)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }

    send(res, 200, data, contentTypes[path.extname(filePath)] || "application/octet-stream");
  });
});

server.listen(port, host, () => {
  console.log(`Frontend running at http://${host}:${port}`);
  console.log(`API base: ${apiBase || "same-origin"}`);
});
