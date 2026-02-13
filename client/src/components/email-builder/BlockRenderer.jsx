import { useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';
import { BLOCK_TYPES } from './types';
import { sanitizeHtml, stripTrailingEmptyParagraphs } from './sanitize';
import { getIndividualValues } from './SpacingControl';

function getSpacingStyle(styles, prefix, cssPrefix) {
  const vals = getIndividualValues(styles, prefix);
  const css = cssPrefix || prefix;
  return {
    [`${css}Top`]: `${vals.top}px`,
    [`${css}Right`]: `${vals.right}px`,
    [`${css}Bottom`]: `${vals.bottom}px`,
    [`${css}Left`]: `${vals.left}px`,
  };
}

function SectionBlockPreview({ block, isSelected, onSelectChild, selectedChildId, globalFontFamily }) {
  const children = block.children || [];
  const { isOver, setNodeRef } = useDroppable({
    id: `section-drop-${block.id}`,
    data: { sectionId: block.id, isSection: true },
  });

  const paddingStyle = getSpacingStyle(block.styles, 'padding');

  return (
    <div
      ref={setNodeRef}
      style={{
        backgroundColor: block.styles.backgroundColor,
        ...paddingStyle,
      }}
      className={`min-h-[60px] transition-colors ${isOver ? 'ring-2 ring-primary ring-inset' : ''}`}
    >
      {children.length === 0 && (
        <div className={`flex items-center justify-center py-6 border-2 border-dashed rounded text-muted-foreground text-sm ${
          isOver ? 'border-primary bg-primary/10' : 'border-muted-foreground/30'
        }`}>
          <Plus className="w-4 h-4 mr-2" />
          {isOver ? 'Drop here' : 'Drop content blocks here'}
        </div>
      )}
      {children.map((child) => {
        if (child.hidden) return null;
        return (
          <ChildBlockRenderer
            key={child.id}
            block={child}
            isSelected={child.id === selectedChildId}
            onSelect={onSelectChild}
            globalFontFamily={globalFontFamily}
          />
        );
      })}
    </div>
  );
}

function ChildBlockRenderer({ block, isSelected, onSelect, globalFontFamily }) {
  const PreviewComponent = contentBlockPreviewComponents[block.type];

  return (
    <div
      className={`relative cursor-pointer ${isSelected ? 'ring-1 ring-primary/40' : 'hover:ring-1 hover:ring-muted-foreground/15'}`}
      onClick={(e) => { e.stopPropagation(); onSelect(block.id); }}
      data-testid={`child-block-${block.id}`}
    >
      <div className={`border ${isSelected ? 'border-primary/30' : 'border-transparent'} rounded transition-colors`}>
        {PreviewComponent && <PreviewComponent block={block} isChild={true} globalFontFamily={globalFontFamily} />}
      </div>
    </div>
  );
}

function TextBlockPreview({ block, isChild, globalFontFamily }) {
  const isHtml = block.content && block.content.includes('<');
  const paddingStyle = getSpacingStyle(block.styles, 'padding');

  const textEl = (
    <div
      className="prose prose-sm max-w-none [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:m-0 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:m-0 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:m-0 [&_p]:mt-0 [&_p]:mb-[1em] [&_p:last-child]:mb-0 [&_ul]:pl-5 [&_ol]:pl-5 [&_a]:text-blue-600 [&_a]:underline [&_strong]:text-inherit [&_em]:text-inherit [&_h1]:text-inherit [&_h2]:text-inherit [&_h3]:text-inherit [&_p]:text-inherit"
      style={{
        fontFamily: block.styles.fontFamily || globalFontFamily || 'Arial, sans-serif',
        color: block.styles.color,
        lineHeight: block.styles.lineHeight || '1.5',
        ...paddingStyle,
      }}
      dangerouslySetInnerHTML={isHtml ? { __html: sanitizeHtml(stripTrailingEmptyParagraphs(block.content)) } : undefined}
    >
      {isHtml ? undefined : block.content}
    </div>
  );

  if (isChild) return textEl;

  const marginAsPadding = getSpacingStyle(block.styles, 'margin', 'padding');
  return <div style={marginAsPadding}>{textEl}</div>;
}

function ImageBlockPreview({ block, isChild }) {
  const getImageWidth = () => {
    const size = block.styles.imageSize || '100%';
    if (size === 'custom' && block.styles.imageSizeCustom) {
      return `${block.styles.imageSizeCustom}px`;
    }
    return size;
  };

  const paddingStyle = getSpacingStyle(block.styles, 'padding');

  if (!block.src) {
    const placeholderEl = (
      <div style={paddingStyle}>
        <div
          className="flex items-center justify-center bg-muted/50 text-muted-foreground border-2 border-dashed rounded"
          style={{ minHeight: '100px' }}
        >
          Click to add image URL
        </div>
      </div>
    );
    if (isChild) return placeholderEl;
    const placeholderMargin = getSpacingStyle(block.styles, 'margin', 'padding');
    return <div style={placeholderMargin}>{placeholderEl}</div>;
  }
  const imgWidth = getImageWidth();
  const align = block.styles.textAlign || 'center';

  const imgStyle = {
    display: 'block',
    width: imgWidth,
    maxWidth: '100%',
  };

  if (align === 'center') {
    imgStyle.marginLeft = 'auto';
    imgStyle.marginRight = 'auto';
  } else if (align === 'right') {
    imgStyle.marginLeft = 'auto';
    imgStyle.marginRight = '0';
  } else {
    imgStyle.marginLeft = '0';
    imgStyle.marginRight = 'auto';
  }

  const imgEl = (
    <div style={paddingStyle}>
      <img
        src={block.src}
        alt={block.alt}
        style={imgStyle}
      />
    </div>
  );

  if (isChild) return imgEl;

  const marginAsPadding = getSpacingStyle(block.styles, 'margin', 'padding');
  return <div style={marginAsPadding}>{imgEl}</div>;
}

function ButtonBlockPreview({ block, isChild, globalFontFamily }) {
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const innerPaddingStyle = getSpacingStyle(block.styles, 'innerPadding', 'padding');

  const btnEl = (
    <div style={{ ...paddingStyle, textAlign: block.styles.textAlign }}>
      <span
        style={{
          display: 'inline-block',
          backgroundColor: block.styles.backgroundColor,
          color: block.styles.color,
          fontFamily: block.styles.fontFamily || globalFontFamily || 'Arial, sans-serif',
          fontSize: block.styles.fontSize,
          fontWeight: block.styles.fontWeight,
          ...innerPaddingStyle,
          borderRadius: block.styles.borderRadius,
          cursor: 'pointer',
        }}
      >
        {block.content}
      </span>
    </div>
  );

  if (isChild) return btnEl;

  const marginAsPadding = getSpacingStyle(block.styles, 'margin', 'padding');
  return <div style={marginAsPadding}>{btnEl}</div>;
}

function DividerBlockPreview({ block, isChild }) {
  const paddingStyle = getSpacingStyle(block.styles, 'padding');

  const divEl = (
    <div style={paddingStyle}>
      <hr
        style={{
          borderColor: block.styles.borderColor,
          borderWidth: block.styles.borderWidth,
          borderStyle: block.styles.borderStyle,
        }}
      />
    </div>
  );

  if (isChild) return divEl;

  const marginAsPadding = getSpacingStyle(block.styles, 'margin', 'padding');
  return <div style={marginAsPadding}>{divEl}</div>;
}

function SpacerBlockPreview({ block }) {
  return <div style={{ height: block.styles.height }} />;
}

function ColumnDropZone({ columnId, blockId, colIndex, width, paddingLeft, paddingRight, children }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `column-drop-${blockId}-${columnId}`,
    data: { isColumn: true, columnId, blockId, colIndex },
  });

  return (
    <div style={{ width, paddingLeft, paddingRight, boxSizing: 'border-box' }}>
      <div
        ref={setNodeRef}
        className={`min-h-[60px] border-2 border-dashed rounded p-2 transition-colors h-full ${
          isOver ? 'border-primary bg-primary/10' : 'border-muted-foreground/30 bg-muted/20'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function ColumnsBlockPreview({ block, onSelectColumnChild, selectedColumnChildId, globalFontFamily }) {
  const colGapPx = parseInt(String(block.styles.columnGap || '10px').replace('px', ''), 10) || 0;
  const halfGap = Math.round(colGapPx / 2);
  const paddingStyle = getSpacingStyle(block.styles, 'padding');

  return (
    <div style={{ ...paddingStyle, backgroundColor: block.styles.backgroundColor }}>
      <div className="flex">
        {block.columns.map((col, idx) => (
          <ColumnDropZone
            key={col.id}
            columnId={col.id}
            blockId={block.id}
            colIndex={idx}
            width={col.width}
            paddingLeft={idx === 0 ? '0px' : `${halfGap}px`}
            paddingRight={idx === block.columns.length - 1 ? '0px' : `${halfGap}px`}
          >
            <span className="text-xs text-muted-foreground">Col {idx + 1} ({col.width})</span>
            {col.blocks.length === 0 && (
              <div className="text-xs text-muted-foreground/50 mt-2">
                Drop blocks here
              </div>
            )}
            {col.blocks.map((childBlock) => {
              if (childBlock.hidden) return null;
              const ChildPreview = contentBlockPreviewComponents[childBlock.type];
              if (!ChildPreview) return null;
              return (
                <div
                  key={childBlock.id}
                  className={`relative cursor-pointer mt-1 ${
                    childBlock.id === selectedColumnChildId
                      ? 'ring-1 ring-primary/40'
                      : 'hover:ring-1 hover:ring-muted-foreground/15'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onSelectColumnChild) onSelectColumnChild(childBlock.id, block.id, col.id);
                  }}
                  data-testid={`column-child-${childBlock.id}`}
                >
                  <ChildPreview block={childBlock} isChild={true} globalFontFamily={globalFontFamily} />
                </div>
              );
            })}
          </ColumnDropZone>
        ))}
      </div>
    </div>
  );
}

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

