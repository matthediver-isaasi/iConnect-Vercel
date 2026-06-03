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
  if (size === '100%') return null;
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

const buttonToMjml = (block) => {
  const href = escapeHtml(block.href || '#');
  const bgColor = block.styles.backgroundColor || '#007bff';
  const color = block.styles.color || '#ffffff';
  const fontSize = block.styles.fontSize || '16px';
  const fontWeight = block.styles.fontWeight || 'bold';
  const borderRadius = block.styles.borderRadius || '4px';
  const innerPad = getInnerPaddingAttr(block.styles);
  const fontFamily = block.styles.fontFamily ? `font-family:${block.styles.fontFamily};` : '';
  const content = escapeHtml(block.content);

  return `<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;line-height:100%;"><tr><td bgcolor="${bgColor}" role="presentation" style="border:none;border-radius:${borderRadius};cursor:auto;mso-padding-alt:${innerPad};background:${bgColor};"><a href="${href}" target="_blank" style="display:inline-block;background:${bgColor};color:${color};${fontFamily}font-size:${fontSize};font-weight:${fontWeight};line-height:120%;margin:0;text-decoration:none;text-transform:none;padding:${innerPad};mso-padding-alt:0;border-radius:${borderRadius};">${content}</a></td></tr></table>`;
};


const SOCIAL_SVG_PATHS = {
  facebook: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h5.047V9.43c0-4.985 2.97-7.74 7.513-7.74 2.177 0 4.454.389 4.454.389v4.89h-2.509c-2.473 0-3.245 1.534-3.245 3.109v3.73h5.51l-.881 3.47h-4.63v8.385C19.612 23.027 24 18.062 24 12.073z',
  twitter: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
  instagram: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z',
  linkedin: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z',
  youtube: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  tiktok: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  pinterest: 'M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12.017 24c6.624 0 11.99-5.367 11.99-11.988C24.007 5.367 18.641 0 12.017 0z',
  github: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  website: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
  email: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z',
};

const SOCIAL_LABELS = {
  facebook: 'Facebook',
  twitter: 'X',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  github: 'GitHub',
  website: 'Website',
  email: 'Email',
};

