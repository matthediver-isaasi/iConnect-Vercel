import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Save } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import PageSeoSocialFields from "@/components/iedit/PageSeoSocialFields";
import { isReservedPageSlug, reservedPageSlugMessage } from "@shared/memberAliases.js";

export default function IEditPageSettings({ page, onClose, onSave }) {
  const [editedPage, setEditedPage] = useState({ ...page });
  const { toast } = useToast();

  const handleSave = () => {
    const slug = String(editedPage.slug || '').trim().toLowerCase();
    if (!slug) {
      toast({ title: 'Slug is required', variant: 'destructive' });
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      toast({ title: 'Slug must be lowercase letters, numbers, and hyphens only', variant: 'destructive' });
      return;
    }
    // Task #3638: reserved routes only collide for default-site pages;
    // microsite pages serve at /{prefix}/{slug}.
    if (!editedPage.microsite_id && isReservedPageSlug(slug)) {
      toast({ title: reservedPageSlugMessage(slug), variant: 'destructive' });
      return;
    }
    onSave({ ...editedPage, slug });
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
              <Label htmlFor="builder_type_display">Builder</Label>
              <Input
                id="builder_type_display"
                value={editedPage.builder_type === 'canvas' ? 'Canvas (free-form drag & drop)' : 'iEdit (stacked elements)'}
                disabled
                readOnly
                data-testid="input-builder-type-readonly"
              />
              <p className="text-xs text-slate-500 mt-1">
                The builder is chosen when the page is created and cannot be changed afterwards.
              </p>
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

          {/* Accessibility */}
          <div className="space-y-4">
            <h3 className="font-semibold text-slate-900">Accessibility</h3>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="screen_reader_optimised">Screen reader optimised</Label>
                <p className="text-xs text-slate-500">
                  Pilot: when on, this page renders with the full screen-reader treatment
                  (single H1, accessible gallery dialog, ARIA on carousels/accordions/tabs,
                  decorative-by-default images without alt text, and an announcement region
                  for async UI). Review the screen-reader authoring guide
                  (<code className="text-[10px] bg-slate-100 px-1 rounded">client/src/docs/screen-reader-authoring.md</code>)
                  with the platform team before turning this on.
                </p>
              </div>
              <Switch
                id="screen_reader_optimised"
                data-testid="switch-screen-reader-optimised"
                checked={!!editedPage.screen_reader_optimised}
                onCheckedChange={(checked) =>
                  setEditedPage({ ...editedPage, screen_reader_optimised: checked })
                }
              />
            </div>
          </div>

          {/* SEO + Social Sharing (shared with the Canvas Builder settings dialog) */}
          <PageSeoSocialFields
            values={editedPage}
            onChange={(patch) => setEditedPage((prev) => ({ ...prev, ...patch }))}
            notify={(kind, { title, description }) => toast({
              title,
              description,
              ...(kind === 'error' ? { variant: 'destructive' } : {}),
            })}
          />
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
