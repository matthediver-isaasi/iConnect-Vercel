import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2, Globe, Image, GripVertical, Handshake } from "lucide-react";
import { base44 } from "@/api/base44Client";

export default function SponsorManagement() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("sponsors");

  const [sponsorDialogOpen, setSponsorDialogOpen] = useState(false);
  const [editingSponsor, setEditingSponsor] = useState(null);
  const [sponsorForm, setSponsorForm] = useState({ name: "", logo_url: "", website_url: "", description: "", category_id: "" });
  const [savingSponsor, setSavingSponsor] = useState(false);
  const [deletingSponsorId, setDeletingSponsorId] = useState(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryForm, setCategoryForm] = useState({ name: "", display_order: 0 });
  const [savingCategory, setSavingCategory] = useState(false);
  const [deletingCategoryId, setDeletingCategoryId] = useState(null);

  const { data: sponsors = [], isLoading: loadingSponsors } = useQuery({
    queryKey: ['/api/entities/EventSponsor'],
    queryFn: () => base44.entities.EventSponsor.list({ sort: { name: 'asc' } })
  });

  const { data: categories = [], isLoading: loadingCategories } = useQuery({
    queryKey: ['/api/entities/EventSponsorCategory'],
    queryFn: () => base44.entities.EventSponsorCategory.list({ sort: { display_order: 'asc' } })
  });

  const categoryMap = useMemo(() => {
    const map = {};
    categories.forEach(c => { map[c.id] = c; });
    return map;
  }, [categories]);

  const openCreateSponsor = () => {
    setEditingSponsor(null);
    setSponsorForm({ name: "", logo_url: "", website_url: "", description: "", category_id: "" });
    setSponsorDialogOpen(true);
  };

  const openEditSponsor = (sponsor) => {
    setEditingSponsor(sponsor);
    setSponsorForm({
      name: sponsor.name || "",
      logo_url: sponsor.logo_url || "",
      website_url: sponsor.website_url || "",
      description: sponsor.description || "",
      category_id: sponsor.category_id || ""
    });
    setSponsorDialogOpen(true);
  };

  const handleSaveSponsor = async () => {
    if (!sponsorForm.name.trim()) {
      toast.error("Please enter a sponsor name");
      return;
    }
    setSavingSponsor(true);
    try {
      const data = {
        name: sponsorForm.name.trim(),
        logo_url: sponsorForm.logo_url || null,
        website_url: sponsorForm.website_url || null,
        description: sponsorForm.description || null,
        category_id: sponsorForm.category_id || null
      };
      if (editingSponsor) {
        await base44.entities.EventSponsor.update(editingSponsor.id, data);
        toast.success("Sponsor updated");
      } else {
        await base44.entities.EventSponsor.create(data);
        toast.success("Sponsor created");
      }
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsor'] });
      setSponsorDialogOpen(false);
    } catch (err) {
      toast.error(err.message || "Failed to save sponsor");
    } finally {
      setSavingSponsor(false);
    }
  };

  const handleDeleteSponsor = async () => {
    if (!deletingSponsorId) return;
    try {
      await base44.entities.EventSponsor.delete(deletingSponsorId);
      toast.success("Sponsor deleted");
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsor'] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsorAssignment'] });
    } catch (err) {
      toast.error(err.message || "Failed to delete sponsor");
    } finally {
      setDeletingSponsorId(null);
    }
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLogo(true);
    try {
      const result = await base44.integrations.Core.UploadFile({
        file,
        type: 'branding'
      });
      setSponsorForm(prev => ({ ...prev, logo_url: result.file_url }));
      toast.success("Logo uploaded");
    } catch (err) {
      toast.error(err.message || "Failed to upload logo");
    } finally {
      setUploadingLogo(false);
    }
  };

  const openCreateCategory = () => {
    setEditingCategory(null);
    setCategoryForm({ name: "", display_order: categories.length });
    setCategoryDialogOpen(true);
  };

  const openEditCategory = (category) => {
    setEditingCategory(category);
    setCategoryForm({ name: category.name || "", display_order: category.display_order || 0 });
    setCategoryDialogOpen(true);
  };

  const handleSaveCategory = async () => {
    if (!categoryForm.name.trim()) {
      toast.error("Please enter a category name");
      return;
    }
    setSavingCategory(true);
    try {
      const data = {
        name: categoryForm.name.trim(),
        display_order: parseInt(categoryForm.display_order) || 0
      };
      if (editingCategory) {
        await base44.entities.EventSponsorCategory.update(editingCategory.id, data);
        toast.success("Category updated");
      } else {
        await base44.entities.EventSponsorCategory.create(data);
        toast.success("Category created");
      }
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsorCategory'] });
      setCategoryDialogOpen(false);
    } catch (err) {
      toast.error(err.message || "Failed to save category");
    } finally {
      setSavingCategory(false);
    }
  };

  const handleDeleteCategory = async () => {
    if (!deletingCategoryId) return;
    try {
      await base44.entities.EventSponsorCategory.delete(deletingCategoryId);
      toast.success("Category deleted");
      queryClient.invalidateQueries({ queryKey: ['/api/entities/EventSponsorCategory'] });
    } catch (err) {
      toast.error(err.message || "Failed to delete category");
    } finally {
      setDeletingCategoryId(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <Handshake className="h-6 w-6 text-blue-600" />
        <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">Sponsor Management</h1>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="sponsors" data-testid="tab-sponsors">Sponsors</TabsTrigger>
          <TabsTrigger value="categories" data-testid="tab-categories">Categories</TabsTrigger>
        </TabsList>

        <TabsContent value="sponsors">
          <div className="flex justify-between items-center mb-4 gap-2">
            <p className="text-sm text-slate-600">Manage event sponsors with their logos, website links, and descriptions.</p>
            <Button onClick={openCreateSponsor} data-testid="button-create-sponsor">
              <Plus className="h-4 w-4 mr-2" />
              Add Sponsor
            </Button>
          </div>

          {loadingSponsors ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
            </div>
          ) : sponsors.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Handshake className="h-12 w-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500">No sponsors yet. Add your first sponsor to get started.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {sponsors.map(sponsor => (
                <Card key={sponsor.id} data-testid={`card-sponsor-${sponsor.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      {sponsor.logo_url ? (
                        <img
                          src={sponsor.logo_url}
                          alt={sponsor.name}
                          className="w-16 h-16 object-contain rounded-md border border-slate-200 bg-white flex-shrink-0"
                          data-testid={`img-sponsor-logo-${sponsor.id}`}
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-md border border-slate-200 bg-slate-50 flex items-center justify-center flex-shrink-0">
                          <Image className="h-6 w-6 text-slate-300" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="font-medium text-slate-900 truncate" data-testid={`text-sponsor-name-${sponsor.id}`}>{sponsor.name}</h3>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <Button variant="ghost" size="icon" onClick={() => openEditSponsor(sponsor)} data-testid={`button-edit-sponsor-${sponsor.id}`}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => setDeletingSponsorId(sponsor.id)} data-testid={`button-delete-sponsor-${sponsor.id}`}>
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </div>
                        {sponsor.category_id && categoryMap[sponsor.category_id] && (
                          <Badge variant="secondary" className="text-xs mt-1" data-testid={`badge-sponsor-category-${sponsor.id}`}>
                            {categoryMap[sponsor.category_id].name}
                          </Badge>
                        )}
                        {sponsor.description && (
                          <p className="text-sm text-slate-500 mt-1 line-clamp-2">{sponsor.description}</p>
                        )}
                        {sponsor.website_url && (
                          <a href={sponsor.website_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1" data-testid={`link-sponsor-website-${sponsor.id}`}>
                            <Globe className="h-3 w-3" />
                            {sponsor.website_url}
                          </a>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="categories">
          <div className="flex justify-between items-center mb-4 gap-2">
            <p className="text-sm text-slate-600">Organize sponsors into categories (e.g. Gold, Silver, Bronze).</p>
            <Button onClick={openCreateCategory} data-testid="button-create-category">
              <Plus className="h-4 w-4 mr-2" />
              Add Category
            </Button>
          </div>

          {loadingCategories ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
            </div>
          ) : categories.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <GripVertical className="h-12 w-12 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500">No categories yet. Categories help organize sponsors (e.g. Gold, Silver, Bronze).</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {categories.map(category => {
                const count = sponsors.filter(s => s.category_id === category.id).length;
                return (
                  <Card key={category.id} data-testid={`card-category-${category.id}`}>
                    <CardContent className="p-4 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-slate-400 w-6 text-center">{category.display_order}</span>
                        <span className="font-medium text-slate-900" data-testid={`text-category-name-${category.id}`}>{category.name}</span>
                        <Badge variant="secondary" className="text-xs">{count} sponsor{count !== 1 ? 's' : ''}</Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEditCategory(category)} data-testid={`button-edit-category-${category.id}`}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => setDeletingCategoryId(category.id)} data-testid={`button-delete-category-${category.id}`}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={sponsorDialogOpen} onOpenChange={setSponsorDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSponsor ? "Edit Sponsor" : "Add Sponsor"}</DialogTitle>
            <DialogDescription>
              {editingSponsor ? "Update sponsor details." : "Add a new event sponsor."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sponsor-name">Name *</Label>
              <Input
                id="sponsor-name"
                value={sponsorForm.name}
                onChange={(e) => setSponsorForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Sponsor name"
                data-testid="input-sponsor-name"
              />
            </div>

            <div className="space-y-2">
              <Label>Logo</Label>
              <div className="flex items-center gap-3">
                {sponsorForm.logo_url ? (
                  <img src={sponsorForm.logo_url} alt="Logo preview" className="w-16 h-16 object-contain rounded-md border border-slate-200 bg-white" />
                ) : (
                  <div className="w-16 h-16 rounded-md border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center">
                    <Image className="h-6 w-6 text-slate-300" />
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <label className="cursor-pointer">
                    <Button variant="outline" size="sm" asChild disabled={uploadingLogo}>
                      <span>
                        {uploadingLogo ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Image className="h-4 w-4 mr-1" />}
                        {uploadingLogo ? "Uploading..." : "Upload Logo"}
                      </span>
                    </Button>
                    <input type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} disabled={uploadingLogo} data-testid="input-sponsor-logo" />
                  </label>
                  {sponsorForm.logo_url && (
                    <Button variant="ghost" size="sm" className="text-xs text-red-500" onClick={() => setSponsorForm(prev => ({ ...prev, logo_url: "" }))} data-testid="button-remove-logo">
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sponsor-url">Website URL</Label>
              <Input
                id="sponsor-url"
                value={sponsorForm.website_url}
                onChange={(e) => setSponsorForm(prev => ({ ...prev, website_url: e.target.value }))}
                placeholder="https://example.com"
                data-testid="input-sponsor-url"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="sponsor-description">Description</Label>
              <Textarea
                id="sponsor-description"
                value={sponsorForm.description}
                onChange={(e) => setSponsorForm(prev => ({ ...prev, description: e.target.value }))}
                placeholder="A short description of the sponsor"
                rows={3}
                data-testid="input-sponsor-description"
              />
            </div>

            {categories.length > 0 && (
              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={sponsorForm.category_id || "none"} onValueChange={(val) => setSponsorForm(prev => ({ ...prev, category_id: val === "none" ? "" : val }))}>
                  <SelectTrigger data-testid="select-sponsor-category">
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Category</SelectItem>
                    {categories.map(cat => (
                      <SelectItem key={cat.id} value={cat.id}>{cat.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setSponsorDialogOpen(false)} data-testid="button-cancel-sponsor">Cancel</Button>
              <Button onClick={handleSaveSponsor} disabled={savingSponsor} data-testid="button-save-sponsor">
                {savingSponsor && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {editingSponsor ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingCategory ? "Edit Category" : "Add Category"}</DialogTitle>
            <DialogDescription>
              {editingCategory ? "Update category details." : "Create a new sponsor category."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="category-name">Name *</Label>
              <Input
                id="category-name"
                value={categoryForm.name}
                onChange={(e) => setCategoryForm(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Gold, Silver, Bronze"
                data-testid="input-category-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category-order">Display Order</Label>
              <Input
                id="category-order"
                type="number"
                value={categoryForm.display_order}
                onChange={(e) => setCategoryForm(prev => ({ ...prev, display_order: parseInt(e.target.value) || 0 }))}
                data-testid="input-category-order"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCategoryDialogOpen(false)} data-testid="button-cancel-category">Cancel</Button>
              <Button onClick={handleSaveCategory} disabled={savingCategory} data-testid="button-save-category">
                {savingCategory && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {editingCategory ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deletingSponsorId} onOpenChange={(open) => { if (!open) setDeletingSponsorId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Sponsor</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this sponsor and remove it from all events. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-sponsor">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSponsor} className="bg-red-600 hover:bg-red-700" data-testid="button-confirm-delete-sponsor">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingCategoryId} onOpenChange={(open) => { if (!open) setDeletingCategoryId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Category</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete this category. Sponsors in this category will become uncategorized.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-category">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteCategory} className="bg-red-600 hover:bg-red-700" data-testid="button-confirm-delete-category">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
