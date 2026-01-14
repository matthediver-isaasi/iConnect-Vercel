import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  Loader2, 
  Mail, 
  MailOpen, 
  Send, 
  Inbox,
  RefreshCw, 
  ChevronDown, 
  ChevronUp,
  Paperclip,
  Clock,
  AlertTriangle,
  CheckCircle2
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/components/ui/use-toast';
import ComposeEmailModal from './ComposeEmailModal';

export default function MemberEmails({ memberId, memberEmail, memberName }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedEmail, setExpandedEmail] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [autoSyncStatus, setAutoSyncStatus] = useState('idle');
  const [composeOpen, setComposeOpen] = useState(false);
  const autoSyncDone = useRef(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['member-emails', memberId],
    queryFn: async () => {
      const response = await fetch(`/api/outlook/emails/${memberId}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to fetch emails');
      }
      return response.json();
    },
    enabled: !!memberId
  });

  useEffect(() => {
    if (!memberId || autoSyncDone.current) return;
    
    const autoSync = async () => {
      autoSyncDone.current = true;
      setAutoSyncStatus('syncing');
      
      try {
        const response = await fetch('/api/outlook/sync', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId })
        });
        
        if (response.ok) {
          const result = await response.json();
          if (result.synced > 0) {
            setAutoSyncStatus('synced');
            queryClient.invalidateQueries({ queryKey: ['member-emails', memberId] });
          } else {
            setAutoSyncStatus('idle');
          }
        } else {
          setAutoSyncStatus('idle');
        }
      } catch (err) {
        console.error('Auto-sync failed:', err);
        setAutoSyncStatus('idle');
      }
      
      setTimeout(() => setAutoSyncStatus('idle'), 3000);
    };
    
    autoSync();
  }, [memberId, queryClient]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const response = await fetch('/api/outlook/sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId })
      });
      
      const result = await response.json();
      
      if (response.ok) {
        toast({
          title: 'Sync Complete',
          description: result.message || `Synced ${result.synced} emails`,
        });
        refetch();
      } else {
        toast({
          title: 'Sync Failed',
          description: result.error || 'Failed to sync emails',
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

  const toggleExpand = (emailId) => {
    setExpandedEmail(expandedEmail === emailId ? null : emailId);
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <AlertTriangle className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">Unable to load emails</p>
              <p className="text-sm text-muted-foreground">{error.message}</p>
            </div>
            <Button variant="outline" onClick={() => refetch()} data-testid="button-retry-emails">
              Try Again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const emails = data?.emails || [];

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Email History
              {autoSyncStatus === 'syncing' && (
                <Badge variant="secondary" className="text-xs font-normal">
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  Syncing
                </Badge>
              )}
              {autoSyncStatus === 'synced' && (
                <Badge variant="secondary" className="text-xs font-normal text-green-600">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Updated
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {emails.length} email{emails.length !== 1 ? 's' : ''} with {memberEmail || 'this member'}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing}
              data-testid="button-sync-member-emails"
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="sm"
              onClick={() => setComposeOpen(true)}
              data-testid="button-compose-email"
            >
              <Send className="h-4 w-4 mr-2" />
              Compose
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {emails.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <Mail className="h-12 w-12 text-muted-foreground/50" />
              <div>
                <p className="font-medium">No emails found</p>
                <p className="text-sm text-muted-foreground">
                  Click sync to fetch emails or compose a new message
                </p>
              </div>
            </div>
          ) : (
            <ScrollArea className="h-[500px]">
              <div className="space-y-2">
                {emails.map((email) => (
                  <div
                    key={email.id}
                    className="border rounded-lg overflow-hidden"
                  >
                    <button
                      className="w-full p-3 text-left hover:bg-muted/50 transition-colors"
                      onClick={() => toggleExpand(email.id)}
                      data-testid={`button-email-${email.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="mt-0.5">
                            {email.direction === 'inbound' ? (
                              <Inbox className="h-4 w-4 text-blue-500" />
                            ) : (
                              <Send className="h-4 w-4 text-green-500" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">
                                {email.subject || '(No subject)'}
                              </span>
                              {email.has_attachments && (
                                <Paperclip className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground truncate">
                              {email.body_preview}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <div className="text-right">
                            <Badge variant={email.direction === 'inbound' ? 'secondary' : 'outline'}>
                              {email.direction === 'inbound' ? 'Received' : 'Sent'}
                            </Badge>
                            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {format(new Date(email.sent_at || email.received_at), 'MMM d, h:mm a')}
                            </p>
                            {email.synced_by_name && (
                              <p className="text-xs text-muted-foreground/70 mt-0.5">
                                via {email.synced_by_name}
                              </p>
                            )}
                          </div>
                          {expandedEmail === email.id ? (
                            <ChevronUp className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      </div>
                    </button>

                    {expandedEmail === email.id && (
                      <>
                        <Separator />
                        <div className="p-4 bg-muted/30">
                          <div className="text-sm space-y-2 mb-4">
                            <p>
                              <span className="text-muted-foreground">From:</span>{' '}
                              {email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address}
                            </p>
                            <p>
                              <span className="text-muted-foreground">To:</span>{' '}
                              {email.to_addresses?.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', ') || '-'}
                            </p>
                            {email.cc_addresses?.length > 0 && (
                              <p>
                                <span className="text-muted-foreground">CC:</span>{' '}
                                {email.cc_addresses.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', ')}
                              </p>
                            )}
                          </div>
                          <div 
                            className="prose prose-sm max-w-none dark:prose-invert"
                            dangerouslySetInnerHTML={{ 
                              __html: email.body_content || email.body_preview || '' 
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <ComposeEmailModal
        open={composeOpen}
        onOpenChange={setComposeOpen}
        memberId={memberId}
        memberEmail={memberEmail}
        memberName={memberName}
        onSuccess={() => {
          refetch();
        }}
      />
    </>
  );
}
