import mjml2html from 'mjml-browser';
import { BLOCK_TYPES } from './types';
import { sanitizeHtml } from './sanitize';
import { getIndividualValues, spacingToMjml } from './SpacingControl';

const escapeHtml = (text) => {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const getImageMjmlWidth = (block) => {
  const size = block.styles?.imageSize || '100%';
  if (size === 'custom' && block.styles?.imageSizeCustom) {
    return `${block.styles.imageSizeCustom}px`;
  }
  if (size === '100%') return block.styles?.maxWidth || '600px';
  return size;
};

const getPaddingAttr = (styles) => {
  const vals = getIndividualValues(styles, 'padding');
  return spacingToMjml(vals);
};

const getInnerPaddingAttr = (styles) => {
  const vals = getIndividualValues(styles, 'innerPadding');
  return spacingToMjml(vals);
};

const getCombinedSectionPadding = (styles) => {
  const margin = getIndividualValues(styles, 'margin');
  return `${margin.top || 0}px ${margin.right || 0}px ${margin.bottom || 0}px ${margin.left || 0}px`;
};


const childBlockToMjml = (block) => {
  switch (block.type) {
    case BLOCK_TYPES.TEXT:
      const childFontFamily = block.styles.fontFamily ? `font-family="${block.styles.fontFamily}"` : '';
      return `<mj-text 
        ${childFontFamily}
        color="${block.styles.color || '#333333'}"
        line-height="${block.styles.lineHeight || '1.5'}"
        padding="${getPaddingAttr(block.styles)}"
      >${sanitizeHtml(block.content || '')}</mj-text>`;
    case BLOCK_TYPES.IMAGE:
      if (!block.src) return '';
      const imgHref = block.href ? `href="${escapeHtml(block.href)}"` : '';
      const imgWidth = getImageMjmlWidth(block);
      return `<mj-image 
        src="${escapeHtml(block.src)}"
        alt="${escapeHtml(block.alt || 'Image')}"
        width="${imgWidth}"
        align="${block.styles.textAlign || 'center'}"
        padding="${getPaddingAttr(block.styles)}"
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
        inner-padding="${getInnerPaddingAttr(block.styles)}"
        padding="${getPaddingAttr(block.styles)}"
        align="${block.styles.textAlign || 'center'}"
      >${escapeHtml(block.content)}</mj-button>`;
    case BLOCK_TYPES.DIVIDER:
      return `<mj-divider 
        border-color="${block.styles.borderColor || '#e0e0e0'}"
        border-width="${block.styles.borderWidth || '1px'}"
        border-style="${block.styles.borderStyle || 'solid'}"
        padding="${getPaddingAttr(block.styles)}"
      />`;
    case BLOCK_TYPES.SPACER:
      return `<mj-spacer height="${block.styles.height || '20px'}" />`;
    default:
      return '';
  }
};

const blockToMjml = (block) => {
  switch (block.type) {
    case BLOCK_TYPES.SECTION: {
      const paddingVal = getPaddingAttr(block.styles);
      const childrenMjml = (block.children || []).filter(c => !c.hidden).map(childBlockToMjml).filter(Boolean).join('\n');
      return `
        <mj-section 
          background-color="${block.styles.backgroundColor || '#ffffff'}"
          padding="${paddingVal}"
        >
          <mj-column>
            ${childrenMjml || '<mj-text></mj-text>'}
          </mj-column>
        </mj-section>
      `;
    }
    case BLOCK_TYPES.TEXT: {
      const textFontFamily = block.styles.fontFamily ? `font-family="${block.styles.fontFamily}"` : '';
      const textSectionPad = getCombinedSectionPadding(block.styles);
      return `
        <mj-section padding="${textSectionPad}">
          <mj-column>
            <mj-text 
              ${textFontFamily}
              color="${block.styles.color || '#333333'}"
              line-height="${block.styles.lineHeight || '1.5'}"
              padding="${getPaddingAttr(block.styles)}"
            >${sanitizeHtml(block.content || '')}</mj-text>
          </mj-column>
        </mj-section>
      `;
    }

    case BLOCK_TYPES.IMAGE: {
      const imgSectionPad = getCombinedSectionPadding(block.styles);
      if (!block.src) {
        return `
          <mj-section padding="${imgSectionPad}">
            <mj-column>
              <mj-text align="center" color="#999999" padding="${getPaddingAttr(block.styles)}">[ Image placeholder ]</mj-text>
            </mj-column>
          </mj-section>
        `;
      }
      const imgHref = block.href ? `href="${escapeHtml(block.href)}"` : '';
      const sectionImgWidth = getImageMjmlWidth(block);
      return `
        <mj-section padding="${imgSectionPad}">
          <mj-column>
            <mj-image 
              src="${escapeHtml(block.src)}"
              alt="${escapeHtml(block.alt || 'Image')}"
              width="${sectionImgWidth}"
              align="${block.styles.textAlign || 'center'}"
              padding="${getPaddingAttr(block.styles)}"
              ${imgHref}
            />
          </mj-column>
        </mj-section>
      `;
    }

    case BLOCK_TYPES.BUTTON: {
      const btnSectionPad = getCombinedSectionPadding(block.styles);
      return `
        <mj-section padding="${btnSectionPad}">
          <mj-column>
            <mj-button 
              href="${escapeHtml(block.href || '#')}"
              background-color="${block.styles.backgroundColor || '#007bff'}"
              color="${block.styles.color || '#ffffff'}"
              font-size="${block.styles.fontSize || '16px'}"
              font-weight="${block.styles.fontWeight || 'bold'}"
              border-radius="${block.styles.borderRadius || '4px'}"
              inner-padding="${getInnerPaddingAttr(block.styles)}"
              padding="${getPaddingAttr(block.styles)}"
              align="${block.styles.textAlign || 'center'}"
            >${escapeHtml(block.content)}</mj-button>
          </mj-column>
        </mj-section>
      `;
    }

    case BLOCK_TYPES.DIVIDER: {
      const divSectionPad = getCombinedSectionPadding(block.styles);
      return `
        <mj-section padding="${divSectionPad}">
          <mj-column>
            <mj-divider 
              border-color="${block.styles.borderColor || '#e0e0e0'}"
              border-width="${block.styles.borderWidth || '1px'}"
              border-style="${block.styles.borderStyle || 'solid'}"
              padding="${getPaddingAttr(block.styles)}"
            />
          </mj-column>
        </mj-section>
      `;
    }

    case BLOCK_TYPES.SPACER:
      return `
        <mj-section padding="0">
          <mj-column>
            <mj-spacer height="${block.styles.height || '20px'}" />
          </mj-column>
        </mj-section>
      `;

    case BLOCK_TYPES.COLUMNS: {
      const colGapPx = parseInt(String(block.styles.columnGap || '10px').replace('px', ''), 10) || 0;
      const halfGap = Math.round(colGapPx / 2);
      const columnsContent = block.columns.map((col, colIdx) => {
        const colBlocks = col.blocks.map(b => {
          if (b.type === BLOCK_TYPES.TEXT) {
            const colFontFamily = b.styles.fontFamily ? `font-family="${b.styles.fontFamily}"` : '';
            return `<mj-text 
              ${colFontFamily}
              color="${b.styles.color || '#333333'}"
              line-height="${b.styles.lineHeight || '1.5'}"
              padding="${getPaddingAttr(b.styles)}"
            >${sanitizeHtml(b.content || '')}</mj-text>`;
          }
          if (b.type === BLOCK_TYPES.IMAGE && b.src) {
            return `<mj-image src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt || '')}" padding="${getPaddingAttr(b.styles)}" />`;
          }
          if (b.type === BLOCK_TYPES.BUTTON) {
            return `<mj-button href="${escapeHtml(b.href || '#')}" background-color="${b.styles.backgroundColor || '#007bff'}" inner-padding="${getInnerPaddingAttr(b.styles)}" padding="${getPaddingAttr(b.styles)}">${escapeHtml(b.content)}</mj-button>`;
          }
          if (b.type === BLOCK_TYPES.DIVIDER) {
            return `<mj-divider border-color="${b.styles.borderColor || '#e0e0e0'}" border-width="${b.styles.borderWidth || '1px'}" border-style="${b.styles.borderStyle || 'solid'}" padding="${getPaddingAttr(b.styles)}" />`;
          }
          return '';
        }).join('');
        const paddingLeft = colIdx === 0 ? '0px' : `${halfGap}px`;
        const paddingRight = colIdx === block.columns.length - 1 ? '0px' : `${halfGap}px`;
        return `<mj-column width="${col.width || '50%'}" padding-left="${paddingLeft}" padding-right="${paddingRight}">${colBlocks || '<mj-text></mj-text>'}</mj-column>`;
      }).join('');
      const columnsBg = block.styles.backgroundColor ? ` background-color="${block.styles.backgroundColor}"` : '';
      return `<mj-section padding="${getPaddingAttr(block.styles)}"${columnsBg}>${columnsContent}</mj-section>`;
    }

    default:
      return '';
  }
};

const GOOGLE_FONTS = {
  'Roboto': 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap',
  'Open Sans': 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap',
  'Lato': 'https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap',
  'Montserrat': 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap',
  'Poppins': 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&display=swap',
  'Raleway': 'https://fonts.googleapis.com/css2?family=Raleway:wght@400;700&display=swap',
  'Oswald': 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;700&display=swap',
  'Playfair Display': 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
  'Merriweather': 'https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap',
  'Source Sans Pro': 'https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;700&display=swap',
};

const collectUsedFonts = (blocks) => {
  const usedFonts = new Set();
  
  const checkBlock = (block) => {
    if (block.type === BLOCK_TYPES.TEXT && block.styles?.fontFamily) {
      const fontName = block.styles.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
      if (GOOGLE_FONTS[fontName]) {
        usedFonts.add(fontName);
      }
    }
    if (block.children) {
      block.children.forEach(checkBlock);
    }
    if (block.columns) {
      block.columns.forEach(col => col.blocks?.forEach(checkBlock));
    }
  };
  
  blocks.forEach(checkBlock);
  return usedFonts;
};

export const designToMjml = (design) => {
  const { blocks = [], globalStyles = {} } = design;
  
  const usedFonts = collectUsedFonts(blocks);
  const fontImports = Array.from(usedFonts)
    .map(font => `<mj-font name="${font}" href="${GOOGLE_FONTS[font]}" />`)
    .join('\n        ');
  
  const mjmlBlocks = blocks.filter(b => !b.hidden).map(blockToMjml).join('\n');
  
  return `
    <mjml>
      <mj-head>
        ${fontImports}
        <mj-attributes>
          <mj-all font-family="${globalStyles.fontFamily || 'Arial, sans-serif'}" />
          <mj-body background-color="${globalStyles.backgroundColor || '#f4f4f4'}" />
        </mj-attributes>
      </mj-head>
      <mj-body background-color="${globalStyles.backgroundColor || '#f4f4f4'}">
        <mj-wrapper background-color="${globalStyles.contentBackgroundColor || '#ffffff'}" padding="${globalStyles.contentPadding || '0px'}">
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
