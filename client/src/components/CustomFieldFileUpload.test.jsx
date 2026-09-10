import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://app.example.test/members/member-1',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const {
  default: CustomFieldFileUpload,
  CustomFieldFileDisplay,
} = await import('./CustomFieldFileUpload.jsx');
const { isSecureReference } = await import('../hooks/useSecureFileUrl.js');
const { formatRecordValue } = await import('../pages/customObjects/recordHelpers.js');

async function mount(value, props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CustomFieldFileDisplay value={value} fieldId="fixture" {...props} />);
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function mountUpload(value, props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CustomFieldFileUpload
        fieldId="upload-fixture"
        value={value}
        onChange={() => {}}
        {...props}
      />,
    );
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('renders public metadata as a filename with preview and download actions', async () => {
  const raw = JSON.stringify({
    file_url: 'https://files.example.test/private/storage-id',
    file_name: 'Readable name.pdf',
    file_size: 2048,
  });
  const view = await mount(raw);

  assert.match(view.container.textContent, /Readable name\.pdf/);
  assert.match(view.container.textContent, /2\.0 KB/);
  assert.doesNotMatch(view.container.textContent, /storage-id|file_url|file_size/);
  assert.equal(
    view.container.querySelector('[data-testid="button-view-file-fixture"]')?.href,
    'https://files.example.test/private/storage-id',
  );
  assert.equal(
    view.container.querySelector('[data-testid="button-download-file-fixture"]')?.getAttribute('download'),
    'Readable name.pdf',
  );
  await view.cleanup();
});

test('resolves secure preview and download URLs through authenticated requests', async () => {
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    requests.push({ parsed, options });
    const isDownload = parsed.searchParams.get('download') === 'true';
    return {
      ok: true,
      async json() {
        return { signedUrl: `https://signed.example.test/${isDownload ? 'download' : 'preview'}` };
      },
    };
  };

  const view = await mount({
    file_url: '/api/storage/secure-url?bucket=private-uploads&path=tenant%2Freport.pdf&redirect=true',
    file_name: 'report.pdf',
    is_private: true,
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  assert.equal(requests.length, 2);
  assert.equal(requests.every(request => request.options.credentials === 'include'), true);
  assert.equal(requests.every(request => !request.parsed.searchParams.has('redirect')), true);
  assert.equal(
    view.container.querySelector('[data-testid="button-view-file-fixture"]')?.href,
    'https://signed.example.test/preview',
  );
  assert.equal(
    view.container.querySelector('[data-testid="button-download-file-fixture"]')?.href,
    'https://signed.example.test/download',
  );
  await view.cleanup();
  delete globalThis.fetch;
});

test('renders clear empty and unavailable states without throwing', async () => {
  const empty = await mount('');
  assert.match(empty.container.textContent, /No file uploaded/);
  await empty.cleanup();

  const malformed = await mount('{not-json');
  assert.match(malformed.container.textContent, /File unavailable/);
  await malformed.cleanup();
});

test('only treats same-origin secure endpoints as authenticated references', () => {
  assert.equal(isSecureReference('/api/storage/secure-url?path=a.pdf'), true);
  assert.equal(isSecureReference('https://app.example.test/api/storage/secure-url?path=a.pdf'), true);
  assert.equal(isSecureReference('https://evil.example.test/api/storage/secure-url?path=a.pdf'), false);
});

test('edit-mode file controls resolve distinct secure preview and download URLs', async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    return {
      ok: true,
      async json() {
        return { signedUrl: `https://signed.example.test/${parsed.searchParams.has('download') ? 'download' : 'preview'}` };
      },
    };
  };

  const view = await mountUpload({
    file_url: '/api/storage/secure-url?bucket=private-uploads&path=tenant%2Freport.pdf',
    file_name: 'report.pdf',
    is_private: true,
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  assert.equal(requests.length, 2);
  assert.equal(requests.some(url => url.searchParams.get('download') === 'true'), true);
  assert.ok(view.container.querySelector('[data-testid="button-view-file-upload-fixture"]'));
  assert.ok(view.container.querySelector('[data-testid="button-download-file-upload-fixture"]'));
  await view.cleanup();
  delete globalThis.fetch;
});

test('custom-object uploads round-trip through the field-bound private endpoint', async () => {
  const requests = [];
  let changedValue = null;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url === '/api/storage/custom-object-upload-url') {
      return {
        ok: true,
        async json() {
          return {
            signedUrl: 'https://storage.example.test/signed-upload',
            fileUrl: '/api/storage/secure-url?bucket=private-uploads&path=tenant%2Fcustom-object-files%2Fobject%2Ffield%2Fid-report.pdf&redirect=true',
            path: 'tenant/custom-object-files/object/field/id-report.pdf',
            bucket: 'private-uploads',
          };
        },
      };
    }
    return { ok: true, async json() { return {}; } };
  };
  const view = await mountUpload('', {
    fieldId: 'field',
    customObjectId: 'object',
    publicAccess: true,
    allowedTypes: ['pdf'],
    onChange: (value) => { changedValue = value; },
  });
  const input = view.container.querySelector('[data-testid="input-file-field"]');
  const file = new window.File(['report'], 'report.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  assert.equal(requests[0].url, '/api/storage/custom-object-upload-url');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    customObjectId: 'object',
    fieldId: 'field',
    fileName: 'report.pdf',
    fileSize: file.size,
    mimeType: 'application/pdf',
  });
  assert.equal(requests[1].url, 'https://storage.example.test/signed-upload');
  const stored = JSON.parse(changedValue);
  assert.equal(stored.storage_path, 'tenant/custom-object-files/object/field/id-report.pdf');
  assert.equal(stored.bucket, 'private-uploads');
  assert.equal(stored.is_private, true);
  assert.equal(stored.file_name, 'report.pdf');
  await view.cleanup();
  delete globalThis.fetch;
});

test('custom-object list formatting never exposes serialized file metadata', () => {
  const value = JSON.stringify({
    file_url: 'https://files.example.test/id-123',
    file_name: 'Human name.pdf',
    storage_path: 'private/internal/path',
  });
  assert.equal(formatRecordValue({ field_type: 'file' }, value), 'Human name.pdf');
});

test('member detail renderers route file fields through the shared presentation', async () => {
  const [pageSource, componentSource] = await Promise.all([
    readFile(new URL('../pages/MemberDetail.jsx', import.meta.url), 'utf8'),
    readFile(new URL('./MemberDetailView.jsx', import.meta.url), 'utf8'),
  ]);

  for (const source of [pageSource, componentSource]) {
    assert.match(source, /CustomFieldFileDisplay/);
    assert.match(source, /field\.field_type === 'file'|case 'file'/);
  }
  assert.match(componentSource, /if \(field\.field_type === 'file'\) \{\s+displayValue = <CustomFieldFileDisplay/);
  assert.match(componentSource, /\{field\.field_type === 'file' \? displayValue : <p/);
});