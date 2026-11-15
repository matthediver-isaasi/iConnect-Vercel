import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { publishProjectCardComment, publishProjectCardUpdate } from "@/lib/projectBoardCache";
import { invalidateInboxViews } from "@/lib/inboxSources.mjs";
import BoardMentionTextarea from "./BoardMentionTextarea";
import { mentionIdentityIds } from "./boardMentionHelpers.mjs";

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const emptyDraft = () => ({ content: "", mentions: [], images: [], requestId: null, busy: false, error: "" });

function Preview({ image }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(image.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image.file]);
  return <img src={url || undefined} alt={`Preview ${image.file.name}`} className="h-24 max-w-full rounded border object-contain" />;
}

// Draft ownership is explicit, including callbacks after switching cards.
// Unsent images remain local. Confirmed uploads are ordinary task attachments:
// cancelling a draft never silently deletes a file another comment might use.
export default function ActivityComposer({ cardId, boardId, members, drafts, refresh }) {
  const client = useQueryClient();
  const draft = useRef(drafts.get(cardId) || emptyDraft());
  const [, render] = useState(0);
  const update = (patch) => {
    Object.assign(draft.current, patch);
    drafts.set(cardId, draft.current);
    draft.current.notify?.();
  };
  useEffect(() => {
    const notify = () => render(value => value + 1);
    draft.current.notify = notify;
    return () => {
      if (draft.current.notify === notify) delete draft.current.notify;
    };
  }, []);
  const edit = patch => update({ ...patch, requestId: null, error: "" });
  const paste = event => {
    if (draft.current.busy || event.defaultPrevented) return;
    // Use items OR files, never both: browsers expose the same image in both.
    const clipboard = event.clipboardData;
    const items = Array.from(clipboard?.items || []);
    const files = items.length
      ? items.filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean)
      : Array.from(clipboard?.files || []);
    const images = files.filter(file => file.type.startsWith("image/"));
    if (!images.length) return; // Native plain text / mention paste is unchanged.
    if (!clipboard.getData("text/plain")) event.preventDefault();
    if (images.some(file => !imageTypes.has(file.type) || !file.size || file.size > 104857600)) {
      update({ error: "Choose PNG, JPEG, GIF or WebP images, up to 100MB each." });
      return;
    }
    if (draft.current.images.length + images.length > 10) {
      update({ error: "You can include up to 10 images per comment." });
      return;
    }
    edit({ images: [...draft.current.images, ...images.map(file => ({
      id: crypto.randomUUID(), file, stage: "Ready to upload",
    }))] });
  };
  const submit = async () => {
    const current = draft.current;
    if (current.busy || (!current.content.trim() && !current.images.length)) return;
    update({ busy: true, error: "", requestId: current.requestId || crypto.randomUUID() });
    try {
      for (const image of current.images) {
        if (image.attachment) continue;
        const progress = stage => { image.stage = stage; update({}); };
        if (!image.upload) {
          progress("Preparing upload…");
          image.upload = await apiRequest("POST", `/api/projects/cards/${cardId}/attachments`, {
            fileName: image.file.name || "screenshot.png", fileSize: image.file.size,
            mimeType: image.file.type, purpose: "activity",
          });
        }
        if (!image.uploaded) {
          progress("Uploading image…");
          try {
            const response = await fetch(image.upload.signedUrl, {
              method: "PUT", headers: { "Content-Type": image.file.type }, body: image.file,
            });
            if (!response.ok) throw new Error("Image upload failed. Retry to keep your draft.");
          } catch (error) {
            // A PUT response may be lost after storage accepted it. Confirmation
            // verifies the stored object, so retries need not overwrite it.
            try {
              const recovered = await apiRequest("POST", `/api/projects/cards/${cardId}/attachments/confirm`,
                { uploadToken: image.upload.uploadToken });
              image.attachment = recovered.attachment;
            } catch (confirmError) {
              if (/expired/i.test(confirmError.message)) image.upload = null;
              throw error;
            }
          }
          image.uploaded = true;
        }
        progress("Confirming upload…");
        let confirmed;
        try {
          confirmed = image.attachment ? { attachment: image.attachment } : await apiRequest("POST", `/api/projects/cards/${cardId}/attachments/confirm`,
            { uploadToken: image.upload.uploadToken });
        } catch (error) {
          if (/expired/i.test(error.message)) {
            // Expired unconfirmed objects are handled by the durable cleanup
            // ledger. A fresh signed upload can be requested on explicit retry.
            image.upload = null;
            image.uploaded = false;
          }
          throw error;
        }
        image.attachment = confirmed.attachment;
        await publishProjectCardUpdate(client, cardId, {}, { attachment: image.attachment });
        progress("Uploaded");
      }
      const result = await apiRequest("POST", `/api/projects/cards/${cardId}/comments`, {
        content: current.content,
        mentionIdentityIds: mentionIdentityIds(current.content, current.mentions, members),
        attachmentIds: current.images.map(image => image.attachment.id),
        requestId: current.requestId,
      });
      await publishProjectCardComment(client, boardId, cardId, result.comment);
      update(emptyDraft());
      void invalidateInboxViews(client, boardId);
      void refresh();
    } catch (error) {
      update({ error: error.message || "Could not post comment. Your draft is kept; try again." });
    } finally {
      update({ busy: false });
    }
  };
  const current = draft.current;
  return <div className="mb-6 space-y-2">
    <BoardMentionTextarea aria-label="Write a comment" data-testid="input-new-comment"
      value={current.content} disabled={current.busy} onChange={content => edit({ content })}
      mentions={current.mentions} onMentionsChange={mentions => edit({ mentions })} members={members}
      onPaste={paste} placeholder="Write a comment or paste a screenshot..." rows={3} className="bg-background" />
    {current.images.length > 0 && <>
      <div className="flex flex-wrap gap-3">{current.images.map(image => <div key={image.id} className="max-w-40 space-y-1">
        <Preview image={image} />
        <p role="status" className="text-xs text-muted-foreground">{image.stage}</p>
        <Button type="button" size="sm" variant="ghost" disabled={current.busy}
          aria-label={`Remove image ${image.file.name}`}
          onClick={() => edit({ images: current.images.filter(item => item.id !== image.id) })}>Remove</Button>
      </div>)}</div>
      <p className="text-xs text-muted-foreground">Images upload when you submit. Uploaded files remain in task Attachments if you remove them here.</p>
    </>}
    {current.error && <p role="alert" className="text-sm text-destructive">{current.error}</p>}
    <div className="flex justify-end"><Button size="sm" data-testid="button-add-comment"
      disabled={current.busy || (!current.content.trim() && !current.images.length)}
      onClick={submit}>{current.busy ? "Posting…" : current.error ? "Retry" : "Submit"}</Button></div>
  </div>;
}
