import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { labelSpreadsheetControls } from './repeatableRowsLayout.js';

test('spreadsheet headings label unnamed controls without replacing option labels', () => {
  const dom = new JSDOM(`
    <div id="cell">
      <input id="unnamed">
      <textarea id="described"></textarea>
      <button id="trigger" role="combobox">Choose</button>
      <input id="named" aria-label="Option A">
      <input id="labelled">
      <label for="labelled">Option B</label>
    </div>
  `);
  const cell = dom.window.document.querySelector('#cell');
  assert.equal(labelSpreadsheetControls(cell, 'column-heading', 'row-one-column'), 3);
  assert.equal(dom.window.document.querySelector('#unnamed').getAttribute('aria-labelledby'), 'column-heading');
  assert.equal(dom.window.document.querySelector('#described').getAttribute('aria-labelledby'), 'column-heading');
  assert.equal(
    dom.window.document.querySelector('#trigger').getAttribute('aria-labelledby'),
    'column-heading row-one-column-value',
  );
  assert.equal(dom.window.document.querySelector('#row-one-column-value').textContent, 'Choose');
  assert.equal(dom.window.document.querySelector('#named').getAttribute('aria-labelledby'), null);
  assert.equal(dom.window.document.querySelector('#labelled').getAttribute('aria-labelledby'), null);
});

test('spreadsheet combobox labelling keeps its selected value current', () => {
  const dom = new JSDOM('<div id="cell"><button id="trigger" role="combobox">Acme Ltd</button></div>');
  const cell = dom.window.document.querySelector('#cell');
  const trigger = dom.window.document.querySelector('#trigger');
  labelSpreadsheetControls(cell, 'organisation-heading', 'row-two-organisation');
  assert.equal(trigger.getAttribute('aria-labelledby'),
    'organisation-heading row-two-organisation-value');
  assert.equal(dom.window.document.querySelector('#row-two-organisation-value').textContent, 'Acme Ltd');

  trigger.textContent = 'Beta Ltd';
  labelSpreadsheetControls(cell, 'organisation-heading', 'row-two-organisation');
  assert.equal(dom.window.document.querySelector('#row-two-organisation-value').textContent, 'Beta Ltd');
});

test('spreadsheet control labelling safely ignores missing containers', () => {
  assert.equal(labelSpreadsheetControls(null, 'heading'), 0);
  assert.equal(labelSpreadsheetControls({}, 'heading'), 0);
});