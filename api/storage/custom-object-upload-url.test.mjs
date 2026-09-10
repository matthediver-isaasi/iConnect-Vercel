import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCustomObjectUploadUrlHandler,
  sanitizeCustomObjectUploadFileName,
} from './custom-object-upload-url.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const objectId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const fieldId = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
const roleId = '33333333-3333-4333-8333-333333333333';

function mockDb(seed = {}, { storageError = null, queryErrorTable = null } = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([name, rows]) => [
    name,
    rows.map((row) => structuredClone(row)),
  ]));
  const storageCalls = [];
  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }
    select() { return this; }
    eq(column, value) {
      this.filters.push((row) => {
        if (typeof row[column] === 'string' && typeof value === 'string'
          && /^[0-9a-f-]{36}$/i.test(row[column]) && /^[0-9a-f-]{36}$/i.test(value)) {
          return row[column].toLowerCase() === value.toLowerCase();
        }
        return row[column] === value;
      });
      return this;
    }
    is(column, value) {
      this.filters.push((row) => row[column] === value || (value === null && row[column] == null));
      return this;
    }
    maybeSingle() {
      if (queryErrorTable === this.table) {
        return Promise.resolve({ data: null, error: { message: 'forced query failure' } });
      }
      const data = (tables[this.table] || []).find((row) =>
        this.filters.every((filter) => filter(row)));
      return Promise.resolve({ data: data ? structuredClone(data) : null, error: null });
    }
  }
  return {
    from: (table) => new Query(table),
    storage: {
      from(bucket) {
        return {
          async createSignedUploadUrl(path) {
            storageCalls.push({ bucket, path });
            return storageError
              ? { data: null, error: storageError }
              : { data: { signedUrl: 'https://storage.test/signed', token: 'token' }, error: null };
          },
        };
      },
    },
    storageCalls,
  };
}

function seed(overrides = {}) {
  return {
    custom_object_definition: [{
      id: objectId,
      tenant_id: tenantId,
      status: 'active',
      archived_at: null,
    }],
    preference_field: [{
      id: fieldId,
      tenant_id: tenantId,
      custom_object_id: objectId,
      entity_scope: 'custom_object',
      name: 'attachment',
      label: 'Attachment',
      field_type: 'file',
      is_active: true,
      public_access: true,
      allowed_file_types: ['pdf'],
    }],
    custom_object_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_create_records: true,
      can_edit_records: false,
    }],
    custom_object_field_role_permission: [],
    ...overrides,
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

async function invoke({
  db = mockDb(seed()),
  context = {
    isAuthenticated: true,
    tenantId,
    roleId,
    memberId: 'member-1',
  },
  body = {
    customObjectId: objectId,
    fieldId,
    fileName: 'report.pdf',
    fileSize: 1024,
    mimeType: 'application/pdf',
  },
  method = 'POST',
  quota = { ok: true },
  adminCheck = (resolvedContext) => Boolean(resolvedContext.tenantUserId),
} = {}) {
  const quotaCalls = [];
  const usageCalls = [];
  const handler = createCustomObjectUploadUrlHandler({
    db,
    getContext: async () => context,
    quotaCheck: async (...args) => {
      quotaCalls.push(args);
      return quota;
    },
    addStorageBytes: async (...args) => usageCalls.push(args),
    adminCheck,
    uuid: () => '44444444-4444-4444-8444-444444444444',
  });
  const res = response();
  await handler({ method, body }, res);
  await Promise.resolve();
  return { res, db, quotaCalls, usageCalls };
}

