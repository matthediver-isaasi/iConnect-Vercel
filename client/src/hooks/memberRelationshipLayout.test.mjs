import test from "node:test";
import assert from "node:assert/strict";
import {
  memberRelationshipLayoutElements,
  memberRelationshipLayoutId,
  mergeLayoutWithCustomFields,
} from "./useMemberDetailLayout.js";
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
  }]);
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
  assert.deepEqual(merged.cards[0].fields, [layout.cards[0].fields[0]]);
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
  assert.deepEqual(mergeLayoutWithCustomFields(layout, [], null).cards[0].fields, [relationship]);
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