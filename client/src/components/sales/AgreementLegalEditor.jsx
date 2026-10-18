import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Node } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, tableEditing } from "prosemirror-tables";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PARTNERSHIP_TERMS_HTML } from "./partnershipTerms";
import { LegalContent } from "./AgreementDocument";

// Table support on the already installed TipTap/ProseMirror stack. Restricted
// schema keeps the legal document portable to PDF and public preview.
const Table = Node.create({
  name: "table", group: "block", content: "tableRow+", tableRole: "table", isolating: true,
  parseHTML: () => [{ tag: "table" }], renderHTML: () => ["table", ["tbody", 0]],
  extendNodeSchema: extension => ({ tableRole: extension.config.tableRole }),
  addProseMirrorPlugins: () => [tableEditing()],
});
const Row = Node.create({ name: "tableRow", content: "(tableCell | tableHeader)+", tableRole: "row", parseHTML: () => [{ tag: "tr" }], renderHTML: () => ["tr", 0] });
const cellAttributes = () => ({ colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } });
const Cell = Node.create({ name: "tableCell", content: "block+", tableRole: "cell", isolating: true, addAttributes: cellAttributes, parseHTML: () => [{ tag: "td" }], renderHTML: ({ HTMLAttributes }) => ["td", HTMLAttributes, 0] });
const Header = Cell.extend({ name: "tableHeader", tableRole: "header_cell", parseHTML: () => [{ tag: "th" }], renderHTML: ({ HTMLAttributes }) => ["th", HTMLAttributes, 0] });

export default function AgreementLegalEditor({ value, onChange, disabled, fields = [] }) {
  const change = useRef(onChange);
  change.current = onChange;
  const [confirmTemplate, setConfirmTemplate] = useState(false);
  const [preview, setPreview] = useState(false);
  const editor = useEditor({
    extensions: [StarterKit, Table, Row, Cell, Header],
    content: value || "", editable: !disabled,
    editorProps: { attributes: { "aria-label": "Legal agreement editor", class: "min-h-[240px] p-4 outline-none" } },
    onUpdate: ({ editor: current }) => change.current(current.getHTML()),
  });
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => {
    if (editor && editor.getHTML() !== (value || "")) editor.commands.setContent(value || "", { emitUpdate: false });
  }, [editor, value]);
  const action = (label, run, active = false) => <Button key={label} type="button" size="sm" variant={active ? "secondary" : "ghost"} disabled={disabled || !editor} onClick={run}>{label}</Button>;
  const command = fn => { if (editor) { editor.commands.focus(); fn(editor.state, editor.view.dispatch); } };
  return <section className="space-y-4">
    <label className="flex items-start gap-3 rounded-lg border p-4 text-sm"><Checkbox disabled={disabled} checked={Boolean(value)} onCheckedChange={checked => onChange(checked ? "<h2>Agreement terms</h2><p></p>" : "")} /><span><strong className="block">Include a two-party agreement</strong><span className="text-muted-foreground">Add legal terms after the quote. Both parties sign the same version. Leave off for a legacy quote.</span></span></label>
    {Boolean(value) && <>
      <div className="flex flex-wrap items-center justify-between gap-2"><Label>Legal agreement</Label><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setConfirmTemplate(true)}>Insert standard partnership terms</Button><Button type="button" size="sm" variant="outline" onClick={() => setPreview(!preview)}>{preview ? "Edit terms" : "Preview terms"}</Button></div></div>
      {confirmTemplate && <div role="alertdialog" aria-label="Insert approved partnership terms" className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm"><p>Insert the supplied agreement’s standard clauses 3–16, including its cancellation table, at the end of this document. Customer-specific details, benefits, fees, dates and signatures are excluded. These terms name Graduate Futures Institute (GFI); check they apply before sending. Any edits should receive your normal legal approval.</p><div className="flex gap-2"><Button type="button" size="sm" disabled={disabled || !editor} onClick={() => { editor.chain().focus("end").insertContent(PARTNERSHIP_TERMS_HTML).run(); setConfirmTemplate(false); }}>Insert approved clauses</Button><Button type="button" size="sm" variant="outline" onClick={() => setConfirmTemplate(false)}>Cancel</Button></div></div>}
      {!preview && <div className="rounded-lg border">
        <div className="flex flex-wrap gap-1 border-b bg-muted/30 p-1">
          {action("Bold", () => editor.chain().focus().toggleBold().run(), editor?.isActive("bold"))}
          {action("Italic", () => editor.chain().focus().toggleItalic().run(), editor?.isActive("italic"))}
          {[2, 3].map(level => action(`Heading ${level}`, () => editor.chain().focus().toggleHeading({ level }).run(), editor?.isActive("heading", { level })))}
          {action("Bullet list", () => editor.chain().focus().toggleBulletList().run())}
          {action("Numbered list", () => editor.chain().focus().toggleOrderedList().run())}
          {action("Insert table", () => editor.chain().focus().insertContent("<table><tr><th><p>Heading</p></th><th><p>Heading</p></th></tr><tr><td><p></p></td><td><p></p></td></tr></table>").run())}
          {editor?.isActive("table") && <>{action("Add row", () => command(addRowAfter))}{action("Add column", () => command(addColumnAfter))}{action("Delete row", () => command(deleteRow))}{action("Delete column", () => command(deleteColumn))}{action("Delete table", () => command(deleteTable))}</>}
        </div>
        {fields.length > 0 && <div className="flex flex-wrap items-center gap-1 border-b p-2"><span className="mr-1 text-xs text-muted-foreground">Insert current quote value:</span>{fields.map(field => <Button key={field.label} type="button" size="sm" variant="outline" disabled={disabled || !editor || !field.value} onClick={() => editor.chain().focus().insertContent({ type: "text", text: String(field.value) }).run()}>{field.label}</Button>)}</div>}
        <EditorContent editor={editor} className="prose prose-sm max-w-none overflow-x-auto [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:bg-muted [&_th]:p-2" />
      </div>}
      {preview && <div className="rounded-lg border p-4"><LegalContent html={value} /></div>}
      <p className="text-xs text-muted-foreground">Inserted quote values are snapshots, not live placeholders. Review the complete document after any pricing or contact changes.</p>
    </>}
  </section>;
}
