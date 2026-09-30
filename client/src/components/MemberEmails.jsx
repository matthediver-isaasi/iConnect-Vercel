import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getActiveTenantId, subscribeToActiveTenantId } from '@/api/base44Client';
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
  CheckCircle2,
  Pin,
  Flag
} from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/components/ui/use-toast';
import ComposeEmailModal from './ComposeEmailModal';

export async function loadAuthenticatedTenant(intentTenantId, signal) {
  const headers = intentTenantId ? { 'X-Tenant-Id': intentTenantId } : {};
  const response = await fetch('/api/auth/tenant-user-me', {
    credentials: 'include',
    cache: 'no-store',
    signal,
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || 'Authenticated organisation context is unavailable. Sign in again before sending email.');
  }
  if (data?.authenticated && !data?.tenant?.id) {
    throw new Error('Authenticated organisation context is invalid. Sign in again before sending email.');
  }
  if (data?.tenant?.id && intentTenantId && data.tenant.id !== intentTenantId) {
    throw new Error('Organisation context changed. Reload this page before sending email.');
  }
  if (data?.authenticated && data.tenant.id) return data.tenant.id;

  // A member with legitimate CRM administration access may not have a
  // tenant-user session. Resolve that authenticated identity separately;
  // never use this fallback to mask a failed tenant-user request.
  const memberResponse = await fetch('/api/auth/me', {
    credentials: 'include',
    cache: 'no-store',
    signal,
    headers,
  });
  const member = await memberResponse.json().catch(() => null);
  if (!memberResponse.ok || !member?.id || !member?.tenant_id) {
    throw new Error(member?.error || 'Authenticated organisation context is unavailable. Sign in again before sending email.');
  }
  if (intentTenantId && member.tenant_id !== intentTenantId) {
    throw new Error('Organisation context changed. Reload this page before sending email.');
  }
  return member.tenant_id;
}

export function memberEmailProviderLabel(email) {
  const provider = String(email?.email_provider || '').trim().toLowerCase();
  if (provider === 'mailgun') return 'Mailgun';
  if (provider === 'outlook' || provider === 'microsoft_graph' || provider === 'graph') return 'Outlook';
  return null;
}

