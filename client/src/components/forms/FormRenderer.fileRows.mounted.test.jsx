import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/forms/file-rows',
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  location: window.location,
  history: window.history,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  DocumentFragment: window.DocumentFragment,
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const React = (await import('react')).default;
globalThis.React = React;
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { default: FormRenderer } = await import('./FormRenderer.jsx');
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  dom.window.close();
});

function Harness({ layout, publicAccess, minRows = 0 }) {
  const field = React.useMemo(() => ({
    id: 'documents',
    label: 'Documents',
    type: 'repeatable_rows',
    layout,
    min_rows: minRows,
    max_rows: 4,
    children: [{ id: 'attachment', label: 'Attachment', type: 'file', required: true,
      allowed_file_types: ['pdf'], public_access: publicAccess }],
  }), [layout, publicAccess, minRows]);
  const [rows, setRows] = React.useState([
    { _row_id: 'first', attachment: '' },
    { _row_id: 'second', attachment: '' },
  ]);
  const [valid, setValid] = React.useState(null);
  return (
    <div>
      <FormRenderer
        field={field}
        value={rows}
        onChange={setRows}
        onValidityChange={(_id, nextValid) => setValid(nextValid)}
        formId="form-file-rows"
        allFields={[field]}
        rootAllFields={[field]}
      />
      <output data-testid="rows-value">{JSON.stringify(rows)}</output>
      <output data-testid="rows-valid">{String(valid)}</output>
    </div>
  );
}

test('failed private upload leaves a required cell unanswered and allows retry', {
  concurrency: false,
}, async () => {
  let resolveRequest;
  const requests = [];
  globalThis.fetch = (url, options) => {
    if (url === '/api/storage/signed-upload-url') {
      requests.push(options);
      return new Promise(resolve => { resolveRequest = resolve; });
    }
    return Promise.resolve({ ok: true });
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <Harness layout="cards" publicAccess={false} minRows={1} />
      </QueryClientProvider>,
    ));
    assert.equal(container.querySelector('[data-testid="rows-valid"]').textContent, 'false');
    await upload(container, 'first');
    assert.equal(JSON.parse(requests[0].body).isPrivate, true);
    await act(async () => {
      resolveRequest({ ok: false, status: 400, json: async () => ({ error: 'Upload rejected' }) });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelector('[data-testid="rows-valid"]').textContent, 'false');
    assert.equal(JSON.parse(container.querySelector('[data-testid="rows-value"]').textContent)[0].attachment, '');
    assert.ok(container.querySelector('[data-testid="input-file-attachment-first"]'));
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  }
});

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function upload(container, rowId, name = 'attachment.pdf') {
  const input = container.querySelector(`[data-testid="input-file-attachment-${rowId}"]`);
  assert.ok(input, `row ${rowId} has its own file input`);
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new window.File(['document'], name, { type: 'application/pdf' })],
  });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

for (const layout of ['cards', 'spreadsheet']) {
  test(`${layout} uploads files per row and discards completion after row removal`, {
    concurrency: false,
  }, async () => {
    const requests = [];
    globalThis.fetch = (url, options) => {
      if (url === '/api/storage/signed-upload-url') {
        let resolve;
        const response = new Promise(done => { resolve = done; });
        requests.push({ options, resolve });
        return response;
      }
      return Promise.resolve({ ok: true });
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const value = () => JSON.parse(container.querySelector('[data-testid="rows-value"]').textContent);
    const valid = () => container.querySelector('[data-testid="rows-valid"]').textContent;
    const finish = async (index, name) => {
      requests[index].resolve({
        ok: true,
        json: async () => ({
          signedUrl: `https://storage.example.test/${name}`,
          fileUrl: `https://files.example.test/${name}`,
          path: `tenant/${name}`,
          bucket: 'public-assets',
        }),
      });
      await flush();
    };
    try {
      await act(async () => root.render(
        <QueryClientProvider client={queryClient}>
          <Harness layout={layout} publicAccess />
        </QueryClientProvider>,
      ));
      assert.equal(valid(), 'true', 'empty optional rows are not required before use');
      await upload(container, 'first');
      assert.equal(valid(), 'false', 'a pending upload blocks submission even when the row is active');
      assert.equal(requests.length, 1);
      assert.deepEqual(JSON.parse(requests[0].options.body), {
        fileName: 'attachment.pdf',
        fileSize: 8,
        mimeType: 'application/pdf',
        type: 'form-submission',
        isPrivate: false,
        formId: 'form-file-rows',
      });
      await finish(0, 'first.pdf');
      assert.equal(JSON.parse(value()[0].attachment).file_name, 'attachment.pdf');
      assert.equal(valid(), 'true');
      assert.ok(container.querySelector('[data-testid="button-remove-file-attachment-first"]'));

      await upload(container, 'second', 'second.pdf');
      assert.equal(valid(), 'false');
      await act(async () => {
        container.querySelector('[data-testid="button-remove-repeatable-row-documents-1"]').click();
      });
      await finish(1, 'second.pdf');
      assert.deepEqual(value().map(row => row._row_id), ['first']);
      assert.equal(valid(), 'true');
      await act(async () => {
        container.querySelector('[data-testid="button-add-repeatable-row-documents"]').click();
      });
      assert.equal(value()[1].attachment, '', 'late completion cannot attach to the new row');
      await act(async () => {
        container.querySelector('[data-testid="button-remove-file-attachment-first"]').click();
      });
      assert.equal(value()[0].attachment, '');
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });
}