import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Bookmark,
  BookmarkPlus,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';

// Named saved-view switcher for the CRM list pages. Purely presentational:
// the page supplies the views plus callbacks; persistence lives in
// useSavedListViews and filter application lives in the page.
export default function SavedViewSwitcher({
  views,
  activeViewId,
  isSaving,
  onApplyView,     // (view) => void
  onClearView,     // () => void — back to unfiltered, keeps all views
  onCreateView,    // (name, { makeDefault }) => Promise
  onUpdateView,    // (view) => Promise — overwrite with current filters/columns
  onRenameView,    // (view, name) => Promise
  onDeleteView,    // (view) => Promise
  onSetDefault,    // (viewId|null) => Promise
  testIdPrefix = 'view',
}) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState(null); // { mode: 'create' | 'rename' | 'delete', view? }
  const [nameInput, setNameInput] = useState('');
  const [makeDefaultInput, setMakeDefaultInput] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);

  const activeView = views.find((v) => v.id === activeViewId) || null;

  const openCreateDialog = () => {
    setNameInput('');
    setMakeDefaultInput(false);
    setDialog({ mode: 'create' });
  };
  const openRenameDialog = (view) => {
    setNameInput(view.name);
    setDialog({ mode: 'rename', view });
  };
  const closeDialog = () => {
    if (dialogBusy) return;
    setDialog(null);
  };

  const failToast = () =>
    toast({
      title: 'Something went wrong',
      description: 'Could not save your change. Please try again.',
      variant: 'destructive',
    });

  const handleDialogConfirm = async () => {
    if (!dialog) return;
    if (dialog.mode === 'delete') {
      setDialogBusy(true);
      try {
        await onDeleteView(dialog.view);
        toast({ title: 'View deleted', description: `"${dialog.view.name}" has been removed.` });
        setDialog(null);
      } catch {
        failToast();
      } finally {
        setDialogBusy(false);
      }
      return;
    }
    const name = nameInput.trim();
    if (!name) return;
    setDialogBusy(true);
    try {
      if (dialog.mode === 'create') {
        await onCreateView(name, { makeDefault: makeDefaultInput });
        toast({ title: 'View saved', description: `"${name}" now remembers these filters, columns and sort.` });
      } else {
        await onRenameView(dialog.view, name);
        toast({ title: 'View renamed', description: `Saved view is now called "${name}".` });
      }
      setDialog(null);
    } catch {
      failToast();
    } finally {
      setDialogBusy(false);
    }
  };

  const handleUpdate = async () => {
    if (!activeView) return;
    try {
      await onUpdateView(activeView);
      toast({ title: 'View updated', description: `"${activeView.name}" now uses the current filters, columns and sort.` });
    } catch {
      failToast();
    }
  };

  const handleToggleDefault = async () => {
    if (!activeView) return;
    try {
      await onSetDefault(activeView.isDefault ? null : activeView.id);
      toast(
        activeView.isDefault
          ? { title: 'Default removed', description: 'This page will open unfiltered next time.' }
          : { title: 'Default view set', description: `"${activeView.name}" will apply when you open this page.` }
      );
    } catch {
      failToast();
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-between h-8 text-xs font-normal"
            data-testid={`button-${testIdPrefix}-switcher`}
          >
            <span className="flex items-center gap-1.5 min-w-0">
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-slate-400" />
              ) : (
                <Bookmark className="w-3.5 h-3.5 shrink-0 text-slate-400" />
              )}
              <span className="truncate">
                {activeView ? activeView.name : 'No view'}
              </span>
            </span>
            <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs">Saved views</DropdownMenuLabel>
          {views.length === 0 ? (
            <DropdownMenuItem disabled className="text-xs text-slate-400">
              No saved views yet
            </DropdownMenuItem>
          ) : (
            views.map((view) => (
              <DropdownMenuItem
                key={view.id}
                className="text-xs gap-2"
                onSelect={() => onApplyView(view)}
                data-testid={`menuitem-${testIdPrefix}-apply-${view.id}`}
              >
                <Check
                  className={`w-3.5 h-3.5 shrink-0 ${view.id === activeViewId ? 'opacity-100' : 'opacity-0'}`}
                />
                <span className="truncate flex-1">{view.name}</span>
                {view.isDefault && (
                  <Star className="w-3 h-3 shrink-0 text-amber-500 fill-amber-400" />
                )}
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-xs gap-2"
            onSelect={openCreateDialog}
            data-testid={`menuitem-${testIdPrefix}-save-new`}
          >
            <BookmarkPlus className="w-3.5 h-3.5 shrink-0" />
            Save current as new view...
          </DropdownMenuItem>
          {activeView && (
            <>
              <DropdownMenuItem
                className="text-xs gap-2"
                onSelect={handleUpdate}
                data-testid={`menuitem-${testIdPrefix}-update`}
              >
                <Save className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Update "{activeView.name}"</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs gap-2"
                onSelect={() => openRenameDialog(activeView)}
                data-testid={`menuitem-${testIdPrefix}-rename`}
              >
                <Pencil className="w-3.5 h-3.5 shrink-0" />
                Rename...
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs gap-2"
                onSelect={handleToggleDefault}
                data-testid={`menuitem-${testIdPrefix}-toggle-default`}
              >
                {activeView.isDefault ? (
                  <StarOff className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <Star className="w-3.5 h-3.5 shrink-0" />
                )}
                {activeView.isDefault ? 'Remove as default' : 'Set as default'}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs gap-2 text-red-600 focus:text-red-600"
                onSelect={() => setDialog({ mode: 'delete', view: activeView })}
                data-testid={`menuitem-${testIdPrefix}-delete`}
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                Delete view...
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-xs gap-2"
            onSelect={onClearView}
            data-testid={`menuitem-${testIdPrefix}-clear`}
          >
            <RotateCcw className="w-3.5 h-3.5 shrink-0" />
            Clear filters (no view)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!dialog} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          {dialog?.mode === 'delete' ? (
            <>
              <DialogHeader>
                <DialogTitle>Delete saved view</DialogTitle>
                <DialogDescription>
                  Delete "{dialog.view.name}"? This only removes the saved view; it
                  does not change any members or data.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={closeDialog} disabled={dialogBusy} data-testid={`button-${testIdPrefix}-delete-cancel`}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDialogConfirm}
                  disabled={dialogBusy}
                  data-testid={`button-${testIdPrefix}-delete-confirm`}
                >
                  {dialogBusy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                  Delete view
                </Button>
              </DialogFooter>
            </>
          ) : dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.mode === 'create' ? 'Save view' : 'Rename view'}
                </DialogTitle>
                <DialogDescription>
                  {dialog.mode === 'create'
                    ? 'Saves the current filters, columns and sort as a named view.'
                    : 'Choose a new name for this saved view.'}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`${testIdPrefix}-view-name`} className="text-xs">
                    View name
                  </Label>
                  <Input
                    id={`${testIdPrefix}-view-name`}
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    placeholder="e.g. Active members"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleDialogConfirm();
                      }
                    }}
                    data-testid={`input-${testIdPrefix}-name`}
                  />
                </div>
                {dialog.mode === 'create' && (
                  <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                    <Checkbox
                      checked={makeDefaultInput}
                      onCheckedChange={(v) => setMakeDefaultInput(v === true)}
                      data-testid={`checkbox-${testIdPrefix}-make-default`}
                    />
                    Apply this view automatically when I open this page
                  </label>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeDialog} disabled={dialogBusy} data-testid={`button-${testIdPrefix}-dialog-cancel`}>
                  Cancel
                </Button>
                <Button
                  onClick={handleDialogConfirm}
                  disabled={dialogBusy || !nameInput.trim()}
                  data-testid={`button-${testIdPrefix}-dialog-confirm`}
                >
                  {dialogBusy && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                  {dialog.mode === 'create' ? 'Save view' : 'Rename'}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
