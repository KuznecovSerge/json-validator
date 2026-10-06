// json-fold.js — сворачивание блоков JSON в textarea-редакторе.
//
// Как это работает:
// - Полное значение текста хранится в модели (this.allLines); оно НИКОГДА не
//   меняется при сворачивании — данные пользователя в безопасности.
// - Когда есть хотя бы один свёрнутый блок, textarea переключается в режим
//   маскирования: его value становится «видимой» версией текста (скрытые
//   строки физически вырезаны), а поверх текста рисуются белые маскирующие
//   плашки («⋯ N строк»). Благодаря этому исходный текст textarea НЕ может
//   просвечивать сквозь фон редактора — эффект «двух накладывающихся текстов»
//   устранён полностью.
// - При редактировании в замаскированном тексте изменения вычисляются через
//   diff и применяются к полной модели, после чего маска перестраивается.
// - Если свёрнутых блоков нет, textarea работает как обычный редактор с
//   полным текстом (никаких накладок).
// - Синхронизированное «зеркало» отвечает за стрелки ▸/▾ в левой зоне и
//   подсветку свёрнутых строк.
// - Кнопки «Свернуть все» / «Развернуть все» вызывают foldAll()/unfoldAll().
// - getFullValue(ta) возвращает ПОЛНЫЙ текст независимо от режима маскирования.

const FOLD_ZONE = 22; // px — кликабельная зона слева, где живут стрелки

// Текст строки-заглушки в textarea вместо скрытого диапазона строк.
// Он полностью перекрывается непрозрачной плашкой (.fold-chip), поэтому его
// содержимое визуально не важно — важна только высота в один ряд.
const CHIP_TEXT = (count) => ` \u22EF ${count} \u0441\u0442\u0440. \u22EF `;

// глобальный реестр экземпляров — нужен, чтобы внешний код мог получить
// полный текст textarea, даже когда он сейчас замаскирован
const registry = new WeakMap();

export function getFullValue(ta) {
  const f = registry.get(ta);
  return f ? f.getFullText() : ta.value;
}

class JsonFolder {
  constructor(ta) {
    this.ta = ta;
    this.folded = new Set();   // startLine -> true (строка открытия свёрнутого блока)
    this.hoverStart = null;
    this.suppress = false;     // защита от рекурсии событий input
    this.allLines = ta.value.split("\n"); // полная модель текста
    registry.set(ta, this);

    // обёртка relative + textarea + зеркало + маскирующий слой
    this.wrap = document.createElement("div");
    this.wrap.className = "fold-wrap";
    ta.parentNode.insertBefore(this.wrap, ta);
    this.wrap.appendChild(ta);

    this.mirror = document.createElement("div");
    this.mirror.className = "fold-mirror";
    this.mirror.setAttribute("aria-hidden", "true");
    this.wrap.appendChild(this.mirror);

    this.maskLayer = document.createElement("div");
    this.maskLayer.className = "fold-mask-layer";
    this.maskLayer.setAttribute("aria-hidden", "true");
    this.wrap.appendChild(this.maskLayer);

    ta.addEventListener("input", () => this.onUserInput());
    ta.addEventListener("scroll", () => this.syncScroll());
    window.addEventListener("resize", () => this.refresh());

    // события мыши на зоне сворачивания ловит отдельный слой .fold-gutter-layer:
    // сам textarea должен оставаться доступным для редактирования, а зеркало и
    // маскирующий слой — прозрачны для кликов (pointer-events:none в CSS).
    this.gutterLayer = document.createElement("div");
    this.gutterLayer.className = "fold-gutter-layer";
    this.wrap.appendChild(this.gutterLayer);

    // offset* событий зависит от того, на какой элемент навешан слушатель —
    // вешаем точно на сам gutter-слой и не делегируем дальше
    this.gutterLayer.addEventListener("click", (e) => {
      if (e.target === this.gutterLayer) this.onGutterClick(e);
    });
    this.gutterLayer.addEventListener("mousemove", (e) => {
      if (e.target === this.gutterLayer) this.onGutterMove(e);
    });
    this.gutterLayer.addEventListener("mouseleave", () => {
      if (this.hoverStart !== null) { this.hoverStart = null; this.renderMirror(); }
    });

    this.refresh();
  }

