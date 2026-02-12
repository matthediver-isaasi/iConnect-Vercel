import { useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';
import { BLOCK_TYPES, SOCIAL_PLATFORMS } from './types';
import { sanitizeHtml, stripTrailingEmptyParagraphs } from './sanitize';
import { getIndividualValues } from './SpacingControl';
import { SOCIAL_ICON_SVGS } from './socialIcons';

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

function SocialIconsBlockPreview({ block, isChild }) {
  const platforms = (block.platforms || []).filter(p => p.enabled);
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const iconSize = parseInt(block.styles.iconSize || '32', 10);
  const iconColor = block.styles.iconColor || '#333333';
  const bgColor = block.styles.iconBgColor || '#f4f4f4';
  const shape = block.styles.shape || 'circle';
  const iconStyle = block.styles.iconStyle || 'filled';
  const displayMode = block.styles.displayMode || 'icon-only';
  const align = block.styles.textAlign || 'center';
  const spacing = parseInt(block.styles.iconSpacing || '8', 10);

  const borderRadius = shape === 'circle' ? '50%' : shape === 'rounded' ? '6px' : '0px';
  const containerSize = iconSize + 12;

  const socialEl = (
    <div style={{ ...paddingStyle, textAlign: align }}>
      <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: `${spacing}px`, justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start' }}>
        {platforms.length === 0 && (
          <div className="text-sm text-muted-foreground py-2">No social platforms enabled</div>
        )}
        {platforms.map(p => {
          const iconData = SOCIAL_ICON_SVGS[p.key];
          const def = SOCIAL_PLATFORMS.find(sp => sp.key === p.key);
          if (!iconData) return null;
          return (
            <div key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <div
                style={{
                  width: `${containerSize}px`,
                  height: `${containerSize}px`,
                  borderRadius,
                  backgroundColor: shape !== 'none' ? bgColor : 'transparent',
                  border: iconStyle === 'outline' && shape !== 'none' ? `2px solid ${iconColor}` : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width={iconSize * 0.6} height={iconSize * 0.6} viewBox={iconData.viewBox} fill={iconColor}>
                  <path d={iconData.path} />
                </svg>
              </div>
              {displayMode === 'icon-text' && (
                <span style={{ fontSize: '13px', color: iconColor }}>{def?.label || p.key}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  if (isChild) return socialEl;
  const marginAsPadding = getSpacingStyle(block.styles, 'margin', 'padding');
  return <div style={marginAsPadding}>{socialEl}</div>;
}

const contentBlockPreviewComponents = {
  [BLOCK_TYPES.TEXT]: TextBlockPreview,
  [BLOCK_TYPES.IMAGE]: ImageBlockPreview,
  [BLOCK_TYPES.BUTTON]: ButtonBlockPreview,
  [BLOCK_TYPES.DIVIDER]: DividerBlockPreview,
  [BLOCK_TYPES.SPACER]: SpacerBlockPreview,
  [BLOCK_TYPES.SOCIAL_ICONS]: SocialIconsBlockPreview,
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
};

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
