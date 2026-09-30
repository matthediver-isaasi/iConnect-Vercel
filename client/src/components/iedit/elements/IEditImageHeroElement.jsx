import React from "react";

export default function IEditImageHeroElement({ content = {}, settings = {} }) {
  const {
    backgroundImageUrl = '',
    foregroundImageUrl = '',
    height = 'medium',
    contentAlignment = 'center',
    overlayOpacity = 0,
    anchor
  } = content;

  const { fullWidth = false } = settings;

  // Height classes mapping - only used when NOT in full-width mode
  const heightClasses = {
    small: 'h-[300px]',
    medium: 'h-[500px]',
    large: 'h-[700px]',
    'full-screen': 'h-screen'
  };

  // For full-width mode: container sizes to background image, foreground overlays
  // For contained mode: use fixed height with object-cover
  const containerClass = fullWidth 
    ? 'w-full relative'  // Container will size to background image
    : `relative w-full ${heightClasses[height] || heightClasses.medium}`;

  return (
    <div id={anchor || undefined} className="w-full relative overflow-hidden">
      <div className={containerClass}>
        {/* Background Image Layer */}
        {backgroundImageUrl && (
          <div className={fullWidth ? 'relative w-full' : 'absolute inset-0 w-full h-full'}>
            <img
              src={backgroundImageUrl}
              alt="Hero background"
              className={`w-full ${fullWidth ? 'h-auto' : 'h-full'} ${fullWidth ? 'object-contain' : 'object-cover'}`}
            />
            
            {/* Optional overlay for better foreground visibility */}
            {overlayOpacity > 0 && (
              <div 
                className="absolute inset-0 bg-black"
                style={{ opacity: overlayOpacity / 100 }}
              />
            )}
          </div>
        )}

        {/* Foreground Image Layer (with transparency/knockout) */}
        {foregroundImageUrl && (
          <div className="absolute inset-0 w-full h-full flex items-center justify-center">
            <img
              src={foregroundImageUrl}
              alt="Hero foreground frame"
              className={`w-full h-full ${fullWidth ? 'object-contain' : 'object-cover'}`}
              style={{ mixBlendMode: 'normal' }}
            />
          </div>
        )}
      </div>

      {/* Placeholder when no images are set */}
      {!backgroundImageUrl && !foregroundImageUrl && (
        <div className={`${heightClasses[height] || heightClasses.medium} bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center`}>
          <div className="text-center text-slate-500">
            <div className="mb-3">
              <svg className="w-16 h-16 mx-auto text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="font-semibold text-lg mb-1">Image Hero Element</p>
            <p className="text-sm">Add background and foreground images to create your hero</p>
            {fullWidth && (
              <p className="text-xs mt-2 text-blue-600">Full-width mode: Images will maintain their aspect ratio</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function IEditImageHeroElementEditor({ element, onChange }) {
  const content = element.content || {};

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  return (
    <div className="space-y-4">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., hero-banner"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-imagehero-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      <p className="text-sm text-slate-500">
        Configure background and foreground images in the Content section above.
      </p>
    </div>
  );
}