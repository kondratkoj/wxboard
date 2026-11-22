const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const changelog = require('../lib/changelog');

test('changelog: days newest first, [!] flag, wrapped lines, CRLF, other text ignored', () => {
  const md = [
    '# What\'s new', 'Intro text that is ignored.', '- not under a day, ignored', '',
    '## 2026-11-20', '- Older change', '',
    '## 2026-11-22', '- [!] Minimums **changed**', '  continued on the next line', '- Plain `code` item', '',
    '## 2026-11-21', '', // a day with no bullets is dropped
  ].join('\r\n');
  const e = changelog.parse(md);
  assert.deepStrictEqual(e.map((d) => d.date), ['2026-11-22', '2026-11-20']);
  assert.deepStrictEqual(e[0].items, [
    { text: 'Minimums **changed** continued on the next line', flag: true },
    { text: 'Plain `code` item', flag: false },
  ]);
  assert.deepStrictEqual(e[1].items, [{ text: 'Older change', flag: false }]);
});

test('changelog: the repo CHANGELOG.md parses, with no empty items', () => {
  const e = changelog.parse(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'));
  assert.ok(e.length > 0);
  for (const d of e) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const i of d.items) assert.ok(i.text.length > 0);
  }
});

test('changelog: load() returns [] when the file is missing', () => {
  assert.deepStrictEqual(changelog.load(path.join(__dirname, 'no-such-changelog.md')), []);
});
