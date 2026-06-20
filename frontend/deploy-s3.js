const { spawnSync } = require("child_process");
const path = require("path");

const bucket = process.env.S3_FRONTEND_BUCKET;
const prefix = (process.env.S3_FRONTEND_PREFIX || "").replace(/^\/+|\/+$/g, "");
const distDir = path.join("frontend", "dist");

if (!bucket) {
  console.error("S3_FRONTEND_BUCKET is required.");
  console.error("Example: S3_FRONTEND_BUCKET=my-site FRONTEND_API_BASE=https://api.example.com npm run frontend:deploy:s3");
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const target = prefix
  ? `s3://${bucket}/${prefix}`
  : `s3://${bucket}`;

run("aws", [
  "s3",
  "sync",
  distDir,
  target,
  "--delete",
  "--cache-control",
  "no-cache"
]);
