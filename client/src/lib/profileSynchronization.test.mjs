import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { confirmedProfilePatch, profileQueryKey, synchronizeProfile } from "./profileSynchronization.js";

test("confirmed fields replace stale cached values without replacing session metadata", async () => {
  const queryClient = new QueryClient();
  const session = { id: "m1", sessionExpiry: "future", handle: "member", job_title: "Old" };
  let current = session;
  let stored = JSON.stringify({ ...session, extra: "preserved" });
  queryClient.setQueryData(profileQueryKey("m1"), { job_title: "Old", mobile: "123", role: { id: "role" } });
  const submitted = { job_title: "New", mobile: "", biography: null, show_in_directory: false };
  const patch = confirmedProfilePatch({ id: "m1", ...submitted, handle: "unowned" }, submitted, "m1");
  await synchronizeProfile({
    queryClient, memberId: "m1", patch, sessionMember: session,
    setSessionMember: fn => { current = fn(current); },
    storage: { getItem: () => stored, setItem: (_, value) => { stored = value; } },
  });
  assert.deepEqual(queryClient.getQueryData(profileQueryKey("m1")), { ...submitted, role: { id: "role" } });
  assert.deepEqual(current, { ...session, ...submitted });
  assert.deepEqual(JSON.parse(stored), { ...session, extra: "preserved", ...submitted });
  queryClient.clear();
});

test("older in-flight reads cannot restore stale values after confirmation", async () => {
  const queryClient = new QueryClient();
  const key = profileQueryKey("m1");
  queryClient.setQueryData(key, { job_title: "Old" });
  let resolveRead;
  const read = queryClient.fetchQuery({ queryKey: key, queryFn: () => new Promise(resolve => { resolveRead = resolve; }) }).catch(() => {});
  await synchronizeProfile({
    queryClient, memberId: "m1", patch: { job_title: "Saved" },
    sessionMember: { id: "m1" }, setSessionMember: () => {},
    storage: { getItem: () => null, setItem: () => {} },
  });
  resolveRead({ job_title: "Old" });
  await read;
  assert.equal(queryClient.getQueryData(key).job_title, "Saved");
  queryClient.clear();
});

for (const brokenStorage of ["malformed", "unavailable"]) {
  test(`${brokenStorage} storage cannot block confirmed updates`, async () => {
    const queryClient = new QueryClient();
    let current = { id: "m1", sessionExpiry: "future", job_title: "Old" };
    await synchronizeProfile({
      queryClient, memberId: "m1", patch: { job_title: "New" }, sessionMember: current,
      setSessionMember: fn => { current = fn(current); },
      storage: {
        getItem: () => { if (brokenStorage === "unavailable") throw Error("Blocked"); return "{"; },
        setItem: () => { if (brokenStorage === "unavailable") throw Error("Blocked"); },
      },
    });
    assert.equal(current.job_title, "New");
    assert.equal(current.sessionExpiry, "future");
    assert.equal(queryClient.getQueryData(profileQueryKey("m1")).job_title, "New");
    queryClient.clear();
  });
}

test("missing or mismatched confirmation is an error, not a successful save", () => {
  for (const result of [null, { id: "other", job_title: "New" }, { id: "m1" }]) {
    assert.throws(() => confirmedProfilePatch(result, { job_title: "New" }, "m1"));
  }
});