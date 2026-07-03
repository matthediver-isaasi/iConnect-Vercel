import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { throwUploadHttpError, showUploadErrorToast } from '@/lib/planQuotaError';
import StorageUsageBanner from '@/components/StorageUsageBanner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  LayoutTemplate, Component as ComponentIcon, History as HistoryIcon,
  Images as ImagesIcon, Palette, Keyboard, Command as CommandIcon,
  ExternalLink, Trash2, RotateCcw, Unlink, Plus, Search, Upload, Eye,
  Pencil, Save as SaveIcon,
} from 'lucide-react';
import CanvasPageRenderer from './CanvasPageRenderer';
import {
  createBlock, BLOCK_TYPES, getRootChildren, setRootChildren,
  normalizeCanvasDesign, createEmptyCanvasDesign,
} from '@/lib/canvasDesign';

// ===========================================================================
// Templates
// ===========================================================================

export function TemplatesDialog({ open, onOpenChange, canvasRef, mode = 'pick', onApplied }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['canvas-templates'],
    queryFn: async () => {
      const r = await fetch('/api/canvas-templates', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load templates');
      return r.json();
    },
    enabled: open,
    staleTime: 0,
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      const design = canvasRef?.current?.getDesign?.() || createEmptyCanvasDesign();
      const r = await fetch('/api/canvas-templates', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, design }),
      });
      if (!r.ok) throw new Error('Failed to save template');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvas-templates'] });
      setName(''); setDescription('');
      toast.success('Template saved');
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: async (id) => {
      const r = await fetch(`/api/canvas-templates/${id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!r.ok) throw new Error('Failed to delete');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['canvas-templates'] }),
    onError: (e) => toast.error(e.message),
  });

  const applyTemplate = async (id) => {
    const r = await fetch(`/api/canvas-templates/${id}`, { credentials: 'include' });
    if (!r.ok) { toast.error('Failed to load template'); return; }
    const body = await r.json();
    if (!body?.template?.design) { toast.error('Template has no design'); return; }
    if (canvasRef?.current?.setDesign) {
      canvasRef.current.setDesign(body.template.design);
      toast.success('Template applied');
    }
    if (onApplied) onApplied(body.template);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Page templates</DialogTitle>
          <DialogDescription>
            Apply a saved template, or save the current page as a reusable template.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <Label htmlFor="cb-tpl-name">Save current page as template</Label>
            <Input id="cb-tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name" data-testid="input-template-name" />
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description (optional)" data-testid="input-template-description" />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => saveMut.mutate()} disabled={!name || saveMut.isPending} data-testid="button-save-template">
                <Plus className="w-4 h-4 mr-2" />Save template
              </Button>
            </div>
          </div>
          <div className="space-y-2 max-h-[40vh] overflow-y-auto">
            {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
            {(data?.templates || []).map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3 hover-elevate" data-testid={`template-row-${t.id}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <LayoutTemplate className="w-4 h-4 text-slate-500" />
                    <span className="font-medium text-slate-900 truncate">{t.name}</span>
                    {t.is_starter && <Badge variant="outline">Starter</Badge>}
                  </div>
                  {t.description && <p className="text-xs text-slate-500 mt-1">{t.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" onClick={() => applyTemplate(t.id)} data-testid={`button-apply-template-${t.id}`}>Apply</Button>
                  {!t.is_starter && (
                    <Button size="icon" variant="ghost" onClick={() => deleteMut.mutate(t.id)} data-testid={`button-delete-template-${t.id}`}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {!isLoading && (data?.templates || []).length === 0 && (
              <p className="text-sm text-slate-500">No templates yet.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Symbols
// ===========================================================================

export function SymbolsDialog({ open, onOpenChange, canvasRef }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['canvas-symbols'],
    queryFn: async () => {
      const r = await fetch('/api/canvas-symbols', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load symbols');
      return r.json();
    },
    enabled: open,
    staleTime: 0,
  });

  const saveSelectionMut = useMutation({
    mutationFn: async () => {
      const selected = canvasRef?.current?.getSelectedBlocks?.() || [];
      if (selected.length === 0) throw new Error('Select one or more blocks first');
      // Build a symbol design from the selection. We translate the
      // selection's top-left to (0,0) so the symbol is reusable anywhere.
      const minX = Math.min(...selected.map((b) => b.bp?.desktop?.x || 0));
      const minY = Math.min(...selected.map((b) => b.bp?.desktop?.y || 0));
      const symChildren = selected.map((b) => ({
        ...JSON.parse(JSON.stringify(b)),
        bp: {
          ...b.bp,
          desktop: { ...b.bp.desktop, x: (b.bp.desktop.x || 0) - minX, y: (b.bp.desktop.y || 0) - minY },
        },
      }));
      const symbolDesign = {
        version: 1,
        root: { background: null, sections: [{ id: 'root-section', children: symChildren }] },
      };
      const r = await fetch('/api/canvas-symbols', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, design: symbolDesign }),
      });
      if (!r.ok) throw new Error('Failed to save symbol');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvas-symbols'] });
      setName(''); setDescription('');
      toast.success('Symbol saved');
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: async (id) => {
      const r = await fetch(`/api/canvas-symbols/${id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!r.ok) throw new Error('Failed to delete');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['canvas-symbols'] }),
    onError: (e) => toast.error(e.message),
  });

  // Edit symbol — rename in place or replace its design with the current
  // selection on this page. Updates propagate to every page that
  // references the symbol on next render (and immediately in the editor
  // once the renderer refetches).
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const updateMut = useMutation({
    mutationFn: async ({ id, patch }) => {
      const r = await fetch(`/api/canvas-symbols/${id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error('Failed to update symbol');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvas-symbols'] });
      setEditId(null); setEditName('');
      toast.success('Symbol updated');
    },
    onError: (e) => toast.error(e.message),
  });
  const replaceDesignFromSelection = (id) => {
    const selected = canvasRef?.current?.getSelectedBlocks?.() || [];
    if (selected.length === 0) { toast.error('Select blocks on the page first'); return; }
    const minX = Math.min(...selected.map((b) => b.bp?.desktop?.x || 0));
    const minY = Math.min(...selected.map((b) => b.bp?.desktop?.y || 0));
    const symChildren = selected.map((b) => ({
      ...JSON.parse(JSON.stringify(b)),
      bp: { ...b.bp, desktop: { ...b.bp.desktop, x: (b.bp.desktop.x || 0) - minX, y: (b.bp.desktop.y || 0) - minY } },
    }));
    updateMut.mutate({ id, patch: { design: { version: 1, root: { background: null, sections: [{ id: 'root-section', children: symChildren }] } } } });
  };

  const insertSymbol = (sym) => {
    if (!canvasRef?.current?.addBlocks) return;
    // Omit x/y so addBlocks drops the symbol centered in the user's current
    // viewport (see CanvasBuilder.addBlocks) instead of the top-left corner.
    canvasRef.current.addBlocks([{
      type: BLOCK_TYPES.SYMBOL,
      name: sym.name,
      desktop: { w: 600, h: 240, hidden: false },
      content: { symbolId: sym.id, symbolName: sym.name },
    }]);
    toast.success('Symbol inserted');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Symbols</DialogTitle>
          <DialogDescription>
            Reusable sections shared across pages. Insert a symbol or save the current selection as a new symbol.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <Label htmlFor="cb-sym-name">Save current selection as symbol</Label>
            <Input id="cb-sym-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Symbol name" data-testid="input-symbol-name" />
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description (optional)" data-testid="input-symbol-description" />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => saveSelectionMut.mutate()} disabled={!name || saveSelectionMut.isPending} data-testid="button-save-symbol">
                <Plus className="w-4 h-4 mr-2" />Save symbol
              </Button>
            </div>
          </div>
          <div className="space-y-2 max-h-[40vh] overflow-y-auto">
            {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
            {(data?.symbols || []).map((s) => (
              <div key={s.id} className="rounded-md border border-slate-200 p-3 hover-elevate" data-testid={`symbol-row-${s.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {editId === s.id ? (
                      <div className="flex items-center gap-2">
                        <Input value={editName} onChange={(e) => setEditName(e.target.value)} data-testid={`input-edit-symbol-name-${s.id}`} />
                        <Button size="sm" onClick={() => updateMut.mutate({ id: s.id, patch: { name: editName } })} disabled={!editName || updateMut.isPending}>
                          <SaveIcon className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => { setEditId(null); setEditName(''); }}>Cancel</Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <ComponentIcon className="w-4 h-4 text-slate-500" />
                        <span className="font-medium text-slate-900 truncate">{s.name}</span>
                      </div>
                    )}
                    {s.description && <p className="text-xs text-slate-500 mt-1">{s.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" onClick={() => insertSymbol(s)} data-testid={`button-insert-symbol-${s.id}`}>Insert</Button>
                    <Button size="icon" variant="ghost" onClick={() => { setEditId(s.id); setEditName(s.name); }} data-testid={`button-rename-symbol-${s.id}`} title="Rename">
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => replaceDesignFromSelection(s.id)} data-testid={`button-update-symbol-${s.id}`} title="Replace design with current selection">
                      <SaveIcon className="w-4 h-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => deleteMut.mutate(s.id)} data-testid={`button-delete-symbol-${s.id}`} title="Delete">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {!isLoading && (data?.symbols || []).length === 0 && (
              <p className="text-sm text-slate-500">No symbols yet.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Unlink a selected symbol — replace the symbol block with its resolved
// children translated into the host page's coordinate space.
export async function unlinkSelectedSymbol(canvasRef) {
  const sel = canvasRef?.current?.getSelectedBlocks?.() || [];
  const symBlock = sel.find((b) => b.type === BLOCK_TYPES.SYMBOL);
  if (!symBlock) { toast.error('Select a symbol block to unlink'); return; }
  const symbolId = symBlock.content?.symbolId;
  if (!symbolId) { toast.error('Symbol is missing an id'); return; }
  const r = await fetch(`/api/canvas-symbols/${symbolId}`, { credentials: 'include' });
  if (!r.ok) { toast.error('Failed to load symbol'); return; }
  const body = await r.json();
  const symDesign = normalizeCanvasDesign(body.symbol?.design);
  const symChildren = getRootChildren(symDesign);
  const hostX = symBlock.bp.desktop.x || 0;
  const hostY = symBlock.bp.desktop.y || 0;
  // Translate symbol children into host coordinates and create fresh
  // blocks so they get new ids and are no longer locked.
  const newBlocks = symChildren.map((c) => ({
    type: c.type,
    name: c.name,
    desktop: { ...c.bp.desktop, x: (c.bp.desktop.x || 0) + hostX, y: (c.bp.desktop.y || 0) + hostY },
    tablet: c.bp.tablet,
    mobile: c.bp.mobile,
    style: c.style,
    a11y: c.a11y,
    content: c.content,
  }));
  // Replace the symbol with its children atomically: full design rewrite.
  const currentDesign = canvasRef.current.getDesign();
  const filtered = getRootChildren(currentDesign).filter((b) => b.id !== symBlock.id);
  const replaced = setRootChildren(currentDesign, filtered);
  canvasRef.current.setDesign(replaced);
  canvasRef.current.addBlocks(newBlocks);
  toast.success('Symbol unlinked');
}

// ===========================================================================
// Version history
// ===========================================================================

export function VersionsDialog({ open, onOpenChange, pageId, onRestored }) {
  const queryClient = useQueryClient();
  const [previewVersion, setPreviewVersion] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // The list endpoint omits design payloads by default. Fetch the full
  // version on demand so the preview renders the actual design.
  const openPreview = async (v) => {
    setPreviewLoading(true);
    try {
      const r = await fetch(`/api/canvas-versions/${pageId}?versionId=${v.id}`, { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load version');
      const body = await r.json();
      setPreviewVersion(body.version || null);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPreviewLoading(false);
    }
  };
  const { data, isLoading } = useQuery({
    queryKey: ['canvas-versions', pageId],
    queryFn: async () => {
      const r = await fetch(`/api/canvas-versions/${pageId}`, { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load versions');
      return r.json();
    },
    enabled: open && !!pageId,
    staleTime: 0,
  });

  const restoreMut = useMutation({
    mutationFn: async (versionId) => {
      const r = await fetch(`/api/canvas-versions/${pageId}?restore=1`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId }),
      });
      if (!r.ok) throw new Error('Failed to restore');
      return r.json();
    },
    onSuccess: (body) => {
      queryClient.invalidateQueries({ queryKey: ['canvas-versions', pageId] });
      queryClient.invalidateQueries({ queryKey: ['canvas-page', pageId] });
      if (onRestored) onRestored(body?.page);
      toast.success('Version restored');
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Roll back to a previous saved version. A snapshot of the current page is taken automatically before restoring.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {(data?.versions || []).map((v) => (
            <div key={v.id} className="flex items-start justify-between gap-3 rounded-md border border-slate-200 p-3 hover-elevate" data-testid={`version-row-${v.id}`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <HistoryIcon className="w-4 h-4 text-slate-500" />
                  <span className="font-medium text-slate-900">
                    {new Date(v.created_at).toLocaleString()}
                  </span>
                  <Badge variant="outline">{v.source}</Badge>
                </div>
                {v.label && <p className="text-xs text-slate-500 mt-1">{v.label}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button size="sm" variant="outline" onClick={() => openPreview(v)} disabled={previewLoading} data-testid={`button-preview-version-${v.id}`}>
                  <Eye className="w-4 h-4 mr-2" />Preview
                </Button>
                <Button size="sm" variant="outline" onClick={() => restoreMut.mutate(v.id)} disabled={restoreMut.isPending} data-testid={`button-restore-version-${v.id}`}>
                  <RotateCcw className="w-4 h-4 mr-2" />Restore
                </Button>
              </div>
            </div>
          ))}
          {!isLoading && (data?.versions || []).length === 0 && (
            <p className="text-sm text-slate-500">No versions yet. Publishing the page creates a snapshot.</p>
          )}
        </div>
      </DialogContent>
      {/* Version preview — renders the picked version via the public
          renderer so authors can confirm before restoring. */}
      <Dialog open={!!previewVersion} onOpenChange={(o) => !o && setPreviewVersion(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Preview version</DialogTitle>
            <DialogDescription>
              {previewVersion && new Date(previewVersion.created_at).toLocaleString()}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto rounded-md border border-slate-200">
            {previewVersion && (
              <CanvasPageRenderer page={{ id: `version-${previewVersion.id}`, slug: 'version-preview', canvas_design: previewVersion.design }} />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewVersion(null)}>Close</Button>
            <Button onClick={() => { restoreMut.mutate(previewVersion.id); setPreviewVersion(null); }} disabled={restoreMut.isPending}>
              <RotateCcw className="w-4 h-4 mr-2" />Restore this version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

// ===========================================================================
// Media library
// ===========================================================================

// Derive a coarse "kind" (image | video) from the MIME type so the
// picker can show appropriate previews and so callers (image vs video
// block inspectors) can filter the library by what they consume.
function mediaKind(asset) {
  const m = String(asset?.mime_type || '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  // Fall back to URL extension when mime_type is missing (URL-only assets).
  const u = String(asset?.url || '').toLowerCase();
  if (/\.(mp4|webm|ogv|mov)(\?|$)/.test(u)) return 'video';
  return 'image';
}

export function MediaLibraryDialog({ open, onOpenChange, onPick, kind }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  // Inline alt-text editing keeps tabbing out of the dialog unnecessary
  // and is the main accessibility win the reviewer flagged.
  const [editId, setEditId] = useState(null);
  const [editAlt, setEditAlt] = useState('');
  const [editName, setEditName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['media-library', search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const r = await fetch(`/api/media-library?${params.toString()}`, { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load assets');
      return r.json();
    },
    enabled: open,
    staleTime: 0,
  });

  const addMut = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/media-library', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, name: name || url }),
      });
      if (!r.ok) throw new Error('Failed to register asset');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media-library'] });
      setUrl(''); setName('');
      toast.success('Asset added');
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, patch }) => {
      const r = await fetch(`/api/media-library/${id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error('Failed to update asset');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media-library'] });
      setEditId(null); setEditAlt(''); setEditName('');
      toast.success('Asset updated');
    },
    onError: (e) => toast.error(e.message),
  });

  const uploadFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('name', file.name);
      const r = await fetch('/api/media-library/upload', {
        method: 'POST', credentials: 'include', body: fd,
      });
      if (!r.ok) await throwUploadHttpError(r, 'Upload failed');
      await r.json();
      queryClient.invalidateQueries({ queryKey: ['media-library'] });
      toast.success('Image uploaded');
    } catch (e) {
      showUploadErrorToast(e, 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Media library</DialogTitle>
          <DialogDescription>Search saved images and videos, upload new files, or register a URL.</DialogDescription>
        </DialogHeader>
        <StorageUsageBanner compact className="mb-1" />
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-slate-500" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or alt text" data-testid="input-media-search" />
          </div>
          <div className="rounded-md border border-slate-200 p-3 space-y-3">
            <div className="space-y-2">
              <Label>Upload image or video</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept={kind === 'video'
                  ? 'video/mp4,video/webm,video/ogg'
                  : kind === 'image'
                  ? 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml'
                  : 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml,video/mp4,video/webm,video/ogg'}
                onChange={(e) => uploadFile(e.target.files?.[0])}
                className="block w-full text-sm text-slate-700 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-200 file:bg-white file:text-sm hover:file:bg-slate-50"
                data-testid="input-media-upload"
              />
              {uploading && <p className="text-xs text-slate-500 flex items-center gap-1"><Upload className="w-3 h-3" /> Uploading…</p>}
            </div>
            <div className="border-t border-slate-200 pt-3 space-y-2">
              <Label>Or add by URL</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" data-testid="input-media-url" />
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" data-testid="input-media-name" />
              <div className="flex justify-end">
                <Button size="sm" onClick={() => addMut.mutate()} disabled={!url || addMut.isPending} data-testid="button-add-media">
                  <Plus className="w-4 h-4 mr-2" />Add asset
                </Button>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[40vh] overflow-y-auto">
            {isLoading && <p className="text-sm text-slate-500 col-span-full">Loading…</p>}
            {(data?.assets || [])
              .filter((a) => !kind || mediaKind(a) === kind)
              .map((a) => {
              const k = mediaKind(a);
              return (
              <div key={a.id} className="rounded-md border border-slate-200 p-2" data-testid={`media-row-${a.id}`}>
                <button
                  type="button"
                  className="block w-full text-left hover-elevate active-elevate-2 rounded"
                  onClick={() => { onPick?.(a); onOpenChange(false); }}
                  data-testid={`button-pick-media-${a.id}`}
                >
                  <div className="aspect-video bg-slate-100 rounded overflow-hidden flex items-center justify-center relative">
                    {a.url && k === 'video' ? (
                      <video src={a.url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
                    ) : a.url ? (
                      <img src={a.url} alt={a.alt_text || a.name} className="w-full h-full object-cover" />
                    ) : (
                      <ImagesIcon className="w-5 h-5 text-slate-400" />
                    )}
                    {k === 'video' && (
                      <span className="absolute top-1 left-1 text-[10px] uppercase tracking-wide bg-black/60 text-white rounded px-1.5 py-0.5">Video</span>
                    )}
                  </div>
                </button>
                {editId === a.id ? (
                  <div className="mt-2 space-y-1">
                    <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Name" className="h-7 text-xs" data-testid={`input-edit-media-name-${a.id}`} />
                    <Input value={editAlt} onChange={(e) => setEditAlt(e.target.value)} placeholder="Alt text" className="h-7 text-xs" data-testid={`input-edit-media-alt-${a.id}`} />
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => updateMut.mutate({ id: a.id, patch: { name: editName, alt_text: editAlt } })} disabled={updateMut.isPending} data-testid={`button-save-media-${a.id}`}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditId(null); setEditAlt(''); setEditName(''); }}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 flex items-start justify-between gap-1">
                    <div className="min-w-0">
                      <p className="text-xs truncate">{a.name}</p>
                      <p className="text-[10px] text-slate-500 truncate">alt: {a.alt_text || <span className="italic">none</span>}</p>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => { setEditId(a.id); setEditAlt(a.alt_text || ''); setEditName(a.name || ''); }} data-testid={`button-edit-media-${a.id}`} title="Edit name and alt text">
                      <Pencil className="w-3 h-3" />
                    </Button>
                  </div>
                )}
              </div>
              );
            })}
            {!isLoading && (data?.assets || []).length === 0 && (
              <p className="text-sm text-slate-500 col-span-full">No assets yet.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Theme editor
// ===========================================================================

const DEFAULT_THEME = {
  colors: { primary: '', accent: '', background: '', foreground: '' },
  typography: { heading: '', body: '' },
  spacing: { sm: '', md: '', lg: '' },
};

export function ThemeDialog({ open, onOpenChange }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ['tenant-canvas-theme'],
    queryFn: async () => {
      const r = await fetch('/api/tenant-canvas-theme', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load theme');
      return r.json();
    },
    enabled: open,
    staleTime: 0,
  });
  const [theme, setTheme] = useState(DEFAULT_THEME);
  useEffect(() => {
    if (data?.theme) {
      setTheme({
        colors: { ...DEFAULT_THEME.colors, ...(data.theme.colors || {}) },
        typography: { ...DEFAULT_THEME.typography, ...(data.theme.typography || {}) },
        spacing: { ...DEFAULT_THEME.spacing, ...(data.theme.spacing || {}) },
      });
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/tenant-canvas-theme', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      });
      if (!r.ok) throw new Error('Failed to save theme');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-canvas-theme'] });
      toast.success('Theme saved');
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const setColor = (k, v) => setTheme((t) => ({ ...t, colors: { ...t.colors, [k]: v } }));
  const setFont = (k, v) => setTheme((t) => ({ ...t, typography: { ...t.typography, [k]: v } }));
  const setSpace = (k, v) => setTheme((t) => ({ ...t, spacing: { ...t.spacing, [k]: v } }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Tenant theme</DialogTitle>
          <DialogDescription>
            These tokens are exposed as CSS variables on Canvas pages (e.g. <code>var(--cb-color-primary)</code>). iEdit pages are not affected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto">
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-700">Colors</h4>
            {Object.entries(theme.colors).map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-2 items-center">
                <Label className="text-xs capitalize">{k}</Label>
                <Input value={v} onChange={(e) => setColor(k, e.target.value)} placeholder="e.g. #1d4ed8 or hsl(222 47% 31%)" className="col-span-2" data-testid={`input-theme-color-${k}`} />
              </div>
            ))}
          </section>
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-700">Typography</h4>
            {Object.entries(theme.typography).map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-2 items-center">
                <Label className="text-xs capitalize">{k}</Label>
                <Input value={v} onChange={(e) => setFont(k, e.target.value)} placeholder="e.g. Inter, system-ui, sans-serif" className="col-span-2" data-testid={`input-theme-font-${k}`} />
              </div>
            ))}
          </section>
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-700">Spacing</h4>
            {Object.entries(theme.spacing).map(([k, v]) => (
              <div key={k} className="grid grid-cols-3 gap-2 items-center">
                <Label className="text-xs capitalize">{k}</Label>
                <Input value={v} onChange={(e) => setSpace(k, e.target.value)} placeholder="e.g. 8 or 1rem" className="col-span-2" data-testid={`input-theme-space-${k}`} />
              </div>
            ))}
          </section>
        </div>
        <DialogFooter>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="button-save-theme">
            <Palette className="w-4 h-4 mr-2" />Save theme
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Shortcut overlay
// ===========================================================================

const SHORTCUTS = [
  ['Cmd/Ctrl + Z', 'Undo'],
  ['Cmd/Ctrl + Shift + Z', 'Redo'],
  ['Cmd/Ctrl + D', 'Duplicate selected'],
  ['Cmd/Ctrl + C / X / V', 'Copy / cut / paste (incl. between pages)'],
  ['Cmd/Ctrl + K', 'Open command palette'],
  ['Cmd/Ctrl + S', 'Save page'],
  ['Delete / Backspace', 'Delete selected'],
  ['Arrow keys', 'Nudge selected (Shift = grid step)'],
  ['Space + drag', 'Pan the canvas'],
  ['?', 'Show this shortcut overlay'],
];

export function ShortcutsOverlay({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="flex items-center justify-between gap-2">
              <kbd className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-xs font-mono">{keys}</kbd>
              <span className="text-sm text-slate-700">{desc}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// Command palette (Cmd+K)
// ===========================================================================

export function CommandPalette({ open, onOpenChange, actions }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CommandIcon className="w-4 h-4" /> Command palette</DialogTitle>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          data-testid="input-command-query"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered.length > 0) {
              filtered[0].run();
              onOpenChange(false);
            }
          }}
        />
        <div className="space-y-1 max-h-[50vh] overflow-y-auto">
          {filtered.map((a) => (
            <button
              key={a.id}
              type="button"
              className="w-full text-left px-2 py-2 rounded-md hover-elevate active-elevate-2 flex items-center justify-between"
              onClick={() => { a.run(); onOpenChange(false); }}
              data-testid={`command-${a.id}`}
            >
              <span className="text-sm text-slate-800">{a.label}</span>
              {a.hint && <span className="text-xs text-slate-500">{a.hint}</span>}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-slate-500 p-2">No matching commands.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
