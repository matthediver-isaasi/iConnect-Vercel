import { useSortable } from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Plus } from 'lucide-react';
import { BLOCK_TYPES } from './types';
import { sanitizeHtml } from './sanitize';
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

function SectionBlockPreview({ block, isSelected, onSelectChild, selectedChildId }) {
  const children = block.children || [];
  const { isOver, setNodeRef } = useDroppable({
    id: `section-drop-${block.id}`,
    data: { sectionId: block.id, isSection: true },
  });

  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const marginStyle = getSpacingStyle(block.styles, 'margin');

  return (
    <div
      ref={setNodeRef}
      style={{
        backgroundColor: block.styles.backgroundColor,
        ...paddingStyle,
        ...marginStyle,
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
          />
        );
      })}
    </div>
  );
}

function ChildBlockRenderer({ block, isSelected, onSelect }) {
  const PreviewComponent = contentBlockPreviewComponents[block.type];

  return (
    <div
      className={`relative cursor-pointer ${isSelected ? 'ring-1 ring-primary/40' : 'hover:ring-1 hover:ring-muted-foreground/15'}`}
      onClick={(e) => { e.stopPropagation(); onSelect(block.id); }}
      data-testid={`child-block-${block.id}`}
    >
      <div className={`border ${isSelected ? 'border-primary/30' : 'border-transparent'} rounded transition-colors`}>
        {PreviewComponent && <PreviewComponent block={block} />}
      </div>
    </div>
  );
}

function TextBlockPreview({ block }) {
  const isHtml = block.content && block.content.includes('<');
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const marginStyle = getSpacingStyle(block.styles, 'margin');
  return (
    <div
      className="prose prose-sm max-w-none [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-0 [&_h1]:mb-[0.5em] [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-0 [&_h2]:mb-[0.5em] [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-0 [&_h3]:mb-[0.5em] [&_p]:mt-0 [&_p]:mb-[1em] [&_p:last-child]:mb-0 [&_ul]:pl-5 [&_ol]:pl-5 [&_a]:text-blue-600 [&_a]:underline [&_strong]:text-inherit [&_em]:text-inherit [&_h1]:text-inherit [&_h2]:text-inherit [&_h3]:text-inherit [&_p]:text-inherit"
      style={{
        fontFamily: block.styles.fontFamily || 'inherit',
        color: block.styles.color,
        lineHeight: block.styles.lineHeight || '1.5',
        ...paddingStyle,
        ...marginStyle,
      }}
      dangerouslySetInnerHTML={isHtml ? { __html: sanitizeHtml(block.content) } : undefined}
    >
      {isHtml ? undefined : block.content}
    </div>
  );
}

function ImageBlockPreview({ block }) {
  const getImageWidth = () => {
    const size = block.styles.imageSize || '100%';
    if (size === 'custom' && block.styles.imageSizeCustom) {
      return `${block.styles.imageSizeCustom}px`;
    }
    return size;
  };

  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const marginStyle = getSpacingStyle(block.styles, 'margin');

  if (!block.src) {
    return (
      <div
        className="flex items-center justify-center bg-muted/50 text-muted-foreground border-2 border-dashed rounded"
        style={{ ...paddingStyle, ...marginStyle, minHeight: '100px' }}
      >
        Click to add image URL
      </div>
    );
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

  return (
    <div style={{ ...paddingStyle, ...marginStyle }}>
      <img
        src={block.src}
        alt={block.alt}
        style={imgStyle}
      />
    </div>
  );
}

function ButtonBlockPreview({ block }) {
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const marginStyle = getSpacingStyle(block.styles, 'margin');
  const innerPaddingStyle = getSpacingStyle(block.styles, 'innerPadding', 'padding');

  return (
    <div style={{ ...paddingStyle, ...marginStyle, textAlign: block.styles.textAlign }}>
      <span
        style={{
          display: 'inline-block',
          backgroundColor: block.styles.backgroundColor,
          color: block.styles.color,
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
}

function DividerBlockPreview({ block }) {
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const marginStyle = getSpacingStyle(block.styles, 'margin');
  return (
    <div style={{ ...paddingStyle, ...marginStyle }}>
      <hr
        style={{
          borderColor: block.styles.borderColor,
          borderWidth: block.styles.borderWidth,
          borderStyle: block.styles.borderStyle,
        }}
      />
    </div>
  );
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

function ColumnsBlockPreview({ block, onSelectColumnChild, selectedColumnChildId }) {
  const colGapPx = parseInt(String(block.styles.columnGap || '10px').replace('px', ''), 10) || 0;
  const halfGap = Math.round(colGapPx / 2);
  const paddingStyle = getSpacingStyle(block.styles, 'padding');
  const marginStyle = getSpacingStyle(block.styles, 'margin');

  return (
    <div style={{ ...paddingStyle, ...marginStyle }}>
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
                  <ChildPreview block={childBlock} />
                </div>
              );
            })}
          </ColumnDropZone>
        ))}
      </div>
    </div>
  );
}

const contentBlockPreviewComponents = {
  [BLOCK_TYPES.TEXT]: TextBlockPreview,
  [BLOCK_TYPES.IMAGE]: ImageBlockPreview,
  [BLOCK_TYPES.BUTTON]: ButtonBlockPreview,
  [BLOCK_TYPES.DIVIDER]: DividerBlockPreview,
  [BLOCK_TYPES.SPACER]: SpacerBlockPreview,
};

const blockPreviewComponents = {
  [BLOCK_TYPES.SECTION]: SectionBlockPreview,
  [BLOCK_TYPES.TEXT]: TextBlockPreview,
  [BLOCK_TYPES.IMAGE]: ImageBlockPreview,
  [BLOCK_TYPES.BUTTON]: ButtonBlockPreview,
  [BLOCK_TYPES.DIVIDER]: DividerBlockPreview,
  [BLOCK_TYPES.SPACER]: SpacerBlockPreview,
  [BLOCK_TYPES.COLUMNS]: ColumnsBlockPreview,
};

export default function BlockRenderer({
  block,
  isSelected,
  onSelect,
  onSelectChild,
  selectedChildId,
  onSelectColumnChild,
  selectedColumnChildId,
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
          />
        ) : block.type === BLOCK_TYPES.COLUMNS ? (
          <ColumnsBlockPreview
            block={block}
            onSelectColumnChild={onSelectColumnChild}
            selectedColumnChildId={selectedColumnChildId}
          />
        ) : (
          PreviewComponent && <PreviewComponent block={block} />
        )}
      </div>
    </div>
  );
}
