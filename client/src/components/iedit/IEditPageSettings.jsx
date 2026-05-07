import React, { useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Save, Upload, Trash2, Image as ImageIcon, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import UnfurlPreview from "@/components/UnfurlPreview";

export default function IEditPageSettings({ page, onClose, onSave }) {
  const [editedPage, setEditedPage] = useState({ ...page });
  const [uploadingOgImage, setUploadingOgImage] = useState(false);
  const [ogImageDimWarning, setOgImageDimWarning] = useState('');
  const ogImageInputRef = useRef(null);
  const { toast } = useToast();

  const handleSave = () => {
    onSave(editedPage);
  };

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
      setEditedPage((prev) => ({ ...prev, og_image_url: data.file_url }));
      toast({
        title: "Image uploaded",
        description: "Click Save Settings to persist changes.",
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: "Could not upload social image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploadingOgImage(false);
      if (ogImageInputRef.current) ogImageInputRef.current.value = '';
    }
  };

  const handleRemoveOgImage = () => {
    setEditedPage((prev) => ({ ...prev, og_image_url: '' }));
    setOgImageDimWarning('');
  };

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Page Settings</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-6">
          {/* Basic Info */}
          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">Basic Information</h3>
            
            <div>
              <Label htmlFor="title">Page Title *</Label>
              <Input
                id="title"
                value={editedPage.title}
                onChange={(e) => setEditedPage({ ...editedPage, title: e.target.value })}
              />
            </div>

            <div>
              <Label htmlFor="slug">URL Slug *</Label>
              <Input
                id="slug"
                value={editedPage.slug}
                onChange={(e) => setEditedPage({ ...editedPage, slug: e.target.value })}
              />
              <p className="text-xs text-slate-500 mt-1">
                Lowercase letters, numbers, and hyphens only
              </p>
            </div>

            <div>
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={editedPage.description || ''}
                onChange={(e) => setEditedPage({ ...editedPage, description: e.target.value })}
                rows={3}
              />
            </div>
          </div>

          {/* Publication Settings */}
          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">Publication</h3>
            
            <div>
              <Label htmlFor="status">Status</Label>
              <Select
                value={editedPage.status}
                onValueChange={(value) => setEditedPage({ 
                  ...editedPage, 
                  status: value,
                  published_at: value === 'published' && !editedPage.published_at ? new Date().toISOString() : editedPage.published_at
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="layout_type">View Type</Label>
              <Select
                value={editedPage.layout_type}
                onValueChange={(value) => setEditedPage({ ...editedPage, layout_type: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public (Anyone can view, public layout)</SelectItem>
                  <SelectItem value="member">Portal (Members only, with sidebar)</SelectItem>
                  <SelectItem value="hybrid">Hybrid (Anyone can view, members see portal)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500 mt-1">
                {editedPage.layout_type === 'public' && 'Accessible to everyone with public header/footer layout'}
                {editedPage.layout_type === 'member' && 'Only logged-in members can access, displayed within the portal sidebar'}
                {editedPage.layout_type === 'hybrid' && 'Anyone can view; logged-in members see it within the portal sidebar'}
              </p>
            </div>
          </div>

          {/* Layout Options */}
          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">Layout</h3>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="hide_chrome">Hide header & footer</Label>
                <p className="text-xs text-slate-500">
                  When enabled, the page displays without the header, footer, or sidebar — ideal for landing pages or embedded content.
                </p>
              </div>
              <Switch
                id="hide_chrome"
                data-testid="switch-hide-chrome"
                checked={!!editedPage.hide_chrome}
                onCheckedChange={(checked) => setEditedPage({ ...editedPage, hide_chrome: checked })}
              />
            </div>
          </div>

          {/* SEO Settings */}
          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">SEO (Optional)</h3>
            
            <div>
              <Label htmlFor="meta_title">Meta Title</Label>
              <Input
                id="meta_title"
                value={editedPage.meta_title || ''}
                onChange={(e) => setEditedPage({ ...editedPage, meta_title: e.target.value })}
                placeholder="Leave empty to use page title"
              />
            </div>

            <div>
              <Label htmlFor="meta_description">Meta Description</Label>
              <Textarea
                id="meta_description"
                value={editedPage.meta_description || ''}
                onChange={(e) => setEditedPage({ ...editedPage, meta_description: e.target.value })}
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
                value={editedPage.seo_title || ''}
                onChange={(e) => setEditedPage({ ...editedPage, seo_title: e.target.value })}
                placeholder="Leave empty to use the tenant default link-preview title"
              />
            </div>

            <div>
              <Label htmlFor="seo_description">Social Description</Label>
              <Textarea
                id="seo_description"
                data-testid="input-seo-description"
                value={editedPage.seo_description || ''}
                onChange={(e) => setEditedPage({ ...editedPage, seo_description: e.target.value })}
                rows={3}
                maxLength={300}
                placeholder="A short description shown in the link preview (≈155 characters)."
              />
              <p className="text-xs text-slate-500 mt-1">Aim for under 160 characters.</p>
            </div>

            <div>
              <Label>Social Image</Label>
              <div className="border-2 border-dashed border-slate-300 rounded-md p-4 mt-1">
                {editedPage.og_image_url ? (
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="bg-slate-100 rounded-md p-2">
                      <img
                        src={editedPage.og_image_url}
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
                <p className="text-xs text-amber-600 mt-1" data-testid="text-og-image-warning">{ogImageDimWarning}</p>
              ) : null}
              <p className="text-xs text-slate-500 mt-1">Recommended size: 1200×630 PNG/JPG.</p>
            </div>

            <UnfurlPreview
              title={editedPage.seo_title || editedPage.meta_title || editedPage.title || ''}
              description={editedPage.seo_description || editedPage.meta_description || ''}
              image={editedPage.og_image_url || ''}
              url={typeof window !== 'undefined' && editedPage.slug ? `${window.location.origin}/${editedPage.slug}` : ''}
              previewPath={editedPage.slug ? `/${editedPage.slug}` : null}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} className="bg-blue-600 hover:bg-blue-700">
            <Save className="w-4 h-4 mr-2" />
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
