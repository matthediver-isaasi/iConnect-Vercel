import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRecordPermissionToggle,
  arrayValue,
  buildRecordPayload,
  coerceRecordValue,
  customObjectDetailLayout,
  detailSections,
  evaluateCustomObjectVisibility,
  fieldAccess,
  formatRecordValue,
  normalizeRecordPermissions,
  optionValues,
  sharedListFields,
  unplacedRelationshipPanels,
  validateRecordValues,
} from "./recordHelpers.js";

const field = (name, fieldType, extra = {}) => ({
  id: `${name}-id`,
  name,
  label: name[0].toUpperCase() + name.slice(1),
  field_type: fieldType,
  is_active: true,
  ...extra,
});

test("required validation treats empty strings and arrays as blank", () => {
  const fields = [
    field("title", "text", { is_required: true }),
    field("tags", "picklist", {
      is_required: true,
      options: [{ value: "one", label: "One" }],
    }),
  ];
  assert.deepEqual(validateRecordValues(fields, { title: "", tags: [] }), {
    title: "Title is required",
    tags: "Tags is required",
  });
  assert.deepEqual(
    validateRecordValues(fields, { title: "Present", tags: ["one"] }),
    {},
  );
});

test("integer and decimal values are coerced and validated", () => {
  const integer = field("count", "number");
  const decimal = field("price", "decimal");
  assert.equal(coerceRecordValue(integer, "12"), 12);
  assert.equal(coerceRecordValue(decimal, "12.50"), 12.5);
  assert.match(
    validateRecordValues([integer], { count: "1.5" }).count,
    /whole number/,
  );
  assert.match(
    validateRecordValues([decimal], { price: "not-a-number" }).price,
    /finite number/,
  );
});

test("email validation accepts normal addresses and rejects malformed values", () => {
  const email = field("email", "email");
  assert.deepEqual(
    validateRecordValues([email], { email: "person@example.org" }),
    {},
  );
  assert.match(
    validateRecordValues([email], { email: "person@" }).email,
    /valid email address/,
  );
});

test("URL validation allows only valid HTTP and HTTPS URLs", () => {
  const website = field("website", "url");
  for (const value of ["https://example.org/path", "http://example.org"]) {
    assert.deepEqual(validateRecordValues([website], { website: value }), {});
  }
  for (const value of ["example.org", "ftp://example.org"]) {
    assert.match(
      validateRecordValues([website], { website: value }).website,
      /valid HTTP or HTTPS URL/,
    );
  }
});

test("date validation rejects malformed and impossible calendar dates", () => {
  const date = field("start", "date");
  assert.deepEqual(validateRecordValues([date], { start: "2024-02-29" }), {});
  for (const value of ["29/02/2024", "2023-02-29", "2024-13-01"]) {
    assert.match(
      validateRecordValues([date], { start: value }).start,
      /valid date/,
    );
  }
});

test("text minimum and maximum lengths are enforced", () => {
  const summary = field("summary", "textarea", {
    min_length: 3,
    max_length: 5,
  });
  assert.match(
    validateRecordValues([summary], { summary: "ab" }).summary,
    /at least 3 characters/,
  );
  assert.deepEqual(
    validateRecordValues([summary], { summary: "valid" }),
    {},
  );
  assert.match(
    validateRecordValues([summary], { summary: "longer" }).summary,
    /no more than 5 characters/,
  );
});

test("multi-selection minimum and maximum counts are enforced", () => {
  const tags = field("tags", "picklist", {
    options: ["one", "two", "three"],
    min_selections: 2,
    max_selections: 2,
  });
  assert.match(
    validateRecordValues([tags], { tags: ["one"] }).tags,
    /at least 2 selections/,
  );
  assert.deepEqual(
    validateRecordValues([tags], { tags: ["one", "two"] }),
    {},
  );
  assert.match(
    validateRecordValues([tags], { tags: ["one", "two", "three"] }).tags,
    /no more than 2 selections/,
  );
});

test("option normalization supports string and object definitions", () => {
  const status = field("status", "dropdown", {
    options: ["draft", { value: 2, label: "Published" }],
  });
  assert.deepEqual(optionValues(status), [
    { value: "draft", label: "draft" },
    { value: "2", label: "Published" },
  ]);
  assert.deepEqual(
    validateRecordValues([status], { status: "draft" }),
    {},
  );
  assert.match(
    validateRecordValues([status], { status: "unknown" }).status,
    /allowed option/,
  );
});

