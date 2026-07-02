import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Plus, Copy, CheckCircle, ExternalLink } from 'lucide-react';

export default function TenantProvisioning() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    tenantName: '',
    slug: '',
    adminEmail: '',
    adminFirstName: '',
    adminLastName: ''
  });
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  const handleSlugChange = (value) => {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setFormData(prev => ({ ...prev, slug: sanitized }));
  };

  const handleTenantNameChange = (value) => {
    setFormData(prev => {
      const currentSlug = prev.slug;
      const autoSlugFromPrevName = prev.tenantName?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
      const newAutoSlug = value.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      const shouldAutoUpdateSlug = !currentSlug || currentSlug === autoSlugFromPrevName;
      
      return {
        ...prev,
        tenantName: value,
        slug: shouldAutoUpdateSlug ? newAutoSlug : currentSlug
      };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch('/api/platform/tenants/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData)
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 409 || data.existingAccount) {
          throw new Error('An account with this email already exists. The admin needs to create the tenant from their own account, or use a different email address.');
        }
        throw new Error(data.error || 'Failed to provision tenant');
      }

      setResult(data);
      toast({
        title: 'Tenant Created',
        description: `${data.tenant.name} has been provisioned successfully.`
      });
      
      setFormData({
        tenantName: '',
        slug: '',
        adminEmail: '',
        adminFirstName: '',
        adminLastName: ''
      });

    } catch (error) {
      toast({
        title: 'Provisioning Failed',
        description: error.message,
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const copySetupUrl = async () => {
    if (result?.admin?.setupUrl) {
      await navigator.clipboard.writeText(result.admin.setupUrl);
      setCopied(true);
      toast({ title: 'Copied', description: 'Setup URL copied to clipboard' });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="w-5 h-5" />
            Create New Tenant
          </CardTitle>
          <CardDescription>
            Provision a new tenant workspace. The admin will receive a setup URL to create their password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="tenantName">Tenant Name</Label>
                <Input
                  id="tenantName"
                  placeholder="Acme Corporation"
                  value={formData.tenantName}
                  onChange={(e) => handleTenantNameChange(e.target.value)}
                  required
                  data-testid="input-tenant-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="slug">Subdomain</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="slug"
                    placeholder="acme"
                    value={formData.slug}
                    onChange={(e) => handleSlugChange(e.target.value)}
                    required
                    className="flex-1"
                    data-testid="input-slug"
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">.iconn.app</span>
                </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="font-medium mb-3">Tenant Admin Details</h4>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="adminFirstName">First Name</Label>
                  <Input
                    id="adminFirstName"
                    placeholder="John"
                    value={formData.adminFirstName}
                    onChange={(e) => setFormData(prev => ({ ...prev, adminFirstName: e.target.value }))}
                    required
                    data-testid="input-admin-first-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="adminLastName">Last Name</Label>
                  <Input
                    id="adminLastName"
                    placeholder="Smith"
                    value={formData.adminLastName}
                    onChange={(e) => setFormData(prev => ({ ...prev, adminLastName: e.target.value }))}
                    required
                    data-testid="input-admin-last-name"
                  />
                </div>
              </div>
              <div className="space-y-2 mt-4">
                <Label htmlFor="adminEmail">Admin Email</Label>
                <Input
                  id="adminEmail"
                  type="email"
                  placeholder="john@acme.com"
                  value={formData.adminEmail}
                  onChange={(e) => setFormData(prev => ({ ...prev, adminEmail: e.target.value }))}
                  required
                  data-testid="input-admin-email"
                />
                <p className="text-sm text-muted-foreground">
                  This email will be used for the tenant owner account and billing notifications.
                </p>
              </div>
            </div>

            <Button type="submit" disabled={loading} className="w-full" data-testid="button-provision">
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Provisioning...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Tenant
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card className="border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-700 dark:text-green-300">
              <CheckCircle className="w-5 h-5" />
              Tenant Created Successfully
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tenant Name:</span>
                <span className="font-medium">{result.tenant.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Portal URL:</span>
                <a 
                  href={result.tenant.portalUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:underline flex items-center gap-1"
                >
                  {result.tenant.portalUrl}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Admin Email:</span>
                <span className="font-medium">{result.admin.email}</span>
              </div>
            </div>

            <div className="border-t pt-4">
              <Label className="text-sm font-medium">Admin Setup URL</Label>
              <p className="text-sm text-muted-foreground mb-2">
                Send this URL to the admin so they can set their password:
              </p>
              <div className="flex gap-2">
                <Input 
                  value={result.admin.setupUrl} 
                  readOnly 
                  className="text-xs"
                  data-testid="input-setup-url"
                />
                <Button 
                  variant="outline" 
                  size="icon" 
                  onClick={copySetupUrl}
                  data-testid="button-copy-url"
                >
                  {copied ? <CheckCircle className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
