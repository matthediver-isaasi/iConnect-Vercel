import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunkMemberContent } from './memberContentChunker.js';
import {
  linkedResourceIsEntitled,
  fetchExactMemberBookings,
  resolveCurrentSourceGenerations,
  isResourcePdfFileAccessible,
  isSourceGenerationCurrent,
  resolvePreRankEligiblePdfChunkIds,
} from './memberContentAccess.js';
import { isTrustedTenantStoragePdf, buildMemberContentLink } from './memberContentIndexer.js';

test('mixed Canvas output separates guest text from authenticated text', () => {
  const page = {
    title: 'Welcome',
    layout_type: 'hybrid',
    canvas_design: {
      root: {
        sections: [{
          children: [
            { type: 'text', content: { text: 'Everyone can read this.' } },
            {
              type: 'custom-html',
              content: {
                memberOnly: true,
                html: '<p>Members-only launch detail.</p>',
                guestMessage: 'Sign in',
              },
            },
          ],
        }],
      },
    },
  };
  const chunks = chunkMemberContent(page, 'canvas_page');
  const publicChunk = chunks.find((chunk) => chunk.accessScope === 'public');
  const memberChunk = chunks.find((chunk) => chunk.accessScope === 'authenticated');
  assert.ok(publicChunk);
  assert.ok(memberChunk);
  assert.match(publicChunk.content, /Everyone can read this/);
  assert.doesNotMatch(publicChunk.content, /Members-only launch detail/);
  assert.match(memberChunk.content, /Members-only launch detail/);
});

test('Canvas citations use the microsite route rather than a bare slug', () => {
  assert.equal(
    buildMemberContentLink('canvas_page', {
      id: 'page-1',
      slug: 'welcome',
      _micrositePrefix: 'partners',
    }),
    '/partners/welcome'
  );
});

test('event-linked resources require a current linked event entitlement', () => {
  const links = [{ event_id: 'event-a' }, { event_id: 'event-b' }];
  assert.equal(linkedResourceIsEntitled(links, new Set()), false);
  assert.equal(linkedResourceIsEntitled(links, new Set(['event-b'])), true);
  assert.equal(
    linkedResourceIsEntitled([{ event_id: 'event-b', session_id: 'session-b' }], new Set(['event-b'])),
    false
  );
  assert.equal(
    linkedResourceIsEntitled(
      [{ event_id: 'event-b', session_id: 'session-b' }],
      new Set(['event-b']),
      new Set(['session-b'])
    ),
    true
  );
  assert.equal(linkedResourceIsEntitled([], new Set()), true);
  assert.equal(linkedResourceIsEntitled(null, new Set()), true);
});

test('PDF extraction trust gate rejects non-tenant, signed and non-PDF URLs', () => {
  const old = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'https://tenant-storage.example';
  const trusted = 'https://tenant-storage.example/storage/v1/object/public/public-assets/a/report.pdf';
  assert.equal(
    isTrustedTenantStoragePdf(trusted, {
      file_url: trusted,
      file_name: 'report.pdf',
      file_type: 'document',
    }),
    true
  );
  assert.equal(
    isTrustedTenantStoragePdf('https://evil.example/report.pdf', {
      file_url: 'https://evil.example/report.pdf',
      file_name: 'report.pdf',
    }),
    false
  );
  const privateUrl = '/api/storage/secure-url?bucket=private-assets&path=tenant-a%2Fresource%2Fguide.pdf';
  assert.equal(
    isTrustedTenantStoragePdf(privateUrl, {
      file_url: privateUrl,
      file_name: 'guide.pdf',
      bucket: 'private-assets',
      storage_path: 'tenant-a/resource/guide.pdf',
    }),
    true
  );
  assert.equal(
    isTrustedTenantStoragePdf(
      'https://tenant-storage.example/storage/v1/object/public/public-assets/a/report.pdf?token=secret',
      {
        file_url: 'https://tenant-storage.example/storage/v1/object/public/public-assets/a/report.pdf?token=secret',
        file_name: 'report.pdf',
      }
    ),
    false
  );
  process.env.SUPABASE_URL = old;
});

