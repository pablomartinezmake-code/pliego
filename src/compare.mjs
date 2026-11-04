// Cotejo de dos textos, como el de un editor que pone dos versiones juntas.
// Recibe los párrafos de cada lado (texto plano) y devuelve qué tramos marcar en cada uno.
//   1. Los párrafos idénticos sirven de anclas.
//   2. Entre dos anclas, cada párrafo se empareja con su versión más parecida del otro lado.
//   3. Dentro de cada pareja se comparan palabras; un párrafo sin pareja se marca entero.
// Las posiciones (start, end) son de carácter dentro del texto recibido, para poder pintarlas.

const TOKEN = /\s+|[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;
const MAX_BLOCK_EDITS = 4000;   // más cambios de párrafo que esto: se marca todo lo no anclado
const MAX_WORD_EDITS = 3000;    // más cambios de palabra en una pareja: se marcan los dos párrafos enteros
const PAIR_WINDOW = 12;         // cuántos párrafos por delante se miran para buscar pareja
const PAIR_MIN = 0.4;           // parecido mínimo (vocabulario compartido) para buscar pareja fuera de su sitio
const IN_PLACE_MIN = 0.2;       // parecido mínimo para cotejar en orden cuando ambos lados tienen tantos párrafos
const SHORT_RUN = 2;            // palabras iguales entre dos cambios que se funden en la marca

const normal = text => text.replace(/\s+/g, ' ').trim();
const vocabulary = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);

function likeness(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return (2 * common) / (a.size + b.size);
}

// Diferencias de Myers (1986): la secuencia más corta de borrados e inserciones.
// Devuelve los pares [i, j] de elementos iguales, en orden, o null si hay más de maxEdits cambios.
export function matchSequences(a, b, maxEdits = Infinity) {
  const n = a.length, m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const core = myers(a.slice(pre, n - suf), b.slice(pre, m - suf), maxEdits);
  if (!core) return null;
  const out = [];
  for (let i = 0; i < pre; i++) out.push([i, i]);
  for (const [i, j] of core) out.push([i + pre, j + pre]);
  for (let s = suf; s > 0; s--) out.push([n - s, m - s]);
  return out;
}

function myers(a, b, maxEdits) {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  const max = n + m, limit = Math.min(max, maxEdits), off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace, n, m) {
  const matches = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d], at = k => snap[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; matches.push([x, y]); }
    x = prevX; y = prevY;
  }
  return matches.reverse();
}

function tokenize(text) {
  const tokens = [];
  for (const match of text.matchAll(TOKEN)) {
    const space = /^\s/.test(match[0]);
    tokens.push({ key: space ? ' ' : match[0], space, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

function wholeMark(text, segment) {
  const start = text.search(/\S/);
  return start < 0 ? null : { segment, start, end: text.trimEnd().length };
}

// Tramos sin pareja de una lista de palabras, de la primera a la última palabra no blanca del tramo.
function unmatchedRanges(tokens, matched, segment) {
  const ranges = [];
  let first = -1, last = -1;
  const close = () => { if (first >= 0) ranges.push({ segment, start: tokens[first].start, end: tokens[last].end }); first = last = -1; };
  tokens.forEach((token, index) => {
    if (matched[index]) { close(); return; }
    if (token.space) return;
    if (first < 0) first = index;
    last = index;
  });
  close();
  return ranges;
}

function comparePair(leftText, rightText, li, rj) {
  const a = tokenize(leftText), b = tokenize(rightText);
  const matches = matchSequences(a.map(t => t.key), b.map(t => t.key), MAX_WORD_EDITS);
  if (!matches) return { left: [wholeMark(leftText, li)].filter(Boolean), right: [wholeMark(rightText, rj)].filter(Boolean) };
  const inA = new Uint8Array(a.length), inB = new Uint8Array(b.length);
  for (const [i, j] of matches) { inA[i] = 1; inB[j] = 1; }
  // Una o dos palabras iguales encajadas entre cambios se funden con ellos: «también es leer», no tres trozos.
  for (let r = 0; r < matches.length;) {
    let end = r;
    while (end + 1 < matches.length && matches[end + 1][0] === matches[end][0] + 1 && matches[end + 1][1] === matches[end][1] + 1) end++;
    const [i0, j0] = matches[r], [i1, j1] = matches[end];
    const interior = (i0 > 0 || j0 > 0) && (i1 < a.length - 1 || j1 < b.length - 1);
    let words = 0;
    for (let i = i0; i <= i1; i++) if (!a[i].space) words++;
    if (interior && words <= SHORT_RUN) for (let s = r; s <= end; s++) { inA[matches[s][0]] = 0; inB[matches[s][1]] = 0; }
    r = end + 1;
  }
  return { left: unmatchedRanges(a, inA, li), right: unmatchedRanges(b, inB, rj) };
}

export function compareTexts(leftTexts, rightTexts) {
  const L = leftTexts.map(normal), R = rightTexts.map(normal);
  const vocabL = [], vocabR = [];
  const result = { left: [], right: [], hunks: [] };
  const anchors = [...(matchSequences(L, R, MAX_BLOCK_EDITS) || []), [L.length, R.length]];
  let i = 0, j = 0;
  for (const [ai, aj] of anchors) {
    if (ai > i || aj > j) gap(i, ai, j, aj);
    i = ai + 1; j = aj + 1;
  }
  return result;

  function gap(i0, i1, j0, j1) {
    const hunk = { left: [], right: [], leftAt: i0, rightAt: j0 };
    const before = result.left.length + result.right.length;
    const removed = li => { const mark = wholeMark(leftTexts[li], li); if (mark) result.left.push(mark); hunk.left.push(li); };
    const added = rj => { const mark = wholeMark(rightTexts[rj], rj); if (mark) result.right.push(mark); hunk.right.push(rj); };
    const pairUp = (li, rj) => {
      const pair = comparePair(leftTexts[li], rightTexts[rj], li, rj);
      result.left.push(...pair.left); result.right.push(...pair.right);
      hunk.left.push(li); hunk.right.push(rj);
    };
    // Tantos párrafos a cada lado: se retocaron en su sitio. Se cotejan en orden, primero con primero.
    if (i1 - i0 === j1 - j0) {
      for (let k = 0; k < i1 - i0; k++) {
        const li = i0 + k, rj = j0 + k;
        if (likeness(vocabulary(L[li]), vocabulary(R[rj])) >= IN_PLACE_MIN) pairUp(li, rj);
        else { removed(li); added(rj); }
      }
      if (result.left.length + result.right.length > before) result.hunks.push(hunk);
      return;
    }
    let r = j0;
    for (let li = i0; li < i1; li++) {
      let best = -1, bestScore = PAIR_MIN;
      vocabL[li] ??= vocabulary(L[li]);
      for (let rj = r; rj < Math.min(j1, r + PAIR_WINDOW); rj++) {
        vocabR[rj] ??= vocabulary(R[rj]);
        const score = likeness(vocabL[li], vocabR[rj]);
        if (score > bestScore) { bestScore = score; best = rj; }
      }
      if (best < 0) { removed(li); continue; }
      for (; r < best; r++) added(r);
      pairUp(li, best);
      r = best + 1;
    }
    for (; r < j1; r++) added(r);
    if (result.left.length + result.right.length > before) result.hunks.push(hunk);
  }
}
