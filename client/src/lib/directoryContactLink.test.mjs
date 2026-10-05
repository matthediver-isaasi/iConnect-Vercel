import test from "node:test";
import assert from "node:assert/strict";
import { directoryContactLink } from "./directoryContactLink.js";

test("typed and legacy contacts preserve full destinations without changing labels", () => {
  for (const field_type of ["text", "url", "website"]) {
    for (const value of ["https://example.test/student/en?q=one&next=%2Ftwo#part", "http://www.example.test/path"]) {
      assert.deepEqual(directoryContactLink({ field_type }, value), { href: value, external: true });
    }
    assert.equal(directoryContactLink({ field_type }, "example.test/a?b=c").href, "https://example.test/a?b=c");
  }
  for (const field_type of ["email", "text"]) {
    assert.equal(directoryContactLink({ field_type }, " person+tag@example.test ").href, "mailto:person%2Btag@example.test");
    assert.equal(directoryContactLink({ field_type }, "a?subject=x@example.test").href, "mailto:a%3Fsubject%3Dx@example.test");
  }
});

test("invalid, malicious, prose, and non-contact field values stay inert", () => {
  const invalid = [
    "javascript:alert(1)", "data:text/html,hi", "ftp://example.test", "//example.test",
    "https://user:pass@example.test", "https:\\\\example.test", "https://example.test\n",
    "\tperson@example.test", "a@example.test\r\nBcc:other@example.test",
    "https:///example.test", "https://%65xample.test",
    "https://example.test/%0d%0a", "person%0a@example.test", "a@@example.test",
    ".a@example.test", "a..b@example.test", "a@example", "https://-bad.test",
    "Contact a@example.test", "Visit https://example.test", "<a@example.test>",
    "example", "", "34644069883", ["a@example.test"], { value: "example.test" },
  ];
  for (const value of invalid) assert.equal(directoryContactLink({ field_type: "text" }, value), null, String(value));
  for (const field_type of ["dropdown", "picklist", "file", "textarea", "richtext", "number", "boolean", "date"]) {
    assert.equal(directoryContactLink({ field_type, label: "Website" }, "example.test"), null);
  }
  assert.equal(directoryContactLink({ field_type: "email" }, "example.test"), null);
  assert.equal(directoryContactLink({ field_type: "url" }, "a@example.test"), null);
});
