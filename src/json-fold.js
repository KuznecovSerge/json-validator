// json-fold.js — сворачивание блоков JSON в textarea-редакторе.
//
// Как это работает:
// - Значение textarea ВСЕГДА остаётся полным — пользовательские данные не
//   изменяются при сворачивании.
// - Над textarea размещается синхронизированное «зеркало» (transparent overlay)
//   с той же метрикой шрифта и переносами строк.
// - Слева каждой строки, открывающей многострочный блок { } или [ ], рисуется
//   стрелка ▸ (клик — свернуть) / ▾ (свёрнуто). Клик по стрелке скрывает
//   строки блока: они «вырезаются» из отображения зеркала, а на их месте
//   появляется плашка «⋯ N строк». Скрытые строки textarea перекрываются
//   непрозрачным фоном плашки, поэтому визуально не видны.
// - Кнопки «Свернуть все» / «Развернуть все» вызывают foldAll()/unfoldAll().
// - getFullValue(ta) возвращает полный текст (value textarea всегда полон),
//   используется внешним кодом для валидации/форматирования.

const FOLD_ZONE = 22; // px — кликабельная зона слева, где живут стрелки

export function getFullValue(ta) {
  return ta.value;
}

class JsonFolder {
  constructor(ta) {
    this.ta = ta;
    this.folded = new Set();   // startLine -> true (строка открытия свёрнутого блока)
    this.hoverStart = null;

    // обёртка relative + textarea + mirror поверх
    this.wrap = document.createElement("div");
    this.wrap.className = "fold-wrap";
    ta.parentNode.insertBefore(this.wrap, ta);
    this.wrap.appendChild(ta);

    this.mirror = document.createElement("div");
    this.mirror.className = "fold-mirror";
    this.mirror.setAttribute("aria-hidden", "true");
    this.wrap.appendChild(this.mirror);

    ta.addEventListener("input", () => this.refresh());
    ta.addEventListener("scroll", () => this.syncScroll());
    window.addEventListener("resize", () => this.refresh());

    // события мыши на зоне сворачивания ловим через overlay-полосу слева:
    // сам textarea должен оставаться доступным для редактирования, поэтому
    // зону реализует зеркало с pointer-events:none, а клики по gutter ловит
    // отдельный слой .fold-gutter-layer (pointer-events:auto только в левой
    // полосе шириной FOLD_ZONE).
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
      if (this.hoverStart !== null) { this.hoverStart = null; this.render(); }
    });

    this.refresh();
  }

  // ---------- модель ----------

  lines() {
    return this.ta.value.split("\n");
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

  // offsetY передаётся относительно gutter-слоя, который начинается сразу
  // под рамкой редактора; padding textarea уже входит в координаты слоя.
  lineAtY(offsetY) {
    const cs = getComputedStyle(this.ta);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.5;
    const padTop = 0;
    const y = offsetY - padTop + this.ta.scrollTop;
    if (y < 0) return null;
    const merged = this.hiddenRanges();
    const lines = this.lines();
    const textWidth = this.ta.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    let acc = 0;
    let i = 0;
    while (i < lines.length) {
      const r = this.rangeAt(i, merged);
      let rows;
      if (r) {
        // скрытый диапазон: плашка высотой count*lh (в mirror тоже one block),
        // в textarea строки остались — их реальная высота:
        rows = 0;
        for (let k = r[0]; k <= r[1]; k++) rows += this.visualRows(lines[k], textWidth);
        if (y < acc + rows * lh) return r[0]; // клик по свёрнутой области → первая скрытая строка
        acc += rows * lh;
        i = r[1] + 1;
        continue;
      }
      rows = this.visualRows(lines[i], textWidth);
      if (y < acc + rows * lh) return i;
      acc += rows * lh;
      i++;
    }
    return null;
  }

  onGutterClick(e) {
    const line = this.lineAtY(e.offsetY);
    if (line === null) return;
    // клик по свёрнутой области (плашке) — разворачиваем создавший её блок
    const merged = this.hiddenRanges();
    const r = this.rangeAt(line, merged);
    if (r) {
      for (const s of this.folded) {
        if (s + 1 === r[0]) { this.toggle(s); return; }
      }
      // диапазон мог слиться из нескольких блоков — снимем все, чьи скрытые
      // строки попадают в него
      for (const s of Array.from(this.folded)) {
        if (s + 1 >= r[0] && s + 1 <= r[1]) this.toggle(s);
      }
      return;
    }
    const b = this.blockAt(line);
    if (b) this.toggle(b[0]);
  }

  onGutterMove(e) {
    const line = this.lineAtY(e.offsetY);
    if (line === null) return;
    const merged = this.hiddenRanges();
    const foldable = this.rangeAt(line, merged) ? true : !!this.blockAt(line);
    this.gutterLayer.style.cursor = foldable ? "pointer" : "default";
    const b = this.blockAt(line);
    const ns = b ? b[0] : null;
    if (ns !== this.hoverStart) { this.hoverStart = ns; this.render(); }
  }

  // ---------- рендер ----------

  refresh() {
    const total = this.lines().length;
    for (const s of Array.from(this.folded)) {
      if (s >= total) this.folded.delete(s);
    }
    this.render();
    this.syncScroll();
  }

  render() {
    const lines = this.lines();
    const blocks = this.parseBlocks(lines);
    const merged = this.hiddenRanges();
    const cs = getComputedStyle(this.ta);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.5;
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    let html = "";
    let i = 0;
    while (i < lines.length) {
      const r = this.rangeAt(i, merged);
      if (r) {
        const count = r[1] - r[0] + 1;
        html += `<div class="fm fm-ellipsis" data-start="${r[0]}" style="height:${count * lh}px"><span class="fe">⋯ ${count} стр.</span></div>`;
        i = r[1] + 1;
        continue;
      }
      const canFold = blocks.has(i);
      const isFolded = this.folded.has(i);
      const isHover = this.hoverStart === i;
      const arrow = canFold ? (isFolded ? "▾" : "▸") : "";
      const cls = "fm" + (isFolded ? " fm-closed" : "") + (isHover && canFold ? " fm-hover" : "");
      html += `<div class="${cls}" data-start="${i}"><span class="fg">${arrow}</span><span class="ft">${esc(lines[i]) || "&#8203;"}</span></div>`;
      i++;
    }
    this.mirror.innerHTML = html;
  }

  syncScroll() {
    this.mirror.scrollTop = this.ta.scrollTop;
    this.mirror.scrollLeft = this.ta.scrollLeft;
  }
}

export { JsonFolder, FOLD_ZONE };
