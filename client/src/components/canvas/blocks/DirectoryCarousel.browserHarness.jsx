// Isolated browser-test mounting helper. Not imported by the application or
// registered as a route; it cannot change the application's authentication.
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LayoutContext from '@/contexts/LayoutContext';
import { DYNAMIC_BLOCK_DEFINITIONS } from './dynamicBlocks';

export function mountDirectoryCarouselTest(host, initialBlock) {
  const root = createRoot(host);
  const queryClient = new QueryClient();
  let changeContent;
  function Fixture() {
    const [block, setBlock] = useState(initialBlock);
    changeContent = (patch) => setBlock((current) => ({ ...current, content: { ...current.content, ...patch } }));
    const Renderer = DYNAMIC_BLOCK_DEFINITIONS['directory-carousel'].Renderer;
    return createElement(QueryClientProvider, { client: queryClient },
      createElement(LayoutContext.Provider, { value: { authResolved: true, sessionValidated: false, memberInfo: null, memberRole: null } },
        createElement('div', { style: { width: 1000, height: 420 } }, createElement(Renderer, { block, breakpoint: 'desktop' }))));
  }
  root.render(createElement(Fixture));
  return {
    changeContent: (patch) => changeContent(patch),
    unmount: () => { root.unmount(); queryClient.clear(); },
  };
}