function SocialIconsBlockPreview({ block, isChild, globalFontFamily }) {
  const enabledPlatforms = (block.platforms || []).filter(p => p.enabled);
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const iconSize = parseInt(block.styles.iconSize || '30', 10);
  const gap = parseInt(block.styles.gap || '8', 10);
  const shape = block.styles.shape || 'circle';
  const iconStyle = block.styles.iconStyle || 'filled';
  const iconColor = block.styles.iconColor || '#333333';
  const displayMode = block.styles.displayMode || 'icon-only';
  const labelPosition = block.styles.labelPosition || 'right';
  const labelFontFamily = block.styles.labelFontFamily || globalFontFamily || 'Arial, sans-serif';
  const labelFontSize = parseInt(block.styles.labelFontSize || '12', 10);
  const align = block.styles.textAlign || 'center';

  const getShapeStyle = () => {
    const base = {
      width: `${iconSize}px`,
      height: `${iconSize}px`,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    };
    if (shape === 'none') {
      return base;
    }
    if (iconStyle === 'filled') {
      return {
        ...base,
        backgroundColor: iconColor,
        borderRadius: shape === 'circle' ? '50%' : shape === 'rounded' ? '4px' : '0',
      };
    }
    if (iconStyle === 'outline') {
      return {
        ...base,
        border: `2px solid ${iconColor}`,
        borderRadius: shape === 'circle' ? '50%' : shape === 'rounded' ? '4px' : '0',
      };
    }
    return {
      ...base,
      backgroundColor: iconColor,
      borderRadius: shape === 'circle' ? '50%' : shape === 'rounded' ? '4px' : '0',
    };
  };

  const getSvgColor = () => {
    if (shape === 'none') return iconColor;
    if (iconStyle === 'filled') return '#ffffff';
    if (iconStyle === 'outline') return iconColor;
    return '#ffffff';
  };

  const svgPad = Math.round(iconSize * 0.22);

  const isVerticalLabel = labelPosition === 'top' || labelPosition === 'bottom';
  const isLabelBefore = labelPosition === 'left' || labelPosition === 'top';

  const getItemStyle = () => {
    const base = { display: 'inline-flex', alignItems: 'center', gap: '4px' };
    if (isVerticalLabel && displayMode === 'icon-label') {
      return { ...base, flexDirection: 'column', textAlign: 'center' };
    }
    return base;
  };

  const labelEl = (p) => (
    <span style={{ fontSize: `${labelFontSize}px`, color: iconColor, fontFamily: labelFontFamily, lineHeight: 1.2 }}>
      {SOCIAL_LABELS[p.key] || p.key}
    </span>
  );

  const iconEl = (p) => (
    <div style={getShapeStyle()}>
      <svg
        viewBox="0 0 24 24"
        fill={getSvgColor()}
        style={{ width: `${iconSize - svgPad * 2}px`, height: `${iconSize - svgPad * 2}px` }}
      >
        <path d={SOCIAL_SVG_PATHS[p.key] || SOCIAL_SVG_PATHS.website} />
      </svg>
    </div>
  );

  const socialEl = (
    <div style={{ ...paddingStyle, textAlign: align }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: `${gap}px`, flexWrap: 'wrap', justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start' }}>
        {enabledPlatforms.length === 0 && (
          <span className="text-muted-foreground text-sm">No platforms selected</span>
        )}
        {enabledPlatforms.map(p => (
          <div key={p.key} style={getItemStyle()}>
            {displayMode === 'icon-label' && isLabelBefore && labelEl(p)}
            {iconEl(p)}
            {displayMode === 'icon-label' && !isLabelBefore && labelEl(p)}
          </div>
        ))}
      </div>
    </div>
  );

  if (isChild) return socialEl;

  const marginAsPadding = getSpacingStyle(block.styles, 'margin', 'padding');
  return <div style={marginAsPadding}>{socialEl}</div>;
}

function UnsubscribeBlockPreview({ block, isChild, globalFontFamily }) {
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const linkText = block.linkText || 'Unsubscribe from these emails';
  const fontFamily = block.styles.fontFamily || globalFontFamily || 'Arial, sans-serif';
  const fontSize = block.styles.fontSize || '12px';
  const color = block.styles.color || '#999999';
  const textAlign = block.styles.textAlign || 'center';

  const unsubEl = (
    <div style={{ ...paddingStyle, textAlign, fontFamily, fontSize, color }}>
      <a
        href="#"
        onClick={(e) => e.preventDefault()}
        style={{ color, textDecoration: 'underline', fontFamily, fontSize }}
        data-testid="unsub-preview-link"
      >
        {linkText}
      </a>
    </div>
  );

  if (isChild) return unsubEl;

  const marginAsPadding = getSpacingStyle(block.styles, 'margin', 'padding');
  return <div style={marginAsPadding}>{unsubEl}</div>;
}

const contentBlockPreviewComponents = {
  [BLOCK_TYPES.TEXT]: TextBlockPreview,
  [BLOCK_TYPES.IMAGE]: ImageBlockPreview,
  [BLOCK_TYPES.BUTTON]: ButtonBlockPreview,
  [BLOCK_TYPES.DIVIDER]: DividerBlockPreview,
  [BLOCK_TYPES.SPACER]: SpacerBlockPreview,
  [BLOCK_TYPES.SOCIAL_ICONS]: SocialIconsBlockPreview,
  [BLOCK_TYPES.UNSUBSCRIBE]: UnsubscribeBlockPreview,
};

const blockPreviewComponents = {
  [BLOCK_TYPES.SECTION]: SectionBlockPreview,
  [BLOCK_TYPES.TEXT]: TextBlockPreview,
  [BLOCK_TYPES.IMAGE]: ImageBlockPreview,
  [BLOCK_TYPES.BUTTON]: ButtonBlockPreview,
  [BLOCK_TYPES.DIVIDER]: DividerBlockPreview,
  [BLOCK_TYPES.SPACER]: SpacerBlockPreview,
  [BLOCK_TYPES.COLUMNS]: ColumnsBlockPreview,
  [BLOCK_TYPES.SOCIAL_ICONS]: SocialIconsBlockPreview,
  [BLOCK_TYPES.UNSUBSCRIBE]: UnsubscribeBlockPreview,
};

function ReadOnlySectionPreview({ block, globalFontFamily }) {
  const children = block.children || [];
  const paddingStyle = getSpacingStyle(block.styles, 'padding');

  return (
    <div
      style={{
        backgroundColor: block.styles.backgroundColor,
        ...paddingStyle,
      }}
    >
      {children.map((child) => {
        if (child.hidden) return null;
        const ChildPreview = contentBlockPreviewComponents[child.type];
        if (!ChildPreview) return null;
        return <ChildPreview key={child.id} block={child} isChild={true} globalFontFamily={globalFontFamily} />;
      })}
    </div>
  );
}

function ReadOnlyColumnsPreview({ block, globalFontFamily }) {
  const colGapPx = parseInt(String(block.styles.columnGap || '10px').replace('px', ''), 10) || 0;
  const halfGap = Math.round(colGapPx / 2);
  const paddingStyle = getSpacingStyle(block.styles, 'padding');

  return (
    <div style={{ ...paddingStyle, backgroundColor: block.styles.backgroundColor }}>
      <div className="flex">
        {block.columns.map((col, idx) => (
          <div
            key={col.id}
            style={{
              width: col.width,
              paddingLeft: idx === 0 ? '0px' : `${halfGap}px`,
              paddingRight: idx === block.columns.length - 1 ? '0px' : `${halfGap}px`,
              boxSizing: 'border-box',
            }}
          >
            {col.blocks.map((childBlock) => {
              if (childBlock.hidden) return null;
              const ChildPreview = contentBlockPreviewComponents[childBlock.type];
              if (!ChildPreview) return null;
              return <ChildPreview key={childBlock.id} block={childBlock} isChild={true} globalFontFamily={globalFontFamily} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReadOnlyBlockPreview({ blocks, globalStyles, footerHtml }) {
  const globalFontFamily = globalStyles?.fontFamily || 'Arial, sans-serif';

  return (
    <div
      style={{
        backgroundColor: globalStyles?.contentBackgroundColor || '#ffffff',
        padding: globalStyles?.contentPadding || '0px',
        width: '100%',
        maxWidth: globalStyles?.contentWidth || '600px',
        margin: '0 auto',
      }}
      data-testid="readonly-preview-canvas"
    >
      {(blocks || []).filter(b => !b.hidden).map((block) => {
        if (block.type === BLOCK_TYPES.SECTION) {
          return <ReadOnlySectionPreview key={block.id} block={block} globalFontFamily={globalFontFamily} />;
        }
        if (block.type === BLOCK_TYPES.COLUMNS) {
          return <ReadOnlyColumnsPreview key={block.id} block={block} globalFontFamily={globalFontFamily} />;
        }
        const PreviewComponent = contentBlockPreviewComponents[block.type];
        if (!PreviewComponent) return null;
        return <PreviewComponent key={block.id} block={block} globalFontFamily={globalFontFamily} />;
      })}
      {globalStyles?.useDefaultFooter !== false && footerHtml && (
        <div
          style={{ padding: '0' }}
        >
          <div
            className="text-xs [&_a]:text-blue-600 [&_a]:underline [&_img]:max-w-full"
            style={{ pointerEvents: 'none' }}
            dangerouslySetInnerHTML={{ __html: footerHtml }}
            data-testid="readonly-footer-preview"
          />
        </div>
      )}
    </div>
  );
}

export default function BlockRenderer({
  block,
  isSelected,
  onSelect,
  onSelectChild,
  selectedChildId,
  onSelectColumnChild,
  selectedColumnChildId,
  globalFontFamily,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: block.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : block.hidden ? 0.3 : 1,
  };

  if (block.hidden) return null;

  const PreviewComponent = blockPreviewComponents[block.type];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative cursor-pointer ${isSelected ? 'ring-1 ring-primary/40' : 'hover:ring-1 hover:ring-muted-foreground/15'}`}
      onClick={() => onSelect(block.id)}
      data-testid={`block-${block.id}`}
    >
      <div className={`border ${isSelected ? 'border-primary/30' : 'border-transparent'} rounded transition-colors`}>
        {block.type === BLOCK_TYPES.SECTION ? (
          <SectionBlockPreview
            block={block}
            isSelected={isSelected}
            onSelectChild={onSelectChild}
            selectedChildId={selectedChildId}
            globalFontFamily={globalFontFamily}
          />
        ) : block.type === BLOCK_TYPES.COLUMNS ? (
          <ColumnsBlockPreview
            block={block}
            onSelectColumnChild={onSelectColumnChild}
            selectedColumnChildId={selectedColumnChildId}
            globalFontFamily={globalFontFamily}
          />
        ) : (
          PreviewComponent && <PreviewComponent block={block} globalFontFamily={globalFontFamily} />
        )}
      </div>
    </div>
  );
}
