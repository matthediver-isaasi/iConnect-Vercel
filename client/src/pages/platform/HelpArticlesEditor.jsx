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
import { Loader2, Plus, Pencil, Trash2, ChevronUp, ChevronDown, Eye, RefreshCw } from 'lucide-react';
import HelpArticleContent from '@/components/help/HelpArticleContent';
import { ROLE_ACCESS_MAP } from '@/lib/roleAccessMap';

const API = '/api/platform/help-articles';
const REINDEX_API = '/api/platform/help-articles-reindex';

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
