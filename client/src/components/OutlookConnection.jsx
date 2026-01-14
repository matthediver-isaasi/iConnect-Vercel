import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Mail, RefreshCw, CheckCircle2, AlertTriangle, ExternalLink, Unlink } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { SiMicrosoftoutlook } from 'react-icons/si';

export default function OutlookConnection() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    fetchConnectionStatus();
    
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('outlook_connected') === 'true') {
      toast({
        title: 'Outlook Connected',
        description: 'Your Outlook account has been connected successfully.',
      });
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (urlParams.get('outlook_error')) {
      toast({
        title: 'Connection Failed',
        description: `Failed to connect Outlook: ${urlParams.get('outlook_error')}`,
        variant: 'destructive',
      });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const fetchConnectionStatus = async () => {
    try {
      const response = await fetch('/api/outlook/status', { credentials: 'include' });
      if (response.ok) {
        const data = await response.json();
        setConnection(data);
      }
    } catch (err) {
      console.error('Failed to fetch Outlook status:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = () => {
    window.location.href = '/api/auth/outlook?returnTo=' + encodeURIComponent(window.location.pathname);
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const response = await fetch('/api/outlook/status', {
        method: 'DELETE',
        credentials: 'include'
      });
      
      if (response.ok) {
        setConnection({ connected: false });
        toast({
          title: 'Outlook Disconnected',
          description: 'Your Outlook account has been disconnected.',
        });
      } else {
        const data = await response.json();
        toast({
          title: 'Disconnection Failed',
          description: data.error || 'Failed to disconnect Outlook',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'Error',
        description: 'Failed to disconnect Outlook',
        variant: 'destructive',
      });
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const response = await fetch('/api/outlook/sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      const data = await response.json();
      
      if (response.ok) {
        toast({
          title: 'Sync Complete',
          description: data.message || `Synced ${data.synced} emails`,
        });
        fetchConnectionStatus();
      } else {
        toast({
          title: 'Sync Failed',
          description: data.error || 'Failed to sync emails',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: 'Error',
        description: 'Failed to sync emails',
        variant: 'destructive',
      });
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <SiMicrosoftoutlook className="h-5 w-5 text-blue-600" />
          <CardTitle>Outlook Integration</CardTitle>
        </div>
        <CardDescription>
          Connect your Outlook account to sync and send emails directly from member records
        </CardDescription>
      </CardHeader>
      <CardContent>
        {connection?.connected ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-full">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="font-medium">{connection.displayName || 'Connected'}</p>
                  <p className="text-sm text-muted-foreground">{connection.email}</p>
                </div>
              </div>
              <Badge variant={connection.status === 'active' ? 'default' : 'destructive'}>
                {connection.status === 'active' ? 'Active' : connection.status}
              </Badge>
            </div>

            {connection.syncError && (
              <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-sm">Last sync had errors</span>
              </div>
            )}

            <div className="text-sm text-muted-foreground">
              {connection.lastSyncAt ? (
                <span>Last synced: {new Date(connection.lastSyncAt).toLocaleString()}</span>
              ) : (
                <span>Not synced yet</span>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleSync}
                disabled={syncing}
                variant="outline"
                data-testid="button-sync-outlook"
              >
                {syncing ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Sync Emails
              </Button>
              <Button
                onClick={handleDisconnect}
                disabled={disconnecting}
                variant="outline"
                className="text-destructive hover:text-destructive"
                data-testid="button-disconnect-outlook"
              >
                {disconnecting ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Unlink className="h-4 w-4 mr-2" />
                )}
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Connect your Microsoft Outlook account to:
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 ml-4 list-disc">
              <li>View email history on member records</li>
              <li>Send emails directly from member profiles</li>
              <li>Track all communication in one place</li>
            </ul>
            <Button
              onClick={handleConnect}
              className="gap-2"
              data-testid="button-connect-outlook"
            >
              <SiMicrosoftoutlook className="h-4 w-4" />
              Connect Outlook
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
