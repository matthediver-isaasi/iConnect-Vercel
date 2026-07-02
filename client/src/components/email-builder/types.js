export const BLOCK_TYPES = {
  SECTION: 'section',
  TEXT: 'text',
  IMAGE: 'image',
  BUTTON: 'button',
  DIVIDER: 'divider',
  SPACER: 'spacer',
  COLUMNS: 'columns',
  SOCIAL_ICONS: 'social_icons',
  UNSUBSCRIBE: 'unsubscribe',
  EVENT_QR: 'event_qr',
  DYNAMIC_TEXT: 'dynamic_text',
  DYNAMIC_IMAGE: 'dynamic_image',
  DYNAMIC_BUTTON: 'dynamic_button',
  PLACEHOLDER: 'placeholder',
};

// Block types whose content is filled in per-send (Dynamic data palette).
// NOTE: PLACEHOLDER is intentionally NOT here — it carries a fixed standard
// placeholder token that is auto-resolved at send time, so it must never be
// collected as a fillable per-send slot.
export const DYNAMIC_BLOCK_TYPES = [
  BLOCK_TYPES.DYNAMIC_TEXT,
  BLOCK_TYPES.DYNAMIC_IMAGE,
  BLOCK_TYPES.DYNAMIC_BUTTON,
];

export const isDynamicBlockType = (type) => DYNAMIC_BLOCK_TYPES.includes(type);

export const SOCIAL_PLATFORMS = [
  { key: 'facebook', label: 'Facebook', defaultUrl: 'https://facebook.com/' },
  { key: 'twitter', label: 'X (Twitter)', defaultUrl: 'https://x.com/' },
  { key: 'instagram', label: 'Instagram', defaultUrl: 'https://instagram.com/' },
  { key: 'linkedin', label: 'LinkedIn', defaultUrl: 'https://linkedin.com/' },
  { key: 'youtube', label: 'YouTube', defaultUrl: 'https://youtube.com/' },
  { key: 'tiktok', label: 'TikTok', defaultUrl: 'https://tiktok.com/' },
  { key: 'pinterest', label: 'Pinterest', defaultUrl: 'https://pinterest.com/' },
  { key: 'github', label: 'GitHub', defaultUrl: 'https://github.com/' },
  { key: 'website', label: 'Website', defaultUrl: 'https://' },
  { key: 'email', label: 'Email', defaultUrl: 'mailto:' },
];

