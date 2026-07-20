import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Database, HardDrive, Play, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { format } from 'date-fns';

const MAX_CHUNKS = 500; // safety cap on resume iterations per manual run

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const STALLED_AFTER_MS = 3 * 60 * 60 * 1000; // no cursor progress for 3h => stalled

function cursorSummary(cursor) {
  if (!cursor) return { label: 'Never run', tone: 'idle' };
  if (cursor.completed) {
    const when = cursor.clearedAt ? format(new Date(cursor.clearedAt), 'MMM d, yyyy HH:mm') : 'unknown';
    return { label: `Last completed ${when}`, tone: 'done' };
  }
  const lastActivity = cursor.updatedAt ? new Date(cursor.updatedAt) : null;
  if (lastActivity && !Number.isNaN(lastActivity.getTime())) {
    if (Date.now() - lastActivity.getTime() > STALLED_AFTER_MS) {
      return {
        label: `Paused mid-run since ${format(lastActivity, 'MMM d, yyyy HH:mm')} — not progressing, check the scheduled job`,
        tone: 'stalled',
      };
    }
    return {
      label: `In progress — resuming automatically (last activity ${format(lastActivity, 'HH:mm')})`,
      tone: 'paused',
    };
  }
  return { label: 'Paused mid-run — will resume automatically on the next scheduled run', tone: 'paused' };
}

