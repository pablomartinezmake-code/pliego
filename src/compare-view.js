// Pinta el cotejo sobre los dos paneles de lectura sin tocar su HTML:
// las marcas van en una capa aparte (CSS Custom Highlights), como la búsqueda.
import { compareTexts } from './compare.mjs';

const FIRST = 'change-first', SECOND = 'change-second';

// Párrafos de un panel: cada bloque de primer nivel; un texto plano se parte por líneas en blanco.
function segmentsOf(prose) {
  const segments = [];
  for (const el of prose.children) {
    const text = el.textContent || '';
    const push = (start, end) => { if (/\S/.test(text.slice(start, end))) segments.push({ el, start, text: text.slice(start, end) }); };
    const blank = /\n[ \t]*\n\s*/g;
    let start = 0, match;
    while ((match = blank.exec(text))) { push(start, match.index); start = match.index + match[0].length; }
    push(start, text.length);
  }
  return segments;
}

function rangeIn(el, start, end) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = new Range();
  let pos = 0, started = false, node;
  while ((node = walker.nextNode())) {
    const length = node.data.length;
    if (!started && start < pos + length) { range.setStart(node, start - pos); started = true; }
    if (started && end <= pos + length) { range.setEnd(node, end - pos); return range; }
    pos += length;
  }
  return null;
}

export function clearChanges() {
  CSS.highlights?.delete(FIRST); CSS.highlights?.delete(SECOND);
}

// Marca los dos paneles y devuelve los pasajes con cambios: el elemento de cada lado al que saltar.
export function markChanges(firstProse, secondProse) {
  if (!CSS.highlights || !window.Highlight) return [];
  const first = segmentsOf(firstProse), second = segmentsOf(secondProse);
  const result = compareTexts(first.map(s => s.text), second.map(s => s.text));
  const ranges = (segments, marks) => marks.map(mark => {
    const segment = segments[mark.segment];
    return rangeIn(segment.el, segment.start + mark.start, segment.start + mark.end);
  }).filter(Boolean);
  CSS.highlights.set(FIRST, new Highlight(...ranges(first, result.left)));
  CSS.highlights.set(SECOND, new Highlight(...ranges(second, result.right)));
  const at = (segments, index) => segments[Math.min(index, segments.length - 1)]?.el || null;
  return result.hunks.map(hunk => ({ first: at(first, hunk.left[0] ?? hunk.leftAt), second: at(second, hunk.right[0] ?? hunk.rightAt) }));
}
