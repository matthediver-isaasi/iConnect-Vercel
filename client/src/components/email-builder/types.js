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
          paddingTop: '20px',
          paddingBottom: '20px',
          paddingLeft: '20px',
          paddingRight: '20px',
          ...props.styles,
        },
      };
    case BLOCK_TYPES.TEXT:
      return {
        id,
        type,
        content: props.content || 'Click to edit text...',
        styles: {
          fontSize: '14px',
          fontWeight: 'normal',
          color: '#333333',
          textAlign: 'left',
          padding: '10px 20px',
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
          padding: '10px 20px',
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
          padding: '12px 24px',
          borderRadius: '4px',
          textAlign: 'center',
          containerPadding: '10px 20px',
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
          padding: '10px 20px',
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
          padding: '10px 0',
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
