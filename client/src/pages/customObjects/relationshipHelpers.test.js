import test from "node:test";
import assert from "node:assert/strict";
import {
  cardinalityLimitReached,
  applicableSidesForRecord,
  displaySide,
  relationshipCreatePayload,
  relationshipPayload,
  relationshipPanels,
  relatedRecordPath,
  canDefineRelationships,
  defaultDefinitionForm,
  definitionPayload,
  relationshipSourceName,
  resolveRelationshipSourceObject,
  contextualCreateEligibility,
  initialRelationshipSelectors,
  initialRelationshipLabel,
  initialRelationshipAllowsMultiple,
  isRequiredInitialRelationship,
  relationshipSelectorKey,
} from "./relationshipHelpers.js";
import { loadRelationshipDefinitions, relationshipRoutes } from "./relationshipApi.js";

test("identifies the configured side without recursive lookups", () => {
  assert.equal(
    displaySide(
      { source_kind: "custom_object", source_custom_object_id: "8", target_kind: "member" },
      "custom_object",
      8,
    ),
    "source",
  );
});

test("enumerates both stable sides for a self relationship", () => {
  assert.deepEqual(
    applicableSidesForRecord(
      {
        source_kind: "custom_object",
        source_custom_object_id: "8",
        target_kind: "custom_object",
        target_custom_object_id: "8",
      },
      "custom_object",
      8,
    ),
    ["source", "target"],
  );
});

test("applies one-side limits from the perspective being edited", () => {
  assert.equal(cardinalityLimitReached({ cardinality: "one_to_many" }, "target", 1), true);
  assert.equal(cardinalityLimitReached({ cardinality: "one_to_many" }, "source", 4), false);
  assert.equal(cardinalityLimitReached({ cardinality: "one_to_one" }, "source", 1), true);
});

test("builds edge payload with endpoints in their defined order", () => {
  assert.deepEqual(
    relationshipPayload({ definitionId: 3, recordId: 9, entityId: 14, editSide: "target" }),
    {
      relationship_definition_id: 3,
      source_record_id: 14,
      target_record_id: 9,
      routed_side: "target",
      routed_record_id: 9,
    },
  );
});

test("builds the core create payload expected by the core relationship service", () => {
  assert.deepEqual(
    relationshipCreatePayload({
      contextKind: "member",
      definitionId: 3,
      recordId: 9,
      entityId: 14,
      editSide: "source",
    }),
    {
      relationship_definition_id: 3,
      related_record_id: 14,
    },
  );
});

test("only allows contextual creation at an active, creatable Custom Object endpoint", () => {
  const definition = {
    source_kind: "member",
    target_kind: "custom_object",
    target_custom_object_id: "target-1",
  };
  assert.deepEqual(
    contextualCreateEligibility({
      definition,
      side: "source",
      object: { id: "target-1", status: "active", capabilities: { create_records: true } },
    })?.objectId,
    "target-1",
  );
  assert.equal(contextualCreateEligibility({
    definition,
    side: "source",
    object: { id: "target-1", status: "archived", capabilities: { create_records: true } },
  }), null);
  assert.equal(contextualCreateEligibility({
    definition: { ...definition, target_kind: "organization" },
    side: "source",
    object: { id: "target-1", status: "active" },
  }), null);
});

test("initial selectors include only active, visible and editable sides", () => {
  const selectors = initialRelationshipSelectors({ data: [
    { id: "visible", status: "active", source_kind: "custom_object", source_custom_object_id: "one", show_on_source: true, edit_from_source: true },
    { id: "hidden", status: "active", source_kind: "custom_object", source_custom_object_id: "one", show_on_source: false },
    { id: "locked", status: "active", source_kind: "custom_object", source_custom_object_id: "one", edit_from_source: false },
    { id: "archived", status: "archived", source_kind: "custom_object", source_custom_object_id: "one" },
  ] }, { kind: "custom_object", objectId: "one" });
  assert.deepEqual(selectors.map((item) => item.definition.id), ["visible"]);
});

test("initial relationship candidates use their dedicated route without a record id", () => {
  const route = relationshipRoutes.initialRelationshipCandidates("object-1", {
    definitionId: "definition-1", side: "source",
  });
  assert.match(route, /initial-relationship-candidates/);
  assert.doesNotMatch(route, /recordId/);
});

test("required initial relationships only apply when the new record is source", () => {
  const definition = { is_required: true };
  assert.equal(isRequiredInitialRelationship(definition, "source"), true);
  assert.equal(isRequiredInitialRelationship(definition, "target"), false);
});

test("initial relationship labels follow the new record side for both orientations", () => {
  const definition = { source_label: "Members", target_label: "Organisation Department" };
  assert.equal(initialRelationshipLabel(definition, "source"), "Members");
  assert.equal(initialRelationshipLabel(definition, "target"), "Organisation Department");
});