test('booking entitlement queries use exact email equality, never ILIKE or a filter string', async () => {
  const calls = [];
  const supabase = {
    from(table) {
      const state = { table, filters: [] };
      const builder = {
        select(columns) {
          state.columns = columns;
          return builder;
        },
        eq(column, value) {
          state.filters.push(['eq', column, value]);
          return builder;
        },
        in(column, value) {
          state.filters.push(['in', column, value]);
          return builder;
        },
        then(resolve) {
          calls.push(state);
          resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
  await fetchExactMemberBookings({
    supabase,
    table: 'booking',
    tenantId: 'tenant-a',
    member: { id: 'member-a', email: 'a_%@example.test' },
    columns: 'id, event_id',
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.filters.every(([op]) => op === 'eq')));
  assert.ok(calls.some((call) => call.filters.some(([, column, value]) =>
    column === 'attendee_email' && value === 'a_%@example.test')));
});

test('source-generation registry failures and legacy chunks fail closed', async () => {
  const failing = {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        then: (resolve) => resolve({ data: null, error: { code: '42P01' } }),
      };
      return q;
    },
  };
  assert.equal(
    await resolveCurrentSourceGenerations({
      supabase: failing,
      tenantId: 'tenant-a',
      candidates: [{ source_id: 'source-a' }],
    }),
    null
  );
});

test('source-generation matching requires a finite non-negative exact generation', () => {
  assert.equal(isSourceGenerationCurrent(4, 4), true);
  assert.equal(isSourceGenerationCurrent('4', 4), true);
  assert.equal(isSourceGenerationCurrent(4, 5), false);
  assert.equal(isSourceGenerationCurrent(null, 4), false);
  assert.equal(isSourceGenerationCurrent(-1, -1), false);
  assert.equal(isSourceGenerationCurrent('4.1', '4.1'), false);
});

test('PDF file authorization excludes private CRM opportunity documents', async () => {
  const allowed = await isResourcePdfFileAccessible({
    supabase: {},
    file: {
      bucket: 'private-uploads',
      storage_path: 'tenant-a/opportunities/opportunity-a/contract.pdf',
    },
    visibilityCtx: { tenantId: 'tenant-a', member: { id: 'member-a' } },
  });
  assert.equal(allowed, false);
});

test('private-uploads PDF authorization denies a guest before folder/gallery checks', async () => {
  const allowed = await isResourcePdfFileAccessible({
    supabase: {},
    file: {
      bucket: 'private-uploads',
      storage_path: 'tenant-a/resources/member-guide.pdf',
    },
    visibilityCtx: { tenantId: 'tenant-a', isAuthenticated: false, member: null },
  });
  assert.equal(allowed, false);
});

test('PDF pre-ranking fails explicitly instead of silently truncating an allow-list', async () => {
  const overLimit = Array.from({ length: 401 }, (_, index) => ({
    id: `chunk-${index}`,
    source_id: `resource-${index}`,
    provenance: { kind: 'resource_pdf', fileId: `file-${index}` },
  }));
  const supabase = {
    from(table) {
      assert.equal(table, 'member_content_chunk');
      const q = {
        select: () => q,
        eq: () => q,
        contains: () => q,
        limit: () => q,
        then: (resolve) => resolve({ data: overLimit, error: null }),
      };
      return q;
    },
  };
  await assert.rejects(
    resolvePreRankEligiblePdfChunkIds({
      supabase,
      tenantId: 'tenant-a',
      visibilityCtx: { tenantId: 'tenant-a', isAuthenticated: true, member: { id: 'member-a' } },
    }),
    (error) => error?.code === 'MEMBER_CONTENT_PRERANK_LIMIT'
  );
});

test('PDF pre-ranking batches source/file reads and evaluates one policy per distinct file', async () => {
  const calls = { resource: 0, file: 0, folder: 0, photo: 0 };
  const chunks = [
    { id: 'pdf-page-1', source_id: 'resource-a', provenance: { kind: 'resource_pdf', fileId: 'file-a' } },
    { id: 'pdf-page-2', source_id: 'resource-a', provenance: { kind: 'resource_pdf', fileId: 'file-a' } },
  ];
  const supabase = {
    from(table) {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        contains: () => q,
        limit: () => q,
        maybeSingle: async () => {
          if (table === 'file_repository_folder') {
            calls.folder++;
            return { data: { id: 'folder-a', parent_folder_id: null, member_group_id: null }, error: null };
          }
          if (table === 'gallery_photo') {
            calls.photo++;
            return { data: null, error: null };
          }
          throw new Error(`unexpected maybeSingle table ${table}`);
        },
        then(resolve) {
          if (table === 'member_content_chunk') return resolve({ data: chunks, error: null });
          if (table === 'resource') {
            calls.resource++;
            return resolve({ data: [{ id: 'resource-a', target_url: '/api/storage/secure-url?bucket=private-uploads&path=tenant-a%2Fresources%2Freport.pdf' }], error: null });
          }
          if (table === 'file_repository') {
            calls.file++;
            return resolve({ data: [{
              id: 'file-a',
              file_url: '/api/storage/secure-url?bucket=private-uploads&path=tenant-a%2Fresources%2Freport.pdf',
              bucket: 'private-uploads',
              storage_path: 'tenant-a/resources/report.pdf',
              folder_id: 'folder-a',
            }], error: null });
          }
          throw new Error(`unexpected query table ${table}`);
        },
      };
      return q;
    },
  };
  const ids = await resolvePreRankEligiblePdfChunkIds({
    supabase,
    tenantId: 'tenant-a',
    visibilityCtx: { tenantId: 'tenant-a', isAuthenticated: true, member: { id: 'member-a' } },
  });
  assert.deepEqual(ids, ['pdf-page-1', 'pdf-page-2']);
  assert.deepEqual(calls, { resource: 1, file: 1, folder: 1, photo: 1 });
});

test('PDF file authorization applies an inherited file-folder member group gate', async () => {
  const supabase = {
    from(table) {
      if (table === 'gallery_photo') {
        const q = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return q;
      }
      assert.equal(table, 'file_repository_folder');
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: { id: 'folder-a', parent_folder_id: null, member_group_id: 'group-a' },
          error: null,
        }),
      };
      return q;
    },
  };
  const args = {
    supabase,
    file: {
      bucket: 'private-uploads',
      storage_path: 'tenant-a/resources/report.pdf',
      folder_id: 'folder-a',
    },
    visibilityCtx: { tenantId: 'tenant-a', member: { id: 'member-a' } },
  };
  assert.equal(await isResourcePdfFileAccessible(args), false);
  assert.equal(
    await isResourcePdfFileAccessible({
      ...args,
      visibilityCtx: {
        ...args.visibilityCtx,
        groupIds: new Set(['group-a']),
      },
    }),
    true
  );
});