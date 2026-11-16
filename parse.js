// parse.js — a fast Markdown renderer whose parse(markdown) returns exactly the HTML
// that marked 18.1.3 returns with its default options (GFM on), for less CPU time.
// Dependency-free: a hand-written block scanner plus an inline scanner with a
// delimiter-stack emphasis pass. No state is kept between calls.

// ---------- small helpers ----------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape every special char (code spans / blocks, attribute values). */
function escapeAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** Escape like marked's text escaping: & is kept when it begins an entity reference. */
function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    else if (c === '&') {
      // entity? &#123; &#x1F; &name;
      let j = i + 1;
      if (s[j] === '#') {
        j++;
        if (s[j] === 'x' || s[j] === 'X') {
          j++;
          const st = j;
          while (j < s.length && j - st < 6 && /[0-9a-fA-F]/.test(s[j])) j++;
          if (j > st && s[j] === ';') rep = null; else rep = '&amp;';
        } else {
          const st = j;
          while (j < s.length && j - st < 7 && s[j] >= '0' && s[j] <= '9') j++;
          if (j > st && s[j] === ';') rep = null; else rep = '&amp;';
        }
      } else {
        const st = j;
        while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        if (j > st && s[j] === ';') rep = null; else rep = '&amp;';
      }
    }
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  return out + s.slice(start);
}

const RE_WS = /\s/;
const RE_PUNCT = /[\p{P}\p{S}]/u;
function isWs(c) {
  return c !== undefined && RE_WS.test(c);
}
function isAsciiPunct(c) {
  if (c === undefined) return false;
  const o = c.charCodeAt(0);
  return (o >= 33 && o <= 47) || (o >= 58 && o <= 64) || (o >= 91 && o <= 96) || (o >= 123 && o <= 126);
}
function isPunct(c) {
  if (c === undefined) return false;
  const o = c.charCodeAt(0);
  if (o < 128) {
    return (o >= 33 && o <= 47) || (o >= 58 && o <= 64) || (o >= 91 && o <= 96) || (o >= 123 && o <= 126);
  }
  return RE_PUNCT.test(c);
}

/** marked's cleanUrl: encodeURI, then un-double-encode %. Returns null on bad input. */
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/** Normalize a link label the way marked does for definition lookup. */
function normLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// ---------- block level ----------

// Split source into line spans [start, end) where end excludes the '\n'.
function splitLines(src) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') {
      lines.push([start, i]);
      start = i + 1;
    }
  }
  if (start < src.length) lines.push([start, src.length]);
  else if (src.length === 0) lines.push([0, 0]);
  return lines;
}

