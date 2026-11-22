// "What's new": reads CHANGELOG.md at the repo root and turns it into dated entries for the page.
//
// Format (anything else in the file is ignored):
//   ## 2026-11-22            one heading per day, newest first
//   - Plain-language change   one bullet per change; **bold**, *italic* and `code` are kept
//   - [!] Change              [!] = changes how a brief reads (minimums, categories, NOTAM levels...)
// A bullet can wrap onto following lines that are indented.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'CHANGELOG.md');

function parse(text) {
  const entries = [];
  let cur = null, item = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const h = raw.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (h) { cur = { date: h[1], items: [] }; entries.push(cur); item = null; continue; }
    if (/^#/.test(raw)) { cur = null; item = null; continue; }
    if (!cur) continue;
    const b = raw.match(/^[-*]\s+(.*)$/);
    if (b) {
      let t = b[1].trim();
      const flag = /^\[!\]\s*/.test(t);
      if (flag) t = t.replace(/^\[!\]\s*/, '');
      item = { text: t, flag };
      cur.items.push(item);
      continue;
    }
    if (item && /^\s+\S/.test(raw)) { item.text += ' ' + raw.trim(); continue; }
    item = null;
  }
  return entries.filter((e) => e.items.length).sort((a, b) => b.date.localeCompare(a.date));
}

// Re-read only when the file changes on disk.
let cache = { mtimeMs: -1, entries: [] };
function load(file = FILE) {
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, entries: parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    cache = { mtimeMs: -1, entries: [] };
  }
  return cache.entries;
}

module.exports = { parse, load, FILE };
