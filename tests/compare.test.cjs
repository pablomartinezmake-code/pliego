const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/compare.mjs');
const marked = (texts, marks) => marks.map(m => texts[m.segment].slice(m.start, m.end));

test('identical texts have no changes', async () => {
  const { compareTexts } = await load();
  const texts = ['Un lugar para leer', 'Un texto necesita espacio.', 'Leo para descubrir qué dice una página.'];
  const result = compareTexts(texts, [...texts]);
  assert.deepEqual(result.left, []); assert.deepEqual(result.right, []); assert.equal(result.hunks.length, 0);
});

test('whitespace alone is not a change', async () => {
  const { compareTexts } = await load();
  const result = compareTexts(['Una  frase\ncon espacios.'], ['Una frase con   espacios.']);
  assert.equal(result.hunks.length, 0); assert.deepEqual(result.left, []);
});

test('a changed word is marked on each side', async () => {
  const { compareTexts } = await load();
  const left = ['Título', 'El tren avanza rápido por la llanura.', 'Final.'];
  const right = ['Título', 'El tren avanza lento por la llanura.', 'Final.'];
  const result = compareTexts(left, right);
  assert.deepEqual(marked(left, result.left), ['rápido']);
  assert.deepEqual(marked(right, result.right), ['lento']);
  assert.equal(result.hunks.length, 1);
  assert.deepEqual(result.hunks[0].left, [1]); assert.deepEqual(result.hunks[0].right, [1]);
});

test('an inserted paragraph is marked whole and anchored on the other side', async () => {
  const { compareTexts } = await load();
  const left = ['Uno.', 'Tres.'];
  const right = ['Uno.', 'Dos, un párrafo nuevo.', 'Tres.'];
  const result = compareTexts(left, right);
  assert.deepEqual(result.left, []);
  assert.deepEqual(marked(right, result.right), ['Dos, un párrafo nuevo.']);
  assert.equal(result.hunks.length, 1);
  assert.deepEqual(result.hunks[0].left, []); assert.equal(result.hunks[0].leftAt, 1);
});

test('short equal words between edits join the marked phrase', async () => {
  const { compareTexts } = await load();
  const left = ['Corregir también es leer. Cada cambio propone una forma distinta de prestar atención.'];
  const right = ['Corregir es volver a escuchar el texto. Cada cambio ensaya otra forma de prestar atención.'];
  const result = compareTexts(left, right);
  const l = marked(left, result.left), r = marked(right, result.right);
  assert.ok(l.includes('también es leer'), l.join(' | '));
  assert.ok(r.includes('es volver a escuchar el texto'), r.join(' | '));
  assert.ok(!l.some(s => /Cada cambio/.test(s)) && !r.some(s => /Cada cambio/.test(s)), 'long shared runs stay unmarked');
});

test('a rewritten paragraph pairs with its version, not with a neighbour', async () => {
  const { compareTexts } = await load();
  const left = ['Inicio.', 'La primera lectura descubre lo que dice una página.', 'Cierre.'];
  const right = ['Inicio.', 'Un párrafo añadido sin relación alguna.', 'La primera lectura descubre lo que dice cada página.', 'Cierre.'];
  const result = compareTexts(left, right);
  assert.deepEqual(marked(left, result.left), ['una']);
  assert.deepEqual(marked(right, result.right), ['Un párrafo añadido sin relación alguna.', 'cada']);
});

test('paragraphs revised in place pair in order, a heading does not jump to the paragraph that quotes it', async () => {
  const { compareTexts } = await load();
  const left = ['Ancla.', 'La primera lectura', 'Leo para descubrir qué dice una página. Vuelvo a leer para descubrir qué había pasado por alto.', 'Fin.'];
  const right = ['Ancla.', 'Volver a la página', 'La primera lectura descubre lo que dice una página. La segunda encuentra lo que había quedado entre líneas.', 'Fin.'];
  const result = compareTexts(left, right);
  assert.deepEqual(result.hunks.map(h => [h.left, h.right]), [[[1, 2], [1, 2]]]);
  assert.ok(!marked(left, result.left).includes(left[2]), 'the revised paragraph is compared word by word, not marked whole');
});

test('long documents with scattered changes stay fast and count each passage', async () => {
  const { compareTexts } = await load();
  const left = Array.from({ length: 3000 }, (_, i) => `Párrafo ${i} con algunas palabras para leer despacio y sin prisa alguna.`);
  const right = left.map((text, i) => i % 100 === 50 ? text.replace('despacio', 'deprisa') : text);
  const started = Date.now();
  const result = compareTexts(left, right);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(result.hunks.length, 30);
  assert.ok(marked(left, result.left).every(s => s === 'despacio'));
});

test('unrelated texts are marked without failing', async () => {
  const { compareTexts } = await load();
  const left = ['Alfa beta gamma.', 'Delta épsilon.'];
  const right = ['Uno dos tres.'];
  const result = compareTexts(left, right);
  assert.equal(marked(left, result.left).join(' '), 'Alfa beta gamma. Delta épsilon.');
  assert.equal(marked(right, result.right).join(' '), 'Uno dos tres.');
  assert.ok(result.hunks.length >= 1);
});
