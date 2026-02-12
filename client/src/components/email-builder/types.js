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
};

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
    default:
      return { id, type, content: '', styles: {} };
  }
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
  },
};
