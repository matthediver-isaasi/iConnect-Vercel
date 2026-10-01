import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import { FileRepositoryPicker } from '@/components/ImageSelector';
import PagePickerDialog from './PagePickerDialog';
import CanvasBuilder from './CanvasBuilder';
import { createSymbolEditorDocument, prepareSymbolEditorSave } from '@/lib/canvasSymbolEditorState';

async function requestSymbol(id, options) {
  const response = await fetch(`/api/canvas-symbols/${encodeURIComponent(id)}`, {
    credentials: 'include', ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Symbol request failed (${response.status})`);
  if (!body.symbol?.design) throw new Error('The server did not return the saved symbol design.');
  return body.symbol;
}

// One mount = one private editing session. Fetch directly, not from the shared
// render cache: refetch/invalidation must never replace an in-progress draft.
const CanvasSymbolContentEditor = forwardRef(function CanvasSymbolContentEditor({
  symbolId, onClose, onSaved, otherPages = [], micrositeId = null,
}, ref) {
  const queryClient = useQueryClient();
  const builderRef = useRef(null);
  const savingRef = useRef(false);
  const aliveRef = useRef(true);
  const [session, setSession] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [breakpoint, setBreakpoint] = useState('desktop');
  const [discard, setDiscard] = useState(false);
  const [filePicker, setFilePicker] = useState(null);
  const [pagePicker, setPagePicker] = useState(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    requestSymbol(symbolId).then((symbol) => {
      const initialDesign = createSymbolEditorDocument(symbol);
      if (!cancelled) setSession({ symbol, initialDesign });
    }).catch((error) => { if (!cancelled) setLoadError(error.message); });
    return () => { cancelled = true; };
  }, [symbolId, loadAttempt]);

  const requestClose = useCallback(() => {
    if (savingRef.current) return;
    if (builderRef.current?.isDirty?.() || dirty) setDiscard(true);
    else onClose();
  }, [dirty, onClose]);
  useImperativeHandle(ref, () => ({ requestClose }), [requestClose]);

  const persist = useCallback(async (draft) => {
    if (savingRef.current) throw new Error('A symbol save is already in progress.');
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      const design = prepareSymbolEditorSave(session.symbol.design, draft);
      await requestSymbol(symbolId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ design }),
      });
      // Only committed definitions enter shared queries. No page save/publish.
      await queryClient.invalidateQueries({ queryKey: ['canvas-symbols'] });
      onSaved?.();
      toast.success('Symbol saved — all linked instances now use this definition.');
    } catch (error) {
      if (aliveRef.current) setSaveError(error.message);
      throw error; // CanvasBuilder keeps its dirty snapshot and undo history.
    } finally {
      savingRef.current = false;
      if (aliveRef.current) setSaving(false);
    }
  }, [session, symbolId, queryClient, onSaved]);

  useEffect(() => {
    const beforeUnload = (event) => {
      if (builderRef.current?.isDirty?.() || savingRef.current) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    const key = (event) => {
      if (event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!savingRef.current && !filePicker && !pagePicker && !discard) builderRef.current?.saveNow?.();
      }
    };
    const file = (event) => { if (!savingRef.current && !discard) setFilePicker({ ...event.detail }); };
    const page = (event) => { if (!savingRef.current && !discard) setPagePicker({ ...event.detail }); };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', key);
    window.addEventListener('canvas:open-file-repository', file);
    window.addEventListener('canvas:open-page-picker', page);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('keydown', key);
      window.removeEventListener('canvas:open-file-repository', file);
      window.removeEventListener('canvas:open-page-picker', page);
    };
  }, [filePicker, pagePicker, discard]);

  return <>
    <Dialog open onOpenChange={(open) => { if (!open) requestClose(); }}>
      <DialogContent
        className="w-[98vw] max-w-[98vw] h-[96vh] flex flex-col gap-2 p-3"
        data-testid="symbol-content-editor"
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!filePicker && !pagePicker && !discard) requestClose();
        }}
      >
        <DialogHeader className="pr-8 shrink-0">
          <DialogTitle>Edit symbol content{session ? ` — ${session.symbol.name}` : ''}</DialogTitle>
          <DialogDescription>
            Save symbol updates every linked instance, including published pages, immediately on their next load.
            This is independent of saving or publishing this page. Detached copies do not change.
          </DialogDescription>
        </DialogHeader>
        {loadError ? <div role="alert" className="p-4 text-red-700">
          <p>{loadError}</p><p>No changes have been written.</p>
          <Button variant="outline" onClick={() => setLoadAttempt((n) => n + 1)}>Retry loading</Button>
        </div> : !session ? <p role="status">Loading symbol…</p> : <>
          <div className="flex items-center gap-2 shrink-0">
            {['desktop', 'tablet', 'mobile'].map((bp) => <Button key={bp} size="sm"
              variant={breakpoint === bp ? 'default' : 'outline'}
              onClick={() => setBreakpoint(bp)} disabled={saving}
              data-testid={`symbol-breakpoint-${bp}`}>{bp[0].toUpperCase() + bp.slice(1)}</Button>)}
            <span className="text-sm text-slate-500 ml-auto">{dirty ? 'Unsaved symbol changes' : 'Symbol saved'}</span>
            <Button variant="outline" disabled={saving} onClick={requestClose}>Close</Button>
            <Button disabled={!dirty || saving} onClick={() => builderRef.current?.saveNow?.()}
              data-testid="button-save-symbol-content">{saving ? 'Saving…' : 'Save symbol'}</Button>
          </div>
          {saveError && <p role="alert" className="text-sm text-red-700">{saveError} Your changes are still here. Retry Save symbol.</p>}
          <div className="flex-1 min-h-0" inert={saving ? '' : undefined}>
            <CanvasBuilder ref={builderRef} initialDesign={session.initialDesign}
              breakpoint={breakpoint} onBreakpointChange={setBreakpoint}
              onSave={persist} isSaving={saving} isDirty={dirty} onDirtyChange={setDirty}
              symbolEditing interactionEnabled={!saving && !filePicker && !pagePicker && !discard}
              otherPages={otherPages} micrositeId={micrositeId} />
          </div>
        </>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={discard} onOpenChange={setDiscard}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard symbol changes?</AlertDialogTitle>
          <AlertDialogDescription>Your symbol edits will be lost. The shared symbol and your underlying page draft will not change.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => setDiscard(false)}>Keep editing</Button>
          <Button variant="destructive" onClick={onClose}>Discard changes</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <FileRepositoryPicker open={!!filePicker} kind={filePicker?.kind || 'image'} title={filePicker?.title}
      allowUpload onOpenChange={(open) => { if (!open) setFilePicker(null); }}
      onSelect={(asset) => {
        const onPick = filePicker?.onPick;
        // Resume this builder before delivering the selection: while the
        // picker was open it rejected edits (including captured callbacks).
        flushSync(() => setFilePicker(null));
        if (aliveRef.current && !savingRef.current) onPick?.(asset);
      }} />
    <PagePickerDialog open={!!pagePicker} onOpenChange={(open) => { if (!open) setPagePicker(null); }}
      onPick={(path) => {
        const onPick = pagePicker?.onPick;
        flushSync(() => setPagePicker(null));
        if (aliveRef.current && !savingRef.current) onPick?.(path);
      }} />
  </>;
});

export default CanvasSymbolContentEditor;