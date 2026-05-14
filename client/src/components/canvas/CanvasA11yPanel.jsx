import { useMemo } from 'react';
import {
  ShieldAlert, AlertTriangle, Info, ShieldCheck, CircleAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  SEVERITY,
  summarizeIssues,
  getBlockingIssues,
} from '@/lib/canvasA11y';

const SEV_ICON = {
  [SEVERITY.ERROR]: CircleAlert,
  [SEVERITY.WARNING]: AlertTriangle,
  [SEVERITY.INFO]: Info,
};

const SEV_CLASS = {
  [SEVERITY.ERROR]: 'text-destructive',
  [SEVERITY.WARNING]: 'text-amber-600',
  [SEVERITY.INFO]: 'text-slate-500',
};

const SEV_BG = {
  [SEVERITY.ERROR]: 'bg-destructive/10 border-destructive/20',
  [SEVERITY.WARNING]: 'bg-amber-50 border-amber-200',
  [SEVERITY.INFO]: 'bg-slate-50 border-slate-200',
};

const SEV_LABEL = {
  [SEVERITY.ERROR]: 'Error',
  [SEVERITY.WARNING]: 'Warning',
  [SEVERITY.INFO]: 'Info',
};

export default function CanvasA11yPanel({ issues, selectedIds, onJumpToBlock }) {
  const summary = useMemo(() => summarizeIssues(issues), [issues]);
  const blocking = useMemo(() => getBlockingIssues(issues), [issues]);
  const grouped = useMemo(() => {
    const order = [SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.INFO];
    return order.map((sev) => ({
      sev,
      items: issues.filter((i) => i.severity === sev),
    })).filter((g) => g.items.length > 0);
  }, [issues]);

  return (
    <div className="space-y-2" data-testid="canvas-a11y-panel">
      <div className="flex items-center gap-2">
        {summary.errors > 0 ? (
          <ShieldAlert className="w-4 h-4 text-destructive" />
        ) : summary.total === 0 ? (
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
        ) : (
          <ShieldAlert className="w-4 h-4 text-amber-500" />
        )}
        <h2 className="text-sm font-semibold text-slate-900">Accessibility</h2>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge
          variant="outline"
          className={summary.errors > 0 ? 'border-destructive/40 text-destructive' : ''}
          data-testid="a11y-count-errors"
        >
          {summary.errors} errors
        </Badge>
        <Badge variant="outline" data-testid="a11y-count-warnings">
          {summary.warnings} warnings
        </Badge>
        <Badge variant="outline" data-testid="a11y-count-info">
          {summary.info} info
        </Badge>
      </div>

      {blocking.length > 0 && (
        <p className="text-[11px] text-destructive" data-testid="a11y-blocking-hint">
          {blocking.length} must-fix issue{blocking.length === 1 ? '' : 's'} block publish.
        </p>
      )}

      {issues.length === 0 ? (
        <div
          className="text-xs text-slate-600 px-2 py-3 rounded border border-emerald-200 bg-emerald-50"
          data-testid="a11y-empty"
        >
          No accessibility issues detected.
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map((g) => (
            <div key={g.sev} className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 px-1">
                {SEV_LABEL[g.sev]} ({g.items.length})
              </div>
              {g.items.map((it, idx) => {
                const Icon = SEV_ICON[it.severity] || Info;
                const isSelected = it.blockId && selectedIds?.includes(it.blockId);
                const interactive = !!it.blockId;
                return (
                  <button
                    key={`${it.rule}-${it.blockId || 'doc'}-${idx}`}
                    type="button"
                    onClick={() => interactive && onJumpToBlock?.(it.blockId)}
                    disabled={!interactive}
                    className={`w-full text-left rounded border px-2 py-1.5 text-xs ${SEV_BG[it.severity]} ${
                      interactive ? 'hover-elevate active-elevate-2 cursor-pointer' : 'cursor-default'
                    } ${isSelected ? 'ring-1 ring-primary/40' : ''}`}
                    data-testid={`a11y-issue-${it.rule}`}
                    data-block-id={it.blockId || ''}
                  >
                    <div className="flex items-start gap-1.5">
                      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${SEV_CLASS[it.severity]}`} />
                      <div className="min-w-0 flex-1">
                        {it.blockName && (
                          <div className="font-medium truncate text-slate-900">
                            {it.blockName}
                          </div>
                        )}
                        <div className="text-slate-700">{it.message}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5 font-mono">
                          {it.rule}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
