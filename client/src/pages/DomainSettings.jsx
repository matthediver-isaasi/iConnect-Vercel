import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { 
  Globe, 
  Plus, 
  Trash2, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  Clock, 
  Copy, 
  ExternalLink,
  Loader2,
  Info
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || error.message || 'Request failed');
  }
  
  return response.json();
}

export default function DomainSettings() {
  const queryClient = useQueryClient();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [newDomain, setNewDomain] = useState("");
  const [addingDomain, setAddingDomain] = useState(false);

  const { data: tenantData, isLoading: tenantLoading, error: tenantError } = useQuery({
    queryKey: ['tenant-domains'],
    queryFn: () => apiRequest('/api/functions/get-tenant-domains'),
    retry: false,
  });

  const addDomainMutation = useMutation({
    mutationFn: async (domain) => {
      return apiRequest('/api/functions/add-tenant-domain', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-domains'] });
      setNewDomain("");
      setAddingDomain(false);
      toast.success("Domain added", {
        description: "Your custom domain has been added. Please configure your DNS.",
      });
    },
    onError: (error) => {
      toast.error("Failed to add domain", {
        description: error.message || "Please try again.",
      });
    },
  });

  const removeDomainMutation = useMutation({
    mutationFn: async (domain) => {
      return apiRequest('/api/functions/remove-tenant-domain', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-domains'] });
      toast.success("Domain removed", {
        description: "Your custom domain has been removed.",
      });
    },
    onError: (error) => {
      toast.error("Failed to remove domain", {
        description: error.message || "Please try again.",
      });
    },
  });

  const verifyDomainMutation = useMutation({
    mutationFn: async (domain) => {
      return apiRequest('/api/functions/verify-tenant-domain', {
        method: 'POST',
        body: JSON.stringify({ domain }),
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['tenant-domains'] });
      if (data.verified) {
        toast.success("Domain verified", {
          description: "Your domain is now active and SSL certificate has been issued.",
        });
      } else {
        toast.info("Verification pending", {
          description: "DNS records not yet detected. This can take up to 48 hours.",
        });
      }
    },
    onError: (error) => {
      toast.error("Verification failed", {
        description: error.message || "Please check your DNS settings.",
      });
    },
  });

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const handleAddDomain = (e) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    
    const domain = newDomain.trim().toLowerCase();
    if (!domain.includes('.') || domain.includes(' ')) {
      toast.error("Invalid domain", {
        description: "Please enter a valid domain name (e.g., example.com)",
      });
      return;
    }
    
    addDomainMutation.mutate(domain);
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'verified':
      case 'active':
        return <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><CheckCircle2 className="w-3 h-3 mr-1" /> Active</Badge>;
      case 'pending':
        return <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"><Clock className="w-3 h-3 mr-1" /> Pending DNS</Badge>;
      case 'error':
        return <Badge variant="destructive"><AlertCircle className="w-3 h-3 mr-1" /> Error</Badge>;
      default:
        return <Badge variant="outline"><Clock className="w-3 h-3 mr-1" /> {status}</Badge>;
    }
  };

  if (!isAccessReady) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (tenantError) {
    return (
      <div className="container max-w-4xl py-8">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Unable to load domain settings</AlertTitle>
          <AlertDescription>
            {tenantError.message || "Please try again or contact support."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (tenantLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tenant = tenantData?.tenant;
  const domains = tenantData?.domains || [];
  const defaultDomain = tenant?.slug ? `${tenant.slug}.iconn.app` : null;

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold" data-testid="text-page-title">Domain Settings</h1>
        <p className="text-muted-foreground">Manage your workspace domains and custom branding</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="w-5 h-5" />
            Default Domain
          </CardTitle>
          <CardDescription>
            Your workspace is always accessible at this subdomain
          </CardDescription>
        </CardHeader>
        <CardContent>
          {defaultDomain ? (
            <div className="flex items-center justify-between gap-2 p-3 bg-muted rounded-lg">
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-muted-foreground" />
                <span className="font-mono text-sm" data-testid="text-default-domain">{defaultDomain}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                </Badge>
                <Button 
                  size="icon" 
                  variant="ghost"
                  onClick={() => window.open(`https://${defaultDomain}`, '_blank')}
                  data-testid="button-open-default-domain"
                >
                  <ExternalLink className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">No default domain configured</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Custom Domains</CardTitle>
            <CardDescription>
              Add your own domain for white-label branding
            </CardDescription>
          </div>
          {!addingDomain && (
            <Button 
              onClick={() => setAddingDomain(true)}
              data-testid="button-add-domain"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Domain
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {addingDomain && (
            <form onSubmit={handleAddDomain} className="space-y-4 p-4 border rounded-lg bg-muted/50">
              <div className="space-y-2">
                <Label htmlFor="newDomain">Domain Name</Label>
                <Input
                  id="newDomain"
                  placeholder="example.com"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  data-testid="input-new-domain"
                />
                <p className="text-xs text-muted-foreground">
                  Enter your domain without http:// or www
                </p>
              </div>
              <div className="flex gap-2">
                <Button 
                  type="submit" 
                  disabled={addDomainMutation.isPending}
                  data-testid="button-save-domain"
                >
                  {addDomainMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : null}
                  Add Domain
                </Button>
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => {
                    setAddingDomain(false);
                    setNewDomain("");
                  }}
                  data-testid="button-cancel-add-domain"
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {domains.length === 0 && !addingDomain ? (
            <div className="text-center py-8 text-muted-foreground">
              <Globe className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No custom domains configured</p>
              <p className="text-sm">Add a custom domain for white-label branding</p>
            </div>
          ) : (
            <div className="space-y-3">
              {domains.map((domain) => (
                <div 
                  key={domain.name} 
                  className="flex items-center justify-between gap-2 p-3 border rounded-lg"
                  data-testid={`domain-item-${domain.name}`}
                >
                  <div className="flex items-center gap-3">
                    <Globe className="w-4 h-4 text-muted-foreground" />
                    <span className="font-mono text-sm">{domain.name}</span>
                    {getStatusBadge(domain.verified ? 'verified' : 'pending')}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => verifyDomainMutation.mutate(domain.name)}
                      disabled={verifyDomainMutation.isPending}
                      data-testid={`button-verify-${domain.name}`}
                    >
                      <RefreshCw className={`w-4 h-4 mr-1 ${verifyDomainMutation.isPending ? 'animate-spin' : ''}`} />
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeDomainMutation.mutate(domain.name)}
                      disabled={removeDomainMutation.isPending}
                      data-testid={`button-remove-${domain.name}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {domains.some(d => !d.verified) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="w-5 h-5" />
              DNS Configuration
            </CardTitle>
            <CardDescription>
              Configure these DNS records at your domain registrar
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Action Required</AlertTitle>
              <AlertDescription>
                Add the following DNS records to verify your domain. DNS changes can take up to 48 hours to propagate.
              </AlertDescription>
            </Alert>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>For root domain (example.com):</Label>
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg font-mono text-sm">
                  <div className="flex-1">
                    <span className="text-muted-foreground">Type:</span> A<br />
                    <span className="text-muted-foreground">Name:</span> @<br />
                    <span className="text-muted-foreground">Value:</span> 76.76.21.21
                  </div>
                  <Button 
                    size="icon" 
                    variant="ghost"
                    onClick={() => copyToClipboard("76.76.21.21")}
                    data-testid="button-copy-a-record"
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>For subdomain (www.example.com):</Label>
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg font-mono text-sm">
                  <div className="flex-1">
                    <span className="text-muted-foreground">Type:</span> CNAME<br />
                    <span className="text-muted-foreground">Name:</span> www<br />
                    <span className="text-muted-foreground">Value:</span> cname.vercel-dns.com
                  </div>
                  <Button 
                    size="icon" 
                    variant="ghost"
                    onClick={() => copyToClipboard("cname.vercel-dns.com")}
                    data-testid="button-copy-cname"
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
