import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Plus, Pencil, Trash2, ChevronUp, ChevronDown, Eye, RefreshCw, Sparkles, CheckCircle2, CircleDashed } from 'lucide-react';
import HelpArticleContent from '@/components/help/HelpArticleContent';
import { ROLE_ACCESS_MAP } from '@/lib/roleAccessMap';

const API = '/api/platform/help-articles';
const REINDEX_API = '/api/platform/help-articles-reindex';
const GENERATE_API = '/api/platform/help-articles-generate';

const NO_FEATURE = '__none__';

// Flatten the app's canonical RBAC map into a single list of selectable keys
// (pages and features), so an owner can gate an article on exactly the same
// keys the portal navigation uses. Grouped by module for readability.
const FEATURE_OPTIONS = ROLE_ACCESS_MAP.flatMap((mod) =>
  (mod.pages || []).flatMap((page) => {
    const rows = [
      { value: page.id, label: `${mod.label} › ${page.label}` },
    ];
    for (const feature of page.features || []) {
      rows.push({
        value: feature.id,
        label: `${mod.label} › ${page.label} › ${feature.label}`,
      });
    }
    return rows;
  })
);

// Canonical list of member/portal pages to build help content for, grouped by
// module. Derived from the same RBAC map the portal navigation uses so the
// coverage view stays in sync with the real pages. Platform-admin-only pages
// are not part of ROLE_ACCESS_MAP, so they're naturally out of scope here.
const PAGE_COVERAGE = ROLE_ACCESS_MAP.map((mod) => ({
  id: mod.id,
  label: mod.label,
  pages: (mod.pages || []).map((page) => ({
    id: page.id,
    label: page.label,
    features: (page.features || []).map((f) => ({ id: f.id, label: f.label })),
  })),
})).filter((mod) => mod.pages.length > 0);

const emptyForm = {
  id: null,
  title: '',
  slug: '',
  category: '',
  summary: '',
  body: '',
  status: 'draft',
  required_feature: '',
};

