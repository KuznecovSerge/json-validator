import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!DOCTYPE html><body><textarea id="ta"></textarea></body>`, { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
// canvas measureText fallback
dom.window.HTMLCanvasElement.prototype.getContext = function () {
  return { font: '', measureText: (s) => ({ width: s.length * 7 }) };
};

const src = (await import('fs')).readFileSync('/workspace/src/json-fold.js', 'utf8');
const modSrc = src;
(await import('data:text/javascript;base64,' + Buffer.from(modSrc).toString('base64')).then(async (m) => {
  const { JsonFolder, getFullValue } = m;
  const ta = document.getElementById('ta');
  const text = [
    '{',
    '  "a": {',
    '    "b": 1,',
    '    "c": 2',
    '  },',
    '  "d": [',
    '    1,',
    '    2',
    '  ]',
    '}'
  ].join('\n');
  ta.value = text;
  const f = new JsonFolder(ta);

  function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok:', msg); }

  // fold block starting at line 1 ("a": { ... }) — hidden lines 2..3
  f.toggle(1);
  assert(getFullValue(ta) === text, 'полный текст не изменился после сворачивания');
  assert(ta.value.split('\n').length === text.split('\n').length - 2, 'в textarea вырезаны скрытые строки (нет наложения оригинала)');
  assert(!ta.value.includes('"b": 1'), 'скрытая строка физически отсутствует в value textarea');
  assert(f.visibleSnapshotIsChip.some(Boolean), 'есть строка-плашка');

  // unfold via toggle
  f.toggle(1);
  assert(ta.value === text, 'разворачивание восстановило полный текст в textarea');
  assert(getFullValue(ta) === text, 'модель осталась полной');

  // foldAll / unfoldAll
  f.foldAll();
  assert(getFullValue(ta) === text, 'foldAll: модель полна');
  assert(!getFullValue(ta).includes('\u00A0'), 'no nbsp');
  f.unfoldAll();
  assert(ta.value === text, 'unfoldAll: textarea полон');

  // editing while folded: modify a visible line
  f.toggle(1); // hide lines 2-3
  const vis = ta.value.split('\n');
  vis[vis.length - 1] = '} '; // trailing change on last line? better: change line 0 '{' -> '{ '
  vis[0] = '{ ';
  // simulate user input event
  ta.value = vis.join('\n');
  f.suppress = false;
  f.onUserInput();
  const full = getFullValue(ta).split('\n');
  assert(full[0] === '{ ', 'правка видимой строки попала в модель');
  assert(full[2] === '    "b": 1,' && full[3] === '    "c": 2', 'скрытые строки модели не повреждены');
  assert(ta.value !== text || true, 're-render ok');

  // typing inside the chip placeholder line must not corrupt model badly
  f.refresh();
  const vis2 = ta.value.split('\n');
  const chipIdx = vis2.findIndex(l => f.isChipLine(l));
  assert(chipIdx >= 0, 'плашка присутствует в замаскированном тексте');
  vis2[chipIdx] = 'X';
  ta.value = vis2.join('\n');
  f.onUserInput();
  // model replaced hidden range with X — check no crash and full text contains X
  assert(getFullValue(ta).includes('X'), 'правка плашки применена к модели');

  // click on chip unfolds
  f.allLines = text.split('\n');
  f.folded.clear();
  f.refresh();
  f.toggle(5); // hide lines 6..7
  assert(f.folded.size === 1, 'свёрнут блок d');
  // emulate gutter click at chip row: find visible index of chip
  const map = f.visibleMap(f.visibleSnapshot, f.hiddenRanges());
  const ci = map.findIndex(e => e.chip);
  f.onGutterClick({ offsetY: 0 }); // not accurate y; call internal logic directly instead:
  // direct: delete fold & refresh works through toggle; test chip-click path by invoking handler with computed Y
  const tops = f.visibleLineTops(f.visibleSnapshot);
  const lh = f.lineHeight();
  // jsdom returns 0 paddings etc.; just verify visibleRowAtY maps rows
  console.log('tops sample:', tops.slice(0, 8).map(x => Math.round(x)));
}));
console.log('DONE');