test("picklist and restricted country values must be allowed", () => {
  const categories = field("categories", "picklist", {
    options: [{ value: "a", label: "A" }],
  });
  const country = field("country", "country", {
    all_countries: false,
    selected_countries: ["GB", "IE"],
  });
  const countries = field("countries", "countries", {
    all_countries: false,
    selected_countries: JSON.stringify(["GB", "IE"]),
  });
  assert.deepEqual(
    validateRecordValues([categories, country, countries], {
      categories: ["a"],
      country: "GB",
      countries: ["GB", "IE"],
    }),
    {},
  );
  assert.match(
    validateRecordValues([categories], { categories: ["x"] }).categories,
    /not allowed/,
  );
  assert.match(
    validateRecordValues([country], { country: "US" }).country,
    /allowed country/,
  );
  assert.match(
    validateRecordValues([countries], { countries: ["GB", "US"] }).countries,
    /country that is not allowed/,
  );
});

test("file upload JSON is normalized for server and display compatibility", () => {
  const upload = field("document", "file", {
    allowed_file_types: ["pdf"],
  });
  const raw = JSON.stringify({
    file_name: "report.pdf",
    file_url: "https://files.example/report.pdf",
    storage_path: "private/report.pdf",
  });
  const normalized = coerceRecordValue(upload, raw);
  assert.equal(normalized.name, "report.pdf");
  assert.equal(normalized.url, "https://files.example/report.pdf");
  assert.equal(normalized.path, "private/report.pdf");
  assert.deepEqual(validateRecordValues([upload], { document: raw }), {});
  assert.match(
    validateRecordValues([upload], {
      document: JSON.stringify({
        file_name: "report.exe",
        file_url: "https://files.example/report.exe",
      }),
    }).document,
    /file type that is not allowed/,
  );
});

test("payload construction coerces active fields and omits archived fields", () => {
  const fields = [
    field("title", "text"),
    field("count", "number"),
    field("enabled", "boolean"),
    field("countries", "countries"),
    field("legacy", "text", { is_active: false }),
  ];
  const values = {
    title: "  A title  ",
    count: "4",
    enabled: "true",
    countries: '["GB","IE"]',
    legacy: "preserve me on the existing server record",
  };
  assert.deepEqual(buildRecordPayload(fields, values), {
    data: {
      title: "A title",
      count: 4,
      enabled: true,
      countries: ["GB", "IE"],
    },
  });
  assert.equal(
    values.legacy,
    "preserve me on the existing server record",
    "building a partial update must not mutate historical input data",
  );
});

test("historic edits omit untouched fields that became required later", () => {
  const fields = [
    field("name", "text", { is_required: true }),
    field("new_required", "text", { is_required: true }),
  ];
  const historicValues = { name: "Radiology" };
  assert.deepEqual(
    validateRecordValues(fields, historicValues, { partial: true }),
    {},
  );
  assert.deepEqual(
    buildRecordPayload(fields, historicValues, { partial: true }),
    { data: { name: "Radiology" } },
  );
  assert.match(
    validateRecordValues(
      fields,
      { ...historicValues, new_required: "" },
      { partial: true },
    ).new_required,
    /required/,
  );
});

test("array coercion and display formatting cover selections, countries and booleans", () => {
  assert.deepEqual(arrayValue('["a","b"]'), ["a", "b"]);
  assert.deepEqual(arrayValue("single"), ["single"]);
  const picklist = field("tags", "picklist", {
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ],
  });
  assert.equal(formatRecordValue(picklist, ["a", "b"]), "Alpha, Beta");
  assert.equal(
    formatRecordValue(field("country", "country"), "GB", {
      GB: "United Kingdom",
    }),
    "United Kingdom",
  );
  assert.equal(formatRecordValue(field("active", "boolean"), true), "Yes");
  assert.equal(formatRecordValue(field("active", "boolean"), false), "No");
  assert.equal(formatRecordValue(field("empty", "text"), null), "—");
});

test("dependent record grants automatically include View", () => {
  for (const key of [
    "can_create_records",
    "can_edit_records",
    "can_archive_records",
    "can_export_records",
  ]) {
    const result = applyRecordPermissionToggle({}, key, true);
    assert.equal(result.can_view_records, true, `${key} should imply View`);
    assert.equal(result[key], true);
  }
});

test("disabling View clears every dependent record grant", () => {
  const result = applyRecordPermissionToggle(
    {
      can_view_records: true,
      can_create_records: true,
      can_edit_records: true,
      can_archive_records: true,
      can_export_records: true,
    },
    "can_view_records",
    false,
  );
  assert.deepEqual(result, {
    can_view_records: false,
    can_create_records: false,
    can_edit_records: false,
    can_archive_records: false,
    can_export_records: false,
  });
});

test("permissions returned in an unusable state are normalized for display and resave", () => {
  assert.deepEqual(
    normalizeRecordPermissions({
      can_view_records: false,
      can_create_records: true,
      can_edit_records: null,
    }),
    {
      can_view_records: true,
      can_create_records: true,
      can_edit_records: false,
      can_archive_records: false,
      can_export_records: false,
    },
  );
  assert.deepEqual(
    applyRecordPermissionToggle(
      { can_view_records: false, can_edit_records: true },
      "can_edit_records",
      false,
    ),
    {
      can_view_records: true,
      can_create_records: false,
      can_edit_records: false,
      can_archive_records: false,
      can_export_records: false,
    },
  );
});

