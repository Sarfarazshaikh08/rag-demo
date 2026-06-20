function termVector(tokens = []) {
  return tokens.reduce((vector, token) => {
    vector[token] = (vector[token] || 0) + 1;
    return vector;
  }, {});
}

function cosineSimilarity(a = [], b = []) {
  if (!a.length || !b.length || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }

  if (!aNorm || !bNorm) {
    return 0;
  }

  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function buildApprovedChunkIndex(documents, chunkDocument) {
  return documents
    .filter(document => document.approvalStatus === "Approved")
    .flatMap(document => chunkDocument(document).map(chunk => ({
      ...chunk,
      termVector: termVector(chunk.tokens)
    })));
}

function assertApprovedForIndexing(document) {
  if (!document || document.approvalStatus !== "Approved") {
    throw new Error("Only approved documents can be indexed.");
  }
}

module.exports = {
  assertApprovedForIndexing,
  buildApprovedChunkIndex,
  cosineSimilarity,
  termVector
};
