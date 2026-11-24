import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CornerDownRight, Loader2, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import * as projectBoardCache from "@/lib/projectBoardCache";
import DiscussionEditor from "./DiscussionEditor";
import { discussionText, legacyDiscussionDoc } from "./discussionFormat.mjs";
import { pastedImages, uploadPastedImage } from "./projectPastedImages";

const emptyDraft = () => ({ doc: null, text: "", images: [], requestId: null, busy: false, error: "" });
const draftText = (draft) => draft.doc ? discussionText(draft.doc) : draft.text;
const fileTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const collectMentions = (node, into = []) => {
  if (node?.type === "mention" && node.attrs?.id && !into.includes(node.attrs.id)) into.push(node.attrs.id);
  (node?.content || []).forEach((child) => collectMentions(child, into));
  return into;
};
const collectImageIds = (node, into = []) => {
  if (node?.type === "commentImage" && node.attrs?.attachmentId) into.push(String(node.attrs.attachmentId));
  (node?.content || []).forEach((child) => collectImageIds(child, into));
  return into;
};
function Preview({ image, onRemove, disabled }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!image.file) return undefined;
    const objectUrl = URL.createObjectURL(image.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image.file]);
  const previewUrl = url || image.attachment?.url;
  return <div className="relative h-16 w-20 overflow-hidden rounded-md border bg-muted">
    {previewUrl && <img src={previewUrl} alt={`Preview ${image.file?.name || image.attachment?.name || "comment image"}`} className="h-full w-full object-cover" />}
    <button type="button" aria-label={`Remove image ${image.file?.name || image.attachment?.name || "comment image"}`} disabled={disabled} onClick={onRemove}
      className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-background/90 text-foreground shadow"><X className="h-3 w-3" /></button>
  </div>;
}

/**
 * Shared compact composer for top-level comments, replies and author edits.
 * Draft state is keyed by card/thread/comment by the caller and survives failures.
 */
