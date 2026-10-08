// Only Canvas previews opt in. Public/standalone iEdit keep viewport queries.
export function featuredJobPreviewCss(css, editorPreview) {
  return editorPreview
    ? css.replaceAll('@media (min-width: 768px)', '@container featured-job-preview (min-width: 768px)')
    : css;
}

const utilities = {
  md: {
    hidden: ['display', 'none'], block: ['display', 'block'],
    'flex-row': ['flex-direction', 'row'], 'gap-8': ['gap', '2rem'],
  },
  lg: {
    'mb-6': ['margin-bottom', '1.5rem'], 'mb-8': ['margin-bottom', '2rem'],
    'mt-8': ['margin-top', '2rem'], 'gap-3': ['gap', '.75rem'],
    'px-6': ['padding-inline', '1.5rem'], 'py-3': ['padding-block', '.75rem'],
    'py-4': ['padding-block', '1rem'], 'w-5': ['width', '1.25rem'],
    'h-5': ['height', '1.25rem'], 'min-w-[120px]': ['min-width', '120px'],
  },
};

// Replace only this element's responsive utilities, not Tailwind's public rules.
export function featuredJobPreviewClasses(classes, editorPreview) {
  return editorPreview ? classes.replace(/\b(md|lg):(\S+)/g, 'fj-preview-$1:$2') : classes;
}

export const FEATURED_JOB_PREVIEW_UTILITIES = Object.entries(utilities).map(([bp, rules]) => (
  `@container featured-job-preview (min-width: ${bp === 'md' ? 768 : 1024}px) {
    ${Object.entries(rules).map(([name, [property, value]]) => {
      const escaped = `fj-preview-${bp}:${name}`.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      return `[data-featured-job-editor] .${escaped} { ${property}: ${value}; }`;
    }).join('\n')}
  }`
)).join('\n');
