// json-fold.js — сворачивание блоков JSON в textarea-редакторе.
//
// Архитектура (исправлено наложение двух текстов):
// - Единственный видимый слой текста — сам textarea. Зеркало под ним рисует
//   только невидимые заглушки строк (для совпадения высоты/переносов),
//   видимые стрелки ▸ и плашку «⋯ N стр.» для свёрнутых блоков.
// - value textarea ВСЕГДА содержит полный текст пользователя — данные не
//   изменяются при сворачивании, валидация читает ta.value как раньше.
// - Скрытые строки визуально перекрываются плашкой зеркала (z-index над
//   полем) с точным позиционированием по высоте строк textarea.
// - Кнопки «Свернуть все» / «Развернуть все» вызывают foldAll()/unfoldAll().

const FOLD_ZONE = 22; // px — кликабельная зона слева, где живут стрелки

export function getFullValue(ta) {
  return ta.value;
}

// ---------- чистые функции (тестируются без DOM) ----------

// Парсит строки и возвращает Map: startLine -> endLine для каждого
// МНОГОСТРОЧНОГО блока { } или [ ]. Скобки внутри строковых значений
// игнорируются ("текст { ... } в строке" — не блок).
function parseBlocks(lines) {
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

// Слитые и отсортированные диапазоны скрытых строк [start..end]
// (не включая строки открытия блоков).
function computeHiddenRanges(lines, foldedSet) {
  const blocks = parseBlocks(lines);
  const ranges = [];
  for (const s of foldedSet) {
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

// Самый внутренний блок, содержащий строку (или начинающийся на ней)
function blockAtLine(lines, line) {
  const blocks = parseBlocks(lines);
  let best = null;
  for (const [s, e] of blocks) {
    if (s <= line && line <= e && (best === null || s > best[0])) best = [s, e];
  }
  return best;
}

// ---------- класс редактора ----------

class JsonFolder {
  constructor(ta) {
    this.ta = ta;
    this.folded = new Set(); // startLine -> true
    this.hoverStart = null;
    this._rendering = false; // служебный флаг: текущий render не должен
                             // перерисовывать сам себя из onGutterMove

    // обёртка relative: textarea (полный текст) + зеркало НАД ним
    this.wrap = document.createElement("div");
    this.wrap.className = "fold-wrap";
    ta.parentNode.insertBefore(this.wrap, ta);
    this.wrap.appendChild(ta);

    this.mirror = document.createElement("div");
    this.mirror.className = "fold-mirror";
    this.mirror.setAttribute("aria-hidden", "true");
    this.wrap.appendChild(this.mirror);

    this.gutterLayer = document.createElement("div");
    this.gutterLayer.className = "fold-gutter-layer";
    this.wrap.appendChild(this.gutterLayer);

    ta.addEventListener("input", () => this.refresh());
    ta.addEventListener("scroll", () => this.syncScroll());
    window.addEventListener("resize", () => this.refresh());

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

  lines() {
    return this.ta.value.split("\n");
  }

  hiddenRanges() {
    return computeHiddenRanges(this.lines(), this.folded);
  }

  blockAt(line) {
    return blockAtLine(this.lines(), line);
  }

  // ---------- действия ----------

  toggle(start) {
    const blocks = parseBlocks(this.lines());
    if (this.folded.has(start)) {
      this.folded.delete(start);
    } else {
      if (!blocks.has(start)) return;
      this.folded.add(start);
      const end = blocks.get(start);
      for (const s of Array.from(this.folded)) {
        if (s !== start && s > start && s <= end) this.folded.delete(s);
      }
    }
    this.refresh();
  }

  foldAll() {
    this.folded = new Set(parseBlocks(this.lines()).keys());
    this.refresh();
  }

  unfoldAll() {
    this.folded.clear();
    this.refresh();
  }

  // ---------- события gutter ----------

  // Количество визуальных (с учётом word-wrap) строк у данной исходной
  // строки в textarea.
  visualRows(line, textWidth) {
    if (!line.length) return 1;
    const parts = line.match(/\S+|\s/g) || [];
    let rows = 1, cur = 0;
    for (const p of parts) {
      const w = this.measure(p);
      if (/^\s/.test(p)) { cur += w; continue; }
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

  metrics() {
    const cs = getComputedStyle(this.ta);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.5;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const textWidth = this.ta.clientWidth - padLeft - padRight;
    return { lh, padTop, padLeft, textWidth };
  }

  // Реальная высота (в px) диапазона полных строк [a..b] в textarea.
  rangeHeight(a, b, m) {
    const lines = this.lines();
    let h = 0;
    for (let i = a; i <= b && i < lines.length; i++) h += this.visualRows(lines[i], m.textWidth) * m.lh;
    return h;
  }

  // Номер ПОЛНОЙ строки под offsetY в координатах gutter-слоя.
  lineAtY(offsetY) {
    const m = this.metrics();
    const y = offsetY - m.padTop + this.ta.scrollTop;
    if (y < 0) return null;
    const merged = this.hiddenRanges();
    const lines = this.lines();
    let acc = 0;
    let i = 0;
    while (i < lines.length) {
      const r = merged.find(([a, b]) => i >= a && i <= b);
      let rows;
      if (r) {
        rows = 0;
        for (let k = r[0]; k <= r[1]; k++) rows += this.visualRows(lines[k], m.textWidth);
        if (y < acc + rows * m.lh) return r[0]; // клик по свёрнутой области
        acc += rows * m.lh;
        i = r[1] + 1;
        continue;
      }
      rows = this.visualRows(lines[i], m.textWidth);
      if (y < acc + rows * m.lh) return i;
      acc += rows * m.lh;
      i++;
    }
    return null;
  }

  onGutterClick(e) {
    const line = this.lineAtY(e.offsetY);
    if (line === null) return;
    const merged = this.hiddenRanges();
    const r = merged.find(([a, b]) => line >= a && line <= b);
    if (r) {
      // клик по свёрнутой области — разворачиваем блоки, создавшие диапазон
      let done = false;
      for (const s of Array.from(this.folded)) {
        if (s + 1 >= r[0] && s + 1 <= r[1]) { this.toggle(s); done = true; }
      }
      if (!done) this.unfoldAll();
      return;
    }
    const b = this.blockAt(line);
    if (b) this.toggle(b[0]);
  }

  onGutterMove(e) {
    const line = this.lineAtY(e.offsetY);
    if (line === null) return;
    const merged = this.hiddenRanges();
    const inHidden = !!merged.find(([a, b]) => line >= a && line <= b);
    const b = this.blockAt(line);
    this.gutterLayer.style.cursor = inHidden || b ? "pointer" : "default";
    const ns = b ? b[0] : null;
    if (ns !== this.hoverStart) {
      this.hoverStart = ns;
      if (!this._rendering) this.render();
    }
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
    this._rendering = true;
    try { this.renderInner(); } finally { this._rendering = false; }
  }

  renderInner() {
    const lines = this.lines();
    const blocks = parseBlocks(lines);
    const merged = this.hiddenRanges();
    const m = this.metrics();
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // y-координаты (в контенте textarea) начала каждой полной строки
    let html = "";
    let y = 0;
    let i = 0;
    while (i < lines.length) {
      const r = merged.find(([a, b]) => i >= a && i <= b);
      if (r) {
        const count = r[1] - r[0] + 1;
        const h = this.rangeHeight(r[0], r[1], m);
        html += `<div class="fm fm-ellipsis" style="top:${m.padTop + y}px;height:${h}px">` +
                `<span class="fe">⋯ ${count} стр.</span></div>`;
        y += h;
        i = r[1] + 1;
        continue;
      }
      const canFold = blocks.has(i);
      const isHover = this.hoverStart === i;
      const arrow = canFold ? "▸" : "";
      const cls = "fm fm-row" + (isHover && canFold ? " fm-hover" : "");
      html += `<div class="${cls}" style="top:${m.padTop + y}px;height:${this.visualRows(lines[i], m.textWidth) * m.lh}px">` +
              `<span class="fg">${arrow}</span><span class="ft">${esc(lines[i]) || "&#8203;"}</span></div>`;
      y += this.visualRows(lines[i], m.textWidth) * m.lh;
      i++;
    }
    this.mirror.innerHTML = html;
  }

  syncScroll() {
    this.mirror.scrollTop = this.ta.scrollTop;
    this.mirror.scrollLeft = this.ta.scrollLeft;
  }
}

export { JsonFolder, FOLD_ZONE, parseBlocks, computeHiddenRanges, blockAtLine };
