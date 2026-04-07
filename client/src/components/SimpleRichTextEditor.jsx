import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { useEffect } from 'react';
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

export default function SimpleRichTextEditor({ content, onChange, placeholder, className }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
    ],
    content: content || '',
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML());
    },
  });

  useEffect(() => {
    if (editor && content !== undefined && editor.getHTML() !== content) {
      editor.commands.setContent(content || '', false);
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
      data-testid={`button-rte-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </Button>
  );

  const addLink = () => {
    const url = window.prompt('Enter URL');
    if (url) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
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
        {toolbarBtn(editor.isActive('link'), addLink, LinkIcon, 'Add Link')}
        {editor.isActive('link') && toolbarBtn(false, () => editor.chain().focus().unsetLink().run(), Unlink, 'Remove Link')}
      </div>
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none p-3 min-h-[100px] focus-within:outline-none [&_.tiptap]:outline-none [&_.tiptap]:min-h-[80px]"
        data-testid="rte-content"
      />
    </div>
  );
}