export default function MemberEmails({ memberId, memberEmail, memberName }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedEmail, setExpandedEmail] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [autoSyncStatus, setAutoSyncStatus] = useState('idle');
  const [composeOpen, setComposeOpen] = useState(false);
  const intendedTenantId = useSyncExternalStore(
    subscribeToActiveTenantId,
    getActiveTenantId,
    () => null
  );
  const tenantContext = useQuery({
    queryKey: ['authenticated-email-tenant', intendedTenantId],
    queryFn: ({ signal }) => loadAuthenticatedTenant(intendedTenantId, signal),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const tenantContextReady = tenantContext.isSuccess
    && !tenantContext.isFetching
    && !tenantContext.error;
  const tenantId = tenantContextReady ? tenantContext.data : null;
  const contextKey = `${tenantId || ''}\u0000${memberId || ''}\u0000${memberEmail || ''}`;
  const contextRef = useRef(contextKey);

  useEffect(() => {
    contextRef.current = contextKey;
    setComposeOpen(false);
    setExpandedEmail(null);
    setAutoSyncStatus('idle');
    setSyncing(false);
  }, [contextKey]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['member-emails', tenantId, memberId],
    queryFn: async ({ signal }) => {
      if (!tenantId) {
        throw new Error('Select an organisation before loading member emails.');
      }
      const response = await fetch(`/api/outlook/emails/${memberId}`, {
        credentials: 'include',
        signal,
        headers: { 'X-Tenant-Id': tenantId }
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to fetch emails');
      }
      return response.json();
    },
    enabled: !!tenantId && !!memberId
  });

  useEffect(() => {
    if (!tenantId || !memberId) return;
    
    let cancelled = false;
    let timeoutId = null;
    const controller = new AbortController();
    const requestContext = contextKey;
    
    const autoSync = async () => {
      setAutoSyncStatus('syncing');
      
      try {
        const response = await fetch('/api/outlook/sync', {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
          body: JSON.stringify({ memberId })
        });
        
        if (cancelled || contextRef.current !== requestContext) return;
        
        if (response.ok) {
          const result = await response.json();
          if (result.synced > 0) {
            setAutoSyncStatus('synced');
            queryClient.invalidateQueries({ queryKey: ['member-emails', tenantId, memberId] });
          } else {
            setAutoSyncStatus('uptodate');
          }
        } else {
          setAutoSyncStatus('failed');
        }
      } catch (err) {
        if (!cancelled) {
          if (err?.name !== 'AbortError') console.error('Auto-sync failed:', err);
          setAutoSyncStatus('failed');
        }
      }
      
      if (!cancelled) {
        timeoutId = setTimeout(() => {
          if (!cancelled) {
            setAutoSyncStatus('idle');
          }
        }, 3000);
      }
    };
    
    autoSync();
    
    return () => {
      cancelled = true;
      controller.abort();
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [contextKey, memberId, queryClient, tenantId]);

  const handleSync = async () => {
    const requestContext = contextKey;
    setSyncing(true);
    try {
      const response = await fetch('/api/outlook/sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
        body: JSON.stringify({ memberId })
      });
      
      const result = await response.json();
      if (contextRef.current !== requestContext) return;
      
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
      if (contextRef.current !== requestContext) return;
      toast({
        title: 'Error',
        description: 'Failed to sync emails',
        variant: 'destructive',
      });
    } finally {
      if (contextRef.current === requestContext) setSyncing(false);
    }
  };

  const toggleExpand = (emailId) => {
    setExpandedEmail(expandedEmail === emailId ? null : emailId);
  };

  const handleTogglePin = async (e, emailId, currentValue) => {
    e.stopPropagation();
    try {
      const response = await fetch('/api/outlook/emails/update', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId, is_pinned: !currentValue })
      });
      if (response.ok) {
        queryClient.invalidateQueries({ queryKey: ['member-emails', tenantId, memberId] });
      }
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    }
  };

  const handleToggleFlag = async (e, emailId, currentValue) => {
    e.stopPropagation();
    try {
      const response = await fetch('/api/outlook/emails/update', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId, is_flagged: !currentValue })
      });
      if (response.ok) {
        queryClient.invalidateQueries({ queryKey: ['member-emails', tenantId, memberId] });
      }
    } catch (err) {
      console.error('Failed to toggle flag:', err);
    }
  };

  if (tenantContext.isPending || tenantContext.isFetching || isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (tenantContext.error) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <AlertTriangle className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">Unable to verify organisation</p>
              <p className="text-sm text-muted-foreground">{tenantContext.error.message}</p>
            </div>
            <Button variant="outline" onClick={() => tenantContext.refetch()} data-testid="button-retry-email-context">
              Try Again
            </Button>
          </div>
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
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => refetch()} data-testid="button-retry-emails">
                Try Again
              </Button>
              <Button onClick={() => setComposeOpen(true)} data-testid="button-compose-email">
                <Send className="h-4 w-4 mr-2" />
                Compose
              </Button>
            </div>
          </div>
        </CardContent>
        <ComposeEmailModal
          open={composeOpen}
          onOpenChange={setComposeOpen}
          memberId={memberId}
          tenantId={tenantId}
          memberEmail={memberEmail}
          memberName={memberName}
          onSuccess={() => refetch()}
        />
      </Card>
    );
  }

  const rawEmails = data?.emails || [];
  const emails = [...rawEmails].sort((a, b) => {
    if (a.is_pinned && !b.is_pinned) return -1;
    if (!a.is_pinned && b.is_pinned) return 1;
    return 0;
  });

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
              {autoSyncStatus === 'uptodate' && (
                <Badge variant="secondary" className="text-xs font-normal text-muted-foreground">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Up to date
                </Badge>
              )}
              {autoSyncStatus === 'failed' && (
                <Badge variant="secondary" className="text-xs font-normal text-warning">
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Sync failed
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
                {emails.map((email) => {
                  const emailDate = email.sent_at || email.received_at;
                  const providerLabel = memberEmailProviderLabel(email);
                  const contactLine = email.direction === 'inbound'
                    ? (email.from_name || email.from_address || 'Unknown sender')
                    : `To: ${email.to_addresses?.[0]?.name || email.to_addresses?.[0]?.address || 'Unknown recipient'}`;

                  return (
                  <div
                    key={email.id}
                    className="border rounded-lg"
                  >
                    <button
                      className="w-full p-3 text-left hover-elevate transition-colors"
                      onClick={() => toggleExpand(email.id)}
                      data-testid={`button-email-${email.id}`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            {email.direction === 'inbound' ? (
                              <Inbox className="h-4 w-4 text-blue-500 flex-shrink-0" />
                            ) : (
                              <Send className="h-4 w-4 text-green-500 flex-shrink-0" />
                            )}
                            <span className="font-medium truncate" data-testid={`text-email-contact-${email.id}`}>
                              {contactLine}
                            </span>
                            {email.has_attachments && (
                              <Paperclip className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className={`toggle-elevate ${email.is_pinned ? 'toggle-elevated text-blue-600' : 'text-muted-foreground/40'}`}
                              onClick={(e) => handleTogglePin(e, email.id, email.is_pinned)}
                              data-testid={`button-pin-email-${email.id}`}
                            >
                              <Pin className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className={`toggle-elevate ${email.is_flagged ? 'toggle-elevated text-red-500' : 'text-muted-foreground/40'}`}
                              onClick={(e) => handleToggleFlag(e, email.id, email.is_flagged)}
                              data-testid={`button-flag-email-${email.id}`}
                            >
                              <Flag className={`h-3.5 w-3.5 ${email.is_flagged ? 'fill-red-500' : ''}`} />
                            </Button>
                            <span className="text-xs text-muted-foreground whitespace-nowrap ml-1" data-testid={`text-email-date-${email.id}`}>
                              {emailDate ? format(new Date(emailDate), 'MMM d, h:mm a') : 'No date'}
                            </span>
                            {expandedEmail === email.id ? (
                              <ChevronUp className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pl-6 flex-wrap">
                          <span className="text-sm truncate min-w-0" data-testid={`text-email-subject-${email.id}`}>
                            {email.subject || '(No subject)'}
                          </span>
                          <Badge variant={email.direction === 'inbound' ? 'secondary' : 'outline'}>
                            {email.direction === 'inbound' ? 'Received' : 'Sent'}
                          </Badge>
                          {providerLabel && (
                            <span className="text-xs text-muted-foreground/70" data-testid={`text-email-provider-${email.id}`}>
                              via {providerLabel}
                            </span>
                          )}
                          {email.synced_by_name && (
                            <span className="text-xs text-muted-foreground/70">
                              by {email.synced_by_name}
                            </span>
                          )}
                        </div>

                        {email.body_preview && (
                          <p className="text-sm text-muted-foreground pl-6 line-clamp-2" data-testid={`text-email-preview-${email.id}`}>
                            {email.body_preview}
                          </p>
                        )}
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
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <ComposeEmailModal
        open={composeOpen}
        onOpenChange={setComposeOpen}
        memberId={memberId}
        tenantId={tenantId}
        memberEmail={memberEmail}
        memberName={memberName}
        onSuccess={() => {
          refetch();
        }}
      />
    </>
  );
}
