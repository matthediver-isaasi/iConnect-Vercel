import React, { lazy, Suspense } from 'react';
import { safeAddonImageUrl } from './addonPresentation.mjs';

const EventImageUpload = lazy(() => import('@/components/events/EventImageUpload'));
const SimpleRichTextEditor = lazy(() => import('@/components/SimpleRichTextEditor'));

function PresentationFallback() {
  return <div className="efb-muted" role="status">Loading add-on presentation controls…</div>;
}

export default function AddonPresentationFields({ presentation = {}, locked, updatePresentation }) {
  const patch = (key, value) => {
    if (locked) return;
    updatePresentation(key, value);
  };
  const image = safeAddonImageUrl(presentation.imageUrl);
  return <section className="efb-field" aria-label="Add-on presentation" data-testid="addon-presentation">
    <span>Add-on presentation</span>
    <p className="efb-muted">Shown in the optional add-on step while members remain on this event.</p>
    <label className="efb-field">
      <span>Heading</span>
      <input type="text" maxLength={200} value={presentation.heading || ''} disabled={locked}
        aria-label="Add-on heading" data-testid="addon-heading"
        onChange={event => patch('heading', event.target.value)} />
      <small className="efb-muted">{(presentation.heading || '').length}/200</small>
    </label>
    <Suspense fallback={<PresentationFallback />}>
      <EventImageUpload value={image} disabled={locked} allowRelativeUrl label="Header image (optional)"
        helpText="Displayed at the top of this add-on offer."
        onChange={value => patch('imageUrl', safeAddonImageUrl(value))} />
    </Suspense>
    <div className="efb-field">
      <span>Add-on details</span>
      <p className="efb-muted">Use concise details about what this extra includes.</p>
      <Suspense fallback={<PresentationFallback />}>
        <SimpleRichTextEditor id="addon-body" aria-label="Add-on details"
          content={presentation.bodyHtml || ''} disabled={locked}
          className="bg-background" onChange={value => {
            if (value.length <= 20000) patch('bodyHtml', value);
          }} />
      </Suspense>
      <small className="efb-muted">{(presentation.bodyHtml || '').length}/20,000</small>
    </div>
  </section>;
}
