const fs = require("fs/promises");
const path = require("path");

const frontendDir = __dirname;
const distDir = path.join(frontendDir, "dist");
const apiBase = process.env.FRONTEND_API_BASE || "";

async function copyFile(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function main() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });

  await copyFile(path.join(frontendDir, "index.html"), path.join(distDir, "index.html"));
  await copyFile(path.join(frontendDir, "solvagence-logo.png"), path.join(distDir, "solvagence-logo.png"));

  await fs.writeFile(
    path.join(distDir, "config.js"),
    `window.KNOWLEDGEOPS_API_BASE = ${JSON.stringify(apiBase.replace(/\/+$/g, ""))};\n`
  );

  console.log(`Frontend build written to ${path.relative(process.cwd(), distDir)}`);
  console.log(`API base: ${apiBase || "same-origin"}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
