import { useMemo } from 'react';
import {
  ShieldAlert, AlertTriangle, Info, ShieldCheck, CircleAlert,
  ExternalLink, Crosshair,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  [SEVERITY.WARNING]: 'text-amber-700',
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

function truncate(str, max = 160) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export default function CanvasA11yPanel({ issues, selectedIds, onJumpToBlock, onLocate }) {
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
          <ShieldAlert className="w-4 h-4 text-amber-700" />
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
        <p className="text-[11px] text-amber-700" data-testid="a11y-blocking-hint">
          {blocking.length} must-fix issue{blocking.length === 1 ? '' : 's'} flagged — publish will ask you to confirm.
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
                const canJump = !!it.blockId;
                const selector = Array.isArray(it.selector)
                  ? it.selector.join(' ')
                  : (it.selector || '');
                const canLocate = !!onLocate && canJump;
                const showDisabledLocate = !!onLocate && !canJump;
                const handleRowClick = canJump ? () => onJumpToBlock?.(it.blockId) : undefined;
                const handleRowKey = canJump
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onJumpToBlock?.(it.blockId);
                      }
                    }
                  : undefined;
                return (
                  <div
                    key={`${it.rule}-${it.blockId || selector || 'doc'}-${idx}`}
                    className={`rounded border px-2 py-1.5 text-xs ${SEV_BG[it.severity]} ${
                      isSelected ? 'ring-1 ring-primary/40' : ''
                    } ${canJump ? 'cursor-pointer hover-elevate' : ''}`}
                    data-testid={`a11y-issue-${it.rule}`}
                    data-block-id={it.blockId || ''}
                    role={canJump ? 'button' : undefined}
                    tabIndex={canJump ? 0 : undefined}
                    onClick={handleRowClick}
                    onKeyDown={handleRowKey}
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
                        {!it.blockId && selector && (
                          <div
                            className="text-[10px] text-slate-600 mt-1 font-mono break-all"
                            data-testid={`a11y-issue-selector-${it.rule}`}
                          >
                            {selector}
                          </div>
                        )}
                        {!it.blockId && it.html && (
                          <div
                            className="text-[10px] text-slate-500 mt-1 font-mono break-all"
                            data-testid={`a11y-issue-html-${it.rule}`}
                          >
                            {truncate(it.html, 200)}
                          </div>
                        )}
                        <div className="flex items-center flex-wrap gap-2 mt-1">
                          <span className="text-[10px] text-slate-500 font-mono">
                            {it.rule}
                          </span>
                          {it.helpUrl && (
                            <a
                              href={it.helpUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-primary inline-flex items-center gap-0.5 hover:underline"
                              data-testid={`a11y-issue-help-${it.rule}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              Learn more <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-1 mt-1.5">
                          {canJump && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px]"
                              onClick={(e) => { e.stopPropagation(); onJumpToBlock?.(it.blockId); }}
                              data-testid={`a11y-issue-jump-${it.rule}`}
                            >
                              Jump to block
                            </Button>
                          )}
                          {canLocate && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px]"
                              onClick={(e) => { e.stopPropagation(); onLocate?.(it); }}
                              data-testid={`a11y-issue-locate-${it.rule}`}
                              title="Select this block on the canvas"
                            >
                              <Crosshair className="w-3 h-3 mr-1" />
                              Locate
                            </Button>
                          )}
                          {showDisabledLocate && (
                            <span
                              className="inline-flex"
                              title="This issue applies to the whole page — there is no specific block to locate."
                              data-testid={`a11y-issue-locate-disabled-wrapper-${it.rule}`}
                            >
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[11px] pointer-events-none"
                                disabled
                                tabIndex={-1}
                                data-testid={`a11y-issue-locate-disabled-${it.rule}`}
                              >
                                <Crosshair className="w-3 h-3 mr-1" />
                                No block to locate
                              </Button>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
