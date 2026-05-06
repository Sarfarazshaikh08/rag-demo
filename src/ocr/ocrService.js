const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const config = require("../config");

function runTesseract(inputPath) {
  return new Promise((resolve, reject) => {
    execFile(config.tesseractBin, [inputPath, "stdout", "--psm", "6"], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }

      resolve(stdout);
    });
  });
}

async function extractText({ buffer, mimeType, fileName }) {
  if (!config.ocrEnabled) {
    return {
      text: "",
      status: "not_required",
      message: "OCR is disabled. Set OCR_ENABLED=true and install Tesseract for scanned images."
    };
  }

  const isImage = /^image\//.test(mimeType || "");

  if (!isImage) {
    return {
      text: "",
      status: "failed",
      message: "OCR fallback is ready for images. For scanned PDFs, add a PDF-to-image step such as Poppler before Tesseract."
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-ocr-"));
  const tempPath = path.join(tempDir, fileName || "upload");

  try {
    await fs.writeFile(tempPath, buffer);
    const text = await runTesseract(tempPath);

    return {
      text,
      status: text.trim() ? "completed" : "failed",
      message: text.trim() ? "OCR completed." : "OCR did not find readable text."
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  extractText
};
