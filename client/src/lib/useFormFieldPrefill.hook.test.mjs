import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://example.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { publicClient } = await import('../api/publicClient.js');
const { useFormFieldPrefill } = await import('./useFormFieldPrefill.js');

const form = id => ({
  id,
  slug: `form-${id}`,
  prefill_source: 'form_field',
  prefill_source_field_id: 'org',
  fields: [
    { id: 'org', type: 'organisation_dropdown' },
    { id: 'region', type: 'text', default_value: 'East Midlands', prefill_field: 'org:region' },
  ],
});

function Harness({ activeForm, initialValues, ready, onValues }) {
  const [values, setValues] = useState(initialValues);

  useFormFieldPrefill({
    form: activeForm,
    formSlug: activeForm.slug,
    formValues: values,
    setFormValues: setValues,
    enabled: ready,
  });

  useEffect(() => {
    setValues(initialValues);
  }, [activeForm.id, initialValues]);

  useEffect(() => {
    onValues(values);
  }, [onValues, values]);

  return null;
}

test('form transition captures the destination default only after its initialization is ready', async () => {
  const originalResolver = publicClient.getFormFieldPrefill;
  publicClient.getFormFieldPrefill = async (_slug, formId, _sourceId, recordId) => ({
    values: {
      region: `${formId}:${recordId}`,
    },
  });

  const root = createRoot(document.getElementById('root'));
  let latestValues = {};
  const onValues = values => { latestValues = values; };
  const firstValues = { org: 'one', region: 'East Midlands' };
  const destinationValues = { org: 'two', region: 'East Midlands' };

  try {
    await act(async () => {
      root.render(React.createElement(Harness, {
        activeForm: form('one'),
        initialValues: firstValues,
        ready: true,
        onValues,
      }));
    });
    assert.equal(latestValues.region, 'one:one');

    await act(async () => {
      root.render(React.createElement(Harness, {
        activeForm: form('two'),
        initialValues: destinationValues,
        ready: false,
        onValues,
      }));
    });
    assert.equal(latestValues.region, 'East Midlands');

    await act(async () => {
      root.render(React.createElement(Harness, {
        activeForm: form('two'),
        initialValues: destinationValues,
        ready: true,
        onValues,
      }));
    });
    assert.equal(latestValues.region, 'two:two');
  } finally {
    publicClient.getFormFieldPrefill = originalResolver;
    await act(async () => root.unmount());
  }
});