test("configured views retain order while excluding hidden and archived fields", () => {
  const fields = [
    field("name", "text"),
    field("private", "text", { field_access: "none" }),
    field("state", "text", { field_access: "read" }),
    field("old", "text", { is_active: false }),
  ];
  const object = { singular_label: "Item", configuration: { views: {
    list: { field_ids: ["state-id", "private-id", "old-id", "name-id"] },
    detail: { sections: [{ label: "Summary", field_ids: ["state-id", "private-id"] }] },
  } } };
  assert.equal(fieldAccess(fields[2]), "read");
  assert.deepEqual(sharedListFields(object, fields).map((item) => item.name), ["state", "name"]);
  assert.deepEqual(detailSections(object, fields).map((section) => section.fields.map((item) => item.name)), [["state"]]);
});

test("CRM detail layouts reconcile stable field and relationship IDs", () => {
  const fields = [field("name", "text"), field("new_field", "text"), field("gone", "text", { is_active: false })];
  const panels = [{ definition: { id: "rel-1" }, side: "target" }, { definition: { id: "rel-2" }, side: "source" }];
  const object = { singular_label: "Item", configuration: { views: { detail: { version: 2, cards: [{
    id: "summary", title: "Summary", columns: 9, fields: [
      { id: "custom:name-id", type: "custom", fieldId: "name-id", columnIndex: 0 },
      { id: "custom:gone-id", type: "custom", fieldId: "gone-id", columnIndex: 1 },
      { id: "relationship:rel-1:target", type: "relationship", definitionId: "rel-1", side: "target", columnIndex: 1 },
    ],
  }] } } } };
  const layout = customObjectDetailLayout(object, fields, panels);
  assert.equal(layout.version, 2);
  assert.equal(layout.cards[0].columns, 3);
  assert.deepEqual(layout.cards[0].fields.map((item) => item.id), [
    "custom:name-id", "relationship:rel-1:target", "custom:new_field-id",
  ]);
  assert.deepEqual(unplacedRelationshipPanels(layout, panels), [panels[1]]);
});

test("CRM visibility rules use stable field IDs and fail safely for stale conditions", () => {
  const fields = [field("state", "text")];
  const rules = { rules: [
    { conditions: [{ field_id: "custom:state-id", operator: "equals", value: "Closed" }], actions: [{ action_type: "hide", target_type: "card", target_card_id: "summary" }] },
    { conditions: [{ field_id: "custom:missing", operator: "equals", value: "x" }], actions: [{ action_type: "hide", target_type: "field", target_field_id: "custom:state-id" }] },
  ] };
  const result = evaluateCustomObjectVisibility(rules, { data: { state: "Closed" } }, fields);
  assert.deepEqual([...result.hiddenCards], ["summary"]);
  assert.equal(result.hiddenElements.size, 0);
});

test("CRM visibility rules support negative contains and both non-empty spellings", () => {
  const fields = [
    field("tags", "list"),
    field("summary", "text"),
  ];
  const rules = [
    {
      conditions: [
        { field_id: "custom:tags-id", operator: "not_contains", value: "blocked" },
        { field_id: "custom:summary-id", operator: "not_empty" },
      ],
      actions: [{ action_type: "hide", target_type: "card", target_card_id: "restricted" }],
    },
    {
      conditions: [
        { field_id: "custom:summary-id", operator: "is_not_empty" },
      ],
      actions: [{ action_type: "hide", target_type: "field", target_field_id: "custom:summary-id" }],
    },
  ];
  const result = evaluateCustomObjectVisibility(
    rules,
    { data: { tags: ["open", "featured"], summary: "Ready" } },
    fields,
  );
  assert.deepEqual([...result.hiddenCards], ["restricted"]);
  assert.deepEqual([...result.hiddenElements], ["custom:summary-id"]);

  const blocked = evaluateCustomObjectVisibility(
    rules,
    { data: { tags: ["blocked"], summary: "Ready" } },
    fields,
  );
  assert.equal(blocked.hiddenCards.size, 0);
});

test("CRM field snapshot distinguishes intentionally unplaced and newly added fields", () => {
  const fields = [field("placed", "text"), field("unplaced", "text"), field("new", "text")];
  const object = { configuration: { views: { detail: {
    version: 2,
    schema_field_ids: ["placed-id", "unplaced-id"],
    cards: [{ id: "details", columns: 1, fields: [{ id: "custom:placed-id", type: "custom", fieldId: "placed-id" }] }],
  } } } };
  const layout = customObjectDetailLayout(object, fields);
  assert.deepEqual(layout.cards[0].fields.map((item) => item.id), ["custom:placed-id", "custom:new-id"]);
});