export default function BackupManagement() {
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [running, setRunning] = useState(null); // 'storage' | 'database' | null
  const [storageProgress, setStorageProgress] = useState(null);
  const [databaseProgress, setDatabaseProgress] = useState(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    fetchStatus();
    return () => { cancelRef.current = true; };
  }, []);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/platform/backups/status', { credentials: 'include' });
      const data = await res.json();
      if (res.ok) setStatus(data);
    } catch {
      // non-fatal; status is informational
    } finally {
      setStatusLoading(false);
    }
  };

  const runChunk = async (type) => {
    const res = await fetch('/api/platform/backups/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ type }),
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Backup ${type} failed`);
    }
    return data;
  };

  const runStorage = async () => {
    setRunning('storage');
    cancelRef.current = false;
    let totals = { copied: 0, skipped: 0, errored: 0, bytes: 0, chunks: 0 };
    setStorageProgress({ ...totals, state: 'running' });
    try {
      for (let i = 0; i < MAX_CHUNKS; i++) {
        if (cancelRef.current) break;
        const chunk = await runChunk('storage');
        totals = {
          copied: totals.copied + (chunk.copied || 0),
          skipped: totals.skipped + (chunk.skipped || 0),
          errored: totals.errored + (chunk.errored || 0),
          bytes: totals.bytes + (chunk.bytes || 0),
          chunks: totals.chunks + 1,
        };
        const done = !chunk.deferred;
        setStorageProgress({ ...totals, state: done ? 'done' : 'running' });
        if (done) {
          toast({ title: 'Storage backup complete', description: `${totals.copied} copied, ${totals.skipped} unchanged, ${totals.errored} errored` });
          break;
        }
      }
    } catch (err) {
      setStorageProgress((p) => ({ ...(p || totals), state: 'error', error: err.message }));
      toast({ title: 'Storage backup failed', description: err.message, variant: 'destructive' });
    } finally {
      setRunning(null);
      fetchStatus();
    }
  };

  const runDatabase = async () => {
    setRunning('database');
    cancelRef.current = false;
    let dumped = 0;
    let totalTables = 0;
    let bytes = 0;
    setDatabaseProgress({ dumped: 0, totalTables: 0, bytes: 0, state: 'running' });
    try {
      for (let i = 0; i < MAX_CHUNKS; i++) {
        if (cancelRef.current) break;
        const chunk = await runChunk('database');
        totalTables = chunk.totalTables || totalTables;
        dumped += (chunk.dumped?.length || 0);
        bytes += (chunk.totalCompressedBytes || 0);
        const errored = chunk.errored?.length || 0;
        setDatabaseProgress({ dumped, totalTables, bytes, errored, state: chunk.complete ? 'done' : 'running' });
        if (chunk.complete) {
          toast({ title: 'Database backup complete', description: `${dumped} of ${totalTables} tables dumped (${formatBytes(bytes)})` });
          break;
        }
        if (errored > 0 && !chunk.skipped?.length) {
          // No remaining tables but some errored — stop with partial result
          setDatabaseProgress({ dumped, totalTables, bytes, errored, state: 'error', error: `${errored} table(s) failed` });
          break;
        }
      }
    } catch (err) {
      setDatabaseProgress((p) => ({ ...(p || { dumped, totalTables, bytes }), state: 'error', error: err.message }));
      toast({ title: 'Database backup failed', description: err.message, variant: 'destructive' });
    } finally {
      setRunning(null);
      fetchStatus();
    }
  };

  const storageStatus = cursorSummary(status?.storage);
  const databaseStatus = cursorSummary(status?.database);
  const notConfigured = status && status.configured === false;

  return (
    <div className="space-y-6">
      {notConfigured && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Backup storage not configured</AlertTitle>
          <AlertDescription>
            Cloudflare R2 credentials (R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ACCOUNT_ID or
            R2_ENDPOINT) are not set. Manual backups will fail until these are configured.
          </AlertDescription>
        </Alert>
      )}

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>How manual backups work</AlertTitle>
        <AlertDescription>
          Backups run automatically every day and finish on their own — the scheduled job keeps resuming until each
          backup completes. Triggering one here runs the same job immediately and streams it to
          Cloudflare R2 in resumable chunks — keep this tab open until it reports complete. Storage backups are
          incremental (only new or changed files are copied); database backups write a fresh timestamped dump.
        </AlertDescription>
      </Alert>

      {/* Storage backup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="w-5 h-5" />
            Storage Backup
          </CardTitle>
          <CardDescription>
            Incrementally copies every Supabase Storage file to Cloudflare R2, preserving bucket and path structure.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              {statusLoading ? 'Loading status…' : storageStatus.label}
            </div>
            <Button
              onClick={runStorage}
              disabled={running !== null}
              data-testid="button-run-storage-backup"
            >
              {running === 'storage' ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Backing up…
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Run Storage Backup
                </>
              )}
            </Button>
          </div>

          {storageProgress && (
            <div className="rounded-md border p-4 space-y-3" data-testid="progress-storage">
              <div className="flex items-center gap-2">
                {storageProgress.state === 'running' && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                {storageProgress.state === 'done' && <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-500" />}
                {storageProgress.state === 'error' && <AlertTriangle className="w-4 h-4 text-destructive" />}
                <span className="text-sm font-medium">
                  {storageProgress.state === 'running' && 'Backing up storage…'}
                  {storageProgress.state === 'done' && 'Storage backup complete'}
                  {storageProgress.state === 'error' && 'Storage backup failed'}
                </span>
              </div>
              {storageProgress.state === 'running' && <Progress value={null} className="h-2" />}
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary" data-testid="badge-storage-copied">{storageProgress.copied} copied</Badge>
                <Badge variant="secondary">{storageProgress.skipped} unchanged</Badge>
                <Badge variant="secondary">{formatBytes(storageProgress.bytes)}</Badge>
                {storageProgress.errored > 0 && (
                  <Badge variant="warning">{storageProgress.errored} errored</Badge>
                )}
              </div>
              {storageProgress.error && (
                <p className="text-sm text-destructive">{storageProgress.error}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Database backup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            Database Backup
          </CardTitle>
          <CardDescription>
            Writes a fresh, timestamped compressed dump of every table to Cloudflare R2.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              {statusLoading ? 'Loading status…' : databaseStatus.label}
            </div>
            <Button
              onClick={runDatabase}
              disabled={running !== null}
              data-testid="button-run-database-backup"
            >
              {running === 'database' ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Backing up…
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 mr-2" />
                  Run Database Backup
                </>
              )}
            </Button>
          </div>

          {databaseProgress && (
            <div className="rounded-md border p-4 space-y-3" data-testid="progress-database">
              <div className="flex items-center gap-2">
                {databaseProgress.state === 'running' && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                {databaseProgress.state === 'done' && <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-500" />}
                {databaseProgress.state === 'error' && <AlertTriangle className="w-4 h-4 text-destructive" />}
                <span className="text-sm font-medium">
                  {databaseProgress.state === 'running' && 'Dumping tables…'}
                  {databaseProgress.state === 'done' && 'Database backup complete'}
                  {databaseProgress.state === 'error' && 'Database backup failed'}
                </span>
              </div>
              <Progress
                value={databaseProgress.totalTables > 0 ? Math.round((databaseProgress.dumped / databaseProgress.totalTables) * 100) : null}
                className="h-2"
              />
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary" data-testid="badge-database-tables">
                  {databaseProgress.dumped}{databaseProgress.totalTables > 0 ? ` / ${databaseProgress.totalTables}` : ''} tables
                </Badge>
                <Badge variant="secondary">{formatBytes(databaseProgress.bytes)}</Badge>
                {databaseProgress.errored > 0 && (
                  <Badge variant="warning">{databaseProgress.errored} errored</Badge>
                )}
              </div>
              {databaseProgress.error && (
                <p className="text-sm text-destructive">{databaseProgress.error}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