test("initial relationship selection count follows cardinality from the new record side", () => {
  assert.equal(initialRelationshipAllowsMultiple({ cardinality: "one_to_one" }, "source"), false);
  assert.equal(initialRelationshipAllowsMultiple({ cardinality: "many_to_one" }, "source"), false);
  assert.equal(initialRelationshipAllowsMultiple({ cardinality: "many_to_one" }, "target"), true);
  assert.equal(initialRelationshipAllowsMultiple({ cardinality: "one_to_many" }, "source"), true);
  assert.equal(initialRelationshipAllowsMultiple({ cardinality: "one_to_many" }, "target"), false);
  assert.equal(initialRelationshipAllowsMultiple({ cardinality: "many_to_many" }, "target"), true);
});

test("self relationship selector keys preserve each legal side", () => {
  assert.notEqual(
    relationshipSelectorKey("self-definition", "source"),
    relationshipSelectorKey("self-definition", "target"),
  );
});

test("loads all relationship definition pages beyond the default page size", async () => {
  const calls = [];
  const result = await loadRelationshipDefinitions("object-1", async (path) => {
    calls.push(path);
    const page = Number(new URL(`https://example.test${path}`).searchParams.get("page"));
    return { total: 26, data: [{ id: page }] };
  }, 25);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.data, [{ id: 1 }, { id: 2 }]);
});

test("no relationship metadata produces no dynamic tabs", () => {
  assert.deepEqual(
    relationshipPanels({ data: [] }, { kind: "organization", recordId: "12" }),
    [],
  );
  assert.deepEqual(
    relationshipPanels(undefined, { kind: "organization_group", recordId: "4" }),
    [],
  );
});

test("core metadata controls side, label count and visibility", () => {
  const panels = relationshipPanels({
    data: [{
      side: "target",
      count: 3,
      definition: {
        id: 7,
        status: "active",
        target_kind: "member",
        target_label: "Qualifications",
        show_on_target: true,
      },
    }],
  }, { kind: "member", recordId: "9" });
  assert.equal(panels.length, 1);
  assert.equal(panels[0].side, "target");
  assert.equal(panels[0].count, 3);
});

test("archived definitions are shown only in explicit history mode", () => {
  const payload = {
    data: [{
      id: "definition-1",
      status: "archived",
      source_kind: "custom_object",
      source_custom_object_id: "object-1",
      source_label: "Historic links",
      show_on_source: true,
    }],
  };
  const context = { kind: "custom_object", objectId: "object-1", recordId: "record-1" };
  assert.deepEqual(relationshipPanels(payload, context), []);
  assert.equal(
    relationshipPanels(payload, context, { includeArchived: true }).length,
    1,
  );
});

test("builds links for core and custom related records", () => {
  assert.equal(relatedRecordPath({ kind: "member", id: "3" }), "/members/3");
  assert.equal(
    relatedRecordPath({ kind: "custom_object", custom_object_id: "8", id: "2" }),
    "/CustomObjectsAdmin/8/records/2",
  );
});

test("uses the current object label for a fixed relationship source", () => {
  assert.equal(relationshipSourceName({ plural_label: "Departments" }), "Departments");
  assert.equal(
    relationshipSourceName({ singular_label: "Department", object_key: "departments" }),
    "Department",
  );
});

test("resolves the real source when a relationship is edited from its target object", () => {
  const source = { id: "object-department", plural_label: "Departments" };
  const target = { id: "object-team", plural_label: "Teams" };

  assert.equal(
    resolveRelationshipSourceObject({
      currentObject: target,
      sourceObjectId: source.id,
      objects: [target, source],
    }),
    source,
  );
  assert.equal(
    relationshipSourceName(resolveRelationshipSourceObject({
      currentObject: target,
      sourceObjectId: source.id,
      objects: [target, source],
    })),
    "Departments",
  );
});

test("target-side edits preserve source and target endpoint labels", () => {
  const form = {
    ...defaultDefinitionForm("object-team"),
    source_custom_object_id: "object-department",
    target_kind: "custom_object",
    target_custom_object_id: "object-team",
    relationship_key: "department_teams",
    source_label: "Teams",
    target_label: "Department",
  };

  assert.deepEqual(definitionPayload(form), {
    ...form,
    source_custom_object_id: "object-department",
    target_custom_object_id: "object-team",
  });
});

test("keeps the current object as source for new definitions and source-side edits", () => {
  const current = { id: "object-department", plural_label: "Departments" };

  assert.equal(
    resolveRelationshipSourceObject({
      currentObject: current,
      sourceObjectId: current.id,
      objects: [{ id: "object-team", plural_label: "Teams" }],
    }),
    current,
  );
  assert.equal(
    resolveRelationshipSourceObject({
      currentObject: current,
      sourceObjectId: null,
      objects: [],
    }),
    current,
  );
});

test("relationship definitions can only be created for active objects", () => {
  assert.equal(canDefineRelationships({ status: "active" }), true);
  assert.equal(canDefineRelationships({ status: "draft" }), false);
  assert.equal(canDefineRelationships({ status: "archived" }), false);
});

test("relationship definition payload keeps the fixed current object as source", () => {
  const form = {
    ...defaultDefinitionForm("object-current"),
    relationship_key: "Department members",
    source_label: "Members",
    target_label: "Departments",
  };

  assert.deepEqual(definitionPayload(form), {
    ...form,
    relationship_key: "department_members",
    source_custom_object_id: "object-current",
    target_custom_object_id: null,
  });
});