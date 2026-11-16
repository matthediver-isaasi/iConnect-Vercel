import assert from "node:assert/strict";
import { test } from "node:test";
import { jsPDF } from "jspdf";
import { PDFDocument } from "pdf-lib";
import { buildSchedulePdfModel, renderSchedulePdf, rasterizeScheduleLogo, downloadSchedulePdf } from "./schedulePdf.mjs";

const event = {
  title: "Community learning forum", start_date: "2026-06-18T23:30:00Z",
  end_date: "2026-06-20T10:00:00Z", timezone: "Europe/London", location: "Forum hall",
  admin_notes: "SECRET NOTES", zoom_join_url: "SECRET LINK",
};
const session = (overrides = {}) => ({
  title: "Opening conversation", start_time: "2026-06-18T23:30:00Z",
  duration_minutes: 45, track_names: ["Research"], ...overrides,
});
const inputs = {
  event, sessions: [session()], eventTracks: [{ name: "Practice" }, { name: "Research" }],
  trackColorMap: { Research: { accent: "#234567" }, Practice: { accent: "#876543" } },
};

test("uses local days, event basics, duration fallback, configured order and only allowlisted fields", () => {
  const model = buildSchedulePdfModel({
    ...inputs,
    sessions: [
      session({ track_names: ["Research", "Hidden", "Practice"], speaker_ids: ["s1"], speaker_names: ["Fallback"], zoom_url: "SECRET URL", notes: "SECRET NOTES" }),
      session({ title: "General welcome", track_names: [] }),
      session({ title: "SECRET SESSION", track_names: ["Hidden"] }),
    ],
    speakerMap: { s1: { full_name: "Amira Shah", private_email: "SECRET EMAIL" } },
  });
  assert.deepEqual(model.tracks.map(track => track.name), ["Practice", "Research", "General"]);
  assert.equal(model.days.length, 1);
  assert.equal(model.days[0].label, "Friday, 19 June 2026");
  assert.equal(model.days[0].sessions[0].time, "00:30 - 01:15");
  assert.equal(model.days[0].sessions[0].speakers, "Amira Shah");
  assert.deepEqual(model.days[0].sessions[0].trackKeys, ["Research", "Practice"]);
  assert.deepEqual(model.days[0].sessions[1].trackKeys, [null]);
  assert.equal(model.title, event.title);
  assert.equal(model.location, event.location);
  assert.equal(model.date, "19 June 2026 - 20 June 2026");
  assert.doesNotMatch(JSON.stringify(model), /SECRET|Hidden|Fallback|private_email|zoom/i);
});

test("an explicitly empty color map never falls back to hidden track names", () => {
  const model = buildSchedulePdfModel({ ...inputs, trackColorMap: {}, sessions: [
    session({ track_names: ["Hidden"] }), session({ title: "Public welcome", track_names: [] }),
  ] });
  assert.deepEqual(model.tracks.map(track => track.name), ["General"]);
  assert.deepEqual(model.days[0].sessions.map(item => item.title), ["Public welcome"]);
});

test("missing times are exported, invalid timezone is visible as an error, legacy tracks/speakers work", () => {
  const model = buildSchedulePdfModel({ ...inputs, sessions: [
    session({ track_names: undefined, track_name: "Research", start_time: null, speaker_names: ["Mila Stone"] }),
    session({ title: "Invalid date", start_time: "invalid" }),
  ] });
  assert.equal(model.days[0].label, "Date to be confirmed");
  assert.equal(model.days[0].sessions.length, 2);
  assert.equal(model.days[0].sessions[0].speakers, "Mila Stone");
  assert.equal(model.days[0].sessions[0].time, "Time to be confirmed");
  assert.throws(() => buildSchedulePdfModel({ ...inputs, timezone: "Not/AZone" }), RangeError);
});

