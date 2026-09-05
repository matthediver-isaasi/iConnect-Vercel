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
  relationshipCandidateLabel,
  contextualOriginLabel,
  contextualPrimaryNameSuggestion,
  shouldApplyContextualNameSuggestion,
  nextInitialRelationshipSelection,
  isRequiredInitialRelationship,
  relationshipSelectorKey,
  relationshipBackPath,
  relationshipLinkState,
  relationshipOriginPath,
  relationshipEndpoint,
  relationshipEndpointsMatch,
  resolveRelationshipPickerPath,
  safeInAppPath,
  relationshipFields,
  relationshipFieldsForSide,
  relationshipFieldsAreValid,
  relationshipFieldCanEdit,
  relationshipFieldUpdatePayload,
  relationshipFieldValue,
  withRelationshipFieldValue,
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

test("guided picker paths follow stable definition IDs and reject cycles", () => {
  const definitions = [{
    id: "assignment-member",
    status: "active",
    source_kind: "custom_object",
    source_custom_object_id: "assignment",
    target_kind: "member",
    target_custom_object_id: null,
  }, {
    id: "assignment-organisation",
    status: "active",
    source_kind: "custom_object",
    source_custom_object_id: "assignment",
    target_kind: "organization",
    target_custom_object_id: null,
  }, {
    id: "organisation-assignment-cycle",
    status: "active",
    source_kind: "organization",
    source_custom_object_id: null,
    target_kind: "custom_object",
    target_custom_object_id: "assignment",
  }];
  const start = { kind: "member", customObjectId: null };
  const first = resolveRelationshipPickerPath({ definitions, start, path: [] });
  assert.deepEqual(first.options.map((item) => [item.definition.id, item.from_side]), [
    ["assignment-member", "target"],
  ]);
  const complete = resolveRelationshipPickerPath({
    definitions,
    start,
    path: [{
      relationship_definition_id: "assignment-member",
      from_side: "target",
    }, {
      relationship_definition_id: "assignment-organisation",
      from_side: "source",
    }],
  });
  assert.deepEqual(complete.endpoint, { kind: "organization", customObjectId: null });
  assert.equal(
    complete.options.some((item) => item.definition.id === "organisation-assignment-cycle"),
    false,
  );
  assert.equal(
    relationshipEndpointsMatch(
      complete.endpoint,
      relationshipEndpoint(definitions[1], "target"),
    ),
    true,
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

test("normalizes displayed boolean relationship fields and reads edge values by stable id or key", () => {
  const definition = { configuration: { relationship_fields: [{
    id: "primary-id",
    key: "is_primary",
    label: "Primary",
    type: "boolean",
    default: false,
    display: true,
    edit_from_source: true,
    edit_from_target: false,
  }] } };
  const [field] = relationshipFields(definition);
  assert.equal(field.id, "primary-id");
  assert.equal(relationshipFieldValue({ field_values: { is_primary: true } }, field), true);
  assert.equal(relationshipFieldValue({
    relationship_field_values: [{ field_id: "primary-id", value: "true" }],
  }, field), true);
  assert.equal(relationshipFieldValue({}, field), false);
});

test("keeps relationship field visibility independent on each routed side", () => {
  const definition = { configuration: { relationship_fields: [{
    id: "source-only",
    key: "source_only",
    label: "Source only",
    type: "boolean",
    display_on_source: true,
    display_on_target: false,
  }, {
    id: "target-only",
    key: "target_only",
    label: "Target only",
    type: "boolean",
    display_on_source: false,
    display_on_target: true,
  }] } };

  assert.deepEqual(
    relationshipFieldsForSide(definition, "source").map((field) => field.id),
    ["source-only"],
  );
  assert.deepEqual(
    relationshipFieldsForSide(definition, "target").map((field) => field.id),
    ["target-only"],
  );
});

test("relationship field edits require the configured side and an active edge", () => {
  const field = { edit_from_source: true, edit_from_target: false };
  assert.equal(relationshipFieldCanEdit({ field, side: "source", editable: true, edge: {} }), true);
  assert.equal(relationshipFieldCanEdit({ field, side: "target", editable: true, edge: {} }), false);
  assert.equal(relationshipFieldCanEdit({
    field, side: "source", editable: true, edge: { archived_at: "2026-01-01" },
  }), false);
});

test("builds partial edge field PATCH payload and optimistic edge value", () => {
  const field = { id: "primary-id", key: "is_primary" };
  assert.deepEqual(relationshipFieldUpdatePayload({
    field, value: true, side: "target", recordId: "record-1",
  }), {
    field_values: { is_primary: true },
    routed_side: "target",
    routed_record_id: "record-1",
  });
  assert.equal(
    relationshipFieldValue(withRelationshipFieldValue({ field_values: {} }, field, true), field),
    true,
  );
});

test("validates relationship field stable keys and preserves them in definition payload", () => {
  const form = {
    ...defaultDefinitionForm("object-1"),
    configuration: { relationship_fields: [
      { id: "one", key: "approved", label: "Approved", type: "boolean" },
      { id: "two", key: "approved", label: "Duplicate", type: "boolean" },
    ] },
  };
  assert.equal(relationshipFieldsAreValid(form), false);
  form.configuration.relationship_fields[1].key = "reviewed";
  assert.equal(relationshipFieldsAreValid(form), true);
  assert.deepEqual(
    definitionPayload(form).configuration.relationship_fields.map(({ id, key }) => ({ id, key })),
    [{ id: "one", key: "approved" }, { id: "two", key: "reviewed" }],
  );
});

test("rejects relationship field keys that the API cannot store", () => {
  assert.equal(relationshipFieldsAreValid({
    configuration: {
      relationship_fields: [{
        id: "field-1",
        key: "123 starts with a number",
        label: "Invalid key",
        type: "boolean",
      }],
    },
  }), false);
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

test("contextual primary names use one fixed origin and one selected single relationship", () => {
  const selector = {
    definition: { id: "organisation", cardinality: "many_to_one" },
    side: "source",
  };
  const key = relationshipSelectorKey("organisation", "source");
  assert.equal(
    contextualPrimaryNameSuggestion({
      originLabel: "Jane Smith",
      selectors: [selector],
      relationships: { [key]: [{ id: "org-1", primary_label: "Acme University" }] },
    }),
    "Jane Smith - Acme University",
  );
  assert.equal(contextualPrimaryNameSuggestion({
    originLabel: "Jane Smith",
    selectors: [selector],
    relationships: { [key]: [] },
  }), "");
  assert.equal(contextualPrimaryNameSuggestion({
    originLabel: "Jane Smith",
    selectors: [selector, { ...selector, definition: { id: "other", cardinality: "one_to_one" } }],
    relationships: { [key]: [{ id: "org-1", primary_label: "Acme University" }] },
  }), "");
});

test("contextual labels follow shared endpoint display conventions", () => {
  assert.equal(
    contextualOriginLabel({ kind: "member" }, { first_name: "Jane", last_name: "Smith" }),
    "Jane Smith",
  );
  assert.equal(contextualOriginLabel({ kind: "organization" }, { name: "Acme" }), "Acme");
  assert.equal(relationshipCandidateLabel({ display_value: "Research" }), "Research");
});

test("manual primary-name edits, including clearing the name, block later suggestions", () => {
  assert.equal(shouldApplyContextualNameSuggestion({
    manuallyOverridden: false,
    currentValue: "Jane Smith - Old Organisation",
    suggestedValue: "Jane Smith - New Organisation",
  }), true);
  assert.equal(shouldApplyContextualNameSuggestion({
    manuallyOverridden: true,
    currentValue: "My own assignment name",
    suggestedValue: "Jane Smith - New Organisation",
  }), false);
  assert.equal(shouldApplyContextualNameSuggestion({
    manuallyOverridden: true,
    currentValue: "",
    suggestedValue: "Jane Smith - New Organisation",
  }), false);
});

test("relationship selections retain full labels across result pages", () => {
  const first = { id: "org-1", primary_label: "Alpha Organisation" };
  const second = { id: "org-80", primary_label: "Zulu Organisation" };
  const selected = nextInitialRelationshipSelection({
    selected: [first],
    entry: second,
    checked: true,
    allowsMultiple: true,
  });
  assert.deepEqual(selected, [first, second]);
  assert.deepEqual(nextInitialRelationshipSelection({
    selected,
    entry: first,
    checked: false,
    allowsMultiple: true,
  }), [second]);
  assert.deepEqual(nextInitialRelationshipSelection({
    selected,
    entry: second,
    checked: true,
    allowsMultiple: false,
  }), [second]);
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

test("relationship links retain the complete in-app organisation origin", () => {
  const location = {
    pathname: "/organisations/org-12",
    search: "?tab=relationship-7-source",
    hash: "#related",
  };
  assert.equal(
    relationshipOriginPath(location),
    "/organisations/org-12?tab=relationship-7-source#related",
  );
  assert.deepEqual(relationshipLinkState(location), {
    relationshipReturnTo: "/organisations/org-12?tab=relationship-7-source#related",
  });
});

test("relationship origins work for member, organisation-group and custom-object details", () => {
  [
    "/members/member-3",
    "/OrganisationGroups/group-4",
    "/CustomObjectsAdmin/object-8/records/record-2",
  ].forEach((pathname) => {
    assert.equal(relationshipBackPath(
      relationshipLinkState({ pathname }),
      "/CustomObjectsAdmin/target/records",
    ), pathname);
  });
});

test("direct record access and unsafe return state fall back to the records list", () => {
  const fallback = "/CustomObjectsAdmin/object-8/records";
  assert.equal(relationshipBackPath(undefined, fallback), fallback);
  assert.equal(relationshipBackPath({}, fallback), fallback);
  assert.equal(relationshipBackPath({ relationshipReturnTo: "https://evil.test/path" }, fallback), fallback);
  assert.equal(relationshipBackPath({ relationshipReturnTo: "//evil.test/path" }, fallback), fallback);
  assert.equal(relationshipBackPath({ relationshipReturnTo: "/\\evil.test/path" }, fallback), fallback);
  assert.equal(safeInAppPath("/members/member-3?tab=details#top"), "/members/member-3?tab=details#top");
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