import test from "node:test";
import assert from "node:assert/strict";
import {
  memberRelationshipLayoutElements,
  memberRelationshipLayoutId,
  mergeLayoutWithCustomFields,
  normalizeRelationshipDisplayMode,
} from "./useMemberDetailLayout.js";
import {
  organisationRelationshipLayoutElements,
  organisationRelationshipLayoutId,
  mergeLayoutWithCustomFields as mergeOrganisationLayoutWithCustomFields,
  normalizeOrganisationRelationshipDisplayMode,
} from "./useOrgDetailLayout.js";
import { evaluateVisibilityRules } from "./useOrgFieldVisibilityRules.js";

const activePanel = {
  definition: { id: "department", source_label: "Organisation Department" },
  side: "source",
};

test("relationship layout identity is stable across labels", () => {
  assert.equal(
    memberRelationshipLayoutId("department", "source"),
    "relationship:department:source",
  );
  assert.deepEqual(memberRelationshipLayoutElements([activePanel]), [{
    id: "relationship:department:source",
    type: "relationship",
    definitionId: "department",
    side: "source",
    displayMode: "columns",
  }]);
});

test("relationship display modes default safely and preserve cards", () => {
  assert.equal(normalizeRelationshipDisplayMode(), "columns");
  assert.equal(normalizeRelationshipDisplayMode("invalid"), "columns");
  assert.equal(normalizeRelationshipDisplayMode("cards"), "cards");
  const layout = { cards: [{ id: "relationships", columns: 1, fields: [{
    id: "relationship:department:source",
    type: "relationship",
    definitionId: "department",
    side: "source",
    display_mode: "cards",
  }] }] };
  assert.equal(
    mergeLayoutWithCustomFields(layout, [], [activePanel]).cards[0].fields[0].displayMode,
    "cards",
  );
});

test("existing layouts remain unchanged when they contain no relationship elements", () => {
  const layout = {
    cards: [{
      id: "legacy",
      title: "Legacy",
      columns: 1,
      fields: [{ id: "core:first_name", type: "core", fieldKey: "first_name", columnIndex: 0 }],
    }],
  };
  assert.deepEqual(mergeLayoutWithCustomFields(layout, [], [activePanel]), layout);
});

test("available relationship elements retain position and stale elements fail safely", () => {
  const layout = {
    cards: [{
      id: "relationships",
      title: "Relationships",
      columns: 2,
      fields: [
        {
          id: "relationship:department:source",
          type: "relationship",
          definitionId: "department",
          side: "source",
          columnIndex: 1,
        },
        {
          id: "relationship:archived:target",
          type: "relationship",
          definitionId: "archived",
          side: "target",
          columnIndex: 0,
        },
      ],
    }],
  };
  const merged = mergeLayoutWithCustomFields(layout, [], [activePanel]);
  assert.deepEqual(merged.cards[0].fields, [{
    ...layout.cards[0].fields[0],
    displayMode: "columns",
  }]);
});

test("unresolved relationship metadata never deletes persisted placements", () => {
  const relationship = {
    id: "relationship:department:source",
    type: "relationship",
    definitionId: "department",
    side: "source",
    columnIndex: 0,
  };
  const layout = {
    cards: [{
      id: "relationships",
      title: "Relationships",
      columns: 1,
      fields: [relationship],
    }],
  };
  assert.deepEqual(mergeLayoutWithCustomFields(layout, [], null).cards[0].fields, [{
    ...relationship,
    displayMode: "columns",
  }]);
  assert.deepEqual(mergeLayoutWithCustomFields(layout, [], []).cards, []);
});

test("relationship targets obey matching and non-matching existing field rules", () => {
  const target = "relationship:department:source";
  const rules = {
    rules: [{
      id: "department-visibility",
      logic: "and",
      conditions: [{ field_id: "core:job_title", operator: "equals", value: "Chair" }],
      actions: [{ action_type: "show", target_type: "relationship", target_field_id: target }],
    }],
  };
  assert.equal(
    evaluateVisibilityRules(rules, { job_title: "Chair" }, []).hiddenFields.has(target),
    false,
  );
  assert.equal(
    evaluateVisibilityRules(rules, { job_title: "Member" }, []).hiddenFields.has(target),
    true,
  );
});

const organisationPanel = {
  definition: { id: "organisation-department", source_label: "Departments" },
  side: "source",
};

test("organisation relationship layout identity is stable across labels", () => {
  assert.equal(
    organisationRelationshipLayoutId("organisation-department", "source"),
    "relationship:organisation-department:source",
  );
  assert.deepEqual(organisationRelationshipLayoutElements([organisationPanel]), [{
    id: "relationship:organisation-department:source",
    type: "relationship",
    definitionId: "organisation-department",
    side: "source",
    displayMode: "columns",
  }]);
});

test("organisation relationship modes default safely and preserve cards", () => {
  assert.equal(normalizeOrganisationRelationshipDisplayMode(), "columns");
  assert.equal(normalizeOrganisationRelationshipDisplayMode("cards"), "cards");
  const relationship = {
    id: "relationship:organisation-department:source",
    type: "relationship",
    definitionId: "organisation-department",
    side: "source",
    displayMode: "cards",
  };
  const layout = { cards: [{ id: "relationships", columns: 1, fields: [relationship] }] };
  assert.equal(
    mergeOrganisationLayoutWithCustomFields(layout, [], [organisationPanel]).cards[0].fields[0].displayMode,
    "cards",
  );
});

test("organisation layouts preserve legacy fields and remove only stale relationships after resolution", () => {
  const layout = {
    cards: [{
      id: "details",
      title: "Details",
      columns: 1,
      fields: [
        { id: "core:name", type: "core", fieldKey: "name", columnIndex: 0 },
        {
          id: "relationship:organisation-department:source",
          type: "relationship",
          definitionId: "organisation-department",
          side: "source",
          columnIndex: 0,
        },
        {
          id: "relationship:archived:source",
          type: "relationship",
          definitionId: "archived",
          side: "source",
          columnIndex: 0,
        },
      ],
    }],
  };

  assert.deepEqual(
    mergeOrganisationLayoutWithCustomFields(layout, [], null).cards[0].fields,
    layout.cards[0].fields.map(field => field.type === "relationship"
      ? { ...field, displayMode: "columns" }
      : field),
  );
  assert.deepEqual(
    mergeOrganisationLayoutWithCustomFields(layout, [], [organisationPanel]).cards[0].fields,
    [
      layout.cards[0].fields[0],
      { ...layout.cards[0].fields[1], displayMode: "columns" },
    ],
  );
  assert.deepEqual(
    mergeOrganisationLayoutWithCustomFields(layout, [], []).cards[0].fields,
    [layout.cards[0].fields[0]],
  );
});

test("relationship lock and unlock actions never affect organisation relationship targets", () => {
  const relationship = "relationship:organisation-department:source";
  const locked = evaluateVisibilityRules({
    rules: [{
      conditions: [{ field_id: "core:name", operator: "equals", value: "Acme" }],
      actions: [{ action_type: "lock", target_type: "relationship", target_field_id: relationship }],
    }],
  }, { name: "Acme" }, []);
  assert.equal(locked.lockedFields.has(relationship), false);

  const shown = evaluateVisibilityRules({
    rules: [{
      conditions: [{ field_id: "core:name", operator: "equals", value: "Acme" }],
      actions: [{ action_type: "show", target_type: "relationship", target_field_id: relationship }],
    }],
  }, { name: "Other" }, []);
  assert.equal(shown.hiddenFields.has(relationship), true);
});