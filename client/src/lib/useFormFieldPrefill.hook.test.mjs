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
const {
  useConditionalFormFieldPrefill,
  useFormFieldPrefill,
} = await import('./useFormFieldPrefill.js');

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

function ConditionalHarness({ activeForm, formValues, onValues }) {
  const values = useConditionalFormFieldPrefill({
    form: activeForm,
    formSlug: activeForm.slug,
    formValues,
  });

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

test('conditional prefill resolves the selected organisation for a rule set-value action', async () => {
  const originalResolver = publicClient.getFormFieldPrefill;
  publicClient.getFormFieldPrefill = async (_slug, _formId, sourceFieldId, recordId) => {
    assert.equal(sourceFieldId, 'org');
    assert.equal(recordId, 'organization-id');
    return {
      conditionalValues: {
        action_set_organization_name: 'British Nuclear Medicine Society',
      },
    };
  };

  const activeForm = {
    ...form('rule-parity'),
    visibility_rules: [{
      id: 'rule-4',
      actions: [{
        id: 'action_set_organization_name',
        action_type: 'set_value',
        target_field_id: 'organization_name',
        set_value_source: 'prefill',
        set_value_prefill_field: 'core.name',
      }],
    }],
  };
  const root = createRoot(document.getElementById('root'));
  let latestValues = {};

  try {
    await act(async () => {
      root.render(React.createElement(ConditionalHarness, {
        activeForm,
        formValues: { org: 'organization-id' },
        onValues: values => { latestValues = values; },
      }));
    });
    assert.equal(
      latestValues.action_set_organization_name,
      'British Nuclear Medicine Society',
    );
  } finally {
    publicClient.getFormFieldPrefill = originalResolver;
    await act(async () => root.unmount());
  }
});