import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Trash2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BLOCK_TYPES } from './types';

function TextBlockPreview({ block }) {
  return (
    <div
      style={{
        fontSize: block.styles.fontSize,
        fontWeight: block.styles.fontWeight,
        color: block.styles.color,
        textAlign: block.styles.textAlign,
        lineHeight: block.styles.lineHeight,
        padding: block.styles.padding,
        whiteSpace: 'pre-wrap',
      }}
    >
      {block.content}
    </div>
  );
}

function ImageBlockPreview({ block }) {
  if (!block.src) {
    return (
      <div 
        className="flex items-center justify-center bg-muted/50 text-muted-foreground border-2 border-dashed rounded"
        style={{ padding: block.styles.padding, minHeight: '100px' }}
      >
        Click to add image URL
      </div>
    );
  }
  return (
    <div style={{ padding: block.styles.padding, textAlign: block.styles.textAlign }}>
      <img 
        src={block.src} 
        alt={block.alt} 
        style={{ maxWidth: block.styles.maxWidth, width: '100%' }}
      />
    </div>
  );
}

function ButtonBlockPreview({ block }) {
  return (
    <div style={{ padding: block.styles.containerPadding, textAlign: block.styles.textAlign }}>
      <span
        style={{
          display: 'inline-block',
          backgroundColor: block.styles.backgroundColor,
          color: block.styles.color,
          fontSize: block.styles.fontSize,
          fontWeight: block.styles.fontWeight,
          padding: block.styles.padding,
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
  return (
    <div style={{ padding: block.styles.padding }}>
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

function ColumnsBlockPreview({ block }) {
  return (
    <div style={{ padding: block.styles.padding }}>
      <div className="flex gap-2">
        {block.columns.map((col, idx) => (
          <div 
            key={col.id} 
            className="flex-1 min-h-[60px] border-2 border-dashed border-muted-foreground/30 rounded p-2 bg-muted/20"
            style={{ width: col.width }}
          >
            <span className="text-xs text-muted-foreground">Column {idx + 1}</span>
            {col.blocks.length === 0 && (
              <div className="text-xs text-muted-foreground/50 mt-2">Drop blocks here</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const blockPreviewComponents = {
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
  onDelete, 
  onDuplicate 
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
    opacity: isDragging ? 0.5 : 1,
  };

  const PreviewComponent = blockPreviewComponents[block.type];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative group ${isSelected ? 'ring-2 ring-primary' : ''}`}
      onClick={() => onSelect(block.id)}
      data-testid={`block-${block.id}`}
    >
      <div className="absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
        <div
          {...attributes}
          {...listeners}
          className="p-1 cursor-grab hover:bg-muted rounded"
        >
          <GripVertical className="w-4 h-4 text-muted-foreground" />
        </div>
      </div>

      <div className="absolute -right-2 top-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 -translate-y-1/2 z-10">
        <Button
          size="icon"
          variant="outline"
          className="h-6 w-6 bg-background"
          onClick={(e) => { e.stopPropagation(); onDuplicate(block.id); }}
          data-testid={`duplicate-block-${block.id}`}
        >
          <Copy className="w-3 h-3" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="h-6 w-6 bg-background text-destructive hover:bg-destructive hover:text-destructive-foreground"
          onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}
          data-testid={`delete-block-${block.id}`}
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>

      <div className={`border ${isSelected ? 'border-primary' : 'border-transparent hover:border-muted-foreground/30'} rounded transition-colors`}>
        {PreviewComponent && <PreviewComponent block={block} />}
      </div>
    </div>
  );
}
