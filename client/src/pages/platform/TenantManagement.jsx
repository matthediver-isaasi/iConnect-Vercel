import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Trash2, Building2, AlertTriangle, RefreshCw, Navigation } from 'lucide-react';
import { format } from 'date-fns';

export default function TenantManagement() {
  const { toast } = useToast();
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [confirmSlug, setConfirmSlug] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteResults, setDeleteResults] = useState(null);
  const [seedingNav, setSeedingNav] = useState(false);
  const [navTemplateStats, setNavTemplateStats] = useState(null);

  useEffect(() => {
    fetchTenants();
  }, []);

  const fetchTenants = async () => {
    try {
      const response = await fetch('/api/platform/tenants', {
        credentials: 'include'
      });
      const data = await response.json();

      if (response.ok) {
        setTenants(data.tenants || []);
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to fetch tenants',
          variant: 'destructive'
        });
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to fetch tenants',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteClick = (tenant) => {
    setSelectedTenant(tenant);
    setConfirmSlug('');
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (confirmSlug !== selectedTenant.slug) {
      toast({
        title: 'Confirmation Failed',
        description: 'The subdomain you entered does not match',
        variant: 'destructive'
      });
      return;
    }

    setDeleteDialogOpen(false);
    setConfirmDialogOpen(true);
  };

  const handleSeedNavigationTemplates = async () => {
    setSeedingNav(true);
    try {
      const response = await fetch('/api/platform/seed-navigation-templates', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await response.json();

      if (response.ok) {
        setNavTemplateStats(data.stats);
        toast({
          title: 'Templates Updated',
          description: `Navigation templates reseeded: ${data.stats.portal_menus} menus, ${data.stats.public_navigation_items} public nav items`
        });
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to seed navigation templates',
          variant: 'destructive'
        });
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to seed navigation templates',
        variant: 'destructive'
      });
    } finally {
      setSeedingNav(false);
    }
  };

  const handleFinalDelete = async () => {
    setDeleting(true);
    setConfirmDialogOpen(false);

    try {
      const response = await fetch('/api/platform/tenants/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          tenantId: selectedTenant.id,
          confirmSlug: selectedTenant.slug
        })
      });

      const data = await response.json();

      if (response.ok) {
        setDeleteResults(data);
        toast({
          title: 'Tenant Deleted',
          description: `Successfully deleted ${selectedTenant.name} and all associated records`
        });
        fetchTenants();
      } else {
        toast({
          title: 'Deletion Failed',
          description: data.error || 'Failed to delete tenant',
          variant: 'destructive'
        });
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to delete tenant',
        variant: 'destructive'
      });
    } finally {
      setDeleting(false);
      setSelectedTenant(null);
    }
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Navigation className="w-5 h-5" />
            Tenant Provisioning Templates
          </CardTitle>
          <CardDescription>
            Re-seed navigation templates from the GFI tenant to update what new tenants receive when provisioned.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-muted-foreground">
              {navTemplateStats ? (
                <span>
                  Last seeded: {navTemplateStats.portal_menus} menus ({navTemplateStats.portal_menus_with_parents} with parents), {navTemplateStats.public_navigation_items} public nav items
                </span>
              ) : (
                <span>Click to reseed navigation templates from GFI tenant</span>
              )}
            </div>
            <Button
              onClick={handleSeedNavigationTemplates}
              disabled={seedingNav}
              data-testid="button-seed-nav-templates"
            >
              {seedingNav ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Seeding...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Reseed Navigation Templates
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            Tenant Workspaces
          </CardTitle>
          <CardDescription>
            Manage all tenant workspaces on the platform. Deleting a tenant removes all associated data permanently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No tenants found</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Subdomain</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((tenant) => (
                  <TableRow key={tenant.id} data-testid={`row-tenant-${tenant.id}`}>
                    <TableCell className="font-medium">{tenant.name}</TableCell>
                    <TableCell>
                      <code className="text-sm bg-muted px-2 py-1 rounded">{tenant.slug}</code>
                    </TableCell>
                    <TableCell>
                      {tenant.created_at ? format(new Date(tenant.created_at), 'MMM d, yyyy') : '-'}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs ${
                        tenant.subscription_status === 'active' 
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {tenant.subscription_status || 'trial'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteClick(tenant)}
                        disabled={deleting}
                        data-testid={`button-delete-tenant-${tenant.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Delete Tenant Workspace
            </DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the tenant
              <strong className="text-foreground"> {selectedTenant?.name}</strong> and all associated data including:
            </DialogDescription>
          </DialogHeader>
          
          <ul className="text-sm text-muted-foreground space-y-1 ml-4 list-disc">
            <li>All organizations and members</li>
            <li>All events, bookings, and program tickets</li>
            <li>All blog posts, resources, and pages</li>
            <li>All forms, submissions, and workflows</li>
            <li>All roles and permissions</li>
            <li>All navigation and settings</li>
          </ul>

          <div className="space-y-2 mt-4">
            <Label htmlFor="confirm-slug">
              Type <code className="bg-muted px-1 rounded">{selectedTenant?.slug}</code> to confirm
            </Label>
            <Input
              id="confirm-slug"
              value={confirmSlug}
              onChange={(e) => setConfirmSlug(e.target.value)}
              placeholder="Enter subdomain to confirm"
              data-testid="input-confirm-slug"
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              data-testid="button-cancel-delete"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={confirmSlug !== selectedTenant?.slug}
              data-testid="button-confirm-delete"
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to permanently delete <strong>{selectedTenant?.name}</strong> ({selectedTenant?.slug}).
              This action is irreversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-final-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleFinalDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-final-delete"
            >
              {deleting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete Permanently'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {deleteResults && (
        <Dialog open={!!deleteResults} onOpenChange={() => setDeleteResults(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Deletion Complete</DialogTitle>
              <DialogDescription>
                Tenant {deleteResults.tenant?.name} has been deleted.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-64 overflow-auto">
              <pre className="text-xs bg-muted p-3 rounded overflow-auto">
                {JSON.stringify(deleteResults.deleted, null, 2)}
              </pre>
            </div>
            {deleteResults.errors?.length > 0 && (
              <div className="text-sm text-destructive">
                <p className="font-medium">Errors encountered:</p>
                <ul className="list-disc ml-4">
                  {deleteResults.errors.map((err, i) => (
                    <li key={i}>{err.table}: {err.error}</li>
                  ))}
                </ul>
              </div>
            )}
            <DialogFooter>
              <Button onClick={() => setDeleteResults(null)} data-testid="button-close-results">
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
