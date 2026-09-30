import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

// Named saved-report switcher for export dialogs (modelled on
// SavedViewSwitcher). Purely presentational: the page supplies the reports
// plus callbacks; persistence lives in useSavedExportReports and applying a
// report's config to dialog state lives in the page.
export default function ExportReportSwitcher({
  reports,
  activeReportId,
  isDirty,          // current settings differ from the active report
  isSaving,
  onApplyReport,    // (report) => void
  onClearReport,    // () => void — deselect, keep current settings
  onCreateReport,   // (name) => Promise
  onUpdateReport,   // (report) => Promise — overwrite with current settings
  onRenameReport,   // (report, name) => Promise
  onDeleteReport,   // (report) => Promise
  testIdPrefix = 'export-report',
}) {
  const [dialog, setDialog] = useState(null); // { mode: 'create' | 'rename' | 'delete', report? }
  const [nameInput, setNameInput] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);

  const activeReport = reports.find((r) => r.id === activeReportId) || null;

  const openCreateDialog = () => {
    setNameInput('');
    setDialog({ mode: 'create' });
  };
  const openRenameDialog = (report) => {
    setNameInput(report.name);
    setDialog({ mode: 'rename', report });
  };
  const closeDialog = () => {
    if (dialogBusy) return;
    setDialog(null);
  };

  const failToast = () =>
    toast.error('Could not save your change. Please try again.');

  const handleDialogConfirm = async () => {
    if (!dialog) return;
    if (dialog.mode === 'delete') {
      setDialogBusy(true);
      try {
        await onDeleteReport(dialog.report);
        toast.success(`Report "${dialog.report.name}" deleted`);
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
        await onCreateReport(name);
        toast.success(`Report "${name}" saved`);
      } else {
        await onRenameReport(dialog.report, name);
        toast.success(`Report renamed to "${name}"`);
      }
      setDialog(null);
    } catch {
      failToast();
    } finally {
      setDialogBusy(false);
    }
  };

  const handleUpdate = async () => {
    if (!activeReport) return;
    try {
      await onUpdateReport(activeReport);
      toast.success(`Report "${activeReport.name}" updated with the current settings`);
    } catch {
      failToast();
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 min-w-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="justify-between font-normal min-w-0 flex-1 sm:flex-none sm:w-64 gap-2"
              data-testid={`button-${testIdPrefix}-switcher`}
            >
              <span className="flex items-center gap-1.5 min-w-0">
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Bookmark className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {activeReport ? activeReport.name : 'No saved report'}
                </span>
              </span>
              <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-xs">Saved reports</DropdownMenuLabel>
            {reports.length === 0 ? (
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                No saved reports yet
              </DropdownMenuItem>
            ) : (
              reports.map((report) => (
                <DropdownMenuItem
                  key={report.id}
                  className="text-xs gap-2"
                  onSelect={() => onApplyReport(report)}
                  data-testid={`menuitem-${testIdPrefix}-apply-${report.id}`}
                >
                  <Check
                    className={`w-3.5 h-3.5 shrink-0 ${report.id === activeReportId ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <span className="truncate flex-1">{report.name}</span>
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
              Save current settings as new report...
            </DropdownMenuItem>
            {activeReport && (
              <>
                <DropdownMenuItem
                  className="text-xs gap-2"
                  onSelect={handleUpdate}
                  data-testid={`menuitem-${testIdPrefix}-update`}
                >
                  <Save className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">Update "{activeReport.name}"</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs gap-2"
                  onSelect={() => openRenameDialog(activeReport)}
                  data-testid={`menuitem-${testIdPrefix}-rename`}
                >
                  <Pencil className="w-3.5 h-3.5 shrink-0" />
                  Rename...
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs gap-2 text-red-600 focus:text-red-600"
                  onSelect={() => setDialog({ mode: 'delete', report: activeReport })}
                  data-testid={`menuitem-${testIdPrefix}-delete`}
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  Delete report...
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-xs gap-2"
                  onSelect={onClearReport}
                  data-testid={`menuitem-${testIdPrefix}-clear`}
                >
                  <X className="w-3.5 h-3.5 shrink-0" />
                  Deselect report (keep settings)
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {activeReport && isDirty && (
          <Badge variant="outline" data-testid={`badge-${testIdPrefix}-modified`}>
            Modified
          </Badge>
        )}
      </div>

      <Dialog open={!!dialog} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="sm:max-w-md">
          {dialog?.mode === 'delete' ? (
            <>
              <DialogHeader>
                <DialogTitle>Delete saved report</DialogTitle>
                <DialogDescription>
                  Delete "{dialog.report.name}"? This removes the saved report for
                  every admin; it does not change any transactions or data.
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
                  Delete report
                </Button>
              </DialogFooter>
            </>
          ) : dialog ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.mode === 'create' ? 'Save report' : 'Rename report'}
                </DialogTitle>
                <DialogDescription>
                  {dialog.mode === 'create'
                    ? 'Saves the current export settings as a named report shared with every admin.'
                    : 'Choose a new name for this saved report.'}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor={`${testIdPrefix}-report-name`} className="text-xs">
                  Report name
                </Label>
                <Input
                  id={`${testIdPrefix}-report-name`}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="e.g. Monthly booking usage"
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
                  {dialog.mode === 'create' ? 'Save report' : 'Rename'}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
