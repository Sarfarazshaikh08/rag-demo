const path = require("path");

const rootDir = path.resolve(__dirname, "..", "..");

const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "127.0.0.1",
  databaseUrl: process.env.DATABASE_URL || "",
  enablePostgres: process.env.ENABLE_POSTGRES === "true",
  awsRegion: process.env.AWS_REGION || "us-east-1",
  objectStorageProvider: process.env.OBJECT_STORAGE_PROVIDER || "local",
  s3Bucket: process.env.S3_BUCKET || "",
  s3Prefix: process.env.S3_PREFIX || "rag-demo/originals",
  objectStorageDir: process.env.OBJECT_STORAGE_DIR || path.join(rootDir, "storage", "objects"),
  ocrEnabled: process.env.OCR_ENABLED === "true",
  tesseractBin: process.env.TESSERACT_BIN || "tesseract",
  roles: {
    admin: "admin",
    reviewer: "reviewer",
    viewer: "viewer"
  }
};

module.exports = config;
