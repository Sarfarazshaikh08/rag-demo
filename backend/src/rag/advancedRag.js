function estimateTokens(text = "") {
  return Math.ceil(String(text).split(/\s+/).filter(Boolean).length * 1.35);
}

function sourceLabel(index) {
  return `S${index + 1}`;
}

function sourceHeader(chunk, label) {
  return [
    `[${label}]`,
    chunk.documentName,
    chunk.department,
    chunk.useCase,
    chunk.version,
    `reference ${chunk.page}`,
    `score ${Number(chunk.score || 0).toFixed(3)}`
  ].filter(Boolean).join(" | ");
}

function buildContextPack(chunks = [], options = {}) {
  const maxCharacters = options.maxCharacters || 4200;
  const selected = [];
  let usedCharacters = 0;

  for (const [index, chunk] of chunks.entries()) {
    const label = sourceLabel(index);
    const header = sourceHeader(chunk, label);
    const block = `${header}\n${chunk.text}`.trim();

    if (usedCharacters && usedCharacters + block.length > maxCharacters) {
      continue;
    }

    selected.push({
      ...chunk,
      citationLabel: label,
      contextBlock: block
    });
    usedCharacters += block.length;
  }

  return {
    context: selected.map(chunk => chunk.contextBlock).join("\n\n"),
    selected,
    estimatedTokens: estimateTokens(selected.map(chunk => chunk.contextBlock).join("\n\n")),
    retrievalTrace: selected.map(chunk => ({
      citationLabel: chunk.citationLabel,
      documentName: chunk.documentName,
      page: chunk.page,
      evidenceType: chunk.evidenceType || "general",
      score: chunk.score,
      bm25Score: chunk.bm25Score || 0,
      semanticScore: chunk.semanticScore || 0,
      keywordScore: chunk.keywordScore || 0,
      exactBoost: chunk.exactBoost || 0,
      metadataBoost: chunk.metadataBoost || 0,
      mmrScore: chunk.mmrScore || 0,
      retrievalMode: chunk.retrievalMode || "keyword-bm25"
    }))
  };
}

function confidenceFromSources(sources = []) {
  if (!sources.length) {
    return "none";
  }

  const best = sources[0];
  if ((best.semanticScore || 0) >= 0.78 || (best.keywordScore || 0) >= 10) {
    return "high";
  }

  if ((best.semanticScore || 0) >= 0.62 || (best.keywordScore || 0) >= 6) {
    return "medium";
  }

  return "low";
}

function answerHasCitation(answer = "") {
  return /\[S\d+\]/.test(answer);
}

function verifyAnswerGrounding(answer = "", sources = []) {
  const normalizedAnswer = String(answer || "").toLowerCase();

  if (!normalizedAnswer || normalizedAnswer === "i don't know based on the document.") {
    return {
      grounded: false,
      citationPresent: false,
      support: 0
    };
  }

  const answerTerms = uniqueTerms(normalizedAnswer)
    .filter(term => term.length >= 4)
    .filter(term => !["based", "document", "source", "answer", "from"].includes(term));

  const sourceText = sources.map(source => source.text || "").join(" ").toLowerCase();
  const supportedTerms = answerTerms.filter(term => sourceText.includes(term));
  const support = answerTerms.length ? supportedTerms.length / answerTerms.length : 0;

  return {
    grounded: support >= 0.55,
    citationPresent: answerHasCitation(answer),
    support: Number(support.toFixed(3))
  };
}

function uniqueTerms(text = "") {
  return [...new Set(String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean))];
}

function buildGroundedPrompt({ context, question }) {
  return `
You are Solvagence KnowledgeOps, a strict retrieval-augmented assistant.

Answering rules:
1. Use only the provided source context.
2. If the answer is not directly supported, say exactly: "I don't know based on the document."
3. Keep the answer concise and operational.
4. Include source citations like [S1] or [S2] for every factual claim.
5. Do not cite a source unless that source directly supports the sentence.

Source context:
${context}

Question:
${question}

Grounded answer:
`.trim();
}

module.exports = {
  answerHasCitation,
  buildGroundedPrompt,
  buildContextPack,
  confidenceFromSources,
  estimateTokens,
  verifyAnswerGrounding
};
