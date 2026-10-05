import { lazy, Suspense } from 'react';

const CanvasPageRenderer = lazy(() => import('./CanvasPageRenderer'));

// Suspend only the renderer, never the established public shell or the page
// component that resolves access/chrome policy. No visible public placeholder.
export default function LazyCanvasPageRenderer(props) {
  return (
    <Suspense fallback={null}>
      <CanvasPageRenderer {...props} />
    </Suspense>
  );
}
