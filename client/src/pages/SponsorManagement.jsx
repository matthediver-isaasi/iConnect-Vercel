import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { Plus, Pencil, Trash2, Globe, Image, Handshake, Building2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useSponsorTenant } from "@/lib/useSponsorTenant";
import { linkSponsorOrganization } from "@/lib/eventSponsorState.mjs";

const emptySponsor = () => ({ name: "", logo_url: "", website_url: "", description: "", organization_id: null });

export default function SponsorManagement() {
  const tenantId = useSponsorTenant();
  const queryClient = useQueryClient();
  const [sponsorDialogOpen, setSponsorDialogOpen] = useState(false);
  const [editingSponsor, setEditingSponsor] = useState(null);
  const [sponsorForm, setSponsorForm] = useState(emptySponsor);
  const [savingSponsor, setSavingSponsor] = useState(false);
  const [deletingSponsorId, setDeletingSponsorId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [organizationSearch, setOrganizationSearch] = useState("");
  const sponsorKey = ['/api/entities/EventSponsor', tenantId];
  const sponsorsQuery = useQuery({
    queryKey: sponsorKey,
    queryFn: () => base44.entities.EventSponsor.listAll({ sort: { name: 'asc' } }),
  });
  // The authenticated generic entity endpoint applies the active tenant boundary.
  // No organisation writes are performed by this page.
  const organizationsQuery = useQuery({
    queryKey: ['/api/entities/Organization', tenantId, 'sponsor-picker'],
    queryFn: () => base44.entities.Organization.listAll({ sort: { name: 'asc' } }),
    enabled: sponsorDialogOpen,
  });
  const sponsors = sponsorsQuery.data || [];
  const organizations = organizationsQuery.data || [];
  const linkedOrganization = organizations.find(o => o.id === sponsorForm.organization_id);
  const matchingOrganizations = organizations.filter(o => o.name?.toLowerCase().includes(organizationSearch.trim().toLowerCase()));

  const openSponsor = (sponsor = null) => {
    setEditingSponsor(sponsor);
    setSponsorForm(sponsor ? {
      name: sponsor.name || "", logo_url: sponsor.logo_url || "", website_url: sponsor.website_url || "",
      description: sponsor.description || "", organization_id: sponsor.organization_id || null,
    } : emptySponsor());
    setOrganizationSearch("");
    setSponsorDialogOpen(true);
  };

  const handleSaveSponsor = async () => {
    if (!sponsorForm.name.trim()) { toast.error("Please enter a sponsor name"); return; }
    setSavingSponsor(true);
    try {
      const data = {
        name: sponsorForm.name.trim(),
        logo_url: sponsorForm.logo_url || null,
        website_url: sponsorForm.website_url || null,
        description: sponsorForm.description || null,
        organization_id: sponsorForm.organization_id || null,
      };
      if (editingSponsor) await base44.entities.EventSponsor.update(editingSponsor.id, data);
      else await base44.entities.EventSponsor.create(data);
      queryClient.invalidateQueries({ queryKey: sponsorKey });
      setSponsorDialogOpen(false);
      toast.success(editingSponsor ? "Sponsor updated" : "Sponsor created");
    } catch (err) { toast.error(err.message || "Failed to save sponsor"); }
    finally { setSavingSponsor(false); }
  };

  const handleDeleteSponsor = async () => {
    if (!deletingSponsorId || deleting) return;
    setDeleting(true);
    try {
      await base44.entities.EventSponsor.delete(deletingSponsorId);
      queryClient.invalidateQueries({ queryKey: sponsorKey });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsorAssignment'] });
      setDeletingSponsorId(null);
      toast.success("Sponsor deleted");
    } catch (err) { toast.error(err.message || "Failed to delete sponsor"); }
    finally { setDeleting(false); }
  };

  const handleLogoUpload = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file, type: 'branding' });
      setSponsorForm(prev => ({ ...prev, logo_url: result.file_url }));
      toast.success("Logo uploaded");
    } catch (err) { showUploadErrorToast(err, "Failed to upload logo"); }
    finally { setUploadingLogo(false); }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-6"><Handshake className="h-6 w-6 text-blue-600" /><h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">Sponsor Management</h1></div>
      <div className="flex flex-wrap justify-between items-center mb-4 gap-3">
        <div className="text-sm text-slate-600"><p>Manage sponsor names, logos, websites and descriptions.</p><p className="text-xs text-slate-500 mt-1">Set sponsor categories within each event. Organisation links are optional.</p></div>
        <Button onClick={() => openSponsor()} data-testid="button-create-sponsor"><Plus className="h-4 w-4 mr-2" />Add Sponsor</Button>
      </div>
      {sponsorsQuery.isLoading ? <div role="status" aria-label="Loading sponsors" className="space-y-3"><div className="h-28 rounded-lg bg-slate-100 animate-pulse" /><div className="h-28 rounded-lg bg-slate-100 animate-pulse" /></div> :
        sponsorsQuery.isError ? <Card><CardContent className="p-6 space-y-3"><p role="alert" className="text-sm text-red-600">Sponsors could not be loaded.</p><Button variant="outline" onClick={() => sponsorsQuery.refetch()}>Retry</Button></CardContent></Card> :
          !sponsors.length ? <Card><CardContent className="py-12 text-center"><Handshake className="h-12 w-12 text-slate-300 mx-auto mb-4" /><p className="text-slate-500">No sponsors yet. Add your first sponsor to get started.</p></CardContent></Card> :
            <div className="grid gap-4 sm:grid-cols-2">{sponsors.map(sponsor => <Card key={sponsor.id} data-testid={`card-sponsor-${sponsor.id}`}><CardContent className="p-4">
              <div className="flex items-start gap-3">
                {sponsor.logo_url ? <img src={sponsor.logo_url} alt={sponsor.name} className="w-16 h-16 object-contain rounded-md border border-slate-200 bg-white shrink-0" /> : <div className="w-16 h-16 rounded-md border border-slate-200 bg-slate-50 flex items-center justify-center shrink-0"><Image className="h-6 w-6 text-slate-300" /></div>}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2"><h3 className="font-medium text-slate-900 break-words" data-testid={`text-sponsor-name-${sponsor.id}`}>{sponsor.name}</h3><div className="flex shrink-0">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${sponsor.name}`} onClick={() => openSponsor(sponsor)} data-testid={`button-edit-sponsor-${sponsor.id}`}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" aria-label={`Delete ${sponsor.name}`} onClick={() => setDeletingSponsorId(sponsor.id)} data-testid={`button-delete-sponsor-${sponsor.id}`}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                  </div></div>
                  {sponsor.organization_id && <p className="text-xs text-slate-500 flex items-center gap-1 mt-1"><Building2 className="h-3 w-3" />Linked organisation</p>}
                  {sponsor.description && <p className="text-sm text-slate-500 mt-1 line-clamp-2">{sponsor.description}</p>}
                  {sponsor.website_url && <a href={sponsor.website_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1 break-all"><Globe className="h-3 w-3 shrink-0" />{sponsor.website_url}</a>}
                </div>
              </div>
            </CardContent></Card>)}</div>}
      <Dialog open={sponsorDialogOpen} onOpenChange={open => { if (!savingSponsor && !uploadingLogo) setSponsorDialogOpen(open); }}>
        <DialogContent className="max-w-md max-h-[85dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editingSponsor ? "Edit Sponsor" : "Add Sponsor"}</DialogTitle><DialogDescription>Sponsor display details can be edited independently of any linked organisation.</DialogDescription></DialogHeader>
          <fieldset disabled={savingSponsor} className="space-y-4 min-w-0">
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <Label htmlFor="sponsor-organization-search">Linked organisation (optional)</Label>
              <p className="text-xs text-slate-500">Select an existing organisation. This never changes its record. Only an empty sponsor name is filled in.</p>
              {sponsorForm.organization_id && <div className="flex justify-between items-center gap-2 text-sm text-slate-700"><span>{linkedOrganization?.name || "Linked organisation (record unavailable)"}</span><Button type="button" size="sm" variant="outline" onClick={() => setSponsorForm(prev => linkSponsorOrganization(prev, null))} data-testid="button-unlink-organization">Unlink</Button></div>}
              {organizationsQuery.isLoading ? <div role="status" className="h-10 rounded bg-slate-200 animate-pulse" aria-label="Loading organisations" /> :
                organizationsQuery.isError ? <div className="text-sm text-red-600" role="alert">Could not load organisations. Your current link is preserved. <Button type="button" variant="outline" size="sm" onClick={() => organizationsQuery.refetch()}>Retry</Button></div> :
                  <><Input id="sponsor-organization-search" value={organizationSearch} onChange={e => setOrganizationSearch(e.target.value)} placeholder="Search organisations..." data-testid="input-organization-search" />
                    <div className="max-h-36 overflow-y-auto space-y-1" role="group" aria-label="Existing organisations">
                      {matchingOrganizations.map(o => <Button key={o.id} type="button" variant={sponsorForm.organization_id === o.id ? "secondary" : "ghost"} className="w-full justify-start h-auto whitespace-normal text-left" aria-pressed={sponsorForm.organization_id === o.id} onClick={() => setSponsorForm(prev => linkSponsorOrganization(prev, o))} data-testid={`button-link-organization-${o.id}`}>{o.name}</Button>)}
                      {!matchingOrganizations.length && <p className="text-xs text-slate-500 p-2">No matching organisations. You can continue without a link.</p>}
                    </div></>}
            </div>
            <div className="space-y-2"><Label htmlFor="sponsor-name">Name *</Label><Input id="sponsor-name" value={sponsorForm.name} onChange={e => setSponsorForm(prev => ({ ...prev, name: e.target.value }))} placeholder="Sponsor name" data-testid="input-sponsor-name" /></div>
            <div className="space-y-2"><Label htmlFor="sponsor-logo">Logo</Label><div className="flex items-center gap-3">
              {sponsorForm.logo_url ? <img src={sponsorForm.logo_url} alt="Logo preview" className="w-16 h-16 object-contain rounded-md border border-slate-200 bg-white" /> : <Image className="h-8 w-8 text-slate-300 shrink-0" />}
              <div className="min-w-0 space-y-1"><Input id="sponsor-logo" type="file" accept="image/*" disabled={uploadingLogo} onChange={handleLogoUpload} data-testid="input-sponsor-logo" />
                {uploadingLogo && <p role="status" className="text-xs text-slate-500">Uploading logo...</p>}
                {sponsorForm.logo_url && <Button type="button" variant="ghost" size="sm" disabled={uploadingLogo} className="text-red-500" onClick={() => setSponsorForm(prev => ({ ...prev, logo_url: "" }))} data-testid="button-remove-logo">Remove logo</Button>}
              </div>
            </div></div>
            <div className="space-y-2"><Label htmlFor="sponsor-url">Website URL</Label><Input id="sponsor-url" value={sponsorForm.website_url} onChange={e => setSponsorForm(prev => ({ ...prev, website_url: e.target.value }))} placeholder="https://example.com" data-testid="input-sponsor-url" /></div>
            <div className="space-y-2"><Label htmlFor="sponsor-description">Description</Label><Textarea id="sponsor-description" value={sponsorForm.description} onChange={e => setSponsorForm(prev => ({ ...prev, description: e.target.value }))} rows={3} data-testid="input-sponsor-description" /></div>
          </fieldset>
          <div className="flex justify-end gap-2 pt-2"><Button variant="outline" disabled={savingSponsor || uploadingLogo} onClick={() => setSponsorDialogOpen(false)}>Cancel</Button><Button onClick={handleSaveSponsor} disabled={savingSponsor || uploadingLogo} data-testid="button-save-sponsor">{savingSponsor ? "Saving..." : editingSponsor ? "Update" : "Create"}</Button></div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!deletingSponsorId} onOpenChange={open => { if (!open && !deleting) setDeletingSponsorId(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete Sponsor</AlertDialogTitle><AlertDialogDescription>This permanently deletes the sponsor and removes it from all events. Linked organisation records will not change.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel><AlertDialogAction disabled={deleting} onClick={e => { e.preventDefault(); handleDeleteSponsor(); }} className="bg-red-600 hover:bg-red-700" data-testid="button-confirm-delete-sponsor">{deleting ? "Deleting..." : "Delete"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
