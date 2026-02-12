export const BLOCK_TYPES = {
  SECTION: 'section',
  TEXT: 'text',
  IMAGE: 'image',
  BUTTON: 'button',
  DIVIDER: 'divider',
  SPACER: 'spacer',
  COLUMNS: 'columns',
};

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
