import mjml2html from 'mjml-browser';
import { BLOCK_TYPES } from './types';

const escapeHtml = (text) => {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const childBlockToMjml = (block) => {
  switch (block.type) {
    case BLOCK_TYPES.TEXT:
      return `<mj-text 
        font-size="${block.styles.fontSize || '14px'}"
        font-weight="${block.styles.fontWeight || 'normal'}"
        color="${block.styles.color || '#333333'}"
        align="${block.styles.textAlign || 'left'}"
        line-height="${block.styles.lineHeight || '1.5'}"
        padding="${block.styles.padding || '10px 0'}"
      >${block.content}</mj-text>`;
    case BLOCK_TYPES.IMAGE:
      if (!block.src) return '';
      const imgHref = block.href ? `href="${escapeHtml(block.href)}"` : '';
      return `<mj-image 
        src="${escapeHtml(block.src)}"
        alt="${escapeHtml(block.alt || 'Image')}"
        width="${block.styles.maxWidth || '100%'}"
        align="${block.styles.textAlign || 'center'}"
        padding="${block.styles.padding || '10px 0'}"
        ${imgHref}
      />`;
    case BLOCK_TYPES.BUTTON:
      return `<mj-button 
        href="${escapeHtml(block.href || '#')}"
        background-color="${block.styles.backgroundColor || '#007bff'}"
        color="${block.styles.color || '#ffffff'}"
        font-size="${block.styles.fontSize || '16px'}"
        font-weight="${block.styles.fontWeight || 'bold'}"
        border-radius="${block.styles.borderRadius || '4px'}"
        padding="${block.styles.padding || '12px 24px'}"
        align="${block.styles.textAlign || 'center'}"
      >${escapeHtml(block.content)}</mj-button>`;
    case BLOCK_TYPES.DIVIDER:
      return `<mj-divider 
        border-color="${block.styles.borderColor || '#e0e0e0'}"
        border-width="${block.styles.borderWidth || '1px'}"
        border-style="${block.styles.borderStyle || 'solid'}"
        padding="${block.styles.padding || '10px 0'}"
      />`;
    case BLOCK_TYPES.SPACER:
      return `<mj-spacer height="${block.styles.height || '20px'}" />`;
    default:
      return '';
  }
};

const blockToMjml = (block) => {
  switch (block.type) {
    case BLOCK_TYPES.SECTION:
      const sectionPadding = `${block.styles.paddingTop || '20px'} ${block.styles.paddingRight || '20px'} ${block.styles.paddingBottom || '20px'} ${block.styles.paddingLeft || '20px'}`;
      const childrenMjml = (block.children || []).map(childBlockToMjml).filter(Boolean).join('\n');
      return `
        <mj-section 
          background-color="${block.styles.backgroundColor || '#ffffff'}"
          padding="${sectionPadding}"
        >
          <mj-column>
            ${childrenMjml || '<mj-text></mj-text>'}
          </mj-column>
        </mj-section>
      `;
    case BLOCK_TYPES.TEXT:
      return `
        <mj-section padding="${block.styles.padding || '10px 20px'}">
          <mj-column>
            <mj-text 
              font-size="${block.styles.fontSize || '14px'}"
              font-weight="${block.styles.fontWeight || 'normal'}"
              color="${block.styles.color || '#333333'}"
              align="${block.styles.textAlign || 'left'}"
              line-height="${block.styles.lineHeight || '1.5'}"
            >${block.content}</mj-text>
          </mj-column>
        </mj-section>
      `;

    case BLOCK_TYPES.IMAGE:
      if (!block.src) {
        return `
          <mj-section padding="${block.styles.padding || '10px 20px'}">
            <mj-column>
              <mj-text align="center" color="#999999">[ Image placeholder ]</mj-text>
            </mj-column>
          </mj-section>
        `;
      }
      const imgHref = block.href ? `href="${escapeHtml(block.href)}"` : '';
      return `
        <mj-section padding="${block.styles.padding || '10px 20px'}">
          <mj-column>
            <mj-image 
              src="${escapeHtml(block.src)}"
              alt="${escapeHtml(block.alt || 'Image')}"
              width="${block.styles.maxWidth || '600px'}"
              align="${block.styles.textAlign || 'center'}"
              ${imgHref}
            />
          </mj-column>
        </mj-section>
      `;

    case BLOCK_TYPES.BUTTON:
      return `
        <mj-section padding="${block.styles.containerPadding || '10px 20px'}">
          <mj-column>
            <mj-button 
              href="${escapeHtml(block.href || '#')}"
              background-color="${block.styles.backgroundColor || '#007bff'}"
              color="${block.styles.color || '#ffffff'}"
              font-size="${block.styles.fontSize || '16px'}"
              font-weight="${block.styles.fontWeight || 'bold'}"
              border-radius="${block.styles.borderRadius || '4px'}"
              padding="${block.styles.padding || '12px 24px'}"
              align="${block.styles.textAlign || 'center'}"
            >${escapeHtml(block.content)}</mj-button>
          </mj-column>
        </mj-section>
      `;

    case BLOCK_TYPES.DIVIDER:
      return `
        <mj-section padding="${block.styles.padding || '10px 20px'}">
          <mj-column>
            <mj-divider 
              border-color="${block.styles.borderColor || '#e0e0e0'}"
              border-width="${block.styles.borderWidth || '1px'}"
              border-style="${block.styles.borderStyle || 'solid'}"
            />
          </mj-column>
        </mj-section>
      `;

    case BLOCK_TYPES.SPACER:
      return `
        <mj-section padding="0">
          <mj-column>
            <mj-spacer height="${block.styles.height || '20px'}" />
          </mj-column>
        </mj-section>
      `;

    case BLOCK_TYPES.COLUMNS:
      const columnsContent = block.columns.map(col => {
        const colBlocks = col.blocks.map(b => {
          if (b.type === BLOCK_TYPES.TEXT) {
            return `<mj-text 
              font-size="${b.styles.fontSize || '14px'}"
              color="${b.styles.color || '#333333'}"
              align="${b.styles.textAlign || 'left'}"
            >${b.content}</mj-text>`;
          }
          if (b.type === BLOCK_TYPES.IMAGE && b.src) {
            return `<mj-image src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt || '')}" />`;
          }
          if (b.type === BLOCK_TYPES.BUTTON) {
            return `<mj-button href="${escapeHtml(b.href || '#')}" background-color="${b.styles.backgroundColor || '#007bff'}">${escapeHtml(b.content)}</mj-button>`;
          }
          return '';
        }).join('');
        return `<mj-column width="${col.width || '50%'}">${colBlocks || '<mj-text></mj-text>'}</mj-column>`;
      }).join('');
      return `<mj-section padding="${block.styles.padding || '10px 0'}">${columnsContent}</mj-section>`;

    default:
      return '';
  }
};

export const designToMjml = (design) => {
  const { blocks = [], globalStyles = {} } = design;
  
  const mjmlBlocks = blocks.map(blockToMjml).join('\n');
  
  return `
    <mjml>
      <mj-head>
        <mj-attributes>
          <mj-all font-family="${globalStyles.fontFamily || 'Arial, sans-serif'}" />
          <mj-body background-color="${globalStyles.backgroundColor || '#f4f4f4'}" />
        </mj-attributes>
      </mj-head>
      <mj-body background-color="${globalStyles.backgroundColor || '#f4f4f4'}">
        <mj-wrapper background-color="${globalStyles.contentBackgroundColor || '#ffffff'}" padding="0">
          ${mjmlBlocks || '<mj-section><mj-column><mj-text></mj-text></mj-column></mj-section>'}
        </mj-wrapper>
      </mj-body>
    </mjml>
  `;
};

export const designToHtml = (design) => {
  try {
    const mjmlString = designToMjml(design);
    const { html, errors } = mjml2html(mjmlString, {
      validationLevel: 'soft',
    });
    
    if (errors && errors.length > 0) {
      console.warn('[EmailBuilder] MJML conversion warnings:', errors);
    }
    
    return html;
  } catch (error) {
    console.error('[EmailBuilder] Failed to convert design to HTML:', error);
    return null;
  }
};
