import React, { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Upload, Trash2, Image as ImageIcon, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

export default function SEOSettings({
  seoTitle,
  onSeoTitleChange,
  seoDescription,
  onSeoDescriptionChange,
  defaultTitle,
  defaultDescription,
  ogImageUrl,
  onOgImageUrlChange,
}) {
  const showSocialImage = typeof onOgImageUrlChange === 'function';
  const ogInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [dimWarning, setDimWarning] = useState('');
  const { toast } = useToast();

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setDimWarning('');
    try {
      const dims = await new Promise((resolve, reject) => {
        const img = new window.Image();
        const url = URL.createObjectURL(file);
        img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
        img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
        img.src = url;
      });
      const widthOk = dims.width >= 1100 && dims.width <= 1300;
      const heightOk = dims.height >= 580 && dims.height <= 680;
      if (!widthOk || !heightOk) {
        setDimWarning(`Uploaded image is ${dims.width}×${dims.height}. The recommended size is 1200×630 for best link-preview results.`);
      }
    } catch (_) {
      // ignore dim probe failures
    }

    const fd = new FormData();
    fd.append('file', file);
    fd.append('folder', 'page-social');
    try {
      const response = await fetch('/api/integrations/upload-file', {
        method: 'POST',
        credentials: 'include',
        body: fd,
      });
      if (!response.ok) throw new Error('Upload failed');
      const data = await response.json();
      onOgImageUrlChange(data.file_url);
      toast({ title: 'Image uploaded', description: 'Click Save to persist changes.' });
    } catch (_err) {
      toast({ title: 'Upload failed', description: 'Could not upload social image. Please try again.', variant: 'destructive' });
    } finally {
      setUploading(false);
      if (ogInputRef.current) ogInputRef.current.value = '';
    }
  };

  return (
    <Collapsible>
      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="pb-3">
          <CollapsibleTrigger className="flex items-center justify-between w-full hover:opacity-70">
            <CardTitle className="text-base">SEO &amp; Social Sharing</CardTitle>
            <ChevronDown className="w-4 h-4 transition-transform ui-open:rotate-180" />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="seo-title" className="text-sm">SEO / Social Title</Label>
              <Input
                id="seo-title"
                data-testid="input-seo-title"
                value={seoTitle}
                onChange={(e) => onSeoTitleChange(e.target.value)}
                placeholder={defaultTitle || "Title shown in search results and link previews..."}
                className="mt-2"
              />
              <p className="text-xs text-slate-500 mt-1">
                {seoTitle.length || defaultTitle?.length || 0} / 60 characters recommended
              </p>
            </div>

            <div>
              <Label htmlFor="seo-desc" className="text-sm">SEO / Social Description</Label>
              <Textarea
                id="seo-desc"
                data-testid="input-seo-description"
                value={seoDescription}
                onChange={(e) => onSeoDescriptionChange(e.target.value)}
                placeholder={defaultDescription || "Brief description for search results and link previews..."}
                className="mt-2 min-h-[80px]"
              />
              <p className="text-xs text-slate-500 mt-1">
                {seoDescription.length || defaultDescription?.length || 0} / 160 characters recommended
              </p>
            </div>

            {showSocialImage ? (
              <div>
                <Label className="text-sm">Social Image</Label>
                <p className="text-xs text-slate-500 mt-1">
                  Customises how this page appears when shared on Slack, WhatsApp, iMessage, Facebook, X/Twitter, and LinkedIn. Leave blank to fall back to the page&rsquo;s main image, then the tenant default.
                </p>
                <div className="border-2 border-dashed border-slate-300 rounded-md p-4 mt-2">
                  {ogImageUrl ? (
                    <div className="flex items-center gap-4 flex-wrap">
                      <div className="bg-slate-100 rounded-md p-2">
                        <img
                          src={ogImageUrl}
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
                          onClick={() => ogInputRef.current?.click()}
                          disabled={uploading}
                          data-testid="button-change-og-image"
                        >
                          {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                          Change
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => { onOgImageUrlChange(''); setDimWarning(''); }}
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
                      <p className="text-slate-500 mb-3 text-sm">No social image set &mdash; falls back to the page image, then the tenant default.</p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => ogInputRef.current?.click()}
                        disabled={uploading}
                        data-testid="button-upload-og-image"
                      >
                        {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                        Upload Social Image
                      </Button>
                    </div>
                  )}
                  <input
                    ref={ogInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleUpload}
                    data-testid="input-og-image-file"
                  />
                </div>
                {dimWarning ? (
                  <p className="text-xs text-amber-700 mt-1" data-testid="text-og-image-warning">{dimWarning}</p>
                ) : null}
                <p className="text-xs text-slate-500 mt-1">Recommended size: 1200×630 PNG/JPG.</p>
              </div>
            ) : null}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
