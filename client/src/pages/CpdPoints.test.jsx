import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const React = (await import("react")).default;
globalThis.React = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { CpdPointsPage } = await import("./CpdPoints.jsx");
const { SpeakerAwardsHistoryView } = await import("../components/SpeakerAwardsHistory.jsx");

test("speaker awards card is hidden for members without award history", () => {
  assert.equal(renderToStaticMarkup(<SpeakerAwardsHistoryView data={{ awards: [], pagination: { total: 0 } }} member />), "");
});

test("speaker history separates badge artwork from issued certificate actions", () => {
  const html = renderToStaticMarkup(<SpeakerAwardsHistoryView
    data={{ pagination: { total: 1 }, awards: [{
      id: "record-1", event_title: "Annual Forum", awarded_at: "2026-02-01T00:00:00Z",
      status: "granted", badge: { name: "Speaker", status: "awarded", image_url: "/badge-artwork" },
      certificate: { status: "issued", available: true },
    }] }}
    page={1} setPage={() => {}} onFile={() => {}} member
  />);
  assert.match(html, /Annual Forum/);
  assert.match(html, /Artwork is not a verifiable credential/);
  assert.match(html, /Preview/);
  assert.match(html, /Download/);
  assert.doesNotMatch(html, /CPD points history/);
});

test("revoked and failed records cannot be downloaded", () => {
  const html = renderToStaticMarkup(<SpeakerAwardsHistoryView
    data={{ pagination: { total: 1 }, awards: [{
      id: "record-2", event_title: "Forum", badge: { name: "Speaker", status: "revoked", image_url: "/badge" },
      certificate: { status: "failed", available: false },
    }] }}
    page={1} setPage={() => {}} onFile={() => {}}
  />);
  assert.match(html, /failed/);
  assert.doesNotMatch(html, /Download|View artwork/);
});

test("authenticated member portal page uses the session member identity", () => {
  function History({ memberId }) {
    return <p>History for {memberId}</p>;
  }
  function SpeakerAwards({ endpoint }) {
    return <p>Speaker awards from {endpoint}</p>;
  }
  const html = renderToStaticMarkup(
    <CpdPointsPage
      useAccess={() => ({
        authResolved: true,
        sessionValidated: true,
        isAccessReady: true,
        isFeatureExcluded: () => false,
        memberInfo: { id: "session-member" },
      })}
      HistoryComponent={History}
      SpeakerAwardsComponent={SpeakerAwards}
    />,
  );
  assert.match(html, /My CPD points/);
  assert.match(html, /History for session-member/);
  assert.match(html, /Speaker awards from \/api\/members\/me\/speaker-awards/);
});

test("portal page does not mount history before server session validation", () => {
  function History() {
    return <p>private history</p>;
  }
  const html = renderToStaticMarkup(
    <CpdPointsPage
      useAccess={() => ({
        authResolved: false,
        sessionValidated: false,
        isAccessReady: false,
        isFeatureExcluded: () => true,
        memberInfo: null,
      })}
      HistoryComponent={History}
      SpeakerAwardsComponent={History}
    />,
  );
  assert.doesNotMatch(html, /private history/);
  assert.match(html, /Loading member CPD points/);
});

test("portal page waits for the canonical access decision", () => {
  function History() {
    return <p>private history</p>;
  }
  const html = renderToStaticMarkup(
    <CpdPointsPage
      useAccess={() => ({
        authResolved: true,
        sessionValidated: true,
        isAccessReady: false,
        isFeatureExcluded: () => false,
        memberInfo: { id: "session-member" },
      })}
      HistoryComponent={History}
      SpeakerAwardsComponent={History}
    />,
  );
  assert.doesNotMatch(html, /private history/);
  assert.match(html, /Loading member CPD points/);
});

test("portal page denies cpd.member_cpd without mounting history", () => {
  const checked = [];
  function History() {
    return <p>private history</p>;
  }
  const html = renderToStaticMarkup(
    <CpdPointsPage
      useAccess={() => ({
        authResolved: true,
        sessionValidated: true,
        isAccessReady: true,
        isFeatureExcluded: (featureId) => {
          checked.push(featureId);
          return featureId === "cpd.member_cpd";
        },
        memberInfo: { id: "session-member" },
      })}
      HistoryComponent={History}
      SpeakerAwardsComponent={History}
    />,
  );
  assert.deepEqual(checked, ["cpd.member_cpd"]);
  assert.match(html, /Access denied/);
  assert.doesNotMatch(html, /private history/);
});