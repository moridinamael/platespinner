// TF-IDF based task similarity engine — pure JS, no dependencies

const STOP_WORDS = new Set([
  'a', 'the', 'is', 'and', 'to', 'of', 'in', 'for', 'with', 'on', 'at', 'by',
  'this', 'that', 'it', 'an', 'be', 'as', 'are', 'was', 'were', 'has', 'have',
  'had', 'do', 'does', 'did', 'will', 'would', 'should', 'can', 'could', 'may',
  'might', 'shall', 'not', 'no', 'or', 'but', 'if', 'then', 'so', 'than',
  'too', 'very', 'just', 'about', 'also', 'each', 'which', 'when', 'where',
  'what', 'how', 'all', 'any', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'only',
]);

export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

export function buildTFIDF(documents) {
  const N = documents.length;
  if (N === 0) return { vectors: new Map(), idf: new Map() };

  // Term frequency per document
  const tfMaps = new Map();
  const docFreq = new Map(); // term → number of documents containing term

  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    // Normalize TF by document length
    const len = tokens.length || 1;
    for (const [term, count] of tf) {
      tf.set(term, count / len);
    }
    tfMaps.set(doc.id, tf);

    // Count document frequency
    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  // IDF: log(N / df)
  const idf = new Map();
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log(N / df));
  }

  // TF-IDF vectors
  const vectors = new Map();
  for (const [id, tf] of tfMaps) {
    const vec = new Map();
    for (const [term, tfVal] of tf) {
      vec.set(term, tfVal * (idf.get(term) || 0));
    }
    vectors.set(id, vec);
  }

  return { vectors, idf };
}

export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.size === 0 || vecB.size === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const [term, valA] of vecA) {
    magA += valA * valA;
    const valB = vecB.get(term);
    if (valB !== undefined) {
      dot += valA * valB;
    }
  }
  for (const valB of vecB.values()) {
    magB += valB * valB;
  }

  const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
  if (magnitude === 0) return 0;
  return dot / magnitude;
}

function combineTaskText(task) {
  const title = task.title || '';
  const description = task.description || '';
  const rationale = task.rationale || '';
  // Double the title for emphasis
  return `${title} ${title} ${description} ${rationale}`;
}

export function findSimilarTasks(newTask, existingTasks, threshold = 0.3) {
  if (!existingTasks || existingTasks.length === 0) return [];

  const newText = combineTaskText(newTask);
  const documents = [
    { id: '__new__', text: newText },
    ...existingTasks.map(t => ({ id: t.id, text: combineTaskText(t) })),
  ];

  const { vectors } = buildTFIDF(documents);
  const newVec = vectors.get('__new__');
  if (!newVec || newVec.size === 0) return [];

  const results = [];
  for (const t of existingTasks) {
    const vec = vectors.get(t.id);
    if (!vec) continue;
    const score = cosineSimilarity(newVec, vec);
    if (score >= threshold) {
      results.push({
        taskId: t.id,
        title: t.title,
        status: t.status,
        score: Math.round(score * 1000) / 1000,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// Known source file extensions for path extraction
const KNOWN_EXTENSIONS = /\.(js|jsx|ts|tsx|py|go|rs|json|md|css|html|yml|yaml|toml|vue|svelte|rb|java|c|cpp|h|hpp|cs|php|sh|bash|sql|prisma|graphql|gql|env|cfg|ini|xml|lock|mjs|cjs)$/;

export function extractFilePaths(planText) {
  if (!planText) return [];

  const paths = new Set();

  // Match backtick-wrapped paths: `path/to/file.ext`
  const backtickPattern = /`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)`/g;
  let m;
  while ((m = backtickPattern.exec(planText)) !== null) {
    if (m[1].includes('/') && KNOWN_EXTENSIONS.test(m[1])) {
      paths.add(m[1]);
    }
  }

  // Match bare paths that look like file references
  const barePattern = /(?:^|\s)((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/gm;
  while ((m = barePattern.exec(planText)) !== null) {
    if (KNOWN_EXTENSIONS.test(m[1])) {
      paths.add(m[1]);
    }
  }

  return [...paths];
}

export function findFileConflicts(taskId, taskFiles, allExecutingTasks) {
  if (!taskFiles || taskFiles.length === 0 || !allExecutingTasks) return [];

  const taskFileSet = new Set(taskFiles);
  const conflicts = [];

  for (const other of allExecutingTasks) {
    if (other.id === taskId) continue;
    if (!other.trackedFiles || other.trackedFiles.length === 0) continue;

    const overlapping = other.trackedFiles.filter(f => taskFileSet.has(f));
    if (overlapping.length > 0) {
      conflicts.push({
        taskId: other.id,
        taskTitle: other.title,
        conflictingFiles: overlapping,
      });
    }
  }

  return conflicts;
}
