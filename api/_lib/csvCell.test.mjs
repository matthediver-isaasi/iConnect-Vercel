// Tests for the shared streamed-export CSV cell helper (Excel-proofing):
// embedded line breaks flattened to a space, formula-injection prefixes
// neutralised, RFC 4180 quoting, plus the BOM/CRLF constants both the
// members and organisations export endpoints rely on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeCsvCell, CSV_BOM, CSV_ROW_SEPARATOR } from './csvCell.js';

test('escapeCsvCell: null/undefined become empty string', () => {
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
});

test('escapeCsvCell: plain values pass through unquoted', () => {
  assert.equal(escapeCsvCell('hello'), 'hello');
  assert.equal(escapeCsvCell(42), '42');
});

test('escapeCsvCell: commas and quotes trigger RFC 4180 quoting', () => {
  assert.equal(escapeCsvCell('Acme, Ltd'), '"Acme, Ltd"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
});

test('escapeCsvCell: embedded line breaks flatten to a single space', () => {
  assert.equal(escapeCsvCell('line one\nline two'), 'line one line two');
  assert.equal(escapeCsvCell('a\r\nb'), 'a b');
  assert.equal(escapeCsvCell('a\rb'), 'a b');
  // Flattened value with a comma still gets quoted.
  assert.equal(escapeCsvCell('one,\ntwo'), '"one, two"');
  // No raw newline may ever survive in the escaped output.
  assert.ok(!/[\r\n]/.test(escapeCsvCell('x\ny\r\nz\rq')));
});

test('escapeCsvCell: formula-injection prefixes are neutralised', () => {
  assert.equal(escapeCsvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(escapeCsvCell('+1'), "'+1");
  assert.equal(escapeCsvCell('-1'), "'-1");
  assert.equal(escapeCsvCell('@cmd'), "'@cmd");
  assert.equal(escapeCsvCell('\tx'), "'\tx");
  // A leading \r flattens to a space, so it no longer needs the apostrophe.
  assert.equal(escapeCsvCell('\r=x'), ' =x');
  // Neutralised value containing a comma still gets quoted.
  assert.equal(escapeCsvCell('=A,B'), `"'=A,B"`);
});

test('CSV constants: BOM and CRLF row separator', () => {
  assert.equal(CSV_BOM, '\ufeff');
  assert.equal(CSV_ROW_SEPARATOR, '\r\n');
});
