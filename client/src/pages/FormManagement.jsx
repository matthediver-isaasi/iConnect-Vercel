import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Pencil, Trash2, Eye, EyeOff, FileText, BarChart3, Copy } from "lucide-react";
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
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function FormManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingForm, setDeletingForm] = useState(null);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FormManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: forms = [], isLoading } = useQuery({
    queryKey: ['forms'],
    queryFn: async () => {
      return await base44.entities.Form.list();
    },
    staleTime: 0, // Admin views need instant freshness after edits
  });

  // Fetch actual submission counts from FormSubmission table (use listAll for pagination)
  const { data: submissions = [] } = useQuery({
    queryKey: ['form-submissions-all'],
    queryFn: async () => {
      return await base44.entities.FormSubmission.listAll();
    },
    staleTime: 0,
  });

  // Create a map of form_id to actual submission count
  const submissionCounts = React.useMemo(() => {
    const counts = {};
    submissions.forEach(sub => {
      if (sub.form_id) {
        counts[sub.form_id] = (counts[sub.form_id] || 0) + 1;
      }
    });
    return counts;
  }, [submissions]);

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Form Management
            </h1>
            <p className="text-slate-600">Create and manage custom forms</p>
          </div>
          <Link to={createPageUrl('FormBuilder')}>
            <Button className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              Create Form
            </Button>
          </Link>
        </div>

        {forms.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No forms yet</h3>
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
            {forms.map(form => (
              <Card key={form.id} className="border-slate-200 hover:shadow-lg transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-base mb-2">{form.name}</CardTitle>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline">
                          {form.layout_type === 'card_swipe' ? 'Card Swipe' : 'Standard'}
                        </Badge>
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
                      <Button variant="outline" size="sm" className="w-full">
                        <Pencil className="w-3 h-3 mr-1" />
                        Edit
                      </Button>
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDuplicate(form)}
                      disabled={duplicateFormMutation.isPending}
                      title="Duplicate form"
                    >
                      <Copy className="w-3 h-3" />
                    </Button>
                    <Link to={`${createPageUrl('FormView')}?slug=${form.slug}`}>
                      <Button variant="outline" size="sm">
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
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
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
    </div>
  );
}