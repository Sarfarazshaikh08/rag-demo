function termVector(tokens = []) {
  return tokens.reduce((vector, token) => {
    vector[token] = (vector[token] || 0) + 1;
    return vector;
  }, {});
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
  termVector
};
