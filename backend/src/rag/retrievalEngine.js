function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function termFrequency(tokens = []) {
  return tokens.reduce((map, token) => {
    map[token] = (map[token] || 0) + 1;
    return map;
  }, {});
}

function detectIntent(question = "") {
  const text = question.toLowerCase();

  if (/\b(sla|response|resolution|p1|p2|p3|priority)\b/.test(text)) {
    return "sla";
  }

  if (/\b(escalate|escalated|escalation|risk|blocker|breach)\b/.test(text)) {
    return "escalation";
  }

  if (/\b(approve|approval|discount|required|must|should|compliance|violation)\b/.test(text)) {
    return "policy-control";
  }

  if (/\b(when|how often|timeline|deadline|within|days|hours)\b/.test(text)) {
    return "timeline";
  }

  if (/\b(who|owner|manager|head|team|responsible)\b/.test(text)) {
    return "ownership";
  }

  return "general";
}

function analyzeQuery(question, tokenize, extractEntityTerms) {
  const normalizedQuestion = String(question || "").trim().replace(/\s+/g, " ");
  const tokens = unique(tokenize(normalizedQuestion));
  const entityTerms = unique(extractEntityTerms(normalizedQuestion));
  const quotedPhrases = [...normalizedQuestion.matchAll(/"([^"]+)"/g)].map(match => match[1].trim()).filter(Boolean);
  const priorityTerms = tokens.filter(token => /^priority[123]$/.test(token));

  return {
    normalizedQuestion,
    intent: detectIntent(normalizedQuestion),
    tokens,
    queryTerms: new Set(tokens),
    entityTerms,
    quotedPhrases,
    priorityTerms,
    hasSpecificConstraint: Boolean(entityTerms.length || priorityTerms.length || quotedPhrases.length)
  };
}

function buildRetrievalStats(chunks = []) {
  const documentFrequency = {};
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = chunk.tokens || [];
    totalLength += tokens.length;

    for (const token of unique(tokens)) {
      documentFrequency[token] = (documentFrequency[token] || 0) + 1;
    }
  }

  return {
    totalChunks: chunks.length,
    averageLength: chunks.length ? totalLength / chunks.length : 0,
    documentFrequency
  };
}

function bm25Score(chunkTokens = [], queryTerms = [], stats = {}) {
  if (!chunkTokens.length || !queryTerms.length || !stats.totalChunks) {
    return 0;
  }

  const frequency = termFrequency(chunkTokens);
  const k1 = 1.35;
  const b = 0.72;
  const avgLength = stats.averageLength || 1;
  const chunkLength = chunkTokens.length || 1;

  return queryTerms.reduce((score, term) => {
    const tf = frequency[term] || 0;
    if (!tf) {
      return score;
    }

    const df = stats.documentFrequency[term] || 0;
    const idf = Math.log(1 + ((stats.totalChunks - df + 0.5) / (df + 0.5)));
    const denominator = tf + k1 * (1 - b + b * (chunkLength / avgLength));
    return score + idf * ((tf * (k1 + 1)) / denominator);
  }, 0);
}

function phraseBoost(text = "", query = {}) {
  const lowerText = text.toLowerCase();
  let boost = 0;

  for (const phrase of query.quotedPhrases || []) {
    if (phrase && lowerText.includes(phrase.toLowerCase())) {
      boost += 0.15;
    }
  }

  const meaningfulTerms = (query.tokens || []).filter(token => token.length >= 5);
  const exactMatches = meaningfulTerms.filter(term => lowerText.includes(term)).length;
  if (meaningfulTerms.length) {
    boost += Math.min(exactMatches / meaningfulTerms.length, 1) * 0.08;
  }

  return boost;
}

function metadataBoost(chunk = {}, useCase = "All", query = {}) {
  let boost = 0;

  if (useCase && useCase !== "All" && chunk.useCase === useCase) {
    boost += 0.08;
  }

  const intentDepartmentHints = {
    sla: ["Support", "Information Technology"],
    escalation: ["Project Management", "Client Delivery", "Support"],
    ownership: ["Project Management", "Client Delivery", "Sales", "Human Resources"],
    "policy-control": ["Legal", "Finance", "Information Technology", "Human Resources"]
  };

  if ((intentDepartmentHints[query.intent] || []).includes(chunk.department)) {
    boost += 0.05;
  }

  if (chunk.approvalStatus === "Approved") {
    boost += 0.03;
  }

  return boost;
}

function jaccardSimilarity(a = [], b = []) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) {
    return 0;
  }

  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}

function diversifyByMmr(candidates = [], limit = 5, lambda = 0.76) {
  const selected = [];
  const remaining = [...candidates];

  while (selected.length < limit && remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const diversityPenalty = selected.length
        ? Math.max(...selected.map(item => jaccardSimilarity(candidate.tokens, item.tokens)))
        : 0;
      const mmrScore = (lambda * candidate.score) - ((1 - lambda) * diversityPenalty);

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }

    selected.push({
      ...remaining[bestIndex],
      mmrScore: Number(bestScore.toFixed(4))
    });
    remaining.splice(bestIndex, 1);
  }

  return selected;
}

function scoreHybridCandidate({ chunk, query, stats, semanticScore = 0, useCase = "All", weights = {} }) {
  const rawBm25 = bm25Score(chunk.tokens, query.tokens, stats);
  const normalizedBm25 = Math.min(rawBm25 / 8, 1);
  const keywordScore = Math.round(normalizedBm25 * 20);
  const exactBoost = phraseBoost(chunk.text, query);
  const metaBoost = metadataBoost(chunk, useCase, query);
  const semantic = Number(semanticScore || 0);
  const lexicalWeight = weights.lexical ?? 0.42;
  const semanticWeight = weights.semantic ?? 0.44;
  const metadataWeight = weights.metadata ?? 0.14;
  const score = (semantic * semanticWeight)
    + (normalizedBm25 * lexicalWeight)
    + ((exactBoost + metaBoost) * metadataWeight);

  return {
    ...chunk,
    score: Number(score.toFixed(4)),
    bm25Score: Number(rawBm25.toFixed(4)),
    keywordScore,
    semanticScore: Number(semantic.toFixed(4)),
    exactBoost: Number(exactBoost.toFixed(4)),
    metadataBoost: Number(metaBoost.toFixed(4))
  };
}

function buildRetrievalPlan({ question, useCase, query, retrievalMode, candidateCount, selectedCount }) {
  return {
    question,
    useCase,
    retrievalMode,
    intent: query.intent,
    normalizedQuestion: query.normalizedQuestion,
    queryTerms: query.tokens,
    entityTerms: query.entityTerms,
    priorityTerms: query.priorityTerms,
    candidateCount,
    selectedCount
  };
}

module.exports = {
  analyzeQuery,
  buildRetrievalPlan,
  buildRetrievalStats,
  diversifyByMmr,
  scoreHybridCandidate
};
