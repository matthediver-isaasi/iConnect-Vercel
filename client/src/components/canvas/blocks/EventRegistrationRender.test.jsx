import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.test/page',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const resizeObservers = new Set();
globalThis.ResizeObserver = class ResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.elements = new Set();
    resizeObservers.add(this);
  }
  observe(element) {
    this.elements.add(element);
  }
  disconnect() {
    this.elements.clear();
    resizeObservers.delete(this);
  }
  static flush() {
    for (const observer of resizeObservers) {
      observer.callback([...observer.elements].map((target) => ({ target })));
    }
  }
};
window.ResizeObserver = globalThis.ResizeObserver;

const React = (await import('react')).default;
globalThis.React = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { getBlockDefinition } = await import('./registry.jsx');
const {
  AccordionReflowProvider,
  useAccordionReflow,
} = await import('../AccordionReflowContext.jsx');

const registration = {
  id: 'registration',
  type: 'event-registration',
  style: { paddingTop: 12, paddingBottom: 20 },
  content: { eventType: 'simple', eventId: '', eventSlug: '' },
  geom: { x: 0, y: 0, w: 600, h: 100 },
};
const after = {
  id: 'after',
  type: 'text',
  content: {},
  geom: { x: 0, y: 120, w: 600, h: 40 },
};

function OffsetProbe() {
  const reflow = useAccordionReflow();
  return <output data-testid="offset">{reflow.getOffset('after', 120)}</output>;
}

function SimpleExperience(props) {
  return <output data-testid="simple-experience">{JSON.stringify(props)}</output>;
}

function ComplexExperience(props) {
  return <output data-testid="complex-experience">{JSON.stringify(props)}</output>;
}

function Harness({ block }) {
  const Renderer = getBlockDefinition('event-registration').Renderer;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccordionReflowProvider
          blocks={[block, after]}
          resolveGeom={(candidate) => candidate.geom}
          breakpoint="desktop"
        >
          <Renderer
            block={block}
            simpleExperience={SimpleExperience}
            complexExperience={ComplexExperience}
          />
          <OffsetProbe />
        </AccordionReflowProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

test('keeps its measured node through selection and includes public padding in V1 reflow', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(<Harness block={registration} />);
    });
    const measuredNode = container.querySelector('[data-testid="event-registration-experience"]');
    assert.ok(measuredNode);
    assert.match(measuredNode.textContent, /Pick an event in the inspector/);

    measuredNode.getBoundingClientRect = () => ({
      width: 600,
      height: 300,
      top: 0,
      right: 600,
      bottom: 300,
      left: 0,
    });
    await act(async () => {
      ResizeObserver.flush();
    });
    assert.equal(
      Number(container.querySelector('[data-testid="offset"]').textContent),
      232,
      '300px content + 32px padding displaces a block below the authored 100px box',
    );

    await act(async () => {
      root.render(<Harness block={{
        ...registration,
        content: { eventType: 'simple', eventId: 'event-1', eventSlug: 'event-one' },
      }} />);
    });
    assert.strictEqual(
      container.querySelector('[data-testid="event-registration-experience"]'),
      measuredNode,
      'selection must not replace the node observed for dynamic height',
    );
    assert.match(
      container.querySelector('[data-testid="simple-experience"]').textContent,
      /"eventId":"event-1".*"embedded":true/,
    );

    await act(async () => {
      root.render(<Harness block={{
        ...registration,
        content: { eventType: 'complex', eventId: 'complex-1', eventSlug: 'complex-one' },
      }} />);
    });
    assert.strictEqual(
      container.querySelector('[data-testid="event-registration-experience"]'),
      measuredNode,
      'switching event kind must retain the measured wrapper',
    );
    assert.match(
      container.querySelector('[data-testid="complex-experience"]').textContent,
      /"eventId":"complex-1".*"embedded":true/,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});