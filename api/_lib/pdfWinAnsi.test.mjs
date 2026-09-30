import test from 'node:test';
import assert from 'node:assert/strict';
import { toWinAnsi } from './pdfWinAnsi.js';

test('plain ASCII is returned unchanged (identity)', () => {
  const s = 'Full name and address (line 1) - required!';
  assert.equal(toWinAnsi(s), s);
  assert.equal(toWinAnsi(''), '');
});

test('curly quotes and apostrophes normalise to straight quotes', () => {
  assert.equal(toWinAnsi('Signatory\u2019s \u201Cofficial\u201D title'), 'Signatory\'s "official" title');
  assert.equal(toWinAnsi('\u2018quoted\u2019'), "'quoted'");
});

test('dashes and ellipsis normalise to ASCII', () => {
  assert.equal(toWinAnsi('Terms \u2014 conditions \u2013 etc\u2026'), 'Terms - conditions - etc...');
});

test('non-breaking and exotic spaces become plain spaces', () => {
  assert.equal(toWinAnsi('a\u00A0b\u2009c\u202Fd'), 'a b c d');
});

test('bullets normalise to hyphens, zero-width chars stripped', () => {
  assert.equal(toWinAnsi('\u2022 item\u200B one'), '- item one');
});

test('Latin-1 characters pass through untouched', () => {
  assert.equal(toWinAnsi('Café naïve £100 ±5° résumé'), 'Café naïve £100 ±5° résumé');
});

test('WinAnsi extras (euro, trademark, OE) pass through', () => {
  assert.equal(toWinAnsi('\u20AC50 \u2122 \u0153uvre'), '\u20AC50 \u2122 \u0153uvre');
});

test('unmappable characters are decomposed or replaced with ?', () => {
  assert.equal(toWinAnsi('\u0101bc'), 'abc'); // a-macron decomposes to a
  assert.equal(toWinAnsi('emoji \u{1F600} end'), 'emoji ? end');
  assert.equal(toWinAnsi('\u4E2D\u6587'), '??');
});

test('non-string inputs coerce safely', () => {
  assert.equal(toWinAnsi(null), '');
  assert.equal(toWinAnsi(undefined), '');
  assert.equal(toWinAnsi(42), '42');
});

test('line/paragraph separators become newlines', () => {
  assert.equal(toWinAnsi('a\u2028b\u2029c'), 'a\nb\nc');
});
