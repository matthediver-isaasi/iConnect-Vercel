import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import handler from './form-draft.js';
import { buildDepartmentCurrentSetCompatibilityContract } from '../_lib/departmentCurrentSetCompatibility.js';

const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
const FORM_ID = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f';
const DEPARTMENT_ID = 'cd1ebfd3-3e16-4091-be5a-99992d926f2f';
const MEMBER_ID = '5e07a96c-cda1-4a0b-a6fe-951ffb62142';
const CONFIG_BASE = {
  workforce_container_field_id: 'workforce',
  equipment_container_field_id: 'equipment',
  workforce_fields: {},
  equipment_fields: { serial: 'serial_number', installed: 'year_installed' },
  required_blank_policy: {
    existing_equipment_blank_required_field_ids: ['serial', 'installed'],
    new_equipment_required_field_ids: ['serial', 'installed'],
  },
  equipment_hidden_preserve: {},
};

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function draftData(version = 'department-version-1', departmentId = DEPARTMENT_ID) {
  return {
    workforce: [], equipment: [],
    __department_current_set: {
      department_id: departmentId,
      version,
      complete_sections: ['workforce', 'equipment'],
    },
  };
}

function responseRecorder() {
  const response = { statusCode: 200, body: null };
  return {
    response,
    res: {
      setHeader() {},
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return body; },
      end() {},
    },
  };
}

function makeDraftDb({
  draft = null,
  currentVersion = 'department-version-1',
  allowedMemberId = MEMBER_ID,
} = {}) {
  const form = {
    id: FORM_ID, tenant_id: TENANT_ID, slug: 'department-return',
    name: 'Department return', is_active: true, require_authentication: true,
    access_policy: null, deactivate_at: null, pages: [], visibility_rules: [], fields: [{
      id: 'workforce', type: 'repeatable_rows', min_rows: 0, max_rows: 20,
      first_row_required: false, child_fields: [{ id: 'workforce_note', type: 'text' }],
    }, {
      id: 'equipment', type: 'repeatable_rows', min_rows: 0, max_rows: 100,
      first_row_required: false, child_fields: [
        { id: 'serial', type: 'text', required: true },
        { id: 'installed', type: 'date', required: true, date_precision: 'year' },
      ],
    }],
  };
  const currentSetConfig = {
    ...CONFIG_BASE,
    form_compatibility: buildDepartmentCurrentSetCompatibilityContract({
      form,
      configuration: CONFIG_BASE,
    }),
  };
  let draftRow = draft ? structuredClone(draft) : null;
  let deleted = false;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.payload = null; this.kind = null; }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    insert(payload) { this.kind = 'insert'; this.payload = payload; return this; }
    update(payload) { this.kind = 'update'; this.payload = payload; return this; }
    delete() { this.kind = 'delete'; return this; }
    filter() { return this; }
    maybeSingle() { return this.result(); }
    single() { return this.result(); }
    result() {
      if (this.table === 'form') return Promise.resolve({ data: structuredClone(form), error: null });
      if (this.table === 'department_current_set_config') {
        return Promise.resolve({ data: { config: structuredClone(currentSetConfig) }, error: null });
      }
      if (this.table === 'form_draft_submission' && !this.kind) {
        return Promise.resolve({ data: draftRow ? structuredClone(draftRow) : null, error: draftRow ? null : { code: 'PGRST116' } });
      }
      return this.then(value => value);
    }
    then(resolve, reject) {
      if (this.table === 'form_draft_submission' && this.kind === 'insert') {
        draftRow = { id: 'draft-1', ...structuredClone(this.payload) };
      } else if (this.table === 'form_draft_submission' && this.kind === 'update' && draftRow) {
        draftRow = { ...draftRow, ...structuredClone(this.payload) };
      } else if (this.table === 'form_draft_submission' && this.kind === 'delete') {
        deleted = true;
        draftRow = null;
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }
  }
  return {
    client: {
      from(table) { return new Query(table); },
      async rpc(name, args) {
        assert.equal(name, 'department_current_set_load_authenticated');
        if (args.p_member_id !== allowedMemberId) {
          return {
            data: null,
            error: { message: 'CURRENT_SET_AUTHORIZATION: a live Survey respondent link is required' },
          };
        }
        return {
          data: {
            version: currentVersion,
            department_id: DEPARTMENT_ID,
            complete_sections: ['workforce', 'equipment'],
            form_values: draftData(currentVersion),
          },
          error: null,
        };
      },
    },
    row: () => structuredClone(draftRow),
    deleted: () => deleted,
  };
}

