import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, FlaskConical, RefreshCw, Trash2, RotateCcw, Plus, CheckCircle, AlertTriangle, KeyRound } from 'lucide-react';
import { format } from 'date-fns';

const ACTION_META = {
  seed: { verb: 'Seeding', done: 'Seeded' },
  reset: { verb: 'Resetting', done: 'Reset' },
  delete: { verb: 'Deleting', done: 'Deleted' },
  'set-password': { verb: 'Setting portal password', done: 'Portal password set' },
};

export default function DemoTenants() {
  const { toast } = useToast();
  const [definitions, setDefinitions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null); // { key, action }
  const [confirm, setConfirm] = useState(null); // { def, action }
  const [confirmSlug, setConfirmSlug] = useState('');
  const [lastResult, setLastResult] = useState(null);
  const [portalPassword, setPortalPassword] = useState({}); // key -> desired password input

  const fetchDefinitions = useCallback(async () => {
    try {
      const response = await fetch('/api/platform/demo-tenants', { credentials: 'include' });
      const data = await response.json();
      if (response.ok) {
        setDefinitions(data.definitions || []);
      } else {
        toast({ title: 'Error', description: data.error || 'Failed to load demo tenants', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load demo tenants', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchDefinitions(); }, [fetchDefinitions]);

  const runOperation = async (def, action, extraBody = {}) => {
    setRunning({ key: def.key, action });
    setLastResult(null);
    try {
      const response = await fetch('/api/platform/demo-tenants/operate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          seedKey: def.key,
          action,
          ...(action === 'reset' || action === 'delete' ? { confirmSlug: def.slug } : {}),
          ...extraBody,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        setLastResult({ key: def.key, action, ok: true, data });
        toast({
          title: `${ACTION_META[action].done} successfully`,
          description: `${def.name} — ${action} completed.`,
        });
      } else {
        setLastResult({ key: def.key, action, ok: false, data });
        toast({
          title: `${ACTION_META[action].verb} failed`,
          description: data.error || 'Operation failed',
          variant: 'destructive',
        });
      }
    } catch (error) {
      setLastResult({
        key: def.key,
        action,
        ok: false,
        data: {
          error: error.message,
          hint: 'If this was a timeout, the operation is idempotent — run it again to safely resume.',
        },
      });
      toast({ title: 'Error', description: `Demo tenant ${action} failed: ${error.message}`, variant: 'destructive' });
    } finally {
      setRunning(null);
      fetchDefinitions();
    }
  };

  const openConfirm = (def, action) => {
    setConfirm({ def, action });
    setConfirmSlug('');
  };

  const handleConfirmed = () => {
    const { def, action } = confirm;
    setConfirm(null);
    runOperation(def, action);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {definitions.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No demo tenant definitions registered.
          </CardContent>
        </Card>
      )}

      {definitions.map((def) => {
        const installed = def.status?.installed;
        const busy = running?.key === def.key;
        const result = lastResult?.key === def.key ? lastResult : null;
        return (
          <Card key={def.key} data-testid={`card-demo-tenant-${def.key}`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="w-5 h-5" />
                {def.name}
                <Badge variant={installed ? 'default' : 'secondary'} data-testid={`badge-demo-status-${def.key}`}>
                  {installed ? 'Installed' : 'Not installed'}
                </Badge>
              </CardTitle>
              <CardDescription>
                Fictional, fully populated demo tenant managed by the seeding framework. All data is
                clearly marked as demo data; reseeding is idempotent and never duplicates records.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2 text-sm md:grid-cols-2">
                <div className="flex justify-between md:justify-start md:gap-2">
                  <span className="text-muted-foreground">Definition version:</span>
                  <span className="font-medium">{def.version}</span>
                </div>
                <div className="flex justify-between md:justify-start md:gap-2">
                  <span className="text-muted-foreground">Installed seed version:</span>
                  <span className="font-medium" data-testid={`text-seed-version-${def.key}`}>
                    {def.status?.seedVersion || '—'}
                  </span>
                </div>
                <div className="flex justify-between md:justify-start md:gap-2">
                  <span className="text-muted-foreground">Last seeded:</span>
                  <span className="font-medium" data-testid={`text-last-seeded-${def.key}`}>
                    {def.status?.lastSeededAt
                      ? format(new Date(def.status.lastSeededAt), 'MMM d, yyyy HH:mm')
                      : '—'}
                  </span>
                </div>
                <div className="flex justify-between md:justify-start md:gap-2">
                  <span className="text-muted-foreground">Tenant:</span>
                  <span className="font-medium">
                    <code className="text-sm bg-muted px-2 py-1 rounded">{def.slug}</code>
                    {installed && def.status?.tenantId ? (
                      <span className="text-xs text-muted-foreground ml-2">{def.status.tenantId}</span>
                    ) : null}
                  </span>
                </div>
              </div>

              {installed && def.status?.counts && Object.keys(def.status.counts).length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Seeded: {Object.entries(def.status.counts)
                    .filter(([, v]) => typeof v === 'number')
                    .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
                    .join(' · ')}
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-2 border-t">
                {!installed && (
                  <Button
                    onClick={() => runOperation(def, 'seed')}
                    disabled={!!running}
                    data-testid={`button-create-demo-${def.key}`}
                  >
                    {busy && running.action === 'seed' ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating…</>
                    ) : (
                      <><Plus className="w-4 h-4 mr-2" />Create Demo Tenant</>
                    )}
                  </Button>
                )}
                {installed && (
                  <>
                    <Button
                      onClick={() => runOperation(def, 'seed')}
                      disabled={!!running}
                      data-testid={`button-reseed-demo-${def.key}`}
                    >
                      {busy && running.action === 'seed' ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Reseeding…</>
                      ) : (
                        <><RefreshCw className="w-4 h-4 mr-2" />Reseed / Refresh</>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => openConfirm(def, 'reset')}
                      disabled={!!running}
                      data-testid={`button-reset-demo-${def.key}`}
                    >
                      {busy && running.action === 'reset' ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Resetting…</>
                      ) : (
                        <><RotateCcw className="w-4 h-4 mr-2" />Reset</>
                      )}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => openConfirm(def, 'delete')}
                      disabled={!!running}
                      data-testid={`button-delete-demo-${def.key}`}
                    >
                      {busy && running.action === 'delete' ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Deleting…</>
                      ) : (
                        <><Trash2 className="w-4 h-4 mr-2" />Delete</>
                      )}
                    </Button>
                  </>
                )}
              </div>

              {installed && (def.loginPersonas || []).length > 0 && (
                <div className="pt-2 border-t space-y-2" data-testid={`section-portal-logins-${def.key}`}>
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <KeyRound className="w-4 h-4" />
                    Member portal logins
                  </div>
                  <div className="text-sm space-y-1">
                    {def.loginPersonas.map((p) => (
                      <div key={p.email} className="flex flex-wrap items-center gap-2" data-testid={`row-persona-${p.email}`}>
                        <span className="font-medium">{p.name}</span>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{p.email}</code>
                        <span className="text-xs text-muted-foreground">{p.role}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    All portal personas share one demo password. Set or reset it here — the password is
                    shown once and only a secure hash is stored.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      className="w-56"
                      placeholder="New password (blank = generate)"
                      value={portalPassword[def.key] || ''}
                      onChange={(e) => setPortalPassword((s) => ({ ...s, [def.key]: e.target.value }))}
                      data-testid={`input-portal-password-${def.key}`}
                    />
                    <Button
                      variant="outline"
                      onClick={() => {
                        const pw = (portalPassword[def.key] || '').trim();
                        runOperation(def, 'set-password', pw ? { password: pw } : {});
                        setPortalPassword((s) => ({ ...s, [def.key]: '' }));
                      }}
                      disabled={
                        !!running ||
                        ((portalPassword[def.key] || '').trim().length > 0 &&
                          (portalPassword[def.key] || '').trim().length < 8)
                      }
                      data-testid={`button-set-portal-password-${def.key}`}
                    >
                      {busy && running.action === 'set-password' ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Setting…</>
                      ) : (
                        <><KeyRound className="w-4 h-4 mr-2" />Set portal password</>
                      )}
                    </Button>
                  </div>
                  {(portalPassword[def.key] || '').trim().length > 0 &&
                    (portalPassword[def.key] || '').trim().length < 8 && (
                    <p className="text-xs text-destructive">Password must be at least 8 characters.</p>
                  )}
                </div>
              )}

              {busy && (
                <p className="text-sm text-muted-foreground">
                  {ACTION_META[running.action].verb} the demo tenant — this can take a few minutes. Leave this
                  page open; if it times out, running the same action again safely resumes it.
                </p>
              )}

              {result && (
                <div
                  className={`rounded-md border p-3 text-sm ${
                    result.ok
                      ? 'border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950'
                      : 'border-destructive/40 bg-destructive/5'
                  }`}
                  data-testid={`result-demo-${def.key}`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    {result.ok ? (
                      <CheckCircle className="w-4 h-4 text-green-600" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-destructive" />
                    )}
                    {result.ok
                      ? `${ACTION_META[result.action].done} successfully.`
                      : `${ACTION_META[result.action].verb} failed: ${result.data?.error || 'Unknown error'}`}
                  </div>
                  {!result.ok && result.data?.hint && (
                    <p className="text-muted-foreground mt-1">{result.data.hint}</p>
                  )}
                  {result.ok && result.action === 'seed' && result.data?.result?.adminSetup && (
                    <p className="text-muted-foreground mt-1">
                      Demo owner login: <strong>{result.data.result.adminSetup.email}</strong>{' '}
                      (password: {result.data.result.adminSetup.password})
                    </p>
                  )}
                  {result.ok && result.action === 'set-password' && result.data?.result && (
                    <div className="text-muted-foreground mt-1 space-y-1" data-testid={`result-portal-password-${def.key}`}>
                      <p>
                        Shared portal password: <strong><code>{result.data.result.password}</code></strong>{' '}
                        — copy it now; it is shown only once.
                      </p>
                      <p>
                        {result.data.result.updated} persona account(s) updated
                        {result.data.result.repaired ? ` (${result.data.result.repaired} repaired)` : ''}.
                      </p>
                      {(result.data.result.personas || []).some((p) => p.outcome === 'skipped' || p.outcome === 'failed') && (
                        <div className="text-destructive" data-testid={`portal-password-issues-${def.key}`}>
                          <p className="font-medium">Some personas were NOT updated — their logins may not work:</p>
                          <ul className="list-disc pl-5">
                            {result.data.result.personas
                              .filter((p) => p.outcome === 'skipped' || p.outcome === 'failed')
                              .map((p) => (
                                <li key={p.email}>
                                  {p.email} — {p.outcome}{p.reason ? `: ${p.reason}` : ''}
                                </li>
                              ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                  {result.ok && result.action === 'reset' && (
                    <p className="text-muted-foreground mt-1">
                      {result.data?.result?.removed ?? 0} seeded rows removed. Use Reseed / Refresh to repopulate.
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {confirm?.action === 'delete' ? 'Delete Demo Tenant' : 'Reset Demo Tenant'}
            </DialogTitle>
            <DialogDescription>
              {confirm?.action === 'delete' ? (
                <>
                  This permanently removes the <strong>{confirm?.def?.name}</strong> demo tenant — all seeded
                  data, its members and the tenant itself. This cannot be undone (but it can be re-created).
                </>
              ) : (
                <>
                  This removes all seeded demo data from <strong>{confirm?.def?.name}</strong> while keeping
                  the tenant shell. You can reseed afterwards.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 mt-2">
            <Label htmlFor="confirm-demo-slug">
              Type <code className="bg-muted px-1 rounded">{confirm?.def?.slug}</code> to confirm
            </Label>
            <Input
              id="confirm-demo-slug"
              value={confirmSlug}
              onChange={(e) => setConfirmSlug(e.target.value)}
              placeholder="Enter slug to confirm"
              data-testid="input-confirm-demo-slug"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} data-testid="button-cancel-demo-op">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmed}
              disabled={confirmSlug !== confirm?.def?.slug}
              data-testid="button-confirm-demo-op"
            >
              {confirm?.action === 'delete' ? 'Delete Permanently' : 'Reset Demo Data'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
