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

// Task #974: the FontSize textStyle attribute now supports per-device
// values. Legacy desktop-only marks remain a plain string (e.g. "16px")
// so any saved HTML that only ever set a desktop size round-trips
// byte-identically. Once an author sets a tablet- or mobile-specific
// size the attribute becomes an object `{ desktop, tablet, mobile }`
// (any subset present) — rendered HTML stores desktop inline
// (`style="font-size:…"`) and tablet/mobile via `data-fs-tablet="…"` /
// `data-fs-mobile="…"` attributes. The canvas renderer extracts those
// data attributes and emits per-block @media CSS that targets them
// (see `buildTiptapFontSizeResponsiveCss` in
// `client/src/components/canvas/blocks/registry.jsx`).
function normalizeFontSizeAttr(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (typeof v === 'object') {
    const o = {};
    if (v.desktop) o.desktop = v.desktop;
    if (v.tablet) o.tablet = v.tablet;
    if (v.mobile) o.mobile = v.mobile;
    const keys = Object.keys(o);
    if (keys.length === 0) return null;
    if (keys.length === 1 && o.desktop) return o.desktop; // collapse to scalar
    return o;
  }
  return null;
}

function resolveFontSizeAtBp(v, bp) {
  if (!v) return '';
  const breakpoint = bp || 'desktop';
  if (typeof v === 'string') return breakpoint === 'desktop' ? v : '';
  if (typeof v === 'object') return v[breakpoint] || '';
  return '';
}

function writeFontSizeAtBp(current, bp, next) {
  const breakpoint = bp || 'desktop';
  const cleanNext = next == null || next === '' ? null : next;
  let obj;
  if (current == null) {
    obj = {};
  } else if (typeof current === 'string') {
    // Legacy scalar = desktop. Lift to object only when we're about to
    // set a non-desktop value; otherwise stay scalar for byte-identity.
    if (breakpoint === 'desktop') {
      return cleanNext; // string or null
    }
    obj = { desktop: current };
  } else if (typeof current === 'object') {
    obj = { ...current };
  } else {
    obj = {};
  }
  if (cleanNext == null) delete obj[breakpoint];
  else obj[breakpoint] = cleanNext;
  return normalizeFontSizeAttr(obj);
}

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
          parseHTML: element => {
            const inline = element.style.fontSize
              ? element.style.fontSize.replace(/['"]+/g, '')
              : null;
            const tablet = element.getAttribute('data-fs-tablet') || null;
            const mobile = element.getAttribute('data-fs-mobile') || null;
            if (!inline && !tablet && !mobile) return null;
            if (!tablet && !mobile) return inline; // legacy scalar
            const obj = {};
            if (inline) obj.desktop = inline;
            if (tablet) obj.tablet = tablet;
            if (mobile) obj.mobile = mobile;
            return normalizeFontSizeAttr(obj);
          },
          renderHTML: attributes => {
            const v = attributes.fontSize;
            if (!v) return {};
            if (typeof v === 'string') {
              return { style: `font-size: ${v}` };
            }
            if (typeof v === 'object') {
              const out = {};
              if (v.desktop) out.style = `font-size: ${v.desktop}`;
              if (v.tablet) out['data-fs-tablet'] = v.tablet;
              if (v.mobile) out['data-fs-mobile'] = v.mobile;
              return out;
            }
            return {};
          },
        },
      },
    }];
  },
  addCommands() {
    return {
      setFontSize: (fontSize, opts) => ({ chain, editor }) => {
        const bp = (opts && opts.breakpoint) || 'desktop';
        const current = editor.getAttributes('textStyle').fontSize;
        const next = writeFontSizeAtBp(current, bp, fontSize);
        return chain().setMark('textStyle', { fontSize: next }).run();
      },
      unsetFontSize: (opts) => ({ chain, editor }) => {
        const bp = (opts && opts.breakpoint) || 'desktop';
        const current = editor.getAttributes('textStyle').fontSize;
        const next = writeFontSizeAtBp(current, bp, null);
        if (next == null) {
          return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
        }
        return chain().setMark('textStyle', { fontSize: next }).run();
      },
    };
  },
});

