import { useEditor, EditorContent } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { FontFamily } from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Link as LinkIcon,
  Unlink,
  Undo,
  Redo,
  Type,
  Minus,
  Palette,
  Highlighter,
} from 'lucide-react';

const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] };
  },
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        fontSize: {
          default: null,
          parseHTML: element => element.style.fontSize?.replace(/['"]+/g, '') || null,
          renderHTML: attributes => {
            if (!attributes.fontSize) return {};
            return { style: `font-size: ${attributes.fontSize}` };
          },
        },
      },
    }];
  },
  addCommands() {
    return {
      setFontSize: (fontSize) => ({ chain }) => {
        return chain().setMark('textStyle', { fontSize }).run();
      },
      unsetFontSize: () => ({ chain }) => {
        return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
      },
    };
  },
});

const BackgroundColor = Extension.create({
  name: 'backgroundColor',
  addOptions() {
    return { types: ['textStyle'] };
  },
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        backgroundColor: {
          default: null,
          parseHTML: element => element.style.backgroundColor || null,
          renderHTML: attributes => {
            if (!attributes.backgroundColor) return {};
            return { style: `background-color: ${attributes.backgroundColor}` };
          },
        },
      },
    }];
  },
  addCommands() {
    return {
      setBackgroundColor: (color) => ({ chain }) => {
        return chain().setMark('textStyle', { backgroundColor: color }).run();
      },
      unsetBackgroundColor: () => ({ chain }) => {
        return chain().setMark('textStyle', { backgroundColor: null }).removeEmptyTextStyle().run();
      },
    };
  },
});

