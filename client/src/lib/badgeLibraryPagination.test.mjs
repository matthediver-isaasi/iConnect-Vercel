import test from "node:test";
import assert from "node:assert/strict";
import { badgeListOptions, badgePageNumbers } from "./badgeLibraryPagination.js";

test("bounded exact-count query combines full-library filters and stable ordering", () => {
  assert.deepEqual(badgeListOptions({ search: "Founding", status: "inactive", page: 3 }), {
    filter: { name: { ilike: "%Founding%" }, is_active: false },
    sort: { created_date: "desc", id: "desc" },
    limit: 12, offset: 24, queryParams: { count: "exact" },
  });
  assert.deepEqual(badgeListOptions({ search: "", status: "all", page: 1 }).filter, {});
  assert.equal(badgeListOptions({ search: "", status: "active", page: 1 }).filter.is_active, true);
});

test("percent, underscore, backslash and regex characters remain literal", () => {
  const options = search => badgeListOptions({ search, status: "all", page: 1 }).filter.name;
  assert.deepEqual(options("50%_\\done"), { ilike: "%50\\%\\_\\\\done%" });
  assert.deepEqual(options("A*.[x](y)+?^$|\\%_"), { imatch: "A\\*\\.\\[x\\]\\(y\\)\\+\\?\\^\\$\\|\\\\%_" });
});

test("page-number windows are bounded at both ends", () => {
  assert.deepEqual(badgePageNumbers(1, 1), [1]);
  assert.deepEqual(badgePageNumbers(1, 100), [1, 2, 3, 4, 5]);
  assert.deepEqual(badgePageNumbers(50, 100), [48, 49, 50, 51, 52]);
  assert.deepEqual(badgePageNumbers(100, 100), [96, 97, 98, 99, 100]);
});