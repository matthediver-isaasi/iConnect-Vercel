// "Create page with AI" wizard — AI Design Studio Phase 5 (Task #2853).
//
// Entry point on the page manager: an advanced brief (purpose / audience /
// desired action / content notes / record pins), an editable section plan
// (the generation job pauses in `awaiting_plan` — plan review is always on
// here), then a whole-page AI Composition generation. On completion the
// wizard creates a Canvas page whose design holds a single full-width AI
// Composition block, applies the AI-suggested SEO fields to the page (shown
// to the author first — they can untick it), and opens the Canvas editor.
//
// Reuses the exact same pipeline as the in-editor AI Composition block: one
// architecture, this is only a different entry point.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, Sparkles } from 'lucide-react';
import { createEmptyCanvasDesign, BLOCK_TYPES, BLOCK_DEFAULTS } from '@/lib/canvasDesign';
import { AdvancedBriefFields, PlanReviewPanel, EMPTY_ADVANCED_BRIEF, advancedBriefToBody } from './AiPageBrief';
import { useGenerationLoop } from './blocks/AiCompositionBlock';

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Canvas design containing a single full-width AI Composition block.
function designWithComposition(compositionId) {
  const design = createEmptyCanvasDesign();
  const defaults = BLOCK_DEFAULTS[BLOCK_TYPES.AI_COMPOSITION] || {};
  design.root.sections[0].children.push({
    id: `block-aic-${Date.now().toString(36)}`,
    type: BLOCK_TYPES.AI_COMPOSITION,
    name: 'AI Composition',
    geom: { x: 0, y: 0, w: 1200, h: 600 },
    style: { ...(defaults.style || {}) },
    content: { ...(defaults.content || {}), compositionId, fullWidth: true },
  });
  return design;
}