const BP_LABEL = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

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
  { value: '72px', label: '72' },
  { value: '96px', label: '96' },
  { value: '128px', label: '128' },
  { value: '160px', label: '160' },
  { value: '192px', label: '192' },
];

function MenuBar({ editor, breakpoint, anchorOptions }) {
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
  // Per-breakpoint font-size editing: when a breakpoint prop is passed
  // by the host (Canvas Text inspector forwards the active chip), the
  // Size dropdown reads/writes the value for that breakpoint only.
  // Hosts that don't pass a breakpoint (legacy email builder) keep
  // editing the desktop scalar value, matching pre-#974 behaviour.
  const activeBp = breakpoint === 'mobile' || breakpoint === 'tablet' || breakpoint === 'desktop'
    ? breakpoint
    : 'desktop';
  const fontSizeAttr = editor.getAttributes('textStyle').fontSize;
  const currentFontSize = resolveFontSizeAtBp(fontSizeAttr, activeBp);
  const showBpChip = !!breakpoint;
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
              editor.chain().focus().unsetFontSize({ breakpoint: activeBp }).run();
            } else {
              editor.chain().focus().setFontSize(v, { breakpoint: activeBp }).run();
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
        {showBpChip && (
          <span
            className="text-[11px] px-1.5 py-0.5 rounded-md border border-border bg-muted text-muted-foreground"
            title="Font sizes apply only to the active breakpoint"
            data-testid="rte-bp-chip"
          >
            Size editing: {BP_LABEL[activeBp]}
          </span>
        )}
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
          {/* Task #1446: pick an in-page anchor to fill the link field. Only
              shown when the host passes anchorOptions (canvas builder). */}
          {anchorOptions && anchorOptions.length > 0 && (
            <Select value="" onValueChange={(v) => setLinkUrl(v)}>
              <SelectTrigger className="h-7 w-28 text-xs shrink-0" data-testid="rte-link-anchor-select">
                <SelectValue placeholder="Section…" />
              </SelectTrigger>
              <SelectContent>
                {anchorOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} data-testid={`rte-link-anchor-${opt.value}`}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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

export default function RichTextEditor({ content, onChange, fontFamily, color, lineHeight, breakpoint, anchorOptions }) {
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
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[120px] p-3 [&_p]:mt-0 [&_p]:mb-[1em] [&_p:last-child]:mb-0 [&_h1]:mt-0 [&_h1]:mb-[0.5em] [&_h2]:mt-0 [&_h2]:mb-[0.5em] [&_h3]:mt-0 [&_h3]:mb-[0.5em] [&_strong]:text-inherit [&_em]:text-inherit [&_h1]:text-inherit [&_h2]:text-inherit [&_h3]:text-inherit [&_p]:text-inherit',
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
            class: 'prose prose-sm max-w-none focus:outline-none min-h-[120px] p-3 [&_p]:mt-0 [&_p]:mb-[1em] [&_p:last-child]:mb-0 [&_h1]:mt-0 [&_h1]:mb-[0.5em] [&_h2]:mt-0 [&_h2]:mb-[0.5em] [&_h3]:mt-0 [&_h3]:mb-[0.5em] [&_strong]:text-inherit [&_em]:text-inherit [&_h1]:text-inherit [&_h2]:text-inherit [&_h3]:text-inherit [&_p]:text-inherit',
            style: buildStyle(fontFamily, color, lineHeight),
          },
        },
      });
    }
  }, [editor, fontFamily, color, lineHeight]);

  return (
    <div className="border rounded-md overflow-hidden bg-background" data-testid="rich-text-editor">
      <MenuBar editor={editor} breakpoint={breakpoint} anchorOptions={anchorOptions} />
      <EditorContent editor={editor} />
    </div>
  );
}