function dependencies(db, member = { id: MEMBER_ID, tenant_id: TENANT_ID }) {
  return {
    supabase: db.client,
    tenantData: { id: TENANT_ID, slug: 'bnms' },
    getSessionMember: async () => member,
    getActiveSession: async () => member ? { id: 'draft-session', data: { memberId: member.id } } : null,
  };
}

test('current-set draft POST is respondent-bound and stores the checked version', async () => {
  const db = makeDraftDb();
  const { response, res } = responseRecorder();
  await handler({
    method: 'POST', headers: {},
    body: { form_id: FORM_ID, draft_data: draftData() },
  }, res, dependencies(db));
  assert.equal(response.statusCode, 201);
  assert.equal(db.row().draft_data.__department_current_set.version, 'department-version-1');
});

test('current-set draft GET and DELETE reject a bearer token after respondent access is revoked', async () => {
  const token = 'draft-resume-token';
  const db = makeDraftDb({
    draft: {
      id: 'draft-1', form_id: FORM_ID, tenant_id: TENANT_ID,
      resume_token_hash: tokenHash(token), draft_data: draftData(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  for (const method of ['GET', 'DELETE']) {
    const { response, res } = responseRecorder();
    await handler({
      method, headers: {}, query: { token }, body: {},
    }, res, dependencies(db, null));
    assert.equal(response.statusCode, 401);
    assert.equal(response.body.code, 'CURRENT_SET_AUTHENTICATION_REQUIRED');
  }
  assert.equal(db.deleted(), false);
});

test('current-set draft writes require the respondent linked to that Department', async () => {
  const db = makeDraftDb();
  const { response, res } = responseRecorder();
  await handler({
    method: 'POST', headers: {},
    body: { form_id: FORM_ID, draft_data: draftData() },
  }, res, dependencies(db, { id: 'b302b8a6-74a2-4412-8ea8-9d6f44f45e78', tenant_id: TENANT_ID }));
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'CURRENT_SET_AUTHORIZATION');
  assert.equal(db.row(), null);
});

test('current-set drafts reject stale versions and cannot be rebound to another Department', async () => {
  const token = 'draft-bound-token';
  const existing = {
    id: 'draft-1', form_id: FORM_ID, tenant_id: TENANT_ID,
    resume_token_hash: tokenHash(token), draft_data: draftData(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const staleDb = makeDraftDb({ draft: existing, currentVersion: 'department-version-2' });
  const stale = responseRecorder();
  await handler({ method: 'GET', headers: {}, query: { token } }, stale.res, dependencies(staleDb));
  assert.equal(stale.response.statusCode, 409);
  assert.equal(stale.response.body.code, 'CURRENT_SET_CONFLICT');

  const boundDb = makeDraftDb({ draft: existing });
  const rebound = responseRecorder();
  await handler({
    method: 'POST', headers: {},
    body: {
      form_id: FORM_ID, resume_token: token,
      draft_data: draftData('department-version-1', 'b302b8a6-74a2-4412-8ea8-9d6f44f45e78'),
    },
  }, rebound.res, dependencies(boundDb));
  assert.equal(rebound.response.statusCode, 409);
  assert.equal(rebound.response.body.code, 'CURRENT_SET_DRAFT_DEPARTMENT_MISMATCH');
});