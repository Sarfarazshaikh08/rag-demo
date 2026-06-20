const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const config = require("../config");

let s3Client;

function safeFileName(fileName = "document.bin") {
  return fileName.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "document.bin";
}

async function putObject(buffer, metadata = {}) {
  const objectId = crypto.randomUUID();
  const fileName = safeFileName(metadata.fileName || metadata.name);
  const key = `${objectId}/${fileName}`;
  const mimeType = metadata.mimeType || "application/octet-stream";
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  if (config.objectStorageProvider === "s3") {
    if (!config.s3Bucket) {
      throw new Error("S3_BUCKET is required when OBJECT_STORAGE_PROVIDER=s3.");
    }

    if (!s3Client) {
      s3Client = new S3Client({
        region: config.awsRegion
      });
    }

    const objectKey = `${config.s3Prefix.replace(/\/+$/g, "")}/${key}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: objectKey,
      Body: buffer,
      ContentType: mimeType,
      Metadata: {
        sha256
      }
    }));

    return {
      key: objectKey,
      fileName,
      mimeType,
      sizeBytes: buffer.length,
      sha256,
      provider: "s3",
      bucket: config.s3Bucket,
      region: config.awsRegion
    };
  }

  const absolutePath = path.join(config.objectStorageDir, key);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);

  return {
    key,
    fileName,
    mimeType,
    sizeBytes: buffer.length,
    sha256,
    provider: "local"
  };
}

function getObjectPath(key) {
  if (!key || key.includes("..")) {
    throw new Error("Invalid object key.");
  }

  return path.join(config.objectStorageDir, key);
}

module.exports = {
  getObjectPath,
  putObject
};
