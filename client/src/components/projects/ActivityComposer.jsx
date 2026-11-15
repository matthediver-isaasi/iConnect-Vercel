import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { publishProjectCardComment, publishProjectCardUpdate } from "@/lib/projectBoardCache";
import { invalidateInboxViews } from "@/lib/inboxSources.mjs";
import BoardMentionTextarea from "./BoardMentionTextarea";
import { mentionIdentityIds } from "./boardMentionHelpers.mjs";
import { pastedImages, uploadPastedImage } from "./projectPastedImages";

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
    try {
      const images = pastedImages(event, draft.current.images.length);
      if (images.length) edit({ images: [...draft.current.images, ...images] });
    } catch (error) { update({ error: error.message }); }
  };
  const submit = async () => {
    const current = draft.current;
    if (current.busy || (!current.content.trim() && !current.images.length)) return;
    update({ busy: true, error: "", requestId: current.requestId || crypto.randomUUID() });
    try {
      for (const image of current.images) {
        if (image.attachment) continue;
        const progress = stage => { image.stage = stage; update({}); };
        image.attachment = await uploadPastedImage(cardId, image, progress);
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