  // ---------- модель ----------

  // ПОЛНЫЕ строки текста (независимо от режима маскирования textarea)
  lines() {
    return this.allLines;
  }

  getFullText() {
    return this.allLines.join("\n");
  }

  // Парсит текст и возвращает Map: startLine -> endLine для каждого
  // МНОГОСТРОЧНОГО блока { } или [ ]. Скобки внутри строковых значений
  // игнорируются ("{...}" в строке JSON — не блок).
  parseBlocks(lines) {
    const blocks = new Map();
    const stack = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let inStr = false, esc = false;
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{" || ch === "[") {
          stack.push({ line: li, ch });
        } else if (ch === "}" || ch === "]") {
          for (let k = stack.length - 1; k >= 0; k--) {
            const o = stack[k];
            if ((ch === "}" && o.ch === "{") || (ch === "]" && o.ch === "[")) {
              stack.splice(k, 1);
              if (o.line !== li && !blocks.has(o.line)) blocks.set(o.line, li);
              break;
            }
          }
        }
      }
    }
    return blocks;
  }

  // Диапазоны скрытых строк [start..end] (не включая строку открытия),
  // слитые и отсортированные. Блоки, чьи пары изменились (текст отредактирован),
  // выбрасываются здесь же.
  hiddenRanges() {
    const blocks = this.parseBlocks(this.lines());
    const ranges = [];
    for (const s of this.folded) {
      const e = blocks.get(s);
      if (e !== undefined) ranges.push([s + 1, e]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    return merged;
  }

  rangeAt(line, merged) {
    return merged.find(([a, b]) => line >= a && line <= b) || null;
  }

  // Самый внутренний блок, содержащий строку (или начинающийся на ней)
  blockAt(line) {
    const blocks = this.parseBlocks(this.lines());
    let best = null;
    for (const [s, e] of blocks) {
      if (s <= line && line <= e && (best === null || s > best[0])) best = [s, e];
    }
    return best;
  }

  // ---------- действия ----------

  toggle(start) {
    const blocks = this.parseBlocks(this.lines());
    if (this.folded.has(start)) {
      this.folded.delete(start);
    } else {
      if (!blocks.has(start)) return;
      this.folded.add(start);
      // внутренние свёрнутые блоки внутри нового скрытого диапазона не нужны
      const end = blocks.get(start);
      for (const s of Array.from(this.folded)) {
        if (s !== start && s > start && s <= end) this.folded.delete(s);
      }
    }
    this.refresh();
  }

  foldAll() {
    this.folded = new Set(this.parseBlocks(this.lines()).keys());
    this.refresh();
  }

  unfoldAll() {
    this.folded.clear();
    this.refresh();
  }

  // ---------- редактирование в замаскированном тексте ----------

  // Минимальный diff по строкам: [стартовый индекс, кол-во удалённых, новые строки].
  static lineDiff(o, n) {
    let s = 0;
    while (s < o.length && s < n.length && o[s] === n[s]) s++;
    let eO = o.length, eN = n.length;
    while (eO > s && eN > s && o[eO - 1] === n[eN - 1]) { eO--; eN--; }
    return [s, eO - s, n.slice(s, eN)];
  }

  isChipLine(line) {
    return /^[\u00A0 ]*\u22EF \d+ стр\. \u22EF$/.test(line);
  }

  chipCountOfLine(line) {
    const m = line.match(/\u22EF (\d+) стр\./);
    return m ? parseInt(m[1], 10) : 1;
  }

  // Карта индексов видимых строк -> реальные индексы полных строк.
  // Строки-плашки помечаются special-объектом {chip:true, count}.
  visibleMap(curLines, merged) {
    const map = [];
    let fi = 0;
    for (let vi = 0; vi < curLines.length; vi++) {
      const r = this.rangeAt(fi, merged);
      if (r) {
        map.push({ chip: true, count: Math.max(1, r[1] - r[0] + 1) });
        fi = r[1] + 1;
      } else {
        map.push({ chip: false, real: fi });
        fi++;
      }
    }
    return map;
  }

  onUserInput() {
    if (this.suppress) return; // программная установка value — игнорируем
    const curLines = this.ta.value.split("\n");
    if (this.folded.size === 0) {
      // textarea показывает полный текст — просто синхронизируем модель
      this.allLines = curLines;
      this.refresh();
      return;
    }
    // Режим маскирования: curLines — «видимая» версия текста.
    // Находим diff видимых строк и проецируем изменение в полную модель.
    const merged = this.hiddenRanges();
    const mapOld = this.visibleMap(this.visibleSnapshot, merged);
    const [vs, vDel, vNew] = JsonFolder.lineDiff(this.visibleSnapshot, curLines);

    // Границы изменённой области сдвигаем к краям смежных плашек, чтобы
    // правка не могла случайно «задеть» соседние со скрытым диапазоном строки.
    let a = vs;
    while (a > 0 && mapOld[a - 1] && mapOld[a - 1].chip) a--;
    let bEnd = vs + vDel;
    while (bEnd < mapOld.length && mapOld[bEnd].chip) bEnd++;

    const realStart = a < mapOld.length ? (mapOld[a].chip ? mapOld[a + 1] && mapOld[a + 1].real !== undefined ? mapOld[a + 1].real : this.allLines.length : mapOld[a].real) : this.allLines.length;
    let realEnd;
    if (bEnd >= mapOld.length) {
      realEnd = this.allLines.length;
    } else if (!mapOld[bEnd].chip) {
      realEnd = mapOld[bEnd].real;
    } else {
      // конец изменения внутри/на границе плашки: скрываемый диапазон тоже
      // затрагивается — включаем его целиком (от realStart уже учтён)
      let lastReal = -1;
      for (let k = bEnd; k < mapOld.length; k++) {
        if (!mapOld[k].chip) { lastReal = mapOld[k].real; break; }
      }
      realEnd = lastReal === -1 ? this.allLines.length : lastReal;
    }
    const removedCount = Math.max(0, realEnd - realStart);
    // из новых строк убираем сами плашки (их содержимое — служебное)
    const cleanNew = vNew.filter((l) => !this.isChipLine(l));
    this.allLines.splice(realStart, removedCount, ...cleanNew);
    // сдвиг индексов свёрнутых блоков после места правки
    const delta = cleanNew.length - removedCount;
    if (delta !== 0) {
      const nf = new Set();
      for (const st of this.folded) nf.add(st >= realEnd ? st + delta : st);
      this.folded = nf;
    }
    this.refresh();
  }

  // ---------- события gutter ----------

  // Количество визуальных (с учётом переносов) строк, которые занимает
  // данная исходная строка в textarea с white-space: pre-wrap.
  visualRows(line, textWidth) {
    if (!line.length) return 1;
    // чередование сегментов без пробелов и одиночных пробелов:
    // перенос возможен только перед пробелом или после него
    const parts = line.match(/\S+|\s/g) || [];
    let rows = 1, cur = 0;
    for (const p of parts) {
      const w = this.measure(p);
      if (/^\s/.test(p)) { cur += w; continue; } // пробел — висячий, не инициирует перенос
      if (cur + w > textWidth + 0.5 && cur > 0) { rows++; cur = w; }
      else cur += w;
    }
    return rows;
  }

  measure(s) {
    if (!this._canvas) this._canvas = document.createElement("canvas");
    const ctx = this._canvas.getContext("2d");
    const cs = getComputedStyle(this.ta);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`.trim();
    return ctx.measureText(s).width;
  }

  lineHeight() {
    const cs = getComputedStyle(this.ta);
    return parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.5;
  }

  // Верхние позиции (в координатах content-области textarea) каждой видимой
  // строки. В режиме маскирования textarea содержит ровно видимые строки,
  // поэтому позиции считаются простым суммированием визуальных рядов.
  visibleLineTops(visibleLines) {
    const cs = getComputedStyle(this.ta);
    const lh = this.lineHeight();
    const padTop = parseFloat(cs.paddingTop) || 0;
    const textWidth = this.ta.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const tops = [];
    let acc = padTop;
    for (const line of visibleLines) {
      tops.push(acc);
      acc += this.visualRows(line, textWidth) * lh;
    }
    return tops;
  }

  // offsetY (относительно gutter-слоя) -> индекс ВИДИМОЙ строки (или null)
  visibleRowAtY(offsetY) {
    const y = offsetY + this.ta.scrollTop;
    const tops = this.visibleLineTops(this.visibleSnapshot);
    const lh = this.lineHeight();
    for (let i = 0; i < tops.length; i++) {
      const h = (i + 1 < tops.length ? tops[i + 1] : tops[i] + lh) - tops[i];
      if (y < tops[i] + h) return i;
    }
    return null;
  }

  onGutterClick(e) {
    const index = this.visibleRowAtY(e.offsetY);
    if (index === null) return;
    const merged = this.hiddenRanges();
    const map = this.visibleMap(this.visibleSnapshot, merged);
    if (map[index].chip) {
      // клик по плашке «⋯ N строк» — разворачиваем все блоки, чей скрытый
      // диапазон формирует эту плашку. Диапазон: от строки после предыдущей
      // реальной строки до строки перед следующей реальной.
      let prevReal = -1;
      for (let k = index - 1; k >= 0; k--) if (!map[k].chip) { prevReal = map[k].real; break; }
      let nextReal = this.allLines.length;
      for (let k = index + 1; k < map.length; k++) if (!map[k].chip) { nextReal = map[k].real; break; }
      const from = prevReal + 1;
      const to = nextReal - 1;
      let changed = false;
      for (const s of Array.from(this.folded)) {
        const r = merged.find(([a, b]) => a >= from && b <= to && a === s + 1);
        if (r) { this.folded.delete(s); changed = true; }
      }
      if (changed) this.refresh();
      return;
    }
    const b = this.blockAt(map[index].real);
    if (b) this.toggle(b[0]);
  }

  onGutterMove(e) {
    const index = this.visibleRowAtY(e.offsetY);
    if (index === null) return;
    const map = this.visibleMap(this.visibleSnapshot, this.hiddenRanges());
    if (map[index].chip) {
      // над плашкой — тоже кликабельно (развернуть)
      this.gutterLayer.style.cursor = "pointer";
      if (this.hoverStart !== null) { this.hoverStart = null; this.renderMirror(); }
      return;
    }
    const b = this.blockAt(map[index].real);
    this.gutterLayer.style.cursor = b ? "pointer" : "default";
    const ns = b ? b[0] : null;
    if (ns !== this.hoverStart) { this.hoverStart = ns; this.renderMirror(); }
  }

  // ---------- рендер ----------

  refresh() {
    const total = this.lines().length;
    for (const s of Array.from(this.folded)) {
      if (s >= total) this.folded.delete(s);
    }
    this.syncTextareaValue();
    this.renderMirror();
    this.renderMask();
    this.syncScroll();
  }

  // Пересобирает value textarea: полный текст, если свёрнутых блоков нет,
  // либо «видимая» версия, где каждая скрытая последовательность строк
  // заменена одной строкой-заглушкой. Скрытые строки физически отсутствуют
  // в textarea, поэтому они НИКАК не могут просвечивать под плашкой.
  syncTextareaValue() {
    const lines = this.lines();
    const merged = this.hiddenRanges();
    if (this.folded.size === 0) {
      this.visibleSnapshot = lines.slice();
      this.visibleSnapshotIsChip = lines.map(() => false);
      this.setTaValue(lines.join("\n"));
      this.maskLayer.style.display = "none";
      this.maskLayer.innerHTML = "";
      return;
    }
    const vis = [];
    const isChip = [];
    let i = 0;
    while (i < lines.length) {
      const r = this.rangeAt(i, merged);
      if (r) {
        const count = r[1] - r[0] + 1;
        vis.push(CHIP_TEXT(count));
        isChip.push(true);
        i = r[1] + 1;
      } else {
        vis.push(lines[i]);
        isChip.push(false);
        i++;
      }
    }
    this.visibleSnapshot = vis;
    this.visibleSnapshotIsChip = isChip;
    this.setTaValue(vis.join("\n"));
    this.maskLayer.style.display = "";
  }

  setTaValue(text) {
    if (this.ta.value === text) return;
    const selStart = Math.min(this.ta.selectionStart, text.length);
    const selEnd = Math.min(this.ta.selectionEnd, text.length);
    this.suppress = true;
    this.ta.value = text;
    this.suppress = false;
    try { this.ta.setSelectionRange(selStart, selEnd); } catch (e) { /* ignore */ }
  }

  // Зеркало: фон редактора + стрелки + видимые плашки «⋯ N стр.» (внизу, под
  // текстом textarea). Текст в плашках — единственный, поэтому наложения
  // двух текстов нет.
  renderMirror() {
    const lines = this.lines();
    const blocks = this.parseBlocks(lines);
    const merged = this.hiddenRanges();

    let html = "";
    let i = 0;
    while (i < lines.length) {
      const r = this.rangeAt(i, merged);
      if (r) {
        const count = r[1] - r[0] + 1;
        html += `<div class="fm fm-chip"><span class="fg"></span>\u22EF ${count} \u0441\u0442\u0440.</div>`;
        i = r[1] + 1;
        continue;
      }
      const canFold = blocks.has(i);
      const isFolded = this.folded.has(i);
      const isHover = this.hoverStart === i;
      const arrow = canFold ? (isFolded ? "▾" : "▸") : "";
      const cls = "fm" + (isFolded ? " fm-closed" : "") + (isHover && canFold ? " fm-hover" : "");
      html += `<div class="${cls}" data-start="${i}"><span class="fg">${arrow}</span></div>`;
      i++;
    }
    this.mirror.innerHTML = html;
  }

  // Непрозрачные заглушки цвета фона редактора поверх служебных строк-
  // заглушек textarea (« ⋯ N стр. ⋯ »), чтобы их текст не был виден.
  // Видимую плашку с надписью рисует зеркало снизу.
  renderMask() {
    if (this.folded.size === 0) { this.maskLayer.innerHTML = ""; return; }
    const cs = getComputedStyle(this.ta);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const tops = this.visibleLineTops(this.visibleSnapshot);
    const lh = this.lineHeight();
    let html = "";
    for (let i = 0; i < this.visibleSnapshot.length; i++) {
      if (!this.visibleSnapshotIsChip[i]) continue;
      const top = tops[i] - this.ta.scrollTop;
      const bottom = (i + 1 < tops.length ? tops[i + 1] : tops[i] + lh) - this.ta.scrollTop;
      html += `<div class="fold-chip" style="top:${top}px;left:${padLeft}px;right:8px;height:${bottom - top}px"></div>`;
    }
    this.maskLayer.innerHTML = html;
  }

  syncScroll() {
    // у зеркала overflow:hidden — прокрутка через scrollTop не работает,
    // поэтому смещаем содержимое трансформом
    // зеркало позиционировано по inset:0 обёртки, а textarea имеет рамку 1px —
    // компенсируем смещение, чтобы плашки совпадали с строками редактора
    const bt = parseFloat(getComputedStyle(this.ta).borderTopWidth) || 0;
    const bl = parseFloat(getComputedStyle(this.ta).borderLeftWidth) || 0;
    this.mirror.style.transform = `translate(${bl - this.ta.scrollLeft}px, ${bt - this.ta.scrollTop}px)`;
    if (this.folded.size > 0) this.renderMask();
  }
}

export { JsonFolder, FOLD_ZONE };