const buildSvgDataUri = (svgPath, fillColor, size) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fillColor}"><path d="${svgPath}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const buildSocialIconHtml = (block) => {
  const enabledPlatforms = (block.platforms || []).filter(p => p.enabled);
  if (enabledPlatforms.length === 0) return '';

  const iconSize = parseInt(block.styles.iconSize || '30', 10);
  const gap = parseInt(block.styles.gap || '8', 10);
  const shape = block.styles.shape || 'circle';
  const iconStyle = block.styles.iconStyle || 'filled';
  const iconColor = block.styles.iconColor || '#333333';
  const displayMode = block.styles.displayMode || 'icon-only';
  const labelPosition = block.styles.labelPosition || 'right';
  const labelFontFamily = block.styles.labelFontFamily || 'Arial, sans-serif';
  const labelFontSize = parseInt(block.styles.labelFontSize || '12', 10);
  const align = block.styles.textAlign || 'center';

  let borderRadius = '0px';
  if (shape === 'circle') borderRadius = `${Math.round(iconSize / 2)}px`;
  else if (shape === 'rounded') borderRadius = '4px';

  const svgPad = Math.round(iconSize * 0.22);
  const innerSvgSize = iconSize - svgPad * 2;

  const getSvgFill = () => {
    if (shape === 'none') return iconColor;
    if (iconStyle === 'filled') return '#ffffff';
    if (iconStyle === 'outline') return iconColor;
    return '#ffffff';
  };

  const getIconBgStyle = () => {
    if (shape === 'none') return '';
    if (iconStyle === 'filled') {
      return `background-color:${iconColor};border-radius:${borderRadius};`;
    }
    if (iconStyle === 'outline') {
      return `border:2px solid ${iconColor};border-radius:${borderRadius};`;
    }
    return `background-color:${iconColor};border-radius:${borderRadius};`;
  };

  const svgFill = getSvgFill();
  const isVertical = labelPosition === 'top' || labelPosition === 'bottom';
  const isLabelBefore = labelPosition === 'left' || labelPosition === 'top';

  const alignMap = { left: 'left', center: 'center', right: 'right' };
  const textAlign = alignMap[align] || 'center';

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://iconn.app';

  const platformCells = enabledPlatforms.map((p, idx) => {
    const iconKey = SOCIAL_SVG_PATHS[p.key] ? p.key : 'website';
    const iconSrc = `${baseUrl}/api/public/social-icon?key=${iconKey}&color=${encodeURIComponent(svgFill)}&size=${innerSvgSize}`;
    const href = p.url || '#';
    const label = SOCIAL_LABELS[p.key] || p.key;
    const spacing = idx > 0 ? `padding-left:${gap}px;` : '';

    const iconImg = `<a href="${escapeHtml(href)}" target="_blank" style="text-decoration:none;display:inline-block;"><span style="display:inline-block;width:${iconSize}px;height:${iconSize}px;${getIconBgStyle()}text-align:center;line-height:${iconSize}px;vertical-align:middle;"><img src="${iconSrc}" width="${innerSvgSize}" height="${innerSvgSize}" alt="${escapeHtml(label)}" style="display:inline-block;vertical-align:middle;border:0;outline:none;" /></span></a>`;

    const labelStyle = `font-size:${labelFontSize}px;color:${iconColor};font-family:${escapeHtml(labelFontFamily)};line-height:1.2;white-space:nowrap;`;
    const labelHtml = displayMode === 'icon-label'
      ? `<span style="${labelStyle}">${escapeHtml(label)}</span>`
      : '';
    const labelTdStyle = displayMode === 'icon-label' ? `color:${iconColor};font-family:${escapeHtml(labelFontFamily)};font-size:${labelFontSize}px;` : '';

    if (displayMode === 'icon-only') {
      return `<td style="${spacing}vertical-align:middle;">${iconImg}</td>`;
    }

    if (isVertical) {
      const topPart = isLabelBefore ? labelHtml : iconImg;
      const bottomPart = isLabelBefore ? iconImg : labelHtml;
      return `<td style="${spacing}vertical-align:middle;text-align:center;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td style="text-align:center;${isLabelBefore ? labelTdStyle : ''}">${topPart}</td></tr><tr><td style="text-align:center;padding-top:2px;${!isLabelBefore ? labelTdStyle : ''}">${bottomPart}</td></tr></table>
      </td>`;
    }

    if (isLabelBefore) {
      return `<td style="${spacing}vertical-align:middle;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="vertical-align:middle;padding-right:4px;${labelTdStyle}">${labelHtml}</td><td style="vertical-align:middle;">${iconImg}</td></tr></table>
      </td>`;
    }

    return `<td style="${spacing}vertical-align:middle;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="vertical-align:middle;">${iconImg}</td><td style="vertical-align:middle;padding-left:4px;${labelTdStyle}">${labelHtml}</td></tr></table>
    </td>`;
  }).join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${textAlign}" style="margin:0${textAlign === 'center' ? ' auto' : textAlign === 'right' ? ' 0 0 auto' : ''};"><tr>${platformCells}</tr></table>`;
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
      const imgWidthAttr = imgWidth ? `width="${imgWidth}"` : '';
      return `<mj-image 
        src="${escapeHtml(block.src)}"
        alt="${escapeHtml(block.alt || 'Image')}"
        ${imgWidthAttr}
        align="${block.styles.textAlign || 'center'}"
        padding="${getPaddingAttr(block.styles)}"
        ${imgHref}
      />`;
    case BLOCK_TYPES.BUTTON:
      return `<mj-text
        align="${block.styles.textAlign || 'center'}"
        padding="${getPaddingAttr(block.styles)}"
      >${buttonToMjml(block)}</mj-text>`;
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
      const socialHtml = buildSocialIconHtml(block);
      if (!socialHtml) return '';
      return `<mj-text padding="${getPaddingAttr(block.styles)}">${socialHtml}</mj-text>`;
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
    case BLOCK_TYPES.EVENT_QR: {
      return eventQrToMjml(block);
    }
    case BLOCK_TYPES.DYNAMIC_TEXT:
      return dynamicTextToMjml(block);
    default:
      return '';
  }
};

const dynamicTextToMjml = (block) => {
  const dtFontFamily = block.styles.fontFamily ? `font-family="${block.styles.fontFamily}"` : '';
  const token = block.token ? `{{${block.token}}}` : '';
  return `<mj-text
        ${dtFontFamily}
        align="${block.styles.textAlign || 'left'}"
        font-size="${block.styles.fontSize || '14px'}"
        color="${block.styles.color || '#333333'}"
        line-height="${block.styles.lineHeight || '1.5'}"
        padding="${getPaddingAttr(block.styles)}"
      >${token}</mj-text>`;
};

