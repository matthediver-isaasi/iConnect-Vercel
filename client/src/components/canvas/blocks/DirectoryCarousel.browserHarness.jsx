// Isolated browser-test mounting helper. Not imported by the application or
// registered as a route; it cannot change the application's authentication.
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LayoutContext from '@/contexts/LayoutContext';
import { DYNAMIC_BLOCK_DEFINITIONS } from './dynamicBlocks';
import { useTypographyStyles } from '@/components/iedit/TypographyStyleSelector';

export function mountDirectoryCarouselTest(host, initialBlock, { typography = false } = {}) {
  const root = createRoot(host);
  const queryClient = new QueryClient();
  let changeContent;
  let changeViewer;
  function TypographyProbe() {
    const { styles, isLoading } = useTypographyStyles();
    return createElement('span', { 'data-testid': 'typography-probe' }, isLoading ? 'Loading typography' : `${styles.length} public styles`);
  }
  function Fixture() {
    const [block, setBlock] = useState(initialBlock);
    const [viewer, setViewer] = useState({ authResolved: true, sessionValidated: false, memberInfo: null, memberRole: null });
    changeViewer = setViewer;
    changeContent = (patch) => setBlock((current) => ({ ...current, content: { ...current.content, ...patch } }));
    const Renderer = DYNAMIC_BLOCK_DEFINITIONS['directory-carousel'].Renderer;
    return createElement(QueryClientProvider, { client: queryClient },
      createElement(LayoutContext.Provider, { value: viewer },
        createElement('div', { style: { width: 1000, height: 420 } },
          typography ? createElement(TypographyProbe) : null,
          createElement(Renderer, { block, breakpoint: 'desktop' }))));
  }
  root.render(createElement(Fixture));
  return {
    changeContent: (patch) => changeContent(patch),
    changeViewer: (viewer) => changeViewer(viewer),
    unmount: () => { root.unmount(); queryClient.clear(); },
  };
}
