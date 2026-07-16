import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Upload, Trash2, Image as ImageIcon, Loader2 } from "lucide-react";
import UnfurlPreview from "@/components/UnfurlPreview";

// Shared SEO + Social Sharing form sections used by both the iEdit page
// settings modal (IEditPageSettings) and the Canvas Builder settings dialog
// (CanvasPageEditor). Controlled: `values` holds the editable fields
// (meta_title, meta_description, seo_title, seo_description, og_image_url)
// plus title/slug for the unfurl preview; `onChange(patch)` merges a partial
// update into the caller's state.
//
// `notify` reports upload success/failure so each host can surface it with
// its own toast system: notify(kind, { title, description }).
export default function PageSeoSocialFields({ values, onChange, notify }) {
  const [uploadingOgImage, setUploadingOgImage] = useState(false);
  const [ogImageDimWarning, setOgImageDimWarning] = useState('');
  const ogImageInputRef = useRef(null);

  const handleOgImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingOgImage(true);
    setOgImageDimWarning('');

    // Non-blocking dimension check
    try {
      const dims = await new Promise((resolve, reject) => {
        const img = new window.Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = (err) => {
          URL.revokeObjectURL(url);
          reject(err);
        };
        img.src = url;
      });
      const { width, height } = dims;
      const widthOk = width >= 1100 && width <= 1300;
      const heightOk = height >= 580 && height <= 680;
      if (!widthOk || !heightOk) {
        setOgImageDimWarning(`Uploaded image is ${width}×${height}. The recommended size is 1200×630 for best link-preview results.`);
      }
    } catch (_dimErr) {
      // ignore
    }

    const uploadFormData = new FormData();
    uploadFormData.append('file', file);
    uploadFormData.append('folder', 'page-social');

    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: uploadFormData,
      });
      if (!response.ok) throw new Error('Upload failed');
      const data = await response.json();
      onChange({ og_image_url: data.file_url });
      notify?.('success', {
        title: 'Image uploaded',
        description: 'Click Save to persist changes.',
      });
    } catch (err) {
      notify?.('error', {
        title: 'Upload failed',
        description: 'Could not upload social image. Please try again.',
      });
    } finally {
      setUploadingOgImage(false);
      if (ogImageInputRef.current) ogImageInputRef.current.value = '';
    }
  };

  const handleRemoveOgImage = () => {
    onChange({ og_image_url: '' });
    setOgImageDimWarning('');
  };

  return (
    <>
      {/* SEO Settings */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-900">SEO (Optional)</h3>

        <div>
          <Label htmlFor="meta_title">Meta Title</Label>
          <Input
            id="meta_title"
            data-testid="input-meta-title"
            value={values.meta_title || ''}
            onChange={(e) => onChange({ meta_title: e.target.value })}
            placeholder="Leave empty to use page title"
          />
        </div>

        <div>
          <Label htmlFor="meta_description">Meta Description</Label>
          <Textarea
            id="meta_description"
            data-testid="input-meta-description"
            value={values.meta_description || ''}
            onChange={(e) => onChange({ meta_description: e.target.value })}
            rows={3}
            placeholder="Brief description for search engines"
          />
        </div>
      </div>

      {/* Social Sharing */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-900">Social Sharing (Link Preview)</h3>
        <p className="text-xs text-slate-500">
          Customize how this page appears when shared on Slack, WhatsApp, iMessage, Facebook, X/Twitter, and LinkedIn. Any field left blank falls back to the tenant defaults configured in Branding → Link Previews.
        </p>

        <div>
          <Label htmlFor="seo_title">Social Title</Label>
          <Input
            id="seo_title"
            data-testid="input-seo-title"
            value={values.seo_title || ''}
            onChange={(e) => onChange({ seo_title: e.target.value })}
            placeholder="Leave empty to use the tenant default link-preview title"
          />
        </div>

        <div>
          <Label htmlFor="seo_description">Social Description</Label>
          <Textarea
            id="seo_description"
            data-testid="input-seo-description"
            value={values.seo_description || ''}
            onChange={(e) => onChange({ seo_description: e.target.value })}
            rows={3}
            maxLength={300}
            placeholder="A short description shown in the link preview (≈155 characters)."
          />
          <p className="text-xs text-slate-500 mt-1">Aim for under 160 characters.</p>
        </div>

        <div>
          <Label>Social Image</Label>
          <div className="border-2 border-dashed border-slate-300 rounded-md p-4 mt-1">
            {values.og_image_url ? (
              <div className="flex items-center gap-4 flex-wrap">
                <div className="bg-slate-100 rounded-md p-2">
                  <img
                    src={values.og_image_url}
                    alt="Social share preview"
                    className="h-24 w-auto object-contain"
                    data-testid="img-og-image-preview"
                  />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => ogImageInputRef.current?.click()}
                    disabled={uploadingOgImage}
                    data-testid="button-change-og-image"
                  >
                    {uploadingOgImage ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4 mr-2" />
                    )}
                    Change
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleRemoveOgImage}
                    data-testid="button-remove-og-image"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Remove
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-center py-6">
                <ImageIcon className="w-10 h-10 mx-auto text-slate-400 mb-3" />
                <p className="text-slate-500 mb-3 text-sm">No social image set — tenant default will be used.</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => ogImageInputRef.current?.click()}
                  disabled={uploadingOgImage}
                  data-testid="button-upload-og-image"
                >
                  {uploadingOgImage ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  Upload Social Image
                </Button>
              </div>
            )}
            <input
              ref={ogImageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleOgImageUpload}
              data-testid="input-og-image-file"
            />
          </div>
          {ogImageDimWarning ? (
            <p className="text-xs text-warning mt-1" data-testid="text-og-image-warning">{ogImageDimWarning}</p>
          ) : null}
          <p className="text-xs text-slate-500 mt-1">Recommended size: 1200×630 PNG/JPG.</p>
        </div>

        <UnfurlPreview
          title={values.seo_title || values.meta_title || values.title || ''}
          description={values.seo_description || values.meta_description || ''}
          image={values.og_image_url || ''}
          url={typeof window !== 'undefined' && values.slug ? `${window.location.origin}/${values.slug}` : ''}
          previewPath={values.slug ? `/${values.slug}` : null}
        />
      </div>
    </>
  );
}