const eventQrToMjml = (block) => {
  const qrSize = parseInt(String(block.styles.qrSize || '180').replace('px', ''), 10) || 180;
  const align = block.styles.textAlign || 'center';
  const captionColor = block.styles.captionColor || '#666666';
  const captionFontSize = block.styles.captionFontSize || '13px';
  const caption = block.caption !== undefined ? block.caption : 'Show this QR code at the door';
  const captionMjml = caption
    ? `<mj-text align="${align}" color="${captionColor}" font-size="${captionFontSize}" padding="8px 0 0 0">${escapeHtml(caption)}</mj-text>`
    : '';
  return `<mj-image
        src="{{event_qr_image_url}}"
        alt="Entrance QR code"
        width="${qrSize}px"
        align="${align}"
        padding="${getPaddingAttr(block.styles)}"
      />${captionMjml}`;
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
      const sectionImgWidthAttr = sectionImgWidth ? `width="${sectionImgWidth}"` : '';
      return `
        <mj-section padding="${imgSectionPad}">
          <mj-column>
            <mj-image 
              src="${escapeHtml(block.src)}"
              alt="${escapeHtml(block.alt || 'Image')}"
              ${sectionImgWidthAttr}
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
            <mj-text
              align="${block.styles.textAlign || 'center'}"
              padding="${getPaddingAttr(block.styles)}"
            >${buttonToMjml(block)}</mj-text>
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
      const socialHtmlTop = buildSocialIconHtml(block);
      if (!socialHtmlTop) return '';
      return `
        <mj-section padding="${socialSectionPad}">
          <mj-column>
            <mj-text padding="${getPaddingAttr(block.styles)}">${socialHtmlTop}</mj-text>
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

    case BLOCK_TYPES.EVENT_QR: {
      const qrSectionPad = getCombinedSectionPadding(block.styles);
      return `
        <mj-raw><!-- EVENT_QR_BLOCK:START --></mj-raw>
        <mj-section padding="${qrSectionPad}">
          <mj-column>
            ${eventQrToMjml(block)}
          </mj-column>
        </mj-section>
        <mj-raw><!-- EVENT_QR_BLOCK:END --></mj-raw>
      `;
    }

    case BLOCK_TYPES.DYNAMIC_TEXT: {
      const dtSectionPad = getCombinedSectionPadding(block.styles);
      return `
        <mj-section padding="${dtSectionPad}">
          <mj-column>
            ${dynamicTextToMjml(block)}
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
            return `<mj-text align="${b.styles.textAlign || 'center'}" padding="${getPaddingAttr(b.styles)}">${buttonToMjml(b)}</mj-text>`;
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
          if (b.type === BLOCK_TYPES.EVENT_QR) {
            return childBlockToMjml(b);
          }
          if (b.type === BLOCK_TYPES.DYNAMIC_TEXT) {
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
    if (block.type === BLOCK_TYPES.SOCIAL_ICONS && block.styles?.labelFontFamily) {
      const fontName = block.styles.labelFontFamily.split(',')[0].replace(/['"]/g, '').trim();
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

export const designToMjml = (design, { footerHtml } = {}) => {
  const { blocks = [], globalStyles = {} } = design;
  
  const usedFonts = collectUsedFonts(blocks);
  const fontImports = Array.from(usedFonts)
    .map(font => `<mj-font name="${font}" href="${GOOGLE_FONTS[font]}" />`)
    .join('\n        ');
  
  const mjmlBlocks = blocks.filter(b => !b.hidden).map(blockToMjml).join('\n');

  const shouldIncludeFooter = globalStyles.useDefaultFooter !== false && footerHtml;
  let footerSection = '';
  if (shouldIncludeFooter) {
    const sanitizedFooter = footerHtml.replace(/<tr[^>]*>\s*<td[^>]*linear-gradient[^>]*>[\s\S]*?<\/td>\s*<\/tr>/gi, '');
    footerSection = `<mj-section padding="0" css-class="tenant-email-footer"><mj-column><mj-text padding="0" font-size="12px" color="#666666" line-height="1.5">${sanitizedFooter}</mj-text></mj-column></mj-section>`;
  }
  
  let wrapperPadding = globalStyles.contentPadding || '0px';
  if (shouldIncludeFooter) {
    const parts = wrapperPadding.replace(/px/g, '').trim().split(/\s+/).map(v => parseInt(v, 10) || 0);
    let top, right, bottom, left;
    if (parts.length === 1) { top = parts[0]; right = parts[0]; bottom = parts[0]; left = parts[0]; }
    else if (parts.length === 2) { top = parts[0]; right = parts[1]; bottom = parts[0]; left = parts[1]; }
    else if (parts.length === 3) { top = parts[0]; right = parts[1]; bottom = parts[2]; left = parts[1]; }
    else { top = parts[0]; right = parts[1]; bottom = parts[2]; left = parts[3]; }
    wrapperPadding = `${top}px ${right}px 0px ${left}px`;
  }
  
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
          .tenant-email-footer img { max-width: 100% !important; height: auto !important; }
          .tenant-email-footer table { max-width: 100% !important; }
        </mj-style>
      </mj-head>
      <mj-body background-color="${globalStyles.backgroundColor || '#f4f4f4'}" width="${globalStyles.contentWidth || '600px'}">
        <mj-wrapper background-color="${globalStyles.contentBackgroundColor || '#ffffff'}" padding="${wrapperPadding}">
          ${mjmlBlocks || '<mj-section><mj-column><mj-text></mj-text></mj-column></mj-section>'}
          ${footerSection}
        </mj-wrapper>
      </mj-body>
    </mjml>
  `;
};

export const designToHtml = (design, { footerHtml } = {}) => {
  try {
    const mjmlString = designToMjml(design, { footerHtml });
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