const RE_BLANK = /^[ \t]*$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const RE_ATX_CLOSE = /[ \t]+#+[ \t]*$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_QUOTE = /^ {0,3}>[ \t]?/;
const RE_DEF_START = /^ {0,3}\[/;
const RE_LIST = /^ {0,3}([*+-]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table td tfoot th thead title tr track ul').split(' '));

function countIndent(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

// Expand a leading tab into spaces count for indent measurement (tab = to next multiple of 4).
function visualIndent(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') col++;
    else if (line[i] === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Expand the leading [ \t]* run of a line to spaces, columns counted from startCol.
function detabLeadFrom(line, startCol) {
  if (!line.includes('\t')) return line;
  let col = startCol;
  let out = '';
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col++; }
    else { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    i++;
  }
  return out + line.slice(i);
}
function detabLead(line) { return detabLeadFrom(line, 0); }

// Remove up to n columns of indentation from a line; returns the rest.
// The leading whitespace run is expanded to spaces (column-true) first.
function stripIndent(line, n) {
  if (n <= 0) return line;
  if (!line.includes('\t')) {
    let run = 0;
    while (run < line.length && line[run] === ' ') run++;
    return line.slice(Math.min(n, run));
  }
  const d = detabLead(line);
  let run = 0;
  while (run < d.length && d[run] === ' ') run++;
  return d.slice(Math.min(n, run));
}

// Indented-code strip: consume one 4-column indent unit. A tab counts as
// a whole unit (or the remainder of one); anything past the unit is raw.
function codeStripIndent(line) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < 4) {
    const c = line[i];
    if (c === ' ') { col++; i++; continue; }
    if (c === '\t') { col += 4 - (col % 4); i++; continue; }
    break;
  }
  return line.slice(i);
}

/** Strip a blockquote marker (and its one optional space, tab-aware). */
function stripQuoteMarker(line) {
  const m = /^ {0,3}>/.exec(line);
  if (!m) return null;
  let idx = m[0].length;
  let col = idx;
  if (line[idx] === ' ') { idx++; col++; return detabLeadFrom(line.slice(idx), col); }
  if (line[idx] === '\t') {
    const w = 4 - (col % 4);
    return ' '.repeat(w - 1) + detabLeadFrom(line.slice(idx + 1), col + w);
  }
  return detabLeadFrom(line.slice(idx), col);
}

/** Try to parse a link reference definition starting at lines[i].
 *  Returns {label, href, title, next} or null. Cursor-based over lines:
 *  the label and the title may span lines; the title must be separated
 *  from the destination by whitespace; a failed title rewinds to just
 *  after the destination (valid only if that line then ends). */
function tryDef(lines, i, src) {
  const n = lines.length;
  const lineAt = (k) => src.slice(lines[k][0], lines[k][1]);
  let li = i;
  let cur = lineAt(li);
  let p = 0;
  while (p < cur.length && cur[p] === ' ') p++;
  if (p > 3 || cur[p] !== '[') return null;
  p++;
  // label: scan to unescaped ']' (may span lines)
  let label = '';
  let closed = false;
  while (li < n) {
    while (p < cur.length) {
      const c = cur[p];
      if (c === '\\') {
        if (p + 1 < cur.length) { label += c + cur[p + 1]; p += 2; }
        else { label += c; p++; }
        continue;
      }
      if (c === '[') return null;
      if (c === ']') { closed = true; p++; break; }
      label += c; p++;
    }
    if (closed) break;
    if (li + 1 >= n) return null;
    label += '\n';
    li++;
    cur = lineAt(li);
    p = 0;
  }
  if (!closed || cur[p] !== ':') return null;
  p++;
  if (label.length > 999 || !/\S/.test(label)) return null;
  // spaces/tabs, then at most one line break, before the destination
  const skipSp = () => { let s = 0; while (p < cur.length && (cur[p] === ' ' || cur[p] === '\t')) { p++; s++; } return s; };
  skipSp();
  if (p >= cur.length) {
    if (li + 1 >= n) return null;
    li++;
    cur = lineAt(li);
    p = 0;
    skipSp();
    if (p >= cur.length) return null; // blank line: no destination
  }
  // destination
  let dest;
  if (cur[p] === '<') {
    const gt = cur.indexOf('>', p + 1);
    if (gt === -1) return null;
    dest = cur.slice(p + 1, gt);
    if (dest.includes('<')) return null;
    p = gt + 1;
  } else {
    const st = p;
    let depth = 0;
    while (p < cur.length) {
      const c = cur[p];
      if (c === '\\') { p += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t') break;
      p++;
    }
    if (p === st) return null;
    dest = cur.slice(st, p);
  }
  const destLi = li;
  const destP = p;
  // optional title
  const attemptTitle = (tli, tp) => {
    // returns {title, endLi} or null; tcur is line tli, tp at the opener
    let tcur = lineAt(tli);
    const open = tcur[tp];
    const closeCh = open === '(' ? ')' : open;
    let text = '';
    let q = tp + 1;
    let l = tli;
    for (;;) {
      while (q < tcur.length) {
        const c = tcur[q];
        if (c === '\\' && q + 1 < tcur.length) { text += c + tcur[q + 1]; q += 2; continue; }
        if (c === closeCh) {
          // after the title only spaces/tabs to end of line
          let r = q + 1;
          while (r < tcur.length && (tcur[r] === ' ' || tcur[r] === '\t')) r++;
          if (r < tcur.length) return null;
          return { title: text, endLi: l };
        }
        if (open === '(' && c === '(') return null;
        text += c; q++;
      }
      if (l + 1 >= n) return null;
      const nxt = lineAt(l + 1);
      if (/^[ \t]*$/.test(nxt)) return null; // titles cannot span a blank line
      text += '\n';
      l++;
      tcur = lineAt(l);
      q = 0;
    }
  };
  let title = null;
  let endLi = destLi;
  {
    const skipped = skipSp();
    let t = null;
    if (p < cur.length && (cur[p] === '"' || cur[p] === "'" || cur[p] === '(') && skipped > 0) {
      t = attemptTitle(li, p);
    } else if (p >= cur.length && li + 1 < n) {
      // title may begin on the next line
      const nl = lineAt(li + 1);
      let q = 0;
      while (q < nl.length && (nl[q] === ' ' || nl[q] === '\t')) q++;
      if (q < nl.length && (nl[q] === '"' || nl[q] === "'" || nl[q] === '(')) {
        t = attemptTitle(li + 1, q);
      }
    }
    if (t) { title = t.title; endLi = t.endLi; }
    else {
      // no title: the rest of the destination line must be blank
      const restLine = lineAt(destLi);
      let r = destP;
      while (r < restLine.length && (restLine[r] === ' ' || restLine[r] === '\t')) r++;
      if (r < restLine.length) return null;
      endLi = destLi;
    }
  }
  return { label, href: dest, title, next: endLi + 1 };
}

/** Split a table row into cells (handles \| and pipes inside code spans). */
function splitRow(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  let code = 0; // backtick run length when inside code span
  row = row.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  while (i < row.length) {
    const c = row[i];
    if (c === '\\' && row[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '\\' && row[i + 1] === '`') { cur += '\\`'; i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (row[i + run] === '`') run++;
      if (code === 0) code = run;
      else if (code === run) code = 0;
      cur += '`'.repeat(run);
      i += run;
      continue;
    }
    if (c === '|' && code === 0) { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Check a delimiter row; returns align array or null. */
function parseDelimRow(line) {
  const t = line.trim();
  if (!t.includes('-')) return null;
  const cells = splitRow(t);
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell.replace(/ /g, ''));
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return aligns;
}

/** Does this line start an HTML block? Returns type 1-7 or 0. */
function htmlBlockType(line) {
  const m = /^ {0,3}</.exec(line);
  if (!m) return 0;
  const rest = line.slice(m[0].length);
  if (/^(pre|script|style|textarea)(?=[\s>]|$)/i.test(rest)) return 1;
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (/^![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('![CDATA[')) return 5;
  let tag = null;
  if (rest[0] === '/') {
    if (/^\/[A-Za-z][A-Za-z0-9-]*\s*>/.test(rest)) tag = /^\/([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  } else {
    tag = /^([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(rest);
  }
  if (tag && /^(script|pre|style|textarea)$/i.test(tag[1])) return 0;
  if (tag && BLOCK_TAGS.has(tag[1].toLowerCase())) return 6;
  if (tag) {
    // type 7: a complete open or closing tag followed only by whitespace
    const full = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>[ \t]*$/.exec(line);
    if (full) return 7;
  }
  return 0;
}

/** Parse blocks from src; defs is a shared Map for link references. Returns HTML. */
function parseBlocks(src, defs, tight = false, collectOnly = false, eofNl = true, inList = false, lazyLines = null) {
  const lines = splitLines(src);
  const n = lines.length;
  const lineAt = (i) => src.slice(lines[i][0], lines[i][1]);
  let out = '';
  let i = 0;
  while (i < n) {
    const line = lineAt(i);
    if (RE_BLANK.test(line)) { i++; continue; }

    // fenced code
    let m = RE_FENCE.exec(line);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      const fence = m[1];
      const ch = fence[0];
      const info = m[2].trim();
      const indent = countIndent(line);
      let j = i + 1;
      let close = -1;
      while (j < n) {
        const l2 = lineAt(j);
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l2);
        if (cm && cm[1][0] === ch && cm[1].length >= fence.length) { close = j; break; }
        j++;
      }
      const end = close === -1 ? n : close;
      let content = '';
      if (!collectOnly) {
        for (let k = i + 1; k < end; k++) {
          content += stripIndent(lineAt(k), indent) + '\n';
        }
        if (close !== -1 && content.endsWith('\n\n')) content = content.slice(0, -1);
      }
      const lang = info ? unescapeBackslash((/^\S+/.exec(info) || [''])[0]) : '';
      if (!collectOnly) out += '<pre><code' + (lang ? ' class="language-' + escapeText(lang) + '"' : '') + '>' + escapeAll(content) + '</code></pre>\n';
      i = close === -1 ? n : close + 1;
      continue;
    }

    // ATX heading
    m = RE_ATX.exec(line);
    if (m) {
      let text = (m[2] ?? '').replace(/[ \t]+$/, '');
      text = text.replace(RE_ATX_CLOSE, '');
      if (/^#+$/.test(text)) text = '';
      out += '<h' + m[1].length + '>' + (collectOnly ? '' : inlineHtml(text, defs)) + '</h' + m[1].length + '>\n';
      i++;
      continue;
    }

    // thematic break
    if (RE_HR.test(line)) { out += '<hr>\n'; i++; continue; }

    // blockquote
    if (RE_QUOTE.test(line)) {
      const inner = [];
      const lazyIdx = new Set();
      let j = i;
      let lastWasPara = false;
      let qFence = false;
      while (j < n) {
        const l = lineAt(j);
        const qm = RE_QUOTE.exec(l);
        if (qm) {
          const stripped = stripQuoteMarker(l);
          inner.push(stripped);
          if (RE_FENCE.test(stripped)) qFence = !qFence;
          // paragraph state is decided by the innermost content line
          lastWasPara = paraStateAfter(stripped, lastWasPara);
          j++;
          continue;
        }
        if (RE_BLANK.test(l)) break;
        // lazy continuation: only while a paragraph is open and line doesn't start a block
        if (!qFence && lastWasPara && !startsBlock(l, defs, true)) {
          lazyIdx.add(inner.length);
          inner.push(visualIndent(l) >= 4 ? stripIndent(l, 4) : l);
          j++;
          continue;
        }
        break;
      }
      out += '<blockquote>\n' + parseBlocks(inner.join('\n'), defs, false, collectOnly, false, inList, lazyIdx) + '</blockquote>\n';
      i = j;
      continue;
    }

    // list
    if (RE_LIST.test(line)) {
      const res = parseList(lines, i, src, defs, collectOnly, eofNl, inList);
      out += res.html;
      i = res.next;
      continue;
    }

    // HTML block
    const hb = htmlBlockType(line);
    if (hb !== 0) {
      let j = i;
      if (hb === 1) {
        const tagName = /<\/?(pre|script|style|textarea)/i.exec(line)[1].toLowerCase();
        const closeRe = new RegExp('</' + tagName + '\\s*>', 'i');
        while (j < n && !closeRe.test(lineAt(j))) j++;
        if (j < n) j++;
      } else if (hb === 2) {
        while (j < n && !lineAt(j).includes('-->')) j++;
        if (j < n) j++;
      } else if (hb === 3) {
        while (j < n && !lineAt(j).includes('?>')) j++;
        if (j < n) j++;
      } else if (hb === 4) {
        while (j < n && !lineAt(j).includes('>')) j++;
        if (j < n) j++;
      } else if (hb === 5) {
        while (j < n && !lineAt(j).includes(']]>')) j++;
        if (j < n) j++;
      } else {
        while (j < n && !RE_BLANK.test(lineAt(j))) j++;
      }
      if (!collectOnly) {
        const parts = [];
        for (let k = i; k < j; k++) parts.push(lineAt(k));
        out += parts.join('\n');
        if (j < n ? !RE_BLANK.test(lineAt(j)) : eofNl) out += '\n';
      }
      i = j;
      continue;
    }

    // link reference definition(s)
    if (RE_DEF_START.test(line)) {
      const d = tryDef(lines, i, src);
      if (d) {
        const key = normLabel(d.label);
        if (!defs.has(key)) defs.set(key, { href: d.href, title: d.title });
        i = d.next;
        continue;
      }
    }

    // indented code block
    if (visualIndent(line) >= 4) {
      let j = i;
      const buf = [];
      while (j < n) {
        const l = lineAt(j);
        if (RE_BLANK.test(l)) {
          // include blank lines only if a later line is indented
          let k = j;
          while (k < n && RE_BLANK.test(lineAt(k))) k++;
          if (k < n && visualIndent(lineAt(k)) >= 4) {
            for (let t = j; t < k; t++) buf.push(codeStripIndent(lineAt(t)));
            j = k;
            continue;
          }
          break;
        }
        if (visualIndent(l) < 4) break;
        if (!collectOnly) buf.push(codeStripIndent(l));
        j++;
      }
      if (!collectOnly) {
        const content = buf.join('\n') + '\n';
        out += '<pre><code>' + escapeAll(content) + '</code></pre>\n';
      }
      i = j;
      continue;
    }

    // paragraph (with setext / table conversion)
    const res = parseParagraph(lines, i, src, defs, tight, collectOnly, eofNl, inList, lazyLines);
    out += res.html;
    i = res.next;
  }
  return out;
}

/** Would this line start a new block (used for lazy continuation + paragraph stops)?
 *  In lazy mode any list item counts as a block start. */
function startsBlock(line, defs, lazy = false) {
  if (RE_BLANK.test(line)) return true;
  if (RE_FENCE.test(line)) return true;
  if (RE_ATX.test(line)) return true;
  if (RE_HR.test(line)) return true;
  if (RE_QUOTE.test(line)) return true;
  const hb = htmlBlockType(line);
  if (hb !== 0 && hb !== 7) return true;
  if (lazy && RE_LIST.test(line)) return true;
  return false;
}

/** Decide whether a paragraph is open after a content line, unwrapping
 *  any blockquote / list markers to reach the innermost line. */
function paraStateAfter(line, prevPara) {
  let core = line;
  for (;;) {
    if (RE_QUOTE.test(core)) { core = stripQuoteMarker(core); continue; }
    const clm = RE_LIST.exec(core);
    if (clm) {
      const rest = core.slice(countIndent(core) + clm[1].length);
      core = /^[ \t]{1,4}/.test(rest) && !/^[ \t]*$/.test(rest)
        ? rest.replace(/^[ \t]{1,4}/, '')
        : rest.replace(/^[ \t]/, '');
      continue;
    }
    break;
  }
  if (RE_BLANK.test(core)) return false;
  if (startsBlock(core, null, true)) return false;
  if (visualIndent(core) >= 4 && !prevPara) return false;
  return true;
}

/** Strip up to `cols` columns of leading indentation (partial advance). */
function stripIndentPartial(line, cols) {
  if (!line.includes('\t')) {
    let L = 0;
    while (line[L] === ' ') L++;
    return line.slice(Math.min(cols, L));
  }
  const d = detabLeadFrom(line, 0);
  let L = 0;
  while (d[L] === ' ') L++;
  return d.slice(Math.min(cols, L));
}

/** Collect a paragraph starting at lines[i]; handle setext headings and GFM tables. */
function parseParagraph(lines, i, src, defs, tight = false, collectOnly = false, eofNl = true, inList = false, lazyLines = null) {
  const n = lines.length;
  const lineAt = (k) => src.slice(lines[k][0], lines[k][1]);
  const collected = [lineAt(i)];
  let j = i + 1;

  // GFM table: single header line + delimiter row
  if (j < n && collected[0].includes('|')) {
    const aligns = parseDelimRow(lineAt(j));
    if (aligns) {
      const header = splitRow(collected[0]);
      if (header.length === aligns.length) {
        return parseTable(lines, i, src, defs, header, aligns, collectOnly);
      }
    }
  }

  while (j < n) {
    const l = lineAt(j);
    if (lazyLines && lazyLines.has(j)) { collected.push(l); j++; continue; }
    if (RE_BLANK.test(l)) {
      // marked absorbs a whitespace-only final line when the source
      // does not end with a newline after it
      if (j === n - 1 && !eofNl && l.length > 0) { collected.push(l); j++; }
      break;
    }
    // setext underline converts the whole paragraph
    const sm = RE_SETEXT.exec(l);
    if (sm) {
      const depth = sm[1][0] === '=' ? 1 : 2;
      const text = [stripIndentPartial(collected[0], 3), ...collected.slice(1)].join('\n').replace(/[ \t]+$/, '');
      return { html: '<h' + depth + '>' + (collectOnly ? '' : inlineHtml(text, defs)) + '</h' + depth + '>\n', next: j + 1 };
    }
    if (startsBlock(l, defs)) break;
    // list interruption (CommonMark: bullet always, ordered only from 1)
    const lm = RE_LIST.exec(l);
    if (lm) {
      const marker = lm[1];
      const isOrdered = /\d/.test(marker[0]);
      if (!isOrdered || parseInt(marker, 10) === 1 || inList) {
        if (lm[2] !== undefined && lm[2].trim() !== '') break;
      }
    }
    collected.push(l);
    j++;
  }
  const text = collected.join('\n');
  return { html: tight ? (collectOnly ? '' : inlineHtml(text, defs)) : '<p>' + (collectOnly ? '' : inlineHtml(text, defs)) + '</p>\n', next: j };
}

function parseTable(lines, i, src, defs, header, aligns, collectOnly = false) {
  const n = lines.length;
  const lineAt = (k) => src.slice(lines[k][0], lines[k][1]);
  const alignAttr = (a) => (a ? ' align="' + a + '"' : '');
  let out = '<table>\n<thead>\n<tr>\n';
  header.forEach((cell, idx) => {
    out += '<th' + alignAttr(aligns[idx]) + '>' + (collectOnly ? '' : inlineHtml(cell, defs)) + '</th>\n';
  });
  out += '</tr>\n</thead>\n';
  let j = i + 2;
  const rows = [];
  while (j < n) {
    const l = lineAt(j);
    if (RE_BLANK.test(l)) break;
    if (startsBlock(l, defs)) break;
    rows.push(splitRow(l));
    j++;
  }
  if (rows.length) {
    out += '<tbody>';
    for (const row of rows) {
      out += '<tr>\n';
      for (let c = 0; c < header.length; c++) {
        out += '<td' + alignAttr(aligns[c]) + '>' + (collectOnly ? '' : inlineHtml(row[c] ?? '', defs)) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  out += '</table>\n';
  return { html: out, next: j };
}

// ---------- lists ----------

/** If `line` (already dedented into an item's content space) is a list
 *  item, return the content indent of that nested item; otherwise -1. */
function nestedContentIndent(line) {
  const m = RE_LIST.exec(line);
  if (!m) return -1;
  const markerEnd = countIndent(line) + m[1].length;
  const after = line.slice(markerEnd);
  if (/^[ \t]*$/.test(after)) return markerEnd + 1;
  const ws = /^[ \t]+/.exec(after);
  const cols = ws ? ws[0].length : 0;
  return cols >= 1 && cols <= 4 ? markerEnd + cols : markerEnd + 1;
}

function parseList(lines, start, src, defs, collectOnly = false, eofNl = true, inList = false) {
  const n = lines.length;
  const lineAt = (k) => src.slice(lines[k][0], lines[k][1]);
  const first = RE_LIST.exec(lineAt(start));
  const firstMarker = first[1];
  const ordered = /\d/.test(firstMarker[0]);
  const delim = ordered ? firstMarker[firstMarker.length - 1] : firstMarker;
  const startNum = ordered ? parseInt(firstMarker, 10) : 1;
  const baseIndent = countIndent(lineAt(start));

  const sameKind = (mm) => {
    if (!mm) return false;
    const mk = mm[1];
    if (/\d/.test(mk[0]) !== ordered) return false;
    if (ordered) return mk[mk.length - 1] === delim;
    return mk === delim;
  };

  const items = []; // {lines: [..content lines..], blankAfter: bool, blankInside: bool}
  let loose = false;
  let i = start;

  while (i < n) {
    const line = lineAt(i);
    if (RE_HR.test(line)) break;
    const mm = RE_LIST.exec(line);
    if (!sameKind(mm) || countIndent(line) > baseIndent + 3) break;
    // content indent for this item
    const markerEnd = countIndent(line) + mm[1].length;
    const after = line.slice(markerEnd);
    let contentIndent;
    let firstContent;
    if (/^[ \t]*$/.test(after)) {
      contentIndent = markerEnd + 1;
      firstContent = '';
    } else {
      const wsMatch = /^[ \t]+/.exec(after);
      const wsStr = wsMatch ? wsMatch[0] : '';
      let cols = 0;
      let col = markerEnd;
      for (const ch of wsStr) { if (ch === '\t') { const add = 4 - (col % 4); cols += add; col += add; } else { cols++; col++; } }
      const useCols = cols >= 1 && cols <= 4 ? cols : 1;
      contentIndent = markerEnd + useCols;
      firstContent = detabLeadFrom(after, markerEnd).slice(useCols);
    }
    const content = [firstContent];
    let sepBlank = false;
    let inFence = RE_FENCE.test(firstContent);
    let openItemIndent = nestedContentIndent(firstContent);
    const paraLine = (l, prev) => paraStateAfter(l, prev);
    let paraOpen = paraLine(firstContent, false);
    let pending = [];
    let k = i + 1;
    let itemDone = false;
    while (k < n && !itemDone) {
      const l = lineAt(k);
      if (RE_BLANK.test(l)) { pending.push(''); k++; continue; }
      const nm = RE_LIST.exec(l);
      if (!RE_HR.test(l) && sameKind(nm) && countIndent(l) < contentIndent && countIndent(l) <= baseIndent + 3 && visualIndent(l) < contentIndent) {
        itemDone = true; break;
      }
      if (visualIndent(l) >= contentIndent) {
        // an item that starts blank ends at the first blank line
        if (pending.length && !content.some((c) => c !== '')) { itemDone = true; break; }
        const ded = stripIndent(l, contentIndent);
        if (pending.length) {
          if (!inFence && (openItemIndent === -1 || visualIndent(ded) < openItemIndent)) sepBlank = true;
          content.push(...pending); pending = [];
          paraOpen = false;
        }
        if (RE_FENCE.test(ded)) { inFence = !inFence; paraOpen = false; }
        else if (inFence) paraOpen = false;
        else paraOpen = paraLine(ded, paraOpen);
        const nci = nestedContentIndent(ded);
        if (nci !== -1) openItemIndent = nci;
        else if (ded[0] === '>') openItemIndent = Infinity;
        content.push(ded);
        k++;
        continue;
      }
      // lazy continuation of a paragraph (no blank line in between)
      if (!inFence && paraOpen && pending.length === 0 && content.length && !RE_BLANK.test(content[content.length - 1]) && !startsBlock(l, defs) && !RE_LIST.test(l)) {
        // (an over-indented list marker line also lands here as paragraph text)
        content.push((l[0] === ' ' || l[0] === '\t') ? stripIndentPartial(l, contentIndent) : l);
        k++;
        continue;
      }
      break;
    }
    if (pending.length && k < n) {
      // blank line(s) after this item, and the list continues or something follows
      const nm2 = RE_LIST.exec(lineAt(k));
      if (sameKind(nm2)) loose = true;
      else if (content.some((c, idx) => idx > 0 && c !== '')) { /* trailing blanks only */ }
    }
    if (sepBlank) loose = true;
    items.push({ content });
    i = k;
    // continue only if next line is a sibling item
    const nl = i < n ? lineAt(i) : '';
    if (!sameKind(RE_LIST.exec(nl))) break;
  }

  let out = ordered ? (startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n') : '<ul>\n';
  if (collectOnly) {
    for (const item of items) parseBlocks(item.content.join('\n'), defs, false, true, false, true);
    return { html: '', next: i };
  }
  for (const item of items) {
    let text = item.content.join('\n');
    let checkbox = '';
    const cb = /^\[( |x|X)\] /.exec(item.content.find((c) => c.trim() !== '') ?? '');
    if (cb && /^\[( |x|X)\] /.test(text)) {
      checkbox = cb[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      text = text.replace(/^\[( |x|X)\] /, '');
    }
    let body = parseBlocks(text, defs, !loose, collectOnly, false, true);
    if (checkbox && body.startsWith('<p>')) body = '<p>' + checkbox + body.slice(3);
    else body = checkbox + body;
    out += '<li>' + body + '</li>\n';
  }
  out += ordered ? '</ol>\n' : '</ul>\n';
  return { html: out, next: i };
}

// ---------- inline ----------

const RE_ENT_DEC = /&#(\d{1,7});/y;
const RE_ENT_HEX = /&#[xX]([0-9a-fA-F]{1,6});/y;
const RE_AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/y;
const RE_EMAILLINK = /<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/y;
const RE_BARE_URL = /(?:https?|ftp):\/\/[^\s<]+|www\.[^\s<]+/iy;
const RE_EMAIL_FULL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/y;
const RE_SCHEME_PREFIX = /^(mailto|xmpp):/i;
const RE_EMAIL_TAIL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/;
const RE_EMAIL_HEAD = /@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/y;

function findCloseBracket(s, open) {
  // s[open] === '['; returns index of matching ']' or -1
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      // skip code span if it closes
      let j = i + run;
      let closed = -1;
      while (j < s.length) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { closed = j + r2; break; }
          j += r2;
        } else j++;
      }
      if (closed !== -1) { i = closed; continue; }
      i += run;
      continue;
    }
    if (c === '<' && /[A-Za-z!/?]/.test(s[i + 1] || '')) {
      RE_AUTOLINK.lastIndex = i;
      RE_EMAILLINK.lastIndex = i;
      const m = RE_AUTOLINK.exec(s) || RE_EMAILLINK.exec(s);
      if (m) { i += m[0].length; continue; }
      const html = matchInlineHtmlAt(s, i);
      if (html) { i += html.length; continue; }
      i++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Index of the first unescaped occurrence of ch at or after `from`, or -1. */
function indexOfUnescaped(s, ch, from) {
  let i = from;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === ch) return i;
    i++;
  }
  return -1;
}

/** True if the string contains an unescaped occurrence of ch. */
function hasUnescaped(s, ch) {
  return indexOfUnescaped(s, ch, 0) !== -1;
}

/** True if a node list contains a real (bracket) link inside it.
 *  Autolinks (raw) and image alt content do not count. */
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && !nd.raw) return true;
    if (nd.t !== 'image' && nd.children && containsLink(nd.children)) return true;
  }
  return false;
}

/** Parse a link or image starting at s[i] === '['. Returns {href,title,children,end} or null. */
function tryLink(s, i, defs, inLink, isImage) {
  const close = findCloseBracket(s, i);
  if (close === -1) return null;
  const textSrc = s.slice(i + 1, close);
  let j = close + 1;
  let href = null;
  let title = null;
  let end = -1;
  if (s[j] === '(') {
    // inline link
    let p = j + 1;
    const skipWs = () => { while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++; };
    skipWs();
    let ok = true;
    if (s[p] === '<') {
      const gt = indexOfUnescaped(s, '>', p + 1);
      if (gt === -1) ok = false;
      else {
        const d = s.slice(p + 1, gt);
        if (d.includes('<') || d.includes('\n')) ok = false;
        else { href = d; p = gt + 1; }
      }
    } else {
      const st = p;
      let depth = 0;
      while (p < s.length) {
        const c = s[p];
        if (c === '\\') { p += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) break;
          depth--;
        } else if ((c === ' ' || c === '\t' || c === '\n') && depth === 0) break;
        p++;
      }
      href = s.slice(st, p);
    }
    if (ok) {
      skipWs();
      const q = s[p];
      if (q === '"' || q === "'" || q === '(') {
        const closeCh = q === '(' ? ')' : q;
        let e = p + 1;
        let tok = false;
        while (e < s.length) {
          if (s[e] === '\\') { e += 2; continue; }
          if (s[e] === closeCh) { tok = true; break; }
          if (q === '(' && s[e] === '(') break;
          e++;
        }
        if (!tok) ok = false;
        else {
          title = s.slice(p + 1, e);
          p = e + 1;
          skipWs();
        }
      }
    }
    if (ok && s[p] === ')') {
      end = p + 1;
    } else {
      // a failed (...) may still be a shortcut reference link
      if (!/\S/.test(textSrc)) return null;
      const def = defs.get(normLabel(textSrc));
      if (!def) return null;
      href = def.href;
      title = def.title;
      end = close + 1;
    }
  } else if (s[j] === '[') {
    const le = indexOfUnescaped(s, ']', j + 1);
    if (le === -1) return null;
    let label = s.slice(j + 1, le);
    if (label === '') label = textSrc;
    if (hasUnescaped(label, '[')) return null;
    if (!/\S/.test(label)) return null;
    const def = defs.get(normLabel(label));
    if (!def) return null;
    href = def.href;
    title = def.title;
    end = le + 1;
  } else {
    if (!/\S/.test(textSrc)) return null;
    const def = defs.get(normLabel(textSrc));
    if (!def) return null;
    href = def.href;
    title = def.title;
    end = close + 1;
  }
  const children = parseInline(textSrc, defs, true, true);
  // links may not contain links (images may)
  if (!isImage && containsLink(children)) return null;
  return { href, title, children, end };
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code') out += nd.s;
    else if (nd.t === 'link' || nd.t === 'em' || nd.t === 'strong' || nd.t === 'del') out += plainText(nd.children);
    else if (nd.t === 'image') out += plainText(nd.children);
    else if (nd.t === 'br') out += '\n';
  }
  return out;
}

function trimBareUrl(u) {
  // GFM extended autolink trailing-punctuation trimming
  for (;;) {
    if (u.length === 0) return u;
    const last = u[u.length - 1];
    if ('?!.,:*_~\'"'.includes(last)) { u = u.slice(0, -1); continue; }
    if (last === ')') {
      const opens = u.split('(').length - 1;
      const closes = u.split(')').length - 1;
      if (closes > opens) { u = u.slice(0, -1); continue; }
    }
    if (last === ';') {
      const m = /&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#[xX][0-9A-Fa-f]+);$/.exec(u);
      if (m) { u = u.slice(0, u.length - m[0].length); continue; }
    }
    if (last === '<') { u = u.slice(0, -1); continue; }
    return u;
  }
}

const RE_RUN = /[\\&`<!\[\n*_~@]|https?:\/\/|ftp:\/\/|www\.|mailto:|xmpp:/gi;
const STOP_CHARS = new Set(['\\', '&', '`', '<', '!', '[', '*', '_', '~', '\n', '@']);
const URL_CHARS = new Set(['h', 'f', 'w', 'm', 'x', 'H', 'F', 'W', 'M', 'X']);

function parseInline(s, defs, inLink, spec = false) {
  const nodes = [];
  let text = '';
  const flush = () => { if (text) { nodes.push({ t: 'text', s: text }); text = ''; } };
  let i = 0;
  const n = s.length;
  const urlActive = !inLink && !spec;
  while (i < n) {
    const c = s[i];
    if (!STOP_CHARS.has(c) && !(urlActive && URL_CHARS.has(c))) {
      RE_RUN.lastIndex = i + 1;
      const rm = RE_RUN.exec(s);
      const end = rm ? rm.index : n;
      text += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) { flush(); nodes.push({ t: 'text', s: nx, esc: true }); i += 2; continue; }
      text += c; i++; continue;
    }
    if (c === '&') {
      RE_ENT_DEC.lastIndex = i;
      RE_ENT_HEX.lastIndex = i;
      const nm = RE_ENT_DEC.exec(s) || RE_ENT_HEX.exec(s);
      if (nm) {
        const val = nm[0][2] === 'x' || nm[0][2] === 'X' ? parseInt(nm[1], 16) : parseInt(nm[1], 10);
        const ch = (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) ? '\uFFFD' : String.fromCodePoint(val);
        flush();
        nodes.push({ t: 'text', s: ch, esc: true });
        i += nm[0].length;
        continue;
      }
      text += c; i++; continue;
    }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (s[j] === '`') {
          let r2 = 1;
          while (s[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found === -1) { text += '`'.repeat(run); i += run; continue; }
      let content = s.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      nodes.push({ t: 'code', s: content });
      i = found + run;
      continue;
    }
    if (c === '<' && /[A-Za-z!/?]/.test(s[i + 1] || '')) {
      RE_AUTOLINK.lastIndex = i;
      let m = RE_AUTOLINK.exec(s);
      if (m) {
        flush();
        nodes.push({ t: 'link', href: m[1], title: null, raw: true, children: [{ t: 'text', s: m[1] }] });
        i += m[0].length;
        continue;
      }
      RE_EMAILLINK.lastIndex = i;
      m = RE_EMAILLINK.exec(s);
      if (m) {
        flush();
        nodes.push({ t: 'link', href: 'mailto:' + m[1], title: null, raw: true, children: [{ t: 'text', s: m[1] }] });
        i += m[0].length;
        continue;
      }
      const html = matchInlineHtmlAt(s, i);
      if (html) {
        flush();
        nodes.push({ t: 'html', s: html });
        i += html.length;
        continue;
      }
      text += c; i++; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const r = tryLink(s, i + 1, defs, inLink, true);
      if (r) {
        flush();
        nodes.push({ t: 'image', href: r.href, title: r.title, children: r.children });
        i = r.end;
        continue;
      }
      text += c; i++; continue;
    }
    if (c === '[' && (!inLink || spec)) {
      const r = tryLink(s, i, defs, inLink, false);
      if (r) {
        flush();
        nodes.push({ t: 'link', href: r.href, title: r.title, children: r.children });
        i = r.end;
        continue;
      }
      text += c; i++; continue;
    }
    if (c === '*' || c === '_') {
      let run = 1;
      while (s[i + run] === c) run++;
      flush();
      const prev = i === 0 ? undefined : s[i - 1];
      const next = i + run >= n ? undefined : s[i + run];
      const prevWs = prev === undefined || isWs(prev);
      const nextWs = next === undefined || isWs(next);
      const prevPunct = prev !== undefined && isPunct(prev);
      const nextPunct = next !== undefined && isPunct(next);
      const left = !nextWs && (!nextPunct || prevWs || prevPunct);
      const right = !prevWs && (!prevPunct || nextWs || nextPunct);
      let canOpen, canClose;
      if (c === '*') { canOpen = left; canClose = right; }
      else {
        canOpen = left && (!right || prevPunct);
        canClose = right && (!left || nextPunct);
      }
      nodes.push({ t: 'delim', ch: c, n: run, canOpen, canClose });
      i += run;
      continue;
    }
    if (c === '~') {
      let run = 1;
      while (s[i + run] === '~') run++;
      if (run > 2) { text += '~'.repeat(run); i += run; continue; }
      flush();
      const prev = i === 0 ? undefined : s[i - 1];
      const next = i + run >= n ? undefined : s[i + run];
      const prevWs = prev === undefined || isWs(prev);
      const nextWs = next === undefined || isWs(next);
      nodes.push({ t: 'delim', ch: '~', n: run, canOpen: !nextWs, canClose: !prevWs });
      i += run;
      continue;
    }
    if (c === '\n') {
      // hard break from trailing spaces?
      let sp = 0;
      while (sp < text.length && text[text.length - 1 - sp] === ' ') sp++;
      if (sp >= 2 && i < n - 1) {
        text = text.slice(0, text.length - sp);
        flush();
        nodes.push({ t: 'br' });
        i++;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      text += c; i++; continue;
    }
    if (!inLink && !spec && ((c === 'h' && s[i + 1] === 't') || (c === 'f' && s[i + 1] === 't') || (c === 'w' && s[i + 1] === 'w') || (c === 'H' && (s[i + 1] === 't' || s[i + 1] === 'T')) || (c === 'F' && (s[i + 1] === 't' || s[i + 1] === 'T')) || (c === 'W' && (s[i + 1] === 'w' || s[i + 1] === 'W')) || ((c === 'm' || c === 'M') && (s[i + 1] === 'a' || s[i + 1] === 'A')) || ((c === 'x' || c === 'X') && (s[i + 1] === 'm' || s[i + 1] === 'M')))) {
      const prevOk = i === 0 || !/[A-Za-z0-9.]/.test(s[i - 1]);
      if (prevOk && (c === 'm' || c === 'M' || c === 'x' || c === 'X')) {
        const pm = RE_SCHEME_PREFIX.exec(s.slice(i));
        if (pm) {
          RE_EMAIL_FULL.lastIndex = i + pm[0].length;
          const em = RE_EMAIL_FULL.exec(s);
          if (em) {
            let len = pm[0].length + em[0].length;
            const after = s[i + len];
            if (after !== '-' && after !== '_') {
              if (pm[1].toLowerCase() === 'xmpp' && after === '/') {
                const rm = /^\/[^/\s<]+/.exec(s.slice(i + len));
                if (rm) len += rm[0].length;
              }
              flush();
              const txt = s.slice(i, i + len);
              nodes.push({ t: 'link', href: txt, title: null, raw: true, children: [{ t: 'text', s: txt }] });
              i += len;
              continue;
            }
          }
        }
      }
      if (prevOk) {
        RE_BARE_URL.lastIndex = i;
        const m = RE_BARE_URL.exec(s);
        if (m) {
          const url = trimBareUrl(m[0]);
          if (url.length >= (/^www\./i.test(m[0]) ? 5 : 8)) {
            flush();
            const href = /^www\./i.test(m[0]) ? 'http://' + url : url;
            nodes.push({ t: 'link', href, title: null, raw: true, children: [{ t: 'text', s: url }] });
            i += url.length;
            continue;
          }
        }
      }
      text += c; i++; continue;
    }
    if (!inLink && !spec && c === '@') {
      // bare email: the local part is the maximal run of email chars
      // immediately before the @ in the raw source (it may span '_'
      // delimiter nodes, so repair the emitted nodes directly)
      let bj = i - 1;
      while (bj >= 0 && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[bj])) bj--;
      const local = s.slice(bj + 1, i);
      RE_EMAIL_HEAD.lastIndex = i;
      const head = local.length ? RE_EMAIL_HEAD.exec(s) : null;
      const afterHead = head ? s[i + head[0].length] : undefined;
      if (head && afterHead !== '-' && afterHead !== '_' && !/(?:mailto|xmpp):$/i.test(s.slice(0, bj + 1))) {
        let rem = local.length;
        const take = Math.min(rem, text.length);
        text = text.slice(0, text.length - take);
        rem -= take;
        while (rem > 0 && nodes.length) {
          const last = nodes[nodes.length - 1];
          if (last.t === 'text' && !last.esc) {
            const t = Math.min(rem, last.s.length);
            last.s = last.s.slice(0, last.s.length - t);
            rem -= t;
            if (!last.s) nodes.pop();
          } else if (last.t === 'delim' && last.ch === '_') {
            if (last.n > rem) { last.n -= rem; rem = 0; }
            else { rem -= last.n; nodes.pop(); }
          } else break;
        }
        if (rem === 0) {
          flush();
          const email = local + head[0];
          nodes.push({ t: 'link', href: 'mailto:' + email, title: null, raw: true, children: [{ t: 'text', s: email }] });
          i += head[0].length;
          continue;
        }
      }
      text += c; i++; continue;
    }
    text += c;
    i++;
  }
  flush();
  processEmphasis(nodes, 0, nodes.length);
  return nodes;
}

const RE_HTML_DECL = /<![A-Z]+[^>]*>/y;
const RE_HTML_CLOSE = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;
const RE_HTML_OPEN = /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^ \t\n"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/y;

/** Match an inline HTML tag / comment / PI at s[i] === '<'; returns the
 *  matched string or null. */
function matchInlineHtmlAt(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return '<!-->';
    if (s.startsWith('<!--->', i)) return '<!--->';
    const end = s.indexOf('-->', i + 4);
    if (end !== -1) return s.slice(i, end + 3);
    return null;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end !== -1) return s.slice(i, end + 2);
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end !== -1) return s.slice(i, end + 3);
    return null;
  }
  RE_HTML_DECL.lastIndex = i;
  let m = RE_HTML_DECL.exec(s);
  if (m) return m[0];
  RE_HTML_CLOSE.lastIndex = i;
  m = RE_HTML_CLOSE.exec(s);
  if (m) return m[0];
  RE_HTML_OPEN.lastIndex = i;
  m = RE_HTML_OPEN.exec(s);
  if (m) return m[0];
  return null;
}

/** CommonMark delimiter-stack emphasis processing over nodes[start..end). */
function processEmphasis(nodes, start, end) {
  // We process in place over the whole array (indices shift as we splice).
  let di = 0;
  // collect delimiter positions fresh each outer iteration
  while (di < nodes.length) {
    const closer = nodes[di];
    if (!closer || closer.t !== 'delim' || !closer.canClose || closer.n === 0) { di++; continue; }
    // find nearest opener below
    let oi = di - 1;
    let opener = null;
    while (oi >= 0) {
      const cand = nodes[oi];
      if (cand && cand.t === 'delim' && cand.ch === closer.ch && cand.canOpen && cand.n > 0) {
        // rule of 3 (not for strikethrough)
        if (closer.ch !== '~' && (closer.canOpen || cand.canClose) &&
            (cand.n + closer.n) % 3 === 0 &&
            !(cand.n % 3 === 0 && closer.n % 3 === 0)) {
          oi--;
          continue;
        }
        if (closer.ch === '~' && cand.n !== closer.n) { oi--; continue; }
        opener = cand;
        break;
      }
      oi--;
    }
    if (!opener) { di++; continue; }
    const use = closer.ch === '~' ? closer.n : (opener.n >= 2 && closer.n >= 2 ? 2 : 1);
    if (opener.n < use || closer.n < use) { di++; continue; }
    opener.n -= use;
    closer.n -= use;
    const inner = nodes.splice(oi + 1, di - oi - 1);
    const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const node = { t: tag, children: inner };
    nodes.splice(oi + 1, 0, node);
    // di now points at the inserted node; the closer sits after it
    di = oi + 2;
    if (closer.n === 0) di++;
    // if opener exhausted, it stays as an empty delim (renders nothing)
    // loop continues; if closer still has n>0 it may match again
    if (closer.n > 0) di = oi + 2;
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += nd.esc ? escapeAll(nd.s) : escapeText(nd.s); break;
      case 'code': out += '<code>' + escapeAll(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.children) + '</del>'; break;
      case 'delim': out += nd.ch.repeat(nd.n); break;
      case 'link': {
        const href = cleanUrl(nd.raw ? nd.href : unescapeBackslash(nd.href));
        if (href === null) { out += renderNodes(nd.children); break; }
        out += '<a href="' + escapeText(href) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeText(unescapeBackslash(nd.title)) + '"';
        out += '>' + renderNodes(nd.children) + '</a>';
        break;
      }
      case 'image': {
        const href = cleanUrl(nd.raw ? nd.href : unescapeBackslash(nd.href));
        const alt = escapeText(plainText(nd.children));
        if (href === null) { out += '<img alt="' + alt + '">'; break; }
        out += '<img src="' + escapeText(href) + '" alt="' + alt + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeText(unescapeBackslash(nd.title)) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

function unescapeBackslash(s) {
  return s.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function inlineHtml(text, defs) {
  return renderNodes(parseInline(text, defs, false));
}

// ---------- entry ----------

export function parse(markdown) {
  let src = String(markdown);
  src = src.replace(/\r\n|\r/g, '\n');
  const eofNl = src.endsWith('\n');
  if (!eofNl) src += '\n';
  const defs = new Map();
  // Pass 1: walk the block structure collecting every link reference
  // definition (marked resolves references against defs found anywhere in
  // the document, including after the link that uses them).
  parseBlocks(src, defs, false, true, eofNl);
  // Pass 2: the real render.
  return parseBlocks(src, defs, false, false, eofNl);
}
