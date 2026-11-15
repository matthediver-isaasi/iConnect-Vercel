import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { publishProjectCardUpdate } from "@/lib/projectBoardCache";
import { pastedImages, uploadPastedImage } from "./projectPastedImages";

// Persist references, not signed URLs or arbitrary HTML. Only attachments from
// this card can resolve these tokens; existing plain-text descriptions stay text.
const tokenPattern = /\n?\[project-image:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
const tokens = value => [...(value || "").matchAll(tokenPattern)].map(match => match[1]);
const plainText = value => (value || "").replace(tokenPattern, "");
const withImages = (text, ids) => text + ids.map(id => `\n[project-image:${id}]`).join("");

function DraftPreview({ file }) {
  const [url, setUrl] = useState();
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <img src={url} alt={`Description preview ${file.name}`} className="max-h-48 max-w-full rounded border object-contain" />;
}

const ProjectDescription = forwardRef(function ProjectDescription({
  cardId, value, onChange, attachments = [], canEdit, disabled,
}, ref) {
  const client = useQueryClient();
  const draft = useRef([]);
  const [, redraw] = useState(0);
  const [error, setError] = useState("");
  const savedIds = tokens(value);
  const render = () => redraw(n => n + 1);
  useImperativeHandle(ref, () => ({
    async prepare(description) {
      if (!draft.current.length) return description;
      setError("");
      try {
        for (const image of draft.current) {
          const attachment = await uploadPastedImage(cardId, image, stage => { image.stage = stage; render(); });
          await publishProjectCardUpdate(client, cardId, {}, { attachment });
        }
        return withImages(plainText(description),
          [...new Set([...tokens(description), ...draft.current.map(image => image.attachment.id)])]);
      } catch (err) {
        setError(err.message || "Could not upload images. Your draft is kept; try Save again.");
        throw err;
      }
    },
  }), [cardId, client]);
  const paste = event => {
    if (!canEdit || disabled) return;
    try {
      const images = pastedImages(event, savedIds.length + draft.current.length);
      if (!images.length) return;
      draft.current.push(...images);
      setError(""); render();
    } catch (err) { setError(err.message); }
  };
  return <div className="mt-2 space-y-3" data-testid="card-description-section">
    {canEdit ? <Textarea id="card-description" data-testid="input-card-description" disabled={disabled}
      value={plainText(value)} onChange={event => onChange(withImages(event.target.value, savedIds))}
      onPaste={paste} placeholder="Add a more detailed description or paste a screenshot..." rows={5} />
      : <p className="whitespace-pre-wrap text-sm text-muted-foreground">{plainText(value) || (!savedIds.length ? "No description" : "")}</p>}
    {savedIds.map(id => {
      const attachment = attachments.find(item => item.id === id);
      return <div key={id} className="space-y-1">
        {attachment?.file_type?.startsWith("image/") && attachment.url
          ? <a href={attachment.url} target="_blank" rel="noopener noreferrer">
            <img src={attachment.url} alt={attachment.name || "Description image"} className="max-h-80 max-w-full rounded border object-contain" />
          </a> : <p className="text-sm text-muted-foreground">Description image unavailable</p>}
        {canEdit && <Button type="button" variant="ghost" size="sm" disabled={disabled}
          onClick={() => onChange(withImages(plainText(value), savedIds.filter(item => item !== id)))}
          aria-label={`Remove description image ${attachment?.name || id}`}>Remove image</Button>}
      </div>;
    })}
    {draft.current.map(image => <div key={image.id} className="space-y-1">
      <DraftPreview file={image.file} />
      <p role="status" className="text-xs text-muted-foreground">{image.stage}</p>
      <Button type="button" variant="ghost" size="sm" disabled={disabled}
        aria-label={`Remove pasted description image ${image.file.name}`}
        onClick={() => { draft.current = draft.current.filter(item => item.id !== image.id); render(); }}>Remove image</Button>
    </div>)}
    {canEdit && (draft.current.length > 0 || savedIds.length > 0) &&
      <p className="text-xs text-muted-foreground">Pasted images upload when you save. Removing an image from the description keeps its uploaded file in Attachments.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
});
export default ProjectDescription;