export default function CreatePageWithAiDialog({ open, onOpenChange }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [layoutType, setLayoutType] = useState('public');
  const [brief, setBrief] = useState('');
  const [direction, setDirection] = useState('');
  const [creativity, setCreativity] = useState('brand_led');
  const [adv, setAdv] = useState({ ...EMPTY_ADVANCED_BRIEF, reviewPlan: true, generateSeo: true });
  const [seo, setSeo] = useState(null);
  const [applySeo, setApplySeo] = useState(true);
  const [creating, setCreating] = useState(false);

  const reset = () => {
    setTitle(''); setSlug(''); setSlugTouched(false); setLayoutType('public');
    setBrief(''); setDirection(''); setCreativity('brand_led');
    setAdv({ ...EMPTY_ADVANCED_BRIEF, reviewPlan: true, generateSeo: true });
    setSeo(null); setApplySeo(true); setCreating(false);
  };

  const createPage = async (compositionId, seoSuggestion) => {
    setCreating(true);
    try {
      const payload = {
        title: title.trim(),
        slug: slug.trim() || slugify(title),
        layout_type: layoutType,
        status: 'draft',
        builder_type: 'canvas',
        canvas_design: designWithComposition(compositionId),
      };
      // Page SEO from the AI copy stage (spec §32) — only with the author's
      // consent, and always editable later in page settings.
      if (seoSuggestion && applySeo) {
        if (seoSuggestion.title) payload.seo_title = seoSuggestion.title;
        if (seoSuggestion.ogImageUrl) payload.og_image_url = seoSuggestion.ogImageUrl;
        if (seoSuggestion.description) payload.seo_description = seoSuggestion.description;
      }
      const created = await base44.entities.IEditPage.create(payload);
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      toast.success('Page created — opening the editor');
      onOpenChange(false);
      reset();
      navigate(createPageUrl(`CanvasPageEditor?id=${created.id}`));
    } catch (err) {
      toast.error(`The design was generated but the page could not be created: ${err.message}`);
      setCreating(false);
    }
  };

  const gen = useGenerationLoop({
    onSeo: (s) => setSeo(s),
    onComplete: (compositionId) => {
      // seo state may not have flushed yet — onSeo fires in the same tick, so
      // read via callback-provided value pattern: createPage reads state on
      // next tick via setTimeout(0).
      setTimeout(() => {
        setSeo((current) => {
          createPage(compositionId, current);
          return current;
        });
      }, 0);
    },
  });

  const busy = gen.running || creating;
  const canGenerate = title.trim() && brief.trim() && !busy && !gen.pendingPlan;

  const generate = () => {
    if (!canGenerate) return;
    gen.start({
      brief,
      mode: 'whole_page',
      direction: direction || undefined,
      creativity,
      ...advancedBriefToBody(adv),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) { onOpenChange(o); if (!o) reset(); } }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create page with AI</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="ai-page-title">Page title *</Label>
            <Input
              id="ai-page-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="e.g. Annual Conference 2026"
              data-testid="input-ai-page-title"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-page-slug">URL slug *</Label>
            <Input
              id="ai-page-slug"
              value={slug}
              onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }}
              placeholder="annual-conference-2026"
              data-testid="input-ai-page-slug"
            />
          </div>
          <div className="space-y-1">
            <Label>View type</Label>
            <Select value={layoutType} onValueChange={setLayoutType}>
              <SelectTrigger data-testid="select-ai-page-layout"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public (anyone can view)</SelectItem>
                <SelectItem value="member">Portal (members only)</SelectItem>
                <SelectItem value="hybrid">Hybrid</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-page-brief">Describe the page *</Label>
            <Textarea
              id="ai-page-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. A landing page for our annual conference with highlights, speakers and a registration call to action"
              rows={4}
              data-testid="input-ai-page-brief"
            />
          </div>

          <AdvancedBriefFields value={adv} onChange={setAdv} idPrefix="ai-page" />

          <div className="space-y-1">
            <Label htmlFor="ai-page-direction">Visual direction (optional)</Label>
            <Input
              id="ai-page-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder="e.g. bold, dark, geometric"
              data-testid="input-ai-page-direction"
            />
          </div>
          <div className="space-y-1">
            <Label>Creativity</Label>
            <Select value={creativity} onValueChange={setCreativity}>
              <SelectTrigger data-testid="select-ai-page-creativity"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="strict">Stay close to our brand</SelectItem>
                <SelectItem value="brand_led">Brand-led (recommended)</SelectItem>
                <SelectItem value="expressive">Expressive</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {adv.generateSeo && (
            <div className="flex flex-wrap items-center gap-2">
              <Checkbox
                id="ai-page-apply-seo"
                checked={applySeo}
                onCheckedChange={(v) => setApplySeo(!!v)}
                data-testid="checkbox-ai-page-apply-seo"
              />
              <Label htmlFor="ai-page-apply-seo" className="text-sm font-normal">
                Apply the suggested SEO title & description to the page
              </Label>
            </div>
          )}

          {gen.pendingPlan && (
            <PlanReviewPanel
              key={gen.pendingPlan.jobId}
              plan={gen.pendingPlan.plan}
              busy={gen.running}
              onApprove={(plan) => gen.resumePlan(gen.pendingPlan.jobId, plan)}
              onCancel={gen.cancelPlan}
            />
          )}

          {gen.running && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(gen.progress * 100)}%` }} />
            </div>
          )}
          {gen.error && (
            <p className="text-xs text-destructive" data-testid="text-ai-page-error">{gen.error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy} data-testid="button-ai-page-cancel">
            Cancel
          </Button>
          <Button onClick={generate} disabled={!canGenerate} data-testid="button-ai-page-generate">
            {busy
              ? (<><Loader2 className="mr-1 h-4 w-4 animate-spin" /> {creating ? 'Creating page…' : (gen.label || 'Generating…')}</>)
              : (<><Sparkles className="mr-1 h-4 w-4" /> {gen.pendingPlan ? 'Waiting for plan approval' : 'Generate page'}</>)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