export default function HelpArticlesEditor() {
  const { toast } = useToast();
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [reindexing, setReindexing] = useState(false);

  // Guided AI generation review flow (Task #2304).
  const [buildOpen, setBuildOpen] = useState(false);
  const [buildTarget, setBuildTarget] = useState(null); // { mod, page }
  const [buildInstructions, setBuildInstructions] = useState('');
  const [buildDraft, setBuildDraft] = useState(null); // { title, summary, category, body }
  const [buildExplanation, setBuildExplanation] = useState('');
  const [buildExists, setBuildExists] = useState(false);
  const [buildGenerating, setBuildGenerating] = useState(false);
  const [buildConfirming, setBuildConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(API, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load');
      setArticles(await res.json());
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (article) => {
    setForm({
      id: article.id,
      title: article.title || '',
      slug: article.slug || '',
      category: article.category || '',
      summary: article.summary || '',
      body: article.body || '',
      status: article.status || 'draft',
      required_feature: article.required_feature || '',
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.title.trim()) {
      toast({ title: 'Title required', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const isEdit = !!form.id;
      const url = isEdit ? `${API}?id=${encodeURIComponent(form.id)}` : API;
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          slug: form.slug,
          category: form.category,
          summary: form.summary,
          body: form.body,
          status: form.status,
          required_feature: form.required_feature || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save');
      toast({ title: isEdit ? 'Article updated' : 'Article created' });
      setDialogOpen(false);
      await load();
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (article) => {
    try {
      const next = article.status === 'published' ? 'draft' : 'published';
      const res = await fetch(`${API}?id=${encodeURIComponent(article.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update');
      await load();
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      toast({ title: 'Article deleted' });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    }
  };

  const rebuildIndex = async () => {
    setReindexing(true);
    try {
      const res = await fetch(REINDEX_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to rebuild AI search index');
      }
      const description =
        `${data.articles} article${data.articles === 1 ? '' : 's'}, ` +
        `${data.chunks} chunk${data.chunks === 1 ? '' : 's'} ` +
        `(${data.embedded} embedded, ${data.reused} reused)` +
        (data.errors ? ` — ${data.errors} failed` : '');
      toast({
        title: data.errors
          ? 'Rebuilt with some errors'
          : 'AI search index rebuilt',
        description,
        variant: data.errors ? 'destructive' : undefined,
      });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setReindexing(false);
    }
  };

  // Open the review dialog for a page, pre-filling any remembered instructions.
  const openBuild = (mod, page) => {
    const matched = articles.filter((a) => (a.required_feature || '') === page.id);
    const lastInstructions =
      matched.map((a) => a.generation_instructions).find((v) => v) || '';
    setBuildTarget({ mod, page });
    setBuildInstructions(lastInstructions);
    setBuildDraft(null);
    setBuildExplanation('');
    setBuildExists(matched.length > 0);
    setBuildOpen(true);
  };

  // Generate (or regenerate) a draft in preview mode — nothing is saved yet.
  const generatePreview = async () => {
    if (!buildTarget) return;
    const { mod, page } = buildTarget;
    setBuildGenerating(true);
    try {
      const res = await fetch(GENERATE_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'preview',
          featureKey: page.id,
          moduleLabel: mod.label,
          pageLabel: page.label,
          pageFeatures: page.features,
          instructions: buildInstructions,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Failed to generate draft');
      }
      setBuildDraft(data.draft || null);
      setBuildExplanation(data.explanation || '');
      setBuildExists(!!data.exists);
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setBuildGenerating(false);
    }
  };

  // Commit the reviewed draft: save + publish + reindex.
  const confirmBuild = async () => {
    if (!buildTarget || !buildDraft) return;
    const { mod, page } = buildTarget;
    setBuildConfirming(true);
    try {
      const res = await fetch(GENERATE_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'commit',
          featureKey: page.id,
          moduleLabel: mod.label,
          pageLabel: page.label,
          pageFeatures: page.features,
          instructions: buildInstructions,
          draft: buildDraft,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || 'Failed to save content');
      }
      toast({
        title: 'Content built',
        description: data.indexError
          ? `Saved "${data.article?.title}" — AI search index update failed: ${data.indexError}`
          : `Saved "${data.article?.title}" and updated AI search.`,
        variant: data.indexError ? 'destructive' : undefined,
      });
      setBuildOpen(false);
      await load();
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setBuildConfirming(false);
    }
  };

  const reorder = async (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= articles.length) return;
    const next = [...articles];
    [next[index], next[target]] = [next[target], next[index]];
    setArticles(next);
    try {
      const res = await fetch(API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reorder', order: next.map((a) => a.id) }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to reorder');
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
      await load();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Help Center Articles</h2>
          <p className="text-sm text-muted-foreground">
            Content is shared across all tenants. Use{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{'{{screenshot: Label | url}}'}</code>{' '}
            for images — leave the URL out for a placeholder box.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={rebuildIndex}
            disabled={reindexing}
            data-testid="button-rebuild-ai-index"
          >
            {reindexing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Rebuild AI search index
          </Button>
          <Button onClick={openCreate} data-testid="button-new-help-article">
            <Plus className="h-4 w-4" />
            New Article
          </Button>
        </div>
      </div>

      <Card data-testid="help-coverage-section">
        <CardHeader className="py-3">
          <CardTitle className="text-base">Page coverage</CardTitle>
          <p className="text-sm text-muted-foreground">
            Every member/portal page from the app navigation. Build or update AI-drafted
            help content per page — it's saved as a published article gated to that page
            and immediately added to AI search.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {PAGE_COVERAGE.map((mod) => (
            <div key={mod.id} className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground">{mod.label}</h3>
              <div className="space-y-2">
                {mod.pages.map((page) => {
                  const matched = articles.filter(
                    (a) => (a.required_feature || '') === page.id
                  );
                  const built = matched.length > 0;
                  const busy =
                    buildTarget?.page?.id === page.id &&
                    (buildGenerating || buildConfirming);
                  return (
                    <div
                      key={page.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                      data-testid={`coverage-row-${page.id}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{page.label}</span>
                          {built ? (
                            <Badge variant="default" className="text-xs" data-testid={`coverage-status-${page.id}`}>
                              <CheckCircle2 className="h-3 w-3" />
                              Content built
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs" data-testid={`coverage-status-${page.id}`}>
                              <CircleDashed className="h-3 w-3" />
                              No content yet
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {built
                            ? matched.map((a) => a.title).join(', ')
                            : page.id}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={built ? 'outline' : 'default'}
                        onClick={() => openBuild(mod, page)}
                        disabled={busy}
                        data-testid={`button-build-${page.id}`}
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        {built ? 'Update content' : 'Build content'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold">Articles</h2>
        <p className="text-sm text-muted-foreground">
          All help articles, including ones you built manually or via page coverage.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : articles.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="help-editor-empty">
            No help articles yet. Create your first one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {articles.map((article, index) => (
            <Card key={article.id} data-testid={`help-editor-row-${article.slug}`}>
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{article.title}</CardTitle>
                    <Badge variant={article.status === 'published' ? 'default' : 'secondary'} className="text-xs">
                      {article.status}
                    </Badge>
                    {article.category && (
                      <Badge variant="outline" className="text-xs">{article.category}</Badge>
                    )}
                    {article.required_feature && (
                      <Badge variant="secondary" className="text-xs" data-testid={`badge-gated-${article.slug}`}>
                        Requires: {article.required_feature}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">/help/{article.slug}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="icon" variant="ghost" onClick={() => reorder(index, -1)} disabled={index === 0} data-testid={`button-up-${article.slug}`}>
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => reorder(index, 1)} disabled={index === articles.length - 1} data-testid={`button-down-${article.slug}`}>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => toggleStatus(article)} data-testid={`button-publish-${article.slug}`}>
                    {article.status === 'published' ? 'Unpublish' : 'Publish'}
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => openEdit(article)} data-testid={`button-edit-${article.slug}`}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(article)} data-testid={`button-delete-${article.slug}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit Article' : 'New Article'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="help-title">Title</Label>
              <Input id="help-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} data-testid="input-help-title" />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="help-slug">Slug</Label>
                <Input id="help-slug" placeholder="auto from title" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} data-testid="input-help-slug" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="help-category">Category</Label>
                <Input id="help-category" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} data-testid="input-help-category" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="help-summary">Summary</Label>
              <Input id="help-summary" value={form.summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} data-testid="input-help-summary" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="help-body">Body</Label>
                <Button type="button" size="sm" variant="ghost" onClick={() => setPreviewOpen((v) => !v)} data-testid="button-toggle-preview">
                  <Eye className="h-4 w-4" />
                  {previewOpen ? 'Hide preview' : 'Preview'}
                </Button>
              </div>
              <Textarea id="help-body" rows={12} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} data-testid="input-help-body" />
              <p className="text-xs text-muted-foreground">
                Gate part of an article on a feature by wrapping it in{' '}
                <code className="rounded bg-muted px-1 py-0.5">{'{{feature: commerce.balances.training-fund-card}}'}</code>{' '}
                … <code className="rounded bg-muted px-1 py-0.5">{'{{/feature}}'}</code>{' '}
                on their own lines. Members without that access won't see the wrapped
                section (heading and all); everyone else does. The preview here shows
                every section regardless of gating.
              </p>
              {previewOpen && (
                <div className="rounded-md border p-4" data-testid="help-body-preview">
                  <HelpArticleContent body={form.body} />
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="help-required-feature">Required feature (article access)</Label>
              <Select
                value={form.required_feature || NO_FEATURE}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, required_feature: v === NO_FEATURE ? '' : v }))
                }
              >
                <SelectTrigger id="help-required-feature" data-testid="select-help-required-feature">
                  <SelectValue placeholder="Visible to everyone" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={NO_FEATURE}>Visible to everyone</SelectItem>
                  {FEATURE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                When set, members who can't access this feature won't see the article on
                the Help index and can't open it by its URL. Leave as "Visible to everyone"
                for general guidance.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="help-status">Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger id="help-status" data-testid="select-help-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving} data-testid="button-save-help-article">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={buildOpen}
        onOpenChange={(o) => {
          if (buildGenerating || buildConfirming) return;
          setBuildOpen(o);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {buildExists ? 'Update content' : 'Build content'}
              {buildTarget?.page?.label ? ` — ${buildTarget.page.label}` : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="build-instructions">Instructions for the AI (optional)</Label>
              <Textarea
                id="build-instructions"
                rows={4}
                placeholder="e.g. Cover the workflow stages, agreement signing, and logo upload. Keep it beginner-friendly."
                value={buildInstructions}
                onChange={(e) => setBuildInstructions(e.target.value)}
                data-testid="input-build-instructions"
              />
              <p className="text-xs text-muted-foreground">
                Steer what the article should cover. Nothing is saved until you press
                Confirm. Your instructions are remembered for next time.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant={buildDraft ? 'outline' : 'default'}
                onClick={generatePreview}
                disabled={buildGenerating || buildConfirming}
                data-testid="button-generate-preview"
              >
                {buildGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {buildDraft ? 'Regenerate' : 'Generate'}
              </Button>
              {buildDraft && (
                <span className="text-xs text-muted-foreground">
                  Review the draft below, then Confirm to save &amp; publish.
                </span>
              )}
            </div>

            {buildGenerating && !buildDraft && (
              <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Generating draft…</span>
              </div>
            )}

            {buildExplanation && (
              <div
                className="rounded-md border bg-muted/40 p-3"
                data-testid="build-explanation"
              >
                <p className="text-sm font-medium">What the AI will {buildExists ? 'update' : 'create'}</p>
                <p className="mt-1 text-sm text-muted-foreground">{buildExplanation}</p>
              </div>
            )}

            {buildDraft && (
              <div className="space-y-3" data-testid="build-preview">
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Title</p>
                  <p className="font-medium" data-testid="build-preview-title">{buildDraft.title}</p>
                </div>
                {buildDraft.summary && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium uppercase text-muted-foreground">Summary</p>
                    <p className="text-sm text-muted-foreground">{buildDraft.summary}</p>
                  </div>
                )}
                <div className="space-y-1">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Body preview</p>
                  <div className="rounded-md border p-4">
                    <HelpArticleContent body={buildDraft.body} />
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBuildOpen(false)}
              disabled={buildConfirming}
              data-testid="button-cancel-build"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmBuild}
              disabled={!buildDraft || buildGenerating || buildConfirming}
              data-testid="button-confirm-build"
            >
              {buildConfirming && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirm &amp; publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete article?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove "{deleteTarget?.title}" from every tenant's Help Center.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} data-testid="button-confirm-delete">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
