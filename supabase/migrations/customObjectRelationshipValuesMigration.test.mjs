import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(
  new URL("./20261001_custom_object_relationship_values.sql", import.meta.url),
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