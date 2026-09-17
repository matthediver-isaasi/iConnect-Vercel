import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
  currentSetSaveBlocked,
  currentSetSubmissionMetadata,
  currentSetCommitConfirmed,
  mergeDepartmentCurrentSetValues,
  useDepartmentCurrentSet,
} = await import('./departmentCurrentSet.js');

const departmentId = '11111111-1111-4111-8111-111111111111';
const form = {
  id: '8b6f44d3-83f8-449e-9496-b10b1dc28e5f',
  slug: 'department-current',
  current_set_enabled: true,
  current_set_configuration: {
    workforce_field_id: 'workforce',
    equipment_field_id: 'equipment',
    equipment_existing_blank_required_field_ids: ['serial', 'installation'],
  },
};

function payload(version = 'v1', equipment = []) {
  return {
    department_id: departmentId,
    version,
    complete_sections: ['workforce', 'equipment'],
    form_values: {
      workforce: [{ _row_id: 'existing:workforce-1', grade: 'Band 5 ' }],
      equipment,
      __department_current_set: {
        department_id: departmentId,
        version,
        complete_sections: ['workforce', 'equipment'],
      },
    },
  };
}

function HookHarness({ initialValues, ready = true, onState }) {
  const [values, setValues] = useState(initialValues);
  const state = useDepartmentCurrentSet({
    form,
    departmentId,
    principalId: 'member-1',
    formValues: values,
    setFormValues: setValues,
    ready,
  });
  useEffect(() => onState({ state, values, setValues }), [state, values, onState]);
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

test('does not infer missing current-set arrays as empty or permit a save', () => {
  const values = mergeDepartmentCurrentSetValues({
    formValues: {},
    sectionIds: { workforce: 'workforce', equipment: 'equipment' },
    currentSet: { workforce: { rows: null }, equipment: { rows: null } },
  });
  assert.deepEqual(values, {});
  assert.match(currentSetSaveBlocked({
    enabled: true,
    departmentId,
    loading: false,
    error: null,
    baselineReady: false,
    currentSet: {},
    sectionIds: { workforce: 'workforce', equipment: 'equipment' },
    acknowledgements: { workforce: true, equipment: true },
  }), /safely applied/i);
});

test('persists verified context but blocks a stale current-set draft instead of rebinding it', async () => {
  const original = publicClient.getDepartmentCurrentSet;
  publicClient.getDepartmentCurrentSet = async () => payload('live-v2', []);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.getElementById('root'));
  let latest;
  try {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client },
        React.createElement(HookHarness, {
          initialValues: {
            workforce: [{ _row_id: 'existing:workforce-1', grade: 'Band 5 ' }],
            equipment: [],
            __department_current_set: {
              department_id: departmentId,
              version: 'old-v1',
              complete_sections: ['workforce', 'equipment'],
            },
          },
          onState: value => { latest = value; },
        }),
      ));
    });
    await flush();
    assert.equal(latest.state.baselineReady, false);
    assert.match(latest.state.error.message, /stale.*reload/i);
    assert.equal(latest.values.__department_current_set.version, 'old-v1');
  } finally {
    publicClient.getDepartmentCurrentSet = original;
    await act(async () => root.unmount());
    client.clear();
  }
});

test('delayed prefill retains draft sections, freezes its version, and loads all 36 rows', async () => {
  const original = publicClient.getDepartmentCurrentSet;
  let resolveRequest;
  publicClient.getDepartmentCurrentSet = () => new Promise(resolve => { resolveRequest = resolve; });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.getElementById('root'));
  let latest;
  try {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client },
        React.createElement(HookHarness, {
          initialValues: { workforce: [{ _row_id: 'draft-row', grade: 'Draft' }] },
          onState: value => { latest = value; },
        }),
      ));
    });
    const equipment = Array.from({ length: 36 }, (_, index) => ({
      _row_id: `existing:equipment-${index}`,
      serial: index === 0 ? '' : `SN-${index}`,
      installation: index === 0 ? '' : '2020',
    }));
    await act(async () => resolveRequest(payload('frozen-v1', equipment)));
    await flush();
    assert.equal(latest.values.workforce[0].grade, 'Draft');
    assert.equal(latest.values.equipment.length, 36);
    assert.equal(latest.values.__department_current_set.version, 'frozen-v1');
    assert.deepEqual(latest.state.existingBlankRequiredFieldsByRow['existing:equipment-0'], ['serial', 'installation']);
    assert.equal(currentSetSubmissionMetadata({
      form, departmentId, currentSet: latest.state.currentSet,
    }).version, 'frozen-v1');

    // A later cache update represents a concurrent edit. It must block rather
    // than replace the frozen form version or overwrite the draft.
    await act(async () => client.setQueryData(
      ['department-current-set', form.id, departmentId, 'member-1'],
      payload('newer-v2', equipment),
    ));
    await flush();
    assert.equal(latest.state.currentSet.version, 'frozen-v1');
    assert.match(currentSetSaveBlocked({
      enabled: latest.state.active,
      departmentId,
      loading: latest.state.loading,
      error: latest.state.error,
      baselineReady: latest.state.baselineReady,
      currentSet: latest.state.currentSet,
      sectionIds: latest.state.sectionIds,
      acknowledgements: { workforce: true, equipment: true },
    }), /(changed|stale).*reload/i);
  } finally {
    publicClient.getDepartmentCurrentSet = original;
    await act(async () => root.unmount());
    client.clear();
  }
});

test('requires both acknowledgements before the complete-array payload can save', () => {
  const loaded = payload('v1', []);
  const currentSet = {
    version: 'v1',
    completeSections: ['workforce', 'equipment'],
    workforce: { complete: true },
    equipment: { complete: true },
  };
  assert.match(currentSetSaveBlocked({
    enabled: true, departmentId, loading: false, error: null, baselineReady: true,
    currentSet, sectionIds: { workforce: 'workforce', equipment: 'equipment' },
    acknowledgements: { workforce: true, equipment: false },
  }), /acknowledge/i);
  const metadata = currentSetSubmissionMetadata({
    form, departmentId, currentSet,
    acknowledgements: { workforce: true, equipment: true },
  });
  assert.deepEqual(metadata, loaded.form_values.__department_current_set);
  assert.equal(currentSetCommitConfirmed({ current_set: { status: 'committed', version: 'v1' } }), true);
  assert.equal(currentSetCommitConfirmed({ current_set: { status: 'replayed', version: 'v1' } }), true);
  assert.equal(currentSetCommitConfirmed({ current_set: { status: 'committed' } }), false);
});