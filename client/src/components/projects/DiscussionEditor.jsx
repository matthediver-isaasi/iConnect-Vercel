import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorContent, Node, mergeAttributes, useEditor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { Link } from "@tiptap/extension-link";
import { Underline } from "@tiptap/extension-underline";
import { AtSign, Bold, ChevronDown, ImagePlus, Italic, Link2, List, ListOrdered, Plus, Quote, Search, Smile, Strikethrough, Underline as UnderlineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { boardMentionOptions } from "./boardMentionHelpers.mjs";
import { safeDiscussionUrl, DISCUSSION_EMOJIS } from "./discussionFormat.mjs";
import "./discussion.css";

const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() { return { id: { default: null }, label: { default: "" } }; },
  parseHTML() { return [{ tag: "span[data-discussion-mention]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-discussion-mention": "", class: "discussion-mention" }), `@${HTMLAttributes.label}`];
  },
});

const CommentImage = Node.create({
  name: "commentImage",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() { return { attachmentId: { default: null } }; },
  parseHTML() { return [{ tag: "img[data-comment-attachment]" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, {
      "data-comment-attachment": HTMLAttributes.attachmentId || "",
      class: "discussion-image-token",
    }), "Attached image"];
  },
});

const safeLink = Link.configure({
  openOnClick: false,
  autolink: true,
  HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
  isAllowedUri: (url) => Boolean(safeDiscussionUrl(url)),
});

const emptyDoc = { type: "doc", content: [{ type: "paragraph" }] };
const types = [
  { name: "Link", description: "Connect readers to related content", icon: Link2 },
  { name: "Image", description: "Add an attachment-backed image", icon: ImagePlus },
  { name: "Mention", description: "Notify a board member", icon: AtSign },
  { name: "Emoji", description: "Insert an emoji in your message", icon: Smile },
  { name: "Quote", description: "Insert a quote or citation", icon: Quote },
];
const formatOptions = [
  { command: "bold", label: "Bold", icon: Bold, shortcut: "Ctrl B" },
  { command: "italic", label: "Italic", icon: Italic, shortcut: "Ctrl I" },
  { command: "underline", label: "Underline", icon: UnderlineIcon, shortcut: "Ctrl U" },
  { command: "strike", label: "Strikethrough", icon: Strikethrough, shortcut: "" },
];

