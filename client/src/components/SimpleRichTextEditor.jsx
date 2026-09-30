import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  Heading2,
  Link as LinkIcon,
  Unlink,
} from 'lucide-react';

export default function SimpleRichTextEditor({ content, onChange, placeholder, className, disabled = false, id, 'aria-label': ariaLabel }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, underline: false }),
      Underline,
      Link.configure({ openOnClick: false }),
    ],
    content: content || '',
    editable: !disabled,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        'aria-label': ariaLabel || 'Rich text editor',
        ...(placeholder ? { 'data-placeholder': placeholder } : {}),
      },
    },
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML());
    },
  });

  useEffect(() => {
    if (editor && content !== undefined && editor.getHTML() !== content) {
      editor.commands.setContent(content || '', false);
    }
  }, [editor, content]);

  useEffect(() => {
    editor?.setEditable(!disabled);
    if (disabled) setLinkOpen(false);
  }, [editor, disabled]);

  useEffect(() => {
    if (!content) {
      setLinkOpen(false);
      setLinkUrl('');
      setLinkError('');
    }
  }, [content]);

  if (!editor) return null;

  const toolbarBtn = (active, onClick, Icon, label) => (
    <Button
      key={label}
      type="button"
      variant="ghost"
      size="icon"
      className={`h-7 w-7 ${active ? 'bg-muted' : ''}`}
      onClick={(e) => { e.preventDefault(); onClick(); }}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      data-testid={`button-rte-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </Button>
  );

  const openLink = () => {
    setLinkUrl(editor.getAttributes('link').href || '');
    setLinkError('');
    setLinkOpen(true);
  };
  const saveLink = () => {
    const url = linkUrl.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(url)) {
      setLinkError('Enter a link beginning with https://, http:// or mailto:');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkOpen(false);
    setLinkError('');
  };

  return (
    <div className={`border rounded-md overflow-hidden ${className || ''}`}>
      <div className="flex flex-wrap items-center gap-0.5 p-1 border-b bg-muted/30">
        {toolbarBtn(editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), Bold, 'Bold')}
        {toolbarBtn(editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), Italic, 'Italic')}
        {toolbarBtn(editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run(), UnderlineIcon, 'Underline')}
        {toolbarBtn(editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), Heading2, 'Heading')}
        {toolbarBtn(editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), List, 'Bullet List')}
        {toolbarBtn(editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), ListOrdered, 'Numbered List')}
        {toolbarBtn(editor.isActive('link'), openLink, LinkIcon, 'Add Link')}
        {editor.isActive('link') && toolbarBtn(false, () => { editor.chain().focus().unsetLink().run(); setLinkOpen(false); }, Unlink, 'Remove Link')}
      </div>
      {linkOpen && !disabled && (
        <div className="flex flex-wrap items-center gap-2 border-b p-2">
          <input
            type="url"
            aria-label="Link URL"
            data-testid="input-rte-link-url"
            value={linkUrl}
            onChange={event => { setLinkUrl(event.target.value); setLinkError(''); }}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); saveLink(); }
              if (event.key === 'Escape') { event.preventDefault(); setLinkOpen(false); }
            }}
            placeholder="https://example.com"
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm"
          />
          <Button type="button" size="sm" onClick={saveLink} data-testid="button-rte-save-link">
            {editor.isActive('link') ? 'Update link' : 'Add link'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setLinkOpen(false)}>Cancel</Button>
          {linkError && <p role="alert" className="w-full text-sm text-destructive">{linkError}</p>}
        </div>
      )}
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none p-3 min-h-[100px] focus-within:outline-none [&_.tiptap]:outline-none [&_.tiptap]:min-h-[80px]"
        data-testid="rte-content"
      />
    </div>
  );
}