const TOOLBAR_FONTS = [
  { value: '', label: 'Default' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Roboto, sans-serif', label: 'Roboto' },
  { value: 'Open Sans, sans-serif', label: 'Open Sans' },
  { value: 'Lato, sans-serif', label: 'Lato' },
  { value: 'Montserrat, sans-serif', label: 'Montserrat' },
  { value: 'Poppins, sans-serif', label: 'Poppins' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Playfair Display, serif', label: 'Playfair Display' },
  { value: 'Times New Roman, serif', label: 'Times New Roman' },
  { value: 'Verdana, sans-serif', label: 'Verdana' },
];

function ToolbarButton({ onClick, isActive, children, title }) {
  return (
    <Button
      type="button"
      size="icon"
      variant={isActive ? 'default' : 'ghost'}
      className="h-7 w-7"
      onClick={onClick}
      title={title}
      data-testid={`rte-btn-${title?.toLowerCase().replace(/\s+/g, '-')}`}
    >
      {children}
    </Button>
  );
}

const FONT_SIZES = [
  { value: '', label: 'Size' },
  { value: '10px', label: '10' },
  { value: '12px', label: '12' },
  { value: '14px', label: '14' },
  { value: '16px', label: '16' },
  { value: '18px', label: '18' },
  { value: '20px', label: '20' },
  { value: '24px', label: '24' },
  { value: '28px', label: '28' },
  { value: '32px', label: '32' },
  { value: '36px', label: '36' },
  { value: '48px', label: '48' },
  { value: '64px', label: '64' },
];

function MenuBar({ editor }) {
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const colorInputRef = useRef(null);
  const bgColorInputRef = useRef(null);

  if (!editor) return null;

  const handleSetLink = () => {
    if (linkUrl) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run();
    }
    setShowLinkInput(false);
    setLinkUrl('');
  };

  const currentColor = editor.getAttributes('textStyle').color || '';
  const currentFont = editor.getAttributes('textStyle').fontFamily || '';
  const currentFontSize = editor.getAttributes('textStyle').fontSize || '';
  const currentBgColor = editor.getAttributes('textStyle').backgroundColor || '';

  return (
    <div className="border-b p-1 space-y-1">
      <div className="flex flex-wrap gap-0.5 items-center">
        <ToolbarButton
          onClick={() => editor.chain().focus().setParagraph().run()}
          isActive={editor.isActive('paragraph')}
          title="Paragraph"
        >
          <Type className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={editor.isActive('heading', { level: 1 })}
          title="Heading 1"
        >
          <Heading1 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={editor.isActive('heading', { level: 2 })}
          title="Heading 2"
        >
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={editor.isActive('heading', { level: 3 })}
          title="Heading 3"
        >
          <Heading3 className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px bg-border mx-0.5 self-stretch" />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive('bold')}
          title="Bold"
        >
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive('italic')}
          title="Italic"
        >
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive('underline')}
          title="Underline"
        >
          <UnderlineIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive('strike')}
          title="Strikethrough"
        >
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px bg-border mx-0.5 self-stretch" />

        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          isActive={editor.isActive({ textAlign: 'left' })}
          title="Align left"
        >
          <AlignLeft className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          isActive={editor.isActive({ textAlign: 'center' })}
          title="Align center"
        >
          <AlignCenter className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          isActive={editor.isActive({ textAlign: 'right' })}
          title="Align right"
        >
          <AlignRight className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px bg-border mx-0.5 self-stretch" />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive('bulletList')}
          title="Bullet list"
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive('orderedList')}
          title="Ordered list"
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>

        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          isActive={false}
          title="Horizontal rule"
        >
          <Minus className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="w-px bg-border mx-0.5 self-stretch" />

        <ToolbarButton
          onClick={() => {
            if (editor.isActive('link')) {
              editor.chain().focus().unsetLink().run();
            } else {
              const previousUrl = editor.getAttributes('link').href;
              setLinkUrl(previousUrl || '');
              setShowLinkInput(true);
            }
          }}
          isActive={editor.isActive('link')}
          title={editor.isActive('link') ? 'Remove link' : 'Add link'}
        >
          {editor.isActive('link') ? (
            <Unlink className="h-3.5 w-3.5" />
          ) : (
            <LinkIcon className="h-3.5 w-3.5" />
          )}
        </ToolbarButton>

        <div className="w-px bg-border mx-0.5 self-stretch" />

        <div className="relative inline-flex" title="Text color">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 relative"
            onClick={() => colorInputRef.current?.click()}
            data-testid="rte-btn-text-color"
          >
            <Palette className="h-3.5 w-3.5" />
            <span
              className="absolute bottom-0.5 left-1.5 right-1.5 h-1 rounded-full pointer-events-none"
              style={{ backgroundColor: currentColor || '#333333' }}
            />
          </Button>
          <input
            ref={colorInputRef}
            type="color"
            value={currentColor || '#333333'}
            onChange={(e) => {
              editor.chain().focus().setColor(e.target.value).run();
            }}
            className="absolute opacity-0 w-0 h-0 pointer-events-none"
            data-testid="rte-color-input"
          />
        </div>

        <div className="relative inline-flex" title="Background color">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 relative"
            onClick={() => bgColorInputRef.current?.click()}
            data-testid="rte-btn-bg-color"
          >
            <Highlighter className="h-3.5 w-3.5" />
            <span
              className="absolute bottom-0.5 left-1.5 right-1.5 h-1 rounded-full pointer-events-none border border-border/50"
              style={{ backgroundColor: currentBgColor || 'transparent' }}
            />
          </Button>
          <input
            ref={bgColorInputRef}
            type="color"
            value={currentBgColor || '#ffff00'}
            onChange={(e) => {
              editor.chain().focus().setBackgroundColor(e.target.value).run();
            }}
            className="absolute opacity-0 w-0 h-0 pointer-events-none"
            data-testid="rte-bg-color-input"
          />
        </div>

        <div className="w-px bg-border mx-0.5 self-stretch" />

        <ToolbarButton
          onClick={() => editor.chain().focus().undo().run()}
          isActive={false}
          title="Undo"
        >
          <Undo className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().redo().run()}
          isActive={false}
          title="Redo"
        >
          <Redo className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>

      <div className="flex gap-1 items-center px-1 flex-wrap">
        <Select
          value={currentFont || '__default__'}
          onValueChange={(v) => {
            if (v === '__default__') {
              editor.chain().focus().unsetFontFamily().run();
            } else {
              editor.chain().focus().setFontFamily(v).run();
            }
          }}
        >
          <SelectTrigger className="h-7 text-xs w-[140px]" data-testid="rte-font-family">
            <SelectValue placeholder="Font..." />
          </SelectTrigger>
          <SelectContent>
            {TOOLBAR_FONTS.map(font => (
              <SelectItem
                key={font.value || '__default__'}
                value={font.value || '__default__'}
                style={{ fontFamily: font.value || 'inherit' }}
              >
                {font.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={currentFontSize || '__default__'}
          onValueChange={(v) => {
            if (v === '__default__') {
              editor.chain().focus().unsetFontSize().run();
            } else {
              editor.chain().focus().setFontSize(v).run();
            }
          }}
        >
          <SelectTrigger className="h-7 text-xs w-[72px]" data-testid="rte-font-size">
            <SelectValue placeholder="Size" />
          </SelectTrigger>
          <SelectContent>
            {FONT_SIZES.map(size => (
              <SelectItem
                key={size.value || '__default__'}
                value={size.value || '__default__'}
              >
                {size.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {showLinkInput && (
        <div className="flex gap-1 items-center px-1 pb-1">
          <Input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://example.com"
            className="h-7 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSetLink();
              }
            }}
            data-testid="rte-link-input"
            autoFocus
          />
          <Button
            size="icon"
            variant="default"
            className="h-7 w-7 shrink-0"
            onClick={handleSetLink}
            data-testid="rte-link-confirm"
          >
            <LinkIcon className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default function RichTextEditor({ content, onChange, fontFamily, color, lineHeight }) {
  const buildStyle = (ff, c, lh) => [
    ff ? `font-family: ${ff}` : '',
    c ? `color: ${c}` : '',
    `line-height: ${lh || '1.5'}`,
  ].filter(Boolean).join('; ');

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      BackgroundColor,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
      Underline,
    ],
    content: content || '<p></p>',
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[120px] p-3 [&_p]:my-0 [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0',
        style: buildStyle(fontFamily, color, lineHeight),
      },
    },
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content || '<p></p>', false);
    }
  }, [content]);

  useEffect(() => {
    if (editor) {
      editor.setOptions({
        editorProps: {
          attributes: {
            class: 'prose prose-sm max-w-none focus:outline-none min-h-[120px] p-3 [&_p]:my-0 [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0',
            style: buildStyle(fontFamily, color, lineHeight),
          },
        },
      });
    }
  }, [editor, fontFamily, color, lineHeight]);

  return (
    <div className="border rounded-md overflow-hidden bg-background" data-testid="rich-text-editor">
      <MenuBar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
