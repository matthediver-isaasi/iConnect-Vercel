import { apiRequest } from "@/lib/queryClient";

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export function pastedImages(event, existingCount = 0) {
  if (event.defaultPrevented) return [];
  const clipboard = event.clipboardData;
  const items = Array.from(clipboard?.items || []);
  const files = items.length
    ? items.filter(item => item.kind === "file").map(item => item.getAsFile()).filter(Boolean)
    : Array.from(clipboard?.files || []);
  const images = files.filter(file => file.type.startsWith("image/"));
  if (!images.length) return [];
  if (!clipboard.getData("text/plain")) event.preventDefault();
  if (images.some(file => !imageTypes.has(file.type) || !file.size || file.size > 104857600)) {
    throw new Error("Choose PNG, JPEG, GIF or WebP images, up to 100MB each.");
  }
  if (existingCount + images.length > 10) throw new Error("You can include up to 10 images.");
  return images.map(file => ({ id: crypto.randomUUID(), file, stage: "Ready to upload" }));
}

// Shared retryable upload protocol. The activity-purpose ledger provides stable
// attachment IDs and confirmation recovery; the resulting file is a normal task
// attachment and can be referenced by either activity or description.
export async function uploadPastedImage(cardId, image, progress) {
  if (image.attachment) return image.attachment;
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
  try {
    if (!image.attachment) {
      const confirmed = await apiRequest("POST", `/api/projects/cards/${cardId}/attachments/confirm`,
        { uploadToken: image.upload.uploadToken });
      image.attachment = confirmed.attachment;
    }
  } catch (error) {
    if (/expired/i.test(error.message)) { image.upload = null; image.uploaded = false; }
    throw error;
  }
  progress("Uploaded");
  return image.attachment;
}
