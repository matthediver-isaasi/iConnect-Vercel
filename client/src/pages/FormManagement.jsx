import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Pencil, Trash2, Eye, EyeOff, FileText, BarChart3, Copy, FileSignature, Building2, Clock, Send, FilePlus } from "lucide-react";
import ManualSubmissionDialog from "@/components/ManualSubmissionDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function FormManagementPage() {
  const { isFeatureExcluded, isAccessReady, authResolved, sessionValidated } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingForm, setDeletingForm] = useState(null);
  const [manualSubmissionOpen, setManualSubmissionOpen] = useState(false);
  const [manualSubmissionForm, setManualSubmissionForm] = useState(null);

  const queryClient = useQueryClient();

  // SECURITY: Only consider authenticated when auth check complete AND session validated
  const isAuthenticated = authResolved && sessionValidated;

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FormManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  // SECURITY: Gate query on auth to prevent fetching before tenant context is ready
  const { data: forms = [], isLoading } = useQuery({
    queryKey: ['forms'],
    queryFn: async () => {
      return await base44.entities.Form.list();
    },
    staleTime: 0, // Admin views need instant freshness after edits
    enabled: isAuthenticated,
  });

  // Fetch actual submission counts from FormSubmission table (use listAll for pagination)
  // SECURITY: Gate on auth to prevent cross-tenant data leakage
  const { data: submissions = [] } = useQuery({
    queryKey: ['form-submissions-all'],
    queryFn: async () => {
      return await base44.entities.FormSubmission.listAll();
    },
    staleTime: 0,
    enabled: isAuthenticated,
  });

  // Create a map of form_id to actual submission count
  const submissionCounts = useMemo(() => {
    const counts = {};
    submissions.forEach(sub => {
      if (sub.form_id) {
        counts[sub.form_id] = (counts[sub.form_id] || 0) + 1;
      }
    });
    return counts;
  }, [submissions]);

  // Split forms into standard and contracts
  const { standardForms, contractForms } = useMemo(() => {
    const standard = forms.filter(form => !form.is_contract);
    const contracts = forms.filter(form => form.is_contract);
    return { standardForms: standard, contractForms: contracts };
  }, [forms]);

  // Fetch organizations for contract display
  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-form-management'],
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    },
    enabled: isAuthenticated,
  });

  const deleteFormMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.Form.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form deleted successfully');
      setDeleteDialogOpen(false);
      setDeletingForm(null);
    },
    onError: (error) => {
      toast.error('Failed to delete form');
    }
  });

  const duplicateFormMutation = useMutation({
    mutationFn: async (form) => {
      const { id, created_date, updated_date, created_by, submission_count, ...formData } = form;
      
      const newForm = {
        ...formData,
        name: `Copy of ${form.name}`,
        slug: `${form.slug}-copy-${Date.now()}`,
        submission_count: 0
      };

      return await base44.entities.Form.create(newForm);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms'] });
      toast.success('Form duplicated successfully');
    },
    onError: (error) => {
      toast.error('Failed to duplicate form');
    }
  });

  const handleDelete = () => {
    if (!deletingForm) return;
    deleteFormMutation.mutate(deletingForm.id);
  };

  const handleDuplicate = (form) => {
    duplicateFormMutation.mutate(form);
  };

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Helper function to get organization name by ID
  const getOrgName = (orgId) => {
    const org = organizations.find(o => o.id === orgId);
    return org?.name || 'Unknown';
  };

  // Form card component for reuse
  const FormCard = ({ form, isContract = false }) => (
    <Card key={form.id} className="border-slate-200 hover:shadow-lg transition-shadow" data-testid={`form-card-${form.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-base mb-2">{form.name}</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {isContract ? (
                <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50">
                  <FileSignature className="w-3 h-3 mr-1" />
                  Contract
                </Badge>
              ) : (
                <Badge variant="outline">
                  {form.layout_type === 'card_swipe' ? 'Card Swipe' : 'Standard'}
                </Badge>
              )}
              <Badge variant={form.is_active ? "default" : "secondary"}>
                {form.is_active ? (
                  <>
                    <Eye className="w-3 h-3 mr-1" />
                    Active
                  </>
                ) : (
                  <>
                    <EyeOff className="w-3 h-3 mr-1" />
                    Inactive
                  </>
                )}
              </Badge>
              {form.require_authentication && (
                <Badge variant="secondary">Auth Required</Badge>
              )}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {form.description && (
          <p className="text-xs text-slate-600 line-clamp-2">{form.description}</p>
        )}
        {isContract && form.contract_settings?.organization_id && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600 flex items-center gap-1">
              <Building2 className="w-3 h-3" />
              Organisation:
            </span>
            <Badge variant="secondary">{getOrgName(form.contract_settings.organization_id)}</Badge>
          </div>
        )}
        {isContract && form.contract_settings?.timeout_days && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Timeout:
            </span>
            <Badge variant="secondary">{form.contract_settings.timeout_days} days</Badge>
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Fields:</span>
          <Badge variant="secondary">{form.fields?.length || 0}</Badge>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Submissions:</span>
          <Link to={`${createPageUrl('FormSubmissions')}?formId=${form.id}`}>
            <Badge variant="secondary" className="gap-1 cursor-pointer hover:bg-slate-200">
              <BarChart3 className="w-3 h-3" />
              {submissionCounts[form.id] || 0}
            </Badge>
          </Link>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-600">Slug:</span>
          <code className="text-xs bg-slate-100 px-2 py-1 rounded">{form.slug}</code>
        </div>
        <div className="flex gap-2 pt-2">
          <Link to={`${createPageUrl('FormBuilder')}?formId=${form.id}`} className="flex-1">
            <Button variant="outline" size="sm" className="w-full" data-testid={`button-edit-${form.id}`}>
              <Pencil className="w-3 h-3 mr-1" />
              Edit
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setManualSubmissionForm(form);
              setManualSubmissionOpen(true);
            }}
            title="Add manual submission"
            data-testid={`button-manual-submission-${form.id}`}
          >
            <FilePlus className="w-3 h-3" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDuplicate(form)}
            disabled={duplicateFormMutation.isPending}
            title="Duplicate form"
            data-testid={`button-duplicate-${form.id}`}
          >
            <Copy className="w-3 h-3" />
          </Button>
          <Link to={`${createPageUrl('FormView')}?slug=${form.slug}`}>
            <Button variant="outline" size="sm" data-testid={`button-view-${form.id}`}>
              <Eye className="w-3 h-3" />
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDeletingForm(form);
              setDeleteDialogOpen(true);
            }}
            data-testid={`button-delete-${form.id}`}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Form Management
            </h1>
            <p className="text-slate-600">Create and manage custom forms and contracts</p>
          </div>
          <Link to={createPageUrl('FormBuilder')}>
            <Button className="bg-blue-600 hover:bg-blue-700" data-testid="button-create-form">
              <Plus className="w-4 h-4 mr-2" />
              Create Form
            </Button>
          </Link>
        </div>

        <Tabs defaultValue="standard" className="w-full">
          <TabsList className="mb-6" data-testid="form-management-tabs">
            <TabsTrigger value="standard" data-testid="tab-standard-forms">
              <FileText className="w-4 h-4 mr-2" />
              Standard Forms
              {standardForms.length > 0 && (
                <Badge variant="secondary" className="ml-2">{standardForms.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="contracts" data-testid="tab-contracts">
              <FileSignature className="w-4 h-4 mr-2" />
              Contracts
              {contractForms.length > 0 && (
                <Badge variant="secondary" className="ml-2">{contractForms.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="standard">
            {standardForms.length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No standard forms yet</h3>
                  <p className="text-slate-600 mb-6">Create your first form to get started</p>
                  <Link to={createPageUrl('FormBuilder')}>
                    <Button className="bg-blue-600 hover:bg-blue-700">
                      <Plus className="w-4 h-4 mr-2" />
                      Create Form
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {standardForms.map(form => (
                  <FormCard key={form.id} form={form} isContract={false} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="contracts">
            {contractForms.length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <FileSignature className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No contracts yet</h3>
                  <p className="text-slate-600 mb-6">Create a form with Contract Mode enabled to see it here</p>
                  <Link to={createPageUrl('FormBuilder')}>
                    <Button className="bg-blue-600 hover:bg-blue-700">
                      <Plus className="w-4 h-4 mr-2" />
                      Create Contract
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {contractForms.map(form => (
                  <FormCard key={form.id} form={form} isContract={true} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the form "{deletingForm?.name}" and all its submissions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ManualSubmissionDialog
        open={manualSubmissionOpen}
        onOpenChange={setManualSubmissionOpen}
        form={manualSubmissionForm}
      />
    </div>
  );
}