export default function ActivityComposer({
  cardId, boardId, members = [], drafts, refresh, mode = "create", targetComment,
  onCancel, onSuccess, placeholder, compact = false,
}) {
  const client = useQueryClient();
  const draftKey = `${cardId}:${mode}:${targetComment?.id || targetComment?.parent_comment_id || "root"}`;
  const [seedDraft] = useState(() => {
    const saved = drafts.get(draftKey);
    if (saved) return saved;
    if (mode !== "edit") return emptyDraft();
    const initialDoc = legacyDiscussionDoc(targetComment);
    const images = (targetComment?.images || []).flatMap((item) => item?.attachment
      ? [{ id: String(item.attachment.id), attachment: item.attachment, stage: "Attached" }] : []);
    return { ...emptyDraft(), doc: initialDoc, text: targetComment?.content || "", images };
  });
  const draft = useRef(seedDraft);
  if (!drafts.has(draftKey)) drafts.set(draftKey, draft.current);
  const imageNodeTracking = useRef(collectImageIds(draft.current.doc));
  const [, render] = useState(0);
  const [editorRevision, setEditorRevision] = useState(0);
  const editorRef = useRef(null);
  const notify = useCallback(() => render((value) => value + 1), []);
  const update = (patch) => {
    Object.assign(draft.current, patch);
    drafts.set(draftKey, draft.current);
    notify();
  };
  const edit = (patch) => update({ ...patch, requestId: null, error: "" });
  const receivePaste = (event) => {
    if (draft.current.busy || event.defaultPrevented) return false;
    try {
      const incoming = pastedImages(event, draft.current.images.length);
      if (incoming.length) edit({ images: [...draft.current.images, ...incoming] });
      return Boolean(incoming.length);
    } catch (error) { update({ error: error.message }); return true; }
  };
  const addFile = (file) => {
    if (draft.current.busy) return;
    if (!fileTypes.has(file.type) || !file.size || file.size > 104857600) {
      update({ error: "Choose PNG, JPEG, GIF or WebP images, up to 100MB each." });
      return;
    }
    if (draft.current.images.length >= 10) {
      update({ error: "You can include up to 10 images." });
      return;
    }
    edit({ images: [...draft.current.images, { id: crypto.randomUUID(), file, stage: "Ready to upload" }] });
  };
  const removeImage = (image) => {
    const nextImages = draft.current.images.filter((item) => item.id !== image.id);
    edit({ images: nextImages });
    const editor = editorRef.current;
    if (!editor) return;
    const removeNode = (node) => {
      if (!node?.content) return node;
      return {
        ...node,
        content: node.content.filter((child) =>
          !(child.type === "commentImage" && String(child.attrs?.attachmentId) === String(image.attachment?.id))
        ).map(removeNode),
      };
    };
    editor.commands.setContent(removeNode(editor.getJSON()));
  };
  const submit = async () => {
    const current = draft.current;
    const text = draftText(current);
    if (current.busy || (!text.trim() && !current.images.length && mode !== "edit")) return;
    if (mode === "edit" && !text.trim() && !current.images.length) {
      update({ error: "A comment must contain text or an image." });
      return;
    }
    const requestId = current.requestId || crypto.randomUUID();
    update({ busy: true, error: "", requestId });
    try {
      const attachmentIds = [];
      for (const image of current.images) {
        let attachment = image.attachment;
        if (!attachment && image.file) {
          const progress = (stage) => { image.stage = stage; update({}); };
          attachment = await uploadPastedImage(cardId, image, progress);
          image.attachment = attachment;
          await projectBoardCache.publishProjectCardUpdate?.(client, cardId, {}, { attachment });
        }
        if (attachment?.id) attachmentIds.push(attachment.id);
      }
      let doc = structuredClone(current.doc || { type: "doc", content: [{ type: "paragraph" }] });
      const originalImageIds = collectImageIds(doc);
      const retainedIds = new Set([
        ...current.images.filter((image) => image.attachment?.id).map((image) => String(image.attachment.id)),
        ...attachmentIds.map(String),
      ]);
      const pruneRemovedImages = (node) => {
        if (!node?.content) return node;
        return { ...node, content: node.content.filter((child) =>
          child.type !== "commentImage" || retainedIds.has(String(child.attrs?.attachmentId))
        ).map(pruneRemovedImages) };
      };
      doc = pruneRemovedImages(doc);
      const newlyUploadedIds = current.images.filter((image) => image.file && image.attachment?.id)
        .map((image) => String(image.attachment.id));
      const newImageIds = newlyUploadedIds.filter((id) => !originalImageIds.includes(id));
      if (newImageIds.length) {
        const paragraph = [...(doc.content || [])].reverse().find((node) => node.type === "paragraph");
        const target = paragraph || { type: "paragraph", content: [] };
        target.content = [...(target.content || []), ...newImageIds.map((attachmentId) => ({
          type: "commentImage", attrs: { attachmentId },
        }))];
        if (!paragraph) doc.content = [...(doc.content || []), target];
      }
      const content = discussionText(doc);
      let result;
      if (mode === "edit") {
        const retainedAttachmentIds = [
          ...collectImageIds(doc),
          ...current.images.filter((image) => image.attachment?.id).map((image) => String(image.attachment.id)),
        ];
        result = await apiRequest("PATCH", `/api/projects/cards/${cardId}/comments`, {
          commentId: targetComment.id, content, richContent: { version: 1, doc }, attachmentIds: [...new Set(retainedAttachmentIds)],
        });
      } else {
        result = await apiRequest("POST", `/api/projects/cards/${cardId}/comments`, {
          content,
          mentionIdentityIds: collectMentions(doc),
          attachmentIds,
          requestId,
          richContent: { version: 1, doc },
          ...(mode === "reply" ? { replyToCommentId: targetComment.id } : {}),
        });
      }
      await projectBoardCache.publishProjectDiscussion(client, boardId, cardId, result);
      drafts.delete(draftKey);
      draft.current = emptyDraft();
      setEditorRevision((value) => value + 1);
      notify();
      void refresh?.();
      onSuccess?.(result);
    } catch (error) {
      update({ error: error.message || `Could not ${mode === "edit" ? "save" : "post"} comment. Your draft is kept; try again.` });
    } finally {
      update({ busy: false });
    }
  };
  const current = draft.current;
  const isEdit = mode === "edit";
  const canSubmit = Boolean(draftText(current).trim() || current.images.length);
  return <div className={`discussion-composer${compact ? " is-compact" : ""}`} data-discussion-mode={mode}>
    {mode === "reply" && <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><CornerDownRight className="h-3.5 w-3.5" />Replying to <strong className="text-foreground">{targetComment?.author?.name || [targetComment?.author?.first_name, targetComment?.author?.last_name].filter(Boolean).join(" ") || targetComment?.reply_to_name || "Board member"}</strong></div>}
    <DiscussionEditor key={`${draftKey}:${editorRevision}`} initialDoc={current.doc} initialText={current.text} members={members}
      disabled={current.busy} placeholder={placeholder || (isEdit ? "Edit your comment…" : "Write a comment…")}
      onChange={(doc, text) => {
        // Store only the editable document. Server URLs never enter draft or persisted JSON.
        const imageIds = collectImageIds(doc);
        const removedNodeIds = new Set(imageNodeTracking.current.filter((id) => !imageIds.includes(id)));
        imageNodeTracking.current = imageIds;
        edit({
          doc, text,
          ...(removedNodeIds.size ? {
            images: draft.current.images.filter((image) =>
              !removedNodeIds.has(String(image.attachment?.id))),
          } : {}),
        });
      }} onPasteImages={receivePaste} onChooseImage={addFile} editorRef={editorRef} />
    {current.images.length > 0 && <div className="mt-2 flex flex-wrap gap-2">
      {current.images.map((image) => <div key={image.id} className="space-y-1">
        <Preview image={image} disabled={current.busy} onRemove={() => removeImage(image)} />
        <span className="block max-w-20 truncate text-[10px] text-muted-foreground">{image.stage}</span>
      </div>)}
      <p className="basis-full text-[11px] text-muted-foreground">Images are stored as task attachments and linked only when submitted.</p>
    </div>}
    {isEdit && (targetComment?.images || []).length > 0 && !current.images.length && <p className="mt-2 text-xs text-muted-foreground">Existing comment images are retained unless removed from the attachment list.</p>}
    {current.error && <p role="alert" className="mt-2 text-xs text-destructive">{current.error}</p>}
    <div className="mt-2 flex justify-end gap-2">
      {onCancel && <Button type="button" size="sm" variant="ghost" disabled={current.busy} onClick={() => {
        drafts.delete(draftKey);
        onCancel();
      }}><X className="mr-1 h-3.5 w-3.5" />Cancel</Button>}
      <Button type="button" size="sm" data-testid={isEdit ? "button-save-comment-edit" : "button-add-comment"} disabled={current.busy || !canSubmit} onClick={submit} className="gap-1.5">
        {current.busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />{isEdit ? "Saving…" : "Posting…"}</> : isEdit ? <><Check className="h-3.5 w-3.5" />Save</> : <><Send className="h-3.5 w-3.5" />{current.error ? "Retry" : mode === "reply" ? "Reply" : "Submit"}</>}
      </Button>
    </div>
  </div>;
}
