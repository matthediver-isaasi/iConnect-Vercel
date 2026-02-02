import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BLOCK_TYPES } from './types';

function TextBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    if (key === 'content') {
      onChange({ ...block, content: value });
    } else {
      onChange({ ...block, styles: { ...block.styles, [key]: value } });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Content</Label>
        <Textarea
          value={block.content}
          onChange={(e) => update('content', e.target.value)}
          rows={4}
          placeholder="Enter text content..."
          data-testid="editor-text-content"
        />
        <p className="text-xs text-muted-foreground">
          Supports: {'{{first_name}}'}, {'{{last_name}}'}, {'{{email}}'}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Font Size</Label>
          <Select value={block.styles.fontSize} onValueChange={(v) => update('fontSize', v)}>
            <SelectTrigger data-testid="editor-font-size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="12px">Small (12px)</SelectItem>
              <SelectItem value="14px">Normal (14px)</SelectItem>
              <SelectItem value="16px">Medium (16px)</SelectItem>
              <SelectItem value="18px">Large (18px)</SelectItem>
              <SelectItem value="24px">XL (24px)</SelectItem>
              <SelectItem value="32px">XXL (32px)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Font Weight</Label>
          <Select value={block.styles.fontWeight} onValueChange={(v) => update('fontWeight', v)}>
            <SelectTrigger data-testid="editor-font-weight">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="bold">Bold</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Text Align</Label>
          <Select value={block.styles.textAlign} onValueChange={(v) => update('textAlign', v)}>
            <SelectTrigger data-testid="editor-text-align">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="center">Center</SelectItem>
              <SelectItem value="right">Right</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Text Color</Label>
          <Input
            type="color"
            value={block.styles.color}
            onChange={(e) => update('color', e.target.value)}
            className="h-9 p-1"
            data-testid="editor-text-color"
          />
        </div>
      </div>
    </div>
  );
}

function ImageBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    if (key === 'src' || key === 'alt' || key === 'href') {
      onChange({ ...block, [key]: value });
    } else {
      onChange({ ...block, styles: { ...block.styles, [key]: value } });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Image URL</Label>
        <Input
          value={block.src}
          onChange={(e) => update('src', e.target.value)}
          placeholder="https://example.com/image.jpg"
          data-testid="editor-image-src"
        />
      </div>
      <div className="space-y-2">
        <Label>Alt Text</Label>
        <Input
          value={block.alt}
          onChange={(e) => update('alt', e.target.value)}
          placeholder="Image description"
          data-testid="editor-image-alt"
        />
      </div>
      <div className="space-y-2">
        <Label>Link URL (optional)</Label>
        <Input
          value={block.href || ''}
          onChange={(e) => update('href', e.target.value)}
          placeholder="https://example.com"
          data-testid="editor-image-href"
        />
      </div>
      <div className="space-y-2">
        <Label>Alignment</Label>
        <Select value={block.styles.textAlign} onValueChange={(v) => update('textAlign', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="center">Center</SelectItem>
            <SelectItem value="right">Right</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ButtonBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    if (key === 'content' || key === 'href') {
      onChange({ ...block, [key]: value });
    } else {
      onChange({ ...block, styles: { ...block.styles, [key]: value } });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Button Text</Label>
        <Input
          value={block.content}
          onChange={(e) => update('content', e.target.value)}
          placeholder="Click Here"
          data-testid="editor-button-text"
        />
      </div>
      <div className="space-y-2">
        <Label>Link URL</Label>
        <Input
          value={block.href}
          onChange={(e) => update('href', e.target.value)}
          placeholder="https://example.com"
          data-testid="editor-button-href"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Background Color</Label>
          <Input
            type="color"
            value={block.styles.backgroundColor}
            onChange={(e) => update('backgroundColor', e.target.value)}
            className="h-9 p-1"
          />
        </div>
        <div className="space-y-2">
          <Label>Text Color</Label>
          <Input
            type="color"
            value={block.styles.color}
            onChange={(e) => update('color', e.target.value)}
            className="h-9 p-1"
          />
        </div>
        <div className="space-y-2">
          <Label>Font Size</Label>
          <Select value={block.styles.fontSize} onValueChange={(v) => update('fontSize', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="14px">Small</SelectItem>
              <SelectItem value="16px">Medium</SelectItem>
              <SelectItem value="18px">Large</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Border Radius</Label>
          <Select value={block.styles.borderRadius} onValueChange={(v) => update('borderRadius', v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">None</SelectItem>
              <SelectItem value="4px">Small</SelectItem>
              <SelectItem value="8px">Medium</SelectItem>
              <SelectItem value="20px">Pill</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-2">
        <Label>Alignment</Label>
        <Select value={block.styles.textAlign} onValueChange={(v) => update('textAlign', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="center">Center</SelectItem>
            <SelectItem value="right">Right</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function DividerBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    onChange({ ...block, styles: { ...block.styles, [key]: value } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Border Color</Label>
        <Input
          type="color"
          value={block.styles.borderColor}
          onChange={(e) => update('borderColor', e.target.value)}
          className="h-9 p-1"
        />
      </div>
      <div className="space-y-2">
        <Label>Border Style</Label>
        <Select value={block.styles.borderStyle} onValueChange={(v) => update('borderStyle', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="solid">Solid</SelectItem>
            <SelectItem value="dashed">Dashed</SelectItem>
            <SelectItem value="dotted">Dotted</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Border Width</Label>
        <Select value={block.styles.borderWidth} onValueChange={(v) => update('borderWidth', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1px">Thin (1px)</SelectItem>
            <SelectItem value="2px">Medium (2px)</SelectItem>
            <SelectItem value="4px">Thick (4px)</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function SpacerBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    onChange({ ...block, styles: { ...block.styles, [key]: value } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Height</Label>
        <Select value={block.styles.height} onValueChange={(v) => update('height', v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="10px">Small (10px)</SelectItem>
            <SelectItem value="20px">Medium (20px)</SelectItem>
            <SelectItem value="40px">Large (40px)</SelectItem>
            <SelectItem value="60px">XL (60px)</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function ColumnsBlockEditor({ block, onChange }) {
  const updateColumnCount = (count) => {
    const currentCols = block.columns || [];
    const newCols = [];
    const width = `${100 / count}%`;
    
    for (let i = 0; i < count; i++) {
      if (currentCols[i]) {
        newCols.push({ ...currentCols[i], width });
      } else {
        newCols.push({ id: `col-${Date.now()}-${i}`, blocks: [], width });
      }
    }
    
    onChange({ ...block, columns: newCols });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Number of Columns</Label>
        <Select 
          value={String(block.columns?.length || 2)} 
          onValueChange={(v) => updateColumnCount(parseInt(v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="2">2 Columns</SelectItem>
            <SelectItem value="3">3 Columns</SelectItem>
            <SelectItem value="4">4 Columns</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        Column content editing coming soon. For now, columns provide layout structure.
      </p>
    </div>
  );
}

function SectionBlockEditor({ block, onChange }) {
  const update = (key, value) => {
    onChange({ ...block, styles: { ...block.styles, [key]: value } });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Background Color</Label>
        <Input
          type="color"
          value={block.styles.backgroundColor || '#ffffff'}
          onChange={(e) => update('backgroundColor', e.target.value)}
          className="h-9 p-1"
          data-testid="editor-section-bg-color"
        />
      </div>
      <div className="space-y-2">
        <Label>Padding</Label>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Top</span>
            <Select value={block.styles.paddingTop || '20px'} onValueChange={(v) => update('paddingTop', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Bottom</span>
            <Select value={block.styles.paddingBottom || '20px'} onValueChange={(v) => update('paddingBottom', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Left</span>
            <Select value={block.styles.paddingLeft || '20px'} onValueChange={(v) => update('paddingLeft', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Right</span>
            <Select value={block.styles.paddingRight || '20px'} onValueChange={(v) => update('paddingRight', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">0</SelectItem>
                <SelectItem value="10px">10px</SelectItem>
                <SelectItem value="20px">20px</SelectItem>
                <SelectItem value="30px">30px</SelectItem>
                <SelectItem value="40px">40px</SelectItem>
                <SelectItem value="60px">60px</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Drag content blocks into this section to build your email layout.
      </p>
    </div>
  );
}

const blockEditors = {
  [BLOCK_TYPES.SECTION]: SectionBlockEditor,
  [BLOCK_TYPES.TEXT]: TextBlockEditor,
  [BLOCK_TYPES.IMAGE]: ImageBlockEditor,
  [BLOCK_TYPES.BUTTON]: ButtonBlockEditor,
  [BLOCK_TYPES.DIVIDER]: DividerBlockEditor,
  [BLOCK_TYPES.SPACER]: SpacerBlockEditor,
  [BLOCK_TYPES.COLUMNS]: ColumnsBlockEditor,
};

export default function BlockEditor({ block, onChange }) {
  if (!block) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        <p>Select a block to edit its properties</p>
      </div>
    );
  }

  const EditorComponent = blockEditors[block.type];
  const blockTypeLabel = block.type.charAt(0).toUpperCase() + block.type.slice(1);

  return (
    <div className="p-4">
      <h3 className="text-sm font-medium mb-4">{blockTypeLabel} Settings</h3>
      {EditorComponent && <EditorComponent block={block} onChange={onChange} />}
    </div>
  );
}
