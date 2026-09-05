import test from "node:test";
import assert from "node:assert/strict";
import {
  loadActiveRelationshipObjects,
  loadCustomObjectFields,
} from "./relationshipApi.js";

test("loads and flattens every page of active relationship objects", async () => {
  const requested = [];
  const request = async (path) => {
    requested.push(path);
    const page = Number(new URL(path, "https://example.test").searchParams.get("page"));
    return {
      data: [{ id: `object-${page}`, status: "active" }],
      total: 3,
      page,
      pageSize: 1,
    };
  };

  const result = await loadActiveRelationshipObjects(request, 1);

  assert.deepEqual(result.data.map((item) => item.id), [
    "object-1",
    "object-2",
    "object-3",
  ]);
  assert.equal(requested.length, 3);
  assert.ok(requested.every((path) => path.includes("status=active")));
});

test("preserves an empty active-object catalogue", async () => {
  const result = await loadActiveRelationshipObjects(async () => ({
    data: [],
    total: 0,
    page: 1,
    pageSize: 100,
  }));
  assert.deepEqual(result.data, []);
});

test("propagates active-object catalogue errors to the dialog", async () => {
  await assert.rejects(
    () => loadActiveRelationshipObjects(async () => {
      throw new Error("Access denied");
    }),
    /Access denied/,
  );
});

test("loads and flattens every page of Custom Object fields", async () => {
  const requested = [];
  const result = await loadCustomObjectFields("object-1", {
    includeInactive: true,
    pageSize: 2,
    request: async (path) => {
      requested.push(path);
      const page = Number(new URL(path, "https://example.test").searchParams.get("page"));
      return {
        data: [{ id: `field-${page}` }],
        total: 3,
        page,
        pageSize: 2,
      };
    },
  });
  assert.deepEqual(result.data.map((item) => item.id), ["field-1", "field-2"]);
  assert.equal(requested.length, 2);
  assert.ok(requested.every((path) => path.includes("includeInactive=true")));
});