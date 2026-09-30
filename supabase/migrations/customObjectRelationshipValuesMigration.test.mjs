import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(
  new URL("./20261001_custom_object_relationship_values.sql", import.meta.url),
  "utf8",
);
const pickerScopeStructuralUpdatesSql = await readFile(
  new URL("./20261003_relationship_picker_scope_structural_updates.sql", import.meta.url),
  "utf8",
);
const pickerScopeCoreTerminalSourcesSql = await readFile(
  new URL("./20261004_relationship_picker_core_terminal_sources.sql", import.meta.url),
  "utf8",
);

test("relationship values migration is additive and keeps legacy edges valid", () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS field_values jsonb NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(sql, /CHECK \(jsonb_typeof\(field_values\) = 'object'\)/i);
});

test("relationship values migration applies configured defaults to every new edge", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.apply_custom_object_relationship_field_defaults\(\)/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF field_values, relationship_definition_id, tenant_id[\s\S]*ON public\.custom_object_relationship/i);
  assert.match(sql, /definition\.tenant_id = NEW\.tenant_id/i);
  assert.match(sql, /NOT NEW\.field_values \? field_key/i);
  assert.match(sql, /custom_object_relationship_field_required/i);
  assert.match(sql, /custom_object_relationship_field_type/i);
});

test("field-value updates on in-scope and grandfathered out-of-scope edges do not queue picker topology validation", () => {
  assert.match(
    pickerScopeStructuralUpdatesSql,
    /CREATE CONSTRAINT TRIGGER custom_object_picker_scope_v2_update_guard_trigger/i,
  );
  assert.match(
    pickerScopeStructuralUpdatesSql,
    /AFTER UPDATE ON public\.custom_object_relationship/i,
  );
  assert.match(pickerScopeStructuralUpdatesSql, /WHEN \([\s\S]*OLD\.id IS DISTINCT FROM NEW\.id/i);
  assert.doesNotMatch(
    pickerScopeStructuralUpdatesSql,
    /OLD\.field_values IS DISTINCT FROM NEW\.field_values/i,
  );
  assert.match(
    pickerScopeStructuralUpdatesSql,
    /EXECUTE FUNCTION public\.guard_custom_object_picker_scope_v2\(\)/i,
  );
});

test("picker topology validation remains queued for every scope-relevant edge change", () => {
  assert.match(
    pickerScopeStructuralUpdatesSql,
    /CREATE CONSTRAINT TRIGGER custom_object_picker_scope_v2_guard_trigger[\s\S]*AFTER INSERT ON public\.custom_object_relationship[\s\S]*EXECUTE FUNCTION public\.guard_custom_object_picker_scope_v2\(\)/i,
  );
  for (const column of [
    "tenant_id",
    "relationship_definition_id",
    "source_record_id",
    "target_record_id",
    "archived_at",
  ]) {
    assert.match(
      pickerScopeStructuralUpdatesSql,
      new RegExp(`OLD\\.${column} IS DISTINCT FROM NEW\\.${column}`, "i"),
    );
  }
});

test("relationship-value enforcement remains independent of picker topology validation", () => {
  assert.match(
    sql,
    /CREATE TRIGGER custom_object_relationship_field_defaults[\s\S]*BEFORE INSERT OR UPDATE OF field_values, relationship_definition_id, tenant_id/i,
  );
  assert.match(sql, /custom_object_relationship_field_required/i);
  assert.match(sql, /custom_object_relationship_field_type/i);
});

test("picker scope core terminal source keeps BNMS primary and secondary Organisations additive", () => {
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /target_terminal_sources[\s\S]*core_field[\s\S]*organization_id/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /SELECT m\.organization_id[\s\S]*m\.tenant_id = NEW\.tenant_id/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /source_terminals\(record_id\)[\s\S]*v_source_primary_organisation[\s\S]*target_terminals\(record_id\)[\s\S]*v_target_primary_organisation/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /v_path_definition\.source_kind <> v_current_kind[\s\S]*v_path_definition\.target_kind <> v_current_kind/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /v_terminal_target_kind <> 'organization'[\s\S]*v_terminal_target_object IS NOT NULL/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /configuration->'picker_scope'->>'version' = '2'/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /REVOKE ALL ON FUNCTION public\.guard_custom_object_picker_scope_v2\(\)[\s\S]*FROM PUBLIC, anon, authenticated/i,
  );
});

test("API and database both reject explicitly empty picker terminal-source arrays", async () => {
  const serviceSource = await readFile(
    new URL("../../api/_lib/customObjectService.js", import.meta.url),
    "utf8",
  );
  assert.match(
    serviceSource,
    /terminalSources !== undefined && sources\.length === 0/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /v_scope \? 'target_terminal_sources'[\s\S]*<> '\[\{"type":"core_field","field":"organization_id"\}\]'::jsonb/i,
  );
  assert.match(
    pickerScopeCoreTerminalSourcesSql,
    /v_scope \? 'source_terminal_sources'[\s\S]*<> '\[\{"type":"core_field","field":"organization_id"\}\]'::jsonb/i,
  );
});