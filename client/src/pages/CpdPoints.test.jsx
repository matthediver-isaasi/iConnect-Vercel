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

test("authenticated member portal page uses the session member identity", () => {
  function History({ memberId }) {
    return <p>History for {memberId}</p>;
  }
  const html = renderToStaticMarkup(
    <CpdPointsPage
      useAccess={() => ({
        authResolved: true,
        sessionValidated: true,
        memberInfo: { id: "session-member" },
      })}
      HistoryComponent={History}
    />,
  );
  assert.match(html, /My CPD points/);
  assert.match(html, /History for session-member/);
});

test("portal page does not mount history before server session validation", () => {
  function History() {
    return <p>private history</p>;
  }
  const html = renderToStaticMarkup(
    <CpdPointsPage
      useAccess={() => ({ authResolved: false, sessionValidated: false, memberInfo: null })}
      HistoryComponent={History}
    />,
  );
  assert.doesNotMatch(html, /private history/);
  assert.match(html, /Loading member CPD points/);
});