export default function DiscussionEditor({
  initialDoc, initialText = "", members = [], disabled = false, onChange,
  onPasteImages, onChooseImage, editorRef, placeholder = "Write a comment…",
}) {
  const [menu, setMenu] = useState(false);
  const [formatMenu, setFormatMenu] = useState(false);
  const [listMenu, setListMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [insertPanel, setInsertPanel] = useState("");
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionTrigger, setMentionTrigger] = useState(null);
  const [mentionActive, setMentionActive] = useState(0);
  const fileRef = useRef(null);
  const savedSelection = useRef(null);
  const editorKeyHandler = useRef(null);
  const linkRange = useRef(null);
  const formatTrigger = useRef(null);
  const listTrigger = useRef(null);
  const menuId = useId();
  const memberOptions = useMemo(() => boardMentionOptions(members), [members]);
  const updateMentionTrigger = (current) => {
    const selection = current.state.selection;
    if (!selection.empty) { setMentionTrigger(null); return; }
    const $from = selection.$from;
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
    const match = before.match(/(?:^|\s)@([^@\n\r]*)$/);
    if (!match) { setMentionTrigger(null); return; }
    setMentionTrigger({
      from: selection.from - match[1].length - 1,
      to: selection.from,
      query: match[1],
    });
    setMentionActive(0);
  };
  const captureSelection = (state) => {
    if (!state) return;
    savedSelection.current = {
      from: state.selection.from,
      to: state.selection.to,
      anchor: state.selection.anchor,
      head: state.selection.head,
      storedMarks: state.storedMarks?.map((mark) => mark.toJSON()) ?? null,
    };
  };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ code: false, codeBlock: false, horizontalRule: false, link: false, underline: false }),
      Underline, safeLink, Mention, CommentImage,
    ],
    content: initialDoc || (initialText ? { type: "doc", content: initialText.split("\n").map((text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })) } : emptyDoc),
    editable: !disabled,
    editorProps: {
      attributes: { "aria-label": "Write a comment", "data-testid": "input-new-comment", class: "discussion-prose" },
      handlePaste: (_view, event) => onPasteImages?.(event) || false,
      // Mention selection must run before StarterKit's Enter/arrow keymaps.
      // A bubbling React handler is too late: Enter has already split the block.
      handleKeyDown: (view, event) => editorKeyHandler.current?.(view, event) || false,
      handleDOMEvents: { blur: (view) => { captureSelection(view.state); return false; } },
    },
    onUpdate: ({ editor: current }) => {
      onChange?.(current.getJSON(), current.getText());
      updateMentionTrigger(current);
    },
    onSelectionUpdate: ({ editor: current }) => {
      if (current.isFocused) captureSelection(current.state);
      updateMentionTrigger(current);
    },
  });
  useEffect(() => { if (editor && editorRef && typeof editorRef === "object") editorRef.current = editor; }, [editor, editorRef]);
  // Toggling posting state is not an author edit. TipTap otherwise emits an
  // update here, erasing errors and rotating the immutable retry request ID.
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    if (!disabled) return;
    setMenu(false); setFormatMenu(false); setListMenu(false);
    setInsertPanel(""); setMentionTrigger(null);
  }, [disabled]);
  const mentionMatches = mentionTrigger
    ? memberOptions.filter((member) => `${member.label} ${member.email}`.toLocaleLowerCase().includes(mentionTrigger.query.toLocaleLowerCase())) : [];
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    if (mentionTrigger) {
      dom.setAttribute("aria-autocomplete", "list");
      dom.setAttribute("aria-haspopup", "listbox");
      dom.setAttribute("aria-controls", `${menuId}-typed-mentions`);
      dom.setAttribute("aria-expanded", "true");
      if (mentionMatches.length) dom.setAttribute("aria-activedescendant", `${menuId}-typed-${mentionActive}`);
      else dom.removeAttribute("aria-activedescendant");
    } else {
      dom.removeAttribute("aria-autocomplete");
      dom.removeAttribute("aria-haspopup");
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-expanded");
      dom.removeAttribute("aria-activedescendant");
    }
  }, [editor, mentionTrigger, mentionMatches.length, mentionActive, menuId]);
  useEffect(() => {
    if (!mentionTrigger || !mentionMatches.length) return;
    document.getElementById(`${menuId}-typed-${mentionActive}`)?.scrollIntoView?.({ block: "nearest" });
  }, [mentionTrigger, mentionMatches.length, mentionActive, menuId]);

  const stashSelection = () => {
    if (editor) captureSelection(editor.state);
  };
  const restore = () => {
    if (!editor || !savedSelection.current) return;
    const saved = savedSelection.current;
    const docSize = editor.state.doc.content.size;
    const anchor = Math.max(1, Math.min(saved.anchor, docSize));
    const head = Math.max(1, Math.min(saved.head, docSize));
    const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head))
      .setStoredMarks(saved.storedMarks?.map((mark) => editor.schema.marks[mark.type].create(mark.attrs)) || null);
    editor.view.dispatch(tr);
    editor.view.focus();
  };
  const openPanel = (name) => {
    stashSelection();
    if (name === "Link" && editor) {
      const selection = editor.state.selection;
      let existing = null;
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((item) => item.type.name === "link");
        if (!mark) return;
        const end = pos + node.nodeSize;
        const overlaps = selection.empty
          ? selection.from >= pos && selection.from <= end
          : end > selection.from && pos < selection.to;
        if (overlaps) existing = { from: pos, to: end, href: mark.attrs.href };
      });
      linkRange.current = existing;
      setLinkValue(existing?.href || editor.getAttributes("link").href || "");
    } else {
      linkRange.current = null;
    }
    setMenu(false);
    setInsertPanel(name);
    setFormatMenu(false);
    setListMenu(false);
    setQuery("");
    setLinkError("");
    if (name !== "Link") setLinkValue("");
  };
  const insert = (name) => {
    setMenu(false);
    setInsertPanel("");
    if (name === "Link") { openPanel("Link"); return; }
    if (name === "Image") { fileRef.current?.click(); return; }
    if (name === "Mention") { openPanel("Mention"); return; }
    if (name === "Emoji") { openPanel("Emoji"); return; }
    if (name === "Quote") {
      restore();
      editor?.chain().focus().toggleBlockquote().run();
    }
  };
  const applyLink = () => {
    const href = safeDiscussionUrl(linkValue);
    if (!href) { setLinkError("Use a safe https://, http:// or mailto: link."); return; }
    const existingRange = linkRange.current;
    if (existingRange) {
      editor?.chain().focus().setTextSelection({ from: existingRange.from, to: existingRange.to }).setLink({ href }).run();
    } else if (savedSelection.current && savedSelection.current.from !== savedSelection.current.to) {
      restore();
      editor?.chain().focus().setLink({ href }).run();
    } else {
      restore();
      editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    }
    linkRange.current = null;
    setInsertPanel("");
  };
  const runFormat = (command, returnFocus = false) => {
    restore();
    const chain = editor?.chain().focus();
    if (!chain) return;
    if (command === "bold") chain.toggleBold().run();
    if (command === "italic") chain.toggleItalic().run();
    if (command === "underline") chain.toggleUnderline().run();
    if (command === "strike") chain.toggleStrike().run();
    setFormatMenu(false);
    if (returnFocus) formatTrigger.current?.focus();
  };
  const runList = (kind, returnFocus = false) => {
    restore();
    const chain = editor?.chain().focus();
    if (kind === "bullet") chain?.toggleBulletList().run();
    if (kind === "ordered") chain?.toggleOrderedList().run();
    setListMenu(false);
    if (returnFocus) listTrigger.current?.focus();
  };
  const closeMenuOnEscape = (event, close, trigger) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(false);
      trigger.current?.focus();
    }
  };
  const chooseMention = (member, range = mentionTrigger) => {
    if (!editor || !range) return;
    editor.chain().focus().deleteRange({ from: range.from, to: range.to })
      .insertContent({ type: "mention", attrs: { id: member.id, label: member.label } })
      .insertContent(" ").run();
    setMentionTrigger(null);
    setInsertPanel("");
  };
  const onComposerKeyDown = (event) => {
    if (disabled) return;
    if (event.key === "Escape") {
      if (insertPanel || menu || formatMenu || listMenu || mentionTrigger) event.stopPropagation();
      if (insertPanel) { event.preventDefault(); setInsertPanel(""); return; }
      if (menu) { event.preventDefault(); setMenu(false); return; }
      if (formatMenu) { event.preventDefault(); setFormatMenu(false); formatTrigger.current?.focus(); return; }
      if (listMenu) { event.preventDefault(); setListMenu(false); listTrigger.current?.focus(); return; }
      if (mentionTrigger) { event.preventDefault(); event.stopPropagation(); setMentionTrigger(null); return; }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault(); openPanel("Link");
      return;
    }
    // Bold/italic/underline/strike shortcuts belong to ProseMirror's keymap.
    // Repeating them in a bubbling React handler can toggle the mark twice.
  };
  editorKeyHandler.current = (_view, event) => {
    if (!mentionTrigger || !mentionMatches.length) return false;
    if (event.key === "ArrowDown") {
      setMentionActive(index => (index + 1) % mentionMatches.length); return true;
    }
    if (event.key === "ArrowUp") {
      setMentionActive(index => (index - 1 + mentionMatches.length) % mentionMatches.length); return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      chooseMention(mentionMatches[mentionActive] || mentionMatches[0]); return true;
    }
    return false;
  };
  const filtered = types.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const matches = memberOptions.filter((member) => `${member.label} ${member.email}`.toLowerCase().includes(mentionQuery.toLowerCase()));
  return <div className="discussion-editor" data-discussion-popup-open={Boolean(menu || formatMenu || listMenu || insertPanel || mentionTrigger)}
    onKeyDown={onComposerKeyDown}>
    <div className="discussion-toolbar" aria-label="Comment formatting" onFocusCapture={stashSelection}>
      <label className="sr-only" htmlFor={`${menuId}-style`}>Text style</label>
      <select id={`${menuId}-style`} aria-label="Text style" disabled={disabled} value={editor?.isActive("heading") ? String(editor.getAttributes("heading").level) : "paragraph"} onMouseDown={stashSelection}
        onChange={(event) => {
          restore();
          if (event.target.value === "paragraph") editor?.chain().focus().setParagraph().run();
          else editor?.chain().focus().toggleHeading({ level: Number(event.target.value) }).run();
        }}>
        <option value="paragraph">Text</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option>
      </select>
      <span className="discussion-divider" />
      <div className="relative">
        <Button ref={formatTrigger} type="button" size="sm" variant="ghost" disabled={disabled}
          aria-label="Formatting options" aria-haspopup="menu" aria-expanded={formatMenu}
          className="h-7 gap-1 px-2 text-xs" onMouseDown={(event) => { event.preventDefault(); stashSelection(); }}
          onClick={() => { setFormatMenu((value) => !value); setListMenu(false); }}>
          Format <ChevronDown className="h-3 w-3" />
        </Button>
        {formatMenu && <div role="menu" aria-label="Formatting options" className="discussion-toolbar-menu"
          onKeyDown={(event) => closeMenuOnEscape(event, setFormatMenu, formatTrigger)}>
          {formatOptions.map(({ command, label, icon: Icon, shortcut }, index) =>
            <button type="button" autoFocus={index === 0} role="menuitemcheckbox" aria-checked={Boolean(editor?.isActive(command))} key={command}
              onMouseDown={(event) => event.preventDefault()} onClick={() => runFormat(command, true)}>
              <Icon className="h-3.5 w-3.5" />{label}<kbd>{shortcut}</kbd>
            </button>)}
        </div>}
      </div>
      <span className="discussion-divider" />
      <div className="relative">
        <Button ref={listTrigger} type="button" size="sm" variant="ghost" disabled={disabled}
          aria-label="List options" aria-haspopup="menu" aria-expanded={listMenu}
          className="h-7 gap-1 px-2 text-xs" onMouseDown={(event) => { event.preventDefault(); stashSelection(); }}
          onClick={() => { setListMenu((value) => !value); setFormatMenu(false); }}>
          Lists <ChevronDown className="h-3 w-3" />
        </Button>
        {listMenu && <div role="menu" aria-label="List options" className="discussion-toolbar-menu"
          onKeyDown={(event) => closeMenuOnEscape(event, setListMenu, listTrigger)}>
          <button type="button" autoFocus role="menuitemcheckbox" aria-checked={Boolean(editor?.isActive("bulletList"))} onMouseDown={(event) => event.preventDefault()} onClick={() => runList("bullet", true)}><List className="h-4 w-4" />Bulleted list</button>
          <button type="button" role="menuitemcheckbox" aria-checked={Boolean(editor?.isActive("orderedList"))} onMouseDown={(event) => event.preventDefault()} onClick={() => runList("ordered", true)}><ListOrdered className="h-4 w-4" />Numbered list</button>
        </div>}
      </div>
      {editor?.isActive("link") && <ToolbarButton label="Remove link" disabled={disabled} onMouseDown={stashSelection} onClick={() => { restore(); editor.chain().focus().extendMarkRange("link").unsetLink().run(); }}><Link2 /></ToolbarButton>}
      <div className="relative ml-auto">
        <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-expanded={menu} aria-haspopup="dialog" aria-controls={menuId} onMouseDown={(event) => { event.preventDefault(); stashSelection(); }} onClick={() => { setMenu((value) => !value); setInsertPanel(""); setFormatMenu(false); setListMenu(false); }} className="h-8 gap-1.5"><Plus className="h-4 w-4" />Insert<ChevronDown className="h-3 w-3" /></Button>
        {menu && <div id={menuId} className="discussion-insert-menu" role="dialog" aria-label="Insert into comment">
          <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input autoFocus aria-label="Search insert options" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" onKeyDown={(event) => { if (event.key === "Escape") setMenu(false); if (event.key === "Enter" && filtered[0]) insert(filtered[0].name); }} /></div>
          {filtered.map(({ name, description, icon: Icon }) => <button type="button" key={name} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(name)} className="discussion-insert-option"><span className="discussion-insert-icon"><Icon /></span><span><strong>{name}</strong><small>{description}</small></span></button>)}
          {!filtered.length && <p role="status" className="p-4 text-sm text-muted-foreground">No matching insert options.</p>}
        </div>}
      </div>
      <input ref={fileRef} type="file" disabled={disabled} accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" aria-label="Choose image" onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onChooseImage?.(file);
        event.target.value = "";
      }} />
    </div>
    {insertPanel && <div className="discussion-panel">
      {insertPanel === "Link" && <div className="flex flex-wrap gap-2">
        <input aria-label="Link URL" autoFocus value={linkValue} onChange={(event) => setLinkValue(event.target.value)} placeholder="https://example.com" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applyLink(); } if (event.key === "Escape") setInsertPanel(""); }} />
        <Button size="sm" type="button" onClick={applyLink}>Save link</Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setInsertPanel("")}>Cancel</Button>
        {linkError && <p role="alert" className="w-full text-xs text-destructive">{linkError}</p>}
      </div>}
      {insertPanel === "Mention" && <div>
        <input aria-label="Search board members" autoFocus value={mentionQuery} onChange={(event) => { setMentionQuery(event.target.value); setMentionActive(0); }}
          placeholder="Find a board member…" onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); setInsertPanel(""); restore(); }
            else if (matches.length && event.key === "ArrowDown") { event.preventDefault(); setMentionActive((index) => (index + 1) % matches.length); }
            else if (matches.length && event.key === "ArrowUp") { event.preventDefault(); setMentionActive((index) => (index - 1 + matches.length) % matches.length); }
            else if (matches.length && event.key === "Enter") { event.preventDefault(); restore(); chooseMention(matches[mentionActive], savedSelection.current); }
          }} />
        <div className="discussion-mention-list" role="listbox" aria-label="Board members" onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setInsertPanel(""); restore(); }
          else if (matches.length && event.key === "ArrowDown") { event.preventDefault(); setMentionActive((index) => (index + 1) % matches.length); }
          else if (matches.length && event.key === "ArrowUp") { event.preventDefault(); setMentionActive((index) => (index - 1 + matches.length) % matches.length); }
          else if (matches.length && event.key === "Enter") { event.preventDefault(); restore(); chooseMention(matches[mentionActive], savedSelection.current); }
        }}>
          {matches.map((member, index) => <button type="button" role="option" key={member.id} aria-selected={index === mentionActive} onMouseDown={(event) => event.preventDefault()} onClick={() => {
            restore(); chooseMention(member, savedSelection.current);
          }}><AtSign className="h-4 w-4" />{member.label}</button>)}
          {!matches.length && <p role="status" className="p-3 text-sm text-muted-foreground">No matching board members.</p>}
        </div>
      </div>}
      {insertPanel === "Emoji" && <div className="flex gap-1" aria-label="Inline emoji">
        {DISCUSSION_EMOJIS.map((emoji) => <button type="button" key={emoji} aria-label={`Insert ${emoji}`} className="discussion-emoji" onMouseDown={(event) => event.preventDefault()} onClick={() => { restore(); editor?.chain().focus().insertContent(emoji).run(); setInsertPanel(""); }}>{emoji}</button>)}
      </div>}
    </div>}
    <EditorContent editor={editor} className="discussion-content" />
    {mentionTrigger && <div id={`${menuId}-typed-mentions`} role="listbox" aria-label="Mention a board member" className="discussion-typed-mentions">
      {mentionMatches.map((member, index) => <button type="button" role="option" id={`${menuId}-typed-${index}`} key={member.id}
        aria-selected={index === mentionActive} onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setMentionActive(index)} onClick={() => chooseMention(member)}>
        <AtSign className="h-4 w-4" /><span>{member.label}</span>{member.email !== member.label && <small>{member.email}</small>}
      </button>)}
      {!mentionMatches.length && <p role="status">No matching board members.</p>}
      <small>↑ ↓ to browse · Enter to mention · Esc to close</small>
    </div>}
  </div>;
}

function ToolbarButton({ label, active, disabled, onClick, onMouseDown, children }) {
  const Icon = children.type;
  return <button type="button" title={label} aria-label={label} aria-pressed={Boolean(active)} disabled={disabled}
    onMouseDown={(event) => { event.preventDefault(); onMouseDown?.(); }} onClick={onClick} className={`discussion-tool${active ? " is-active" : ""}`}><Icon aria-hidden="true" /></button>;
}