test('authorized create or edit capability signs only a field-bound private path', async () => {
  for (const capability of ['can_create_records', 'can_edit_records']) {
    const grant = {
      tenant_id: tenantId,
      custom_object_id: objectId,
      role_id: roleId,
      can_view_records: true,
      can_create_records: false,
      can_edit_records: false,
      [capability]: true,
    };
    const db = mockDb(seed({ custom_object_role_permission: [grant] }));
    const { res, quotaCalls, usageCalls } = await invoke({
      db,
      body: {
        customObjectId: objectId,
        fieldId,
        fileName: '../../Board report (final).pdf',
        fileSize: 2048,
        mimeType: 'application/pdf',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.body.bucket, 'private-uploads');
    assert.equal(res.body.isPrivate, true);
    assert.equal(
      res.body.path,
      `${tenantId}/custom-object-files/${objectId}/${fieldId}/44444444-4444-4444-8444-444444444444-Board_report_final_.pdf`,
    );
    assert.equal(db.storageCalls[0].path, res.body.path);
    assert.match(res.body.fileUrl, /^\/api\/storage\/secure-url\?bucket=private-uploads&path=/);
    assert.equal(res.body.fileUrl.includes('../'), false);
    assert.deepEqual(quotaCalls, [[tenantId, { fileSizeBytes: 2048 }]]);
    assert.deepEqual(usageCalls, [[tenantId, 2048]]);
  }
});

test('storage ownership path uses canonical object and field IDs returned by the database', async () => {
  const { res } = await invoke({
    body: {
      customObjectId: objectId.toUpperCase(),
      fieldId: fieldId.toUpperCase(),
      fileName: 'report.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(
    res.body.path,
    `${tenantId}/custom-object-files/${objectId}/${fieldId}/44444444-4444-4444-8444-444444444444-report.pdf`,
  );
});

test('tenant users bypass role rows while portal access fails closed without role or object grant', async () => {
  const admin = await invoke({
    db: mockDb(seed({
      custom_object_role_permission: [],
      custom_object_field_role_permission: [{
        tenant_id: tenantId,
        custom_object_id: objectId,
        field_id: fieldId,
        role_id: roleId,
        access_level: 'none',
      }],
    })),
    context: { isAuthenticated: true, tenantId, tenantUserId: 'tenant-user-1' },
  });
  assert.equal(admin.res.statusCode, 200);

  for (const context of [
    { isAuthenticated: false, tenantId: null },
    { isAuthenticated: true, tenantId, memberId: 'member-1', roleId: null },
  ]) {
    const { res } = await invoke({ context });
    assert.equal(res.statusCode, context.isAuthenticated ? 403 : 401);
  }
  const missingGrant = await invoke({
    db: mockDb(seed({ custom_object_role_permission: [] })),
  });
  assert.equal(missingGrant.res.statusCode, 403);

  const mismatch = await invoke({
    context: {
      isAuthenticated: true,
      tenantId,
      roleId,
      memberId: 'member-1',
      tenantMismatch: true,
    },
  });
  assert.equal(mismatch.res.statusCode, 409);
  assert.equal(mismatch.res.body.error, 'Tenant context mismatch');
  assert.equal(mismatch.db.storageCalls.length, 0);
});

test('portal-member admins use the same Data Studio admin bypass as tenant users', async () => {
  const memberAdminContext = {
    isAuthenticated: true,
    tenantId,
    memberId: 'member-admin',
    roleId: 'member-admin-role',
  };
  const deniedRows = seed({
    custom_object_role_permission: [],
    custom_object_field_role_permission: [{
      tenant_id: tenantId,
      custom_object_id: objectId,
      field_id: fieldId,
      role_id: memberAdminContext.roleId,
      access_level: 'none',
    }],
  });
  const admin = await invoke({
    db: mockDb(deniedRows),
    context: memberAdminContext,
    adminCheck: async (context) =>
      context.memberId === memberAdminContext.memberId && !context.tenantUserId,
  });
  assert.equal(admin.res.statusCode, 200);

  const regularMember = await invoke({
    db: mockDb(deniedRows),
    context: { ...memberAdminContext, memberId: 'regular-member' },
    adminCheck: async () => false,
  });
  assert.equal(regularMember.res.statusCode, 403);
  assert.equal(regularMember.db.storageCalls.length, 0);
});

test('read-only or denied field permissions cannot obtain an upload URL', async () => {
  for (const access_level of ['read', 'none', 'unexpected']) {
    const { res, db } = await invoke({
      db: mockDb(seed({
        custom_object_field_role_permission: [{
          tenant_id: tenantId,
          custom_object_id: objectId,
          field_id: fieldId,
          role_id: roleId,
          access_level,
        }],
      })),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(db.storageCalls.length, 0);
  }
});

test('cross-tenant, archived objects, and inactive or non-file fields are unavailable', async () => {
  const unavailableSeeds = [
    seed({
      custom_object_definition: [{
        id: objectId, tenant_id: 'other-tenant', status: 'active', archived_at: null,
      }],
    }),
    seed({
      custom_object_definition: [{
        id: objectId, tenant_id: tenantId, status: 'archived', archived_at: '2026-01-01',
      }],
    }),
    seed({
      preference_field: [{
        ...seed().preference_field[0],
        is_active: false,
      }],
    }),
    seed({
      preference_field: [{
        ...seed().preference_field[0],
        field_type: 'text',
      }],
    }),
    seed({
      preference_field: [{
        ...seed().preference_field[0],
        custom_object_id: 'another-object',
      }],
    }),
  ];
  for (const fixture of unavailableSeeds) {
    const { res, db } = await invoke({ db: mockDb(fixture) });
    assert.equal(res.statusCode, 404);
    assert.equal(db.storageCalls.length, 0);
  }
});

test('server enforces configured extension, 50MB ceiling, positive size, and quota', async () => {
  for (const body of [
    {
      customObjectId: objectId, fieldId, fileName: 'malware.exe',
      fileSize: 1, mimeType: 'application/pdf',
    },
    {
      customObjectId: objectId, fieldId, fileName: 'large.pdf',
      fileSize: 50 * 1024 * 1024 + 1, mimeType: 'application/pdf',
    },
    {
      customObjectId: objectId, fieldId, fileName: 'empty.pdf',
      fileSize: 0, mimeType: 'application/pdf',
    },
  ]) {
    const { res, db } = await invoke({ body });
    assert.equal(res.statusCode, 400);
    assert.equal(db.storageCalls.length, 0);
  }
  const quotaDenied = await invoke({
    quota: { ok: false, status: 413, body: { error: 'Storage quota exceeded' } },
  });
  assert.equal(quotaDenied.res.statusCode, 413);
  assert.equal(quotaDenied.db.storageCalls.length, 0);
});

test('malformed requests and database or storage failures return explicit errors', async () => {
  const methodDenied = await invoke({ method: 'GET' });
  assert.equal(methodDenied.res.statusCode, 405);
  assert.equal(methodDenied.res.headers['Cache-Control'], 'private, no-store');
  const malformed = await invoke({ body: {} });
  assert.equal(malformed.res.statusCode, 400);
  assert.equal(malformed.res.headers['Cache-Control'], 'private, no-store');
  assert.equal((await invoke({
    db: mockDb(seed(), { queryErrorTable: 'custom_object_definition' }),
  })).res.statusCode, 500);
  assert.equal((await invoke({
    db: mockDb(seed(), { storageError: { message: 'signing unavailable' } }),
  })).res.statusCode, 500);
});

test('filename sanitization removes path ownership ambiguity while retaining an extension', () => {
  assert.equal(sanitizeCustomObjectUploadFileName('../../report.pdf'), 'report.pdf');
  assert.equal(sanitizeCustomObjectUploadFileName('..\\..\\report..pdf'), 'report.pdf');
  assert.equal(sanitizeCustomObjectUploadFileName(''), '');
});