export const createBlock = (type, props = {}) => {
  const id = `block-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  switch (type) {
    case BLOCK_TYPES.SECTION:
      return {
        id,
        type,
        children: props.children || [],
        styles: {
          backgroundColor: '#ffffff',
          paddingTop: '20',
          paddingBottom: '20',
          paddingLeft: '20',
          paddingRight: '20',
          marginTop: '0',
          marginBottom: '0',
          marginLeft: '0',
          marginRight: '0',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.TEXT:
      return {
        id,
        type,
        content: props.content || '<p>Click to edit text...</p>',
        styles: {
          fontFamily: '',
          color: '#333333',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          lineHeight: '1.5',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.IMAGE:
      return {
        id,
        type,
        src: props.src || '',
        alt: props.alt || 'Image',
        href: props.href || '',
        styles: {
          width: '100%',
          maxWidth: '600px',
          imageSize: '100%',
          imageSizeCustom: '',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          textAlign: 'center',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.BUTTON:
      return {
        id,
        type,
        content: props.content || 'Click Here',
        href: props.href || '#',
        styles: {
          backgroundColor: '#007bff',
          color: '#ffffff',
          fontSize: '16px',
          fontWeight: 'bold',
          innerPaddingTop: '12',
          innerPaddingRight: '24',
          innerPaddingBottom: '12',
          innerPaddingLeft: '24',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          borderRadius: '4px',
          textAlign: 'center',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.DIVIDER:
      return {
        id,
        type,
        styles: {
          borderColor: '#e0e0e0',
          borderWidth: '1px',
          borderStyle: 'solid',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.SPACER:
      return {
        id,
        type,
        styles: {
          height: '20px',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.COLUMNS:
      return {
        id,
        type,
        columns: props.columns || [
          { id: `col-${Date.now()}-1`, blocks: [], width: '50%' },
          { id: `col-${Date.now()}-2`, blocks: [], width: '50%' },
        ],
        styles: {
          paddingTop: '10',
          paddingRight: '0',
          paddingBottom: '10',
          paddingLeft: '0',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.SOCIAL_ICONS:
      return {
        id,
        type,
        platforms: props.platforms || [
          { key: 'facebook', enabled: true, url: 'https://facebook.com/' },
          { key: 'twitter', enabled: true, url: 'https://x.com/' },
          { key: 'instagram', enabled: true, url: 'https://instagram.com/' },
          { key: 'linkedin', enabled: true, url: 'https://linkedin.com/' },
          { key: 'youtube', enabled: false, url: 'https://youtube.com/' },
          { key: 'tiktok', enabled: false, url: 'https://tiktok.com/' },
          { key: 'pinterest', enabled: false, url: 'https://pinterest.com/' },
          { key: 'github', enabled: false, url: 'https://github.com/' },
          { key: 'website', enabled: false, url: 'https://' },
          { key: 'email', enabled: false, url: 'mailto:' },
        ],
        styles: {
          displayMode: 'icon-only',
          labelPosition: 'right',
          labelFontFamily: '',
          labelFontSize: '12',
          iconStyle: 'filled',
          shape: 'circle',
          iconColor: '#333333',
          iconSize: '30',
          borderColor: '#333333',
          textAlign: 'center',
          gap: '8',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.UNSUBSCRIBE:
      return {
        id,
        type,
        linkText: props.linkText || 'Unsubscribe from these emails',
        styles: {
          fontFamily: '',
          fontSize: '12px',
          color: '#999999',
          textAlign: 'center',
          paddingTop: '20',
          paddingRight: '20',
          paddingBottom: '20',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.EVENT_QR:
      return {
        id,
        type,
        caption: props.caption !== undefined ? props.caption : 'Show this QR code at the door',
        styles: {
          qrSize: '180',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          textAlign: 'center',
          captionColor: '#666666',
          captionFontSize: '13px',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.DYNAMIC_TEXT:
      return {
        id,
        type,
        token: props.token || '',
        label: props.label || '',
        styles: {
          fontFamily: '',
          color: '#333333',
          fontSize: '14px',
          lineHeight: '1.5',
          textAlign: 'left',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.DYNAMIC_IMAGE:
      return {
        id,
        type,
        token: props.token || '',
        label: props.label || '',
        src: props.src || '',
        alt: props.alt || 'Image',
        href: props.href || '',
        styles: {
          width: '100%',
          maxWidth: '600px',
          imageSize: '100%',
          imageSizeCustom: '',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          textAlign: 'center',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.DYNAMIC_BUTTON:
      return {
        id,
        type,
        token: props.token || '',
        linkToken: props.linkToken || '',
        label: props.label || '',
        content: props.content || 'Click Here',
        href: props.href || '#',
        styles: {
          backgroundColor: '#007bff',
          color: '#ffffff',
          fontSize: '16px',
          fontWeight: 'bold',
          innerPaddingTop: '12',
          innerPaddingRight: '24',
          innerPaddingBottom: '12',
          innerPaddingLeft: '24',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          borderRadius: '4px',
          textAlign: 'center',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.PLACEHOLDER:
      return {
        id,
        type,
        // The fixed standard placeholder token this block emits literally into
        // the HTML (e.g. '[[member.first_name]]' or '{{event_name}}'). It is
        // auto-resolved by the existing send-time substitution — NOT a per-send
        // fillable slot, so it never carries a `dynamic_N` token.
        placeholder: props.placeholder || '',
        label: props.label || '',
        styles: {
          fontFamily: '',
          color: '#333333',
          fontSize: '14px',
          lineHeight: '1.5',
          textAlign: 'left',
          paddingTop: '10',
          paddingRight: '20',
          paddingBottom: '10',
          paddingLeft: '20',
          marginTop: '0',
          marginRight: '0',
          marginBottom: '0',
          marginLeft: '0',
          ...props.styles,
        },
      };
    default:
      return { id, type, content: '', styles: {} };
  }
};

// Recursively walk a design's block tree (top-level blocks, section children,
// and column blocks) and collect every Dynamic block's slot definition.
// Returns a de-duplicated array keyed by primary token (first definition wins).
// Each slot is shaped:
//   { token, label, type, defaultValue, linkToken?, defaultLink? }
// - token is the primary substitution key ({{token}}): text content, image src,
//   or button label depending on `type` ('text' | 'image' | 'button').
// - linkToken (button only) is the secondary key ({{linkToken}}) for the href.
// `type` defaults to 'text' so legacy text-only designs keep working unchanged.
export const extractDynamicSlots = (design) => {
  const blocks = Array.isArray(design) ? design : (design?.blocks || []);
  const seen = new Map();

  const visit = (block) => {
    if (!block || typeof block !== 'object') return;
    if (block.token && isDynamicBlockType(block.type) && !seen.has(block.token)) {
      if (block.type === BLOCK_TYPES.DYNAMIC_IMAGE) {
        seen.set(block.token, {
          token: block.token,
          label: block.label || block.token,
          type: 'image',
          defaultValue: block.src || '',
        });
      } else if (block.type === BLOCK_TYPES.DYNAMIC_BUTTON) {
        seen.set(block.token, {
          token: block.token,
          label: block.label || block.token,
          type: 'button',
          defaultValue: block.content || '',
          linkToken: block.linkToken || '',
          defaultLink: block.href || '',
        });
      } else {
        seen.set(block.token, {
          token: block.token,
          label: block.label || block.token,
          type: 'text',
          defaultValue: '',
        });
      }
    }
    if (Array.isArray(block.children)) block.children.forEach(visit);
    if (Array.isArray(block.columns)) {
      block.columns.forEach((col) => {
        if (Array.isArray(col?.blocks)) col.blocks.forEach(visit);
      });
    }
  };

  blocks.forEach(visit);
  return Array.from(seen.values());
};

// Compute the next numeric suffix for a `dynamic_N` token by scanning every
// existing Dynamic Text block in the tree. Guarantees uniqueness on insertion.
export const nextDynamicTokenIndex = (blocks) => {
  let max = 0;
  const slots = extractDynamicSlots(blocks);
  slots.forEach(({ token }) => {
    const m = /^dynamic_(\d+)$/.exec(token || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  return max + 1;
};

export const defaultEmailDesign = {
  type: 'custom-email-builder',
  version: 1,
  subject: '',
  blocks: [],
  globalStyles: {
    backgroundColor: '#f4f4f4',
    contentBackgroundColor: '#ffffff',
    contentWidth: '600px',
    fontFamily: 'Arial, sans-serif',
    useDefaultFooter: true,
  },
};
