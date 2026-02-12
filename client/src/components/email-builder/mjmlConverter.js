import mjml2html from 'mjml-browser';
import { BLOCK_TYPES } from './types';
import { sanitizeHtml, stripTrailingEmptyParagraphs } from './sanitize';
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


const SOCIAL_NAME_MAP = {
  facebook: 'facebook-noshare',
  twitter: 'x-noshare',
  instagram: 'instagram',
  linkedin: 'linkedin-noshare',
  youtube: 'youtube',
  tiktok: 'web',
  pinterest: 'pinterest-noshare',
  github: 'github',
  website: 'web',
};

const SOCIAL_BRAND_COLORS = {
  facebook: '#1877F2',
  twitter: '#000000',
  instagram: '#E4405F',
  linkedin: '#0A66C2',
  youtube: '#FF0000',
  tiktok: '#000000',
  pinterest: '#BD081C',
  github: '#181717',
  website: '#4CAF50',
};

const getSocialBorderRadius = (shape, iconSize) => {
  const size = parseInt(iconSize || '30', 10);
  if (shape === 'circle') return `${Math.round(size / 2)}px`;
  if (shape === 'rounded') return '4px';
  if (shape === 'none') return '0px';
  return '0px';
};

const getSocialElementAttrs = (platform, block) => {
  const iconStyle = block.styles.iconStyle || 'filled';
  const iconColor = block.styles.iconColor || '#333333';
  const brandColor = SOCIAL_BRAND_COLORS[platform.key] || '#333333';

  let bgColor;
  if (iconStyle === 'filled') {
    bgColor = iconColor;
  } else if (iconStyle === 'outline') {
    bgColor = 'transparent';
  } else {
    bgColor = iconColor;
  }

  return `background-color="${bgColor}"`;
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
      >${sanitizeHtml(stripTrailingEmptyParagraphs(block.content || ''))}</mj-text>`;
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
    case BLOCK_TYPES.SOCIAL_ICONS: {
      const enabledChild = (block.platforms || []).filter(p => p.enabled);
      const displayMode = block.styles.displayMode || 'icon-only';
      const labelFontFamily = block.styles.labelFontFamily || '';
      const labelFontSize = block.styles.labelFontSize || '12';
      const socialElements = enabledChild
        .map(p => {
          const name = SOCIAL_NAME_MAP[p.key] || 'web';
          const attrs = getSocialElementAttrs(p, block);
          const labelAttr = displayMode === 'icon-only' ? ' text-padding="0px"' : '';
          const labelText = displayMode === 'icon-label' ? (p.key === 'twitter' ? 'X' : (p.key.charAt(0).toUpperCase() + p.key.slice(1))) : '';
          return `<mj-social-element name="${name}" href="${escapeHtml(p.url || '#')}" ${attrs}${labelAttr}>${labelText}</mj-social-element>`;
        })
        .join('\n            ');
      const fontFamilyAttr = labelFontFamily ? ` font-family="${labelFontFamily}"` : '';
      return `<mj-social
            mode="horizontal"
            icon-size="${block.styles.iconSize || '30'}px"
            icon-padding="${block.styles.gap ? Math.round(parseInt(block.styles.gap) / 2) : 4}px"
            padding="${getPaddingAttr(block.styles)}"
            align="${block.styles.textAlign || 'center'}"
            font-size="${labelFontSize}px"${fontFamilyAttr}
            border-radius="${getSocialBorderRadius(block.styles.shape, block.styles.iconSize)}"
          >${socialElements}</mj-social>`;
    }
    case BLOCK_TYPES.UNSUBSCRIBE: {
      const uFontFamily = block.styles.fontFamily ? ` font-family="${block.styles.fontFamily}"` : '';
      const uColor = block.styles.color || '#999999';
      const uFontSize = block.styles.fontSize || '12px';
      const uLinkText = escapeHtml(block.linkText || 'Unsubscribe from these emails');
      return `<mj-text
        align="${block.styles.textAlign || 'center'}"${uFontFamily}
        font-size="${uFontSize}"
        color="${uColor}"
        padding="${getPaddingAttr(block.styles)}"
      ><a href="{{unsubscribe_url}}" style="color: ${uColor}; text-decoration: underline;">${uLinkText}</a></mj-text>`;
    }
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
            >${sanitizeHtml(stripTrailingEmptyParagraphs(block.content || ''))}</mj-text>
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

    case BLOCK_TYPES.SOCIAL_ICONS: {
      const socialSectionPad = getCombinedSectionPadding(block.styles);
      const enabledPlatforms = (block.platforms || []).filter(p => p.enabled);
      const displayMode = block.styles.displayMode || 'icon-only';
      const topLabelFontFamily = block.styles.labelFontFamily || '';
      const topLabelFontSize = block.styles.labelFontSize || '12';
      const socialEls = enabledPlatforms.map(p => {
        const name = SOCIAL_NAME_MAP[p.key] || 'web';
        const attrs = getSocialElementAttrs(p, block);
        const labelAttr = displayMode === 'icon-only' ? ' text-padding="0px"' : '';
        const contentText = displayMode === 'icon-label' ? (p.key === 'twitter' ? 'X' : (p.key.charAt(0).toUpperCase() + p.key.slice(1))) : '';
        return `<mj-social-element name="${name}" href="${escapeHtml(p.url || '#')}" ${attrs}${labelAttr}>${contentText}</mj-social-element>`;
      }).join('\n              ');
      const topFontFamilyAttr = topLabelFontFamily ? `\n              font-family="${topLabelFontFamily}"` : '';
      return `
        <mj-section padding="${socialSectionPad}">
          <mj-column>
            <mj-social
              mode="horizontal"
              icon-size="${block.styles.iconSize || '30'}px"
              icon-padding="${block.styles.gap ? Math.round(parseInt(block.styles.gap) / 2) : 4}px"
              padding="${getPaddingAttr(block.styles)}"
              align="${block.styles.textAlign || 'center'}"
              font-size="${topLabelFontSize}px"${topFontFamilyAttr}
              border-radius="${getSocialBorderRadius(block.styles.shape, block.styles.iconSize)}"
            >
              ${socialEls}
            </mj-social>
          </mj-column>
        </mj-section>
      `;
    }

    case BLOCK_TYPES.UNSUBSCRIBE: {
      const uSectionPad = getCombinedSectionPadding(block.styles);
      const uTopFontFamily = block.styles.fontFamily ? ` font-family="${block.styles.fontFamily}"` : '';
      const uTopColor = block.styles.color || '#999999';
      const uTopFontSize = block.styles.fontSize || '12px';
      const uTopLinkText = escapeHtml(block.linkText || 'Unsubscribe from these emails');
      return `
        <mj-section padding="${uSectionPad}">
          <mj-column>
            <mj-text
              align="${block.styles.textAlign || 'center'}"${uTopFontFamily}
              font-size="${uTopFontSize}"
              color="${uTopColor}"
              padding="${getPaddingAttr(block.styles)}"
            ><a href="{{unsubscribe_url}}" style="color: ${uTopColor}; text-decoration: underline;">${uTopLinkText}</a></mj-text>
          </mj-column>
        </mj-section>
      `;
    }

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
            >${sanitizeHtml(stripTrailingEmptyParagraphs(b.content || ''))}</mj-text>`;
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
          if (b.type === BLOCK_TYPES.SOCIAL_ICONS) {
            return childBlockToMjml(b);
          }
          if (b.type === BLOCK_TYPES.UNSUBSCRIBE) {
            return childBlockToMjml(b);
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
    if ((block.type === BLOCK_TYPES.TEXT || block.type === BLOCK_TYPES.UNSUBSCRIBE) && block.styles?.fontFamily) {
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
        <mj-style>
          h1, h2, h3, h4, h5, h6 { margin: 0; }
          p { margin: 0 0 1em 0; }
          p:last-child { margin-bottom: 0; }
        </mj-style>
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
