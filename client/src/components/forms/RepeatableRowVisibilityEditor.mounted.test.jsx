import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/FormBuilder",
});
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.scrollIntoView = () => {};

const React = (await import("react")).default;
globalThis.React = React;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: RepeatableRowVisibilityEditor } = await import("./RepeatableRowVisibilityEditor.jsx");
const { validateRepeatableRowVisibilityConfiguration } = await import("../../../../shared/formRepeatableRows.js");

const baseChildren = () => [
  {
    id: "status",
    type: "select",
    label: "Status",
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
    ],
  },
  {
    id: "details",
    type: "text",
    label: "Details",
  },
];

const fieldFor = children => ({
  id: "people",
  type: "repeatable_rows",
  children,
});

function EditorHarness({ initialChildren = baseChildren() }) {
  const [children, setChildren] = React.useState(initialChildren);
  const child = children.find(item => item.id === "details");
  const field = fieldFor(children);
  const updateChild = row_visibility => {
    setChildren(previous => previous.map(item => item.id === child.id
      ? { ...item, row_visibility }
      : item));
  };
  return React.createElement(
    "div",
    null,
    React.createElement(RepeatableRowVisibilityEditor, {
      field,
      child,
      onChange: updateChild,
    }),
    React.createElement("output", {
      "data-testid": "saved-json",
    }, JSON.stringify(field)),
    React.createElement("button", {
      type: "button",
      "data-testid": "remove-source",
      onClick: () => setChildren(previous => previous.filter(item => item.id !== "status")),
    }, "Remove source"),
    React.createElement("button", {
      type: "button",
      "data-testid": "remove-option",
      onClick: () => setChildren(previous => previous.map(item => item.id === "status"
        ? { ...item, options: [{ value: "open", label: "Open" }] }
        : item)),
    }, "Remove option"),
    React.createElement("button", {
      type: "button",
      "data-testid": "make-source-multiselect",
      onClick: () => setChildren(previous => previous.map(item => item.id === "status"
        ? { ...item, selection_mode: "multiple" }
        : item)),
    }, "Make source multi-select"),
    React.createElement("button", {
      type: "button",
      "data-testid": "make-source-text",
      onClick: () => setChildren(previous => previous.map(item => item.id === "status"
        ? { ...item, type: "text" }
        : item)),
    }, "Make source text"),
    React.createElement("button", {
      type: "button",
      "data-testid": "make-source-dynamic",
      onClick: () => setChildren(previous => previous.map(item => item.id === "status"
        ? { ...item, option_source: { kind: "records" } }
        : item)),
    }, "Make source dynamic"),
  );
}

async function choose(container, testId, optionText) {
  const trigger = container.querySelector(`[data-testid="${testId}"]`);
  assert.ok(trigger, `missing select trigger ${testId}`);
  await act(async () => trigger.click());
  const item = [...document.querySelectorAll('[role="option"]')]
    .find(candidate => candidate.textContent.trim() === optionText);
  assert.ok(item, `missing option ${optionText}`);
  await act(async () => item.click());
}

async function mount(initialChildren = baseChildren()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(EditorHarness, { initialChildren }));
  });
  return {
    container,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach(node => node.remove());
    },
  };
}

test("mounted editor changes mode/source/value and survives a saved JSON remount", async () => {
  const view = await mount();
  try {
    assert.equal(
      view.container.querySelector('[data-testid="select-repeatable-visibility-mode-details"]').textContent.trim(),
      "Always visible",
    );
    await choose(view.container, "select-repeatable-visibility-mode-details", "Show when…");
    await choose(view.container, "select-repeatable-visibility-source-details", "Status");
    await choose(view.container, "select-repeatable-visibility-value-details", "Closed");

    const saved = JSON.parse(view.container.querySelector('[data-testid="saved-json"]').textContent);
    assert.deepEqual(saved.children.find(item => item.id === "details").row_visibility, {
      mode: "show_when",
      source_field_id: "status",
      value: "closed",
    });
    assert.deepEqual(validateRepeatableRowVisibilityConfiguration(saved), []);

    await act(async () => {
      view.root.render(React.createElement(EditorHarness, {
        key: "remounted-from-save",
        initialChildren: saved.children,
      }));
    });
    assert.equal(
      view.container.querySelector('[data-testid="select-repeatable-visibility-mode-details"]').textContent.trim(),
      "Show when…",
    );
    assert.equal(
      view.container.querySelector('[data-testid="select-repeatable-visibility-source-details"]').textContent.trim(),
      "Status",
    );
    assert.equal(
      view.container.querySelector('[data-testid="select-repeatable-visibility-value-details"]').textContent.trim(),
      "Closed",
    );
  } finally {
    await view.cleanup();
  }
});

test("mounted editor reports removed sources and options instead of silently accepting them", async () => {
  const view = await mount([{
    ...baseChildren()[0],
  }, {
    ...baseChildren()[1],
    row_visibility: {
      mode: "show_when",
      source_field_id: "status",
      value: "closed",
    },
  }]);
  try {
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    await act(async () => view.container.querySelector('[data-testid="remove-source"]').click());
    assert.match(view.container.querySelector('[role="alert"]').textContent, /static single-select child/);

    await act(async () => {
      view.root.render(React.createElement(EditorHarness, {
        key: "option-removed",
        initialChildren: [{
          ...baseChildren()[0],
          options: [{ value: "open", label: "Open" }],
        }, {
          ...baseChildren()[1],
          row_visibility: {
            mode: "show_when",
            source_field_id: "status",
            value: "closed",
          },
        }],
      }));
    });
    assert.match(view.container.querySelector('[role="alert"]').textContent, /one of the source options/);
  } finally {
    await view.cleanup();
  }
});

test("mounted editor reports source type and multi-select changes as invalid", async () => {
  const view = await mount([{
    ...baseChildren()[0],
  }, {
    ...baseChildren()[1],
    row_visibility: {
      mode: "show_when",
      source_field_id: "status",
      value: "closed",
    },
  }]);
  try {
    await act(async () => view.container.querySelector('[data-testid="make-source-multiselect"]').click());
    assert.match(view.container.querySelector('[role="alert"]').textContent, /static single-select child/);
    await act(async () => view.container.querySelector('[data-testid="make-source-text"]').click());
    assert.match(view.container.querySelector('[role="alert"]').textContent, /static single-select child/);
    await act(async () => view.container.querySelector('[data-testid="make-source-dynamic"]').click());
    assert.match(view.container.querySelector('[role="alert"]').textContent, /static single-select child/);
  } finally {
    await view.cleanup();
  }
});
