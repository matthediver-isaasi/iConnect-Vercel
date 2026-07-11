import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
  Images as ImagesIcon, Keyboard, Command as CommandIcon,
  ExternalLink, Trash2, RotateCcw, Unlink, Plus, Eye,
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
            Roll back to a previous saved version. A snapshot of the current page is taken automatically before restoring. Only the last 10 versions are kept — older versions are removed automatically.
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
                <p className="text-xs text-slate-500 mt-1" data-testid={`text-version-author-${v.id}`}>
                  Saved by {v.saved_by_name || 'Unknown'}
                </p>
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