test("landscape PDF splits many tracks and very long content over bounded, readable pages without losing text", async () => {
  const tracks = Array.from({ length: 9 }, (_, index) => ({ name: `Track ${index + 1}` }));
  const longTitle = Array.from({ length: 200 }, (_, index) => `Titleword${index}`).join(" ");
  const longSpeaker = Array.from({ length: 150 }, (_, index) => `Speakerword${index}`).join(" ");
  const model = buildSchedulePdfModel({
    ...inputs, eventTracks: tracks, trackColorMap: Object.fromEntries(tracks.map(track => [track.name, {}])),
    sessions: [
      ...tracks.map(track => session({ title: `Session for ${track.name}`, track_names: [track.name] })),
      session({ title: longTitle, track_names: [tracks[0].name], speaker_names: [longSpeaker] }),
      session({ title: "Shared panel", track_names: [tracks[1].name, tracks[2].name] }),
      session({ title: "No track welcome", track_names: [] }),
      session({ title: "Second day", start_time: "2026-06-20T09:00:00Z", track_names: [tracks[0].name] }),
    ],
  });
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const drawn = [];
  const originalText = doc.text.bind(doc);
  doc.text = (value, x, y, ...args) => {
    drawn.push({ value, x, y, size: doc.getFontSize(), page: doc.getNumberOfPages() });
    return originalText(value, x, y, ...args);
  };
  renderSchedulePdf(doc, model);
  const contents = drawn.map(item => item.value).join(" ");
  for (const word of [...longTitle.split(" "), ...longSpeaker.split(" ")]) assert.ok(contents.includes(word), word);
  assert.equal(drawn.filter(item => item.value === "Shared panel").length, 2);
  assert.ok(contents.includes("No track welcome"));
  assert.ok(contents.includes("Saturday, 20 June 2026"));
  assert.ok(contents.includes("continued"));
  assert.ok(doc.getNumberOfPages() > 6);
  for (const item of drawn) {
    assert.ok(item.y >= 32 && item.y <= doc.internal.pageSize.getHeight() - 19, JSON.stringify(item));
    assert.ok(item.x >= 32);
    assert.ok(item.size >= 9);
  }
  const bytes = doc.output("arraybuffer");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), doc.getNumberOfPages());
  assert.ok(pdf.getPage(0).getWidth() > pdf.getPage(0).getHeight());
});

test("very long unbroken titles and track names are wrapped inside each column", () => {
  const name = "Research".repeat(100);
  const model = buildSchedulePdfModel({
    ...inputs, sessions: [session({ title: "LongTitle".repeat(300), track_names: [name, "Practice"] })],
    trackColorMap: { [name]: {}, Practice: {} }, eventTracks: [{ name }],
  });
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const originalText = doc.text.bind(doc);
  doc.text = (value, x, y, ...args) => {
    const colWidth = (doc.internal.pageSize.getWidth() - 64 - 14) / 2;
    // All 10pt text belongs to a column; jsPDF must split even no-space words.
    if (doc.getFontSize() === 10) assert.ok(doc.getTextWidth(value) <= colWidth + 0.1);
    return originalText(value, x, y, ...args);
  };
  renderSchedulePdf(doc, model);
  assert.ok(doc.getNumberOfPages() > 1);
});

test("SVG and raster logos use safe image decoding and bounded PNG rasterization; failures reject", async () => {
  let loaded;
  let imageType;
  const canvas = { getContext: () => ({ drawImage() {} }), toDataURL: type => { imageType = type; return "data:image/png;base64,fixture"; } };
  class ImageClass {
    naturalWidth = 2400;
    naturalHeight = 800;
    set src(value) { loaded = { value, crossOrigin: this.crossOrigin }; queueMicrotask(() => this.onload()); }
  }
  const documentObject = { baseURI: "https://tenant.example.test/", createElement: type => { assert.equal(type, "canvas"); return canvas; } };
  for (const url of ["/tenant-logo.svg", "/tenant-logo.png", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E"]) {
    const result = await rasterizeScheduleLogo(url, { ImageClass, documentObject });
    assert.equal(result.width, 1200);
    assert.equal(result.height, 400);
    assert.equal(loaded.crossOrigin, "anonymous");
    assert.equal(imageType, "image/png");
  }
  class BrokenImage { set src(_value) { queueMicrotask(() => this.onerror()); } }
  await assert.rejects(rasterizeScheduleLogo("/bad.svg", { ImageClass: BrokenImage, documentObject }), /logo could not be included/);
  await assert.rejects(rasterizeScheduleLogo("javascript:alert(1)", { ImageClass, documentObject }), /logo could not be included/);
  const tainted = { ...documentObject, createElement: () => ({ ...canvas, toDataURL: () => { throw new Error("SecurityError"); } }) };
  await assert.rejects(rasterizeScheduleLogo("/tainted.svg", { ImageClass, documentObject: tainted }), /cross-origin/);
  assert.equal(await rasterizeScheduleLogo(null), null);
});

test("download creates an actual PDF and requests a safe .pdf filename, not a print dialog", async () => {
  const originalSave = jsPDF.API.save;
  let saved;
  jsPDF.API.save = function (filename, options) {
    saved = { filename, options, bytes: this.output("arraybuffer") };
    return Promise.resolve();
  };
  try {
    await downloadSchedulePdf(inputs, null);
    assert.equal(saved.filename, "Community-learning-forum-programme.pdf");
    assert.equal(saved.options.returnPromise, true);
    const pdf = await PDFDocument.load(saved.bytes);
    assert.ok(pdf.getPageCount() >= 1);
  } finally {
    jsPDF.API.save = originalSave;
  }
});
