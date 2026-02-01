import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, FileText, Calendar, User, Building2, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import FormRenderer from "../components/forms/FormRenderer";
import SingleFieldEditModal from "@/components/SingleFieldEditModal";
import { format } from "date-fns";

export default function FormSubmissionView() {
  const { submissionId } = useParams();
  const [expandedSections, setExpandedSections] = useState({});
  const [editField, setEditField] = useState(null);
  const [editModalOpen, setEditModalOpen] = useState(false);

  const { data: submission, isLoading: submissionLoading, error: submissionError } = useQuery({
    queryKey: ['form-submission', submissionId],
    queryFn: async () => {
      return await base44.entities.FormSubmission.get(submissionId);
    },
    enabled: !!submissionId
  });

  const { data: form, isLoading: formLoading } = useQuery({
    queryKey: ['form-for-submission', submission?.form_id],
    queryFn: async () => {
      return await base44.entities.Form.get(submission.form_id);
    },
    enabled: !!submission?.form_id
  });

  const { data: organization } = useQuery({
    queryKey: ['organization-for-submission', submission?.organization_id],
    queryFn: async () => {
      return await base44.entities.Organization.get(submission.organization_id);
    },
    enabled: !!submission?.organization_id
  });

  const toggleSection = (sectionId) => {
    setExpandedSections(prev => ({
      ...prev,
      [sectionId]: !prev[sectionId]
    }));
  };

  if (submissionLoading || formLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (submissionError || !submission) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="border-red-200">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 text-red-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
                Submission not found
              </h3>
              <p className="text-slate-600 dark:text-slate-400 mb-4">
                The form submission you're looking for doesn't exist or you don't have access to it.
              </p>
              <Link to="/FormSubmissions">
                <Button variant="outline">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Submissions
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const submissionData = submission.submission_data || {};
  const fields = form?.fields || [];
  
  const hasPages = form?.pages && form.pages.length > 0;
  
  // Fields are linked to pages via field.page_id
  // Filter out due_diligence fields - they should not be shown to end users
  const visibleFields = fields.filter(f => !f.due_diligence);
  
  const getFieldsForPage = (page) => {
    if (!hasPages || !page) return visibleFields;
    // Filter fields that belong to this page
    return visibleFields.filter(f => f.page_id === page.id);
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'new':
        return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">New</Badge>;
      case 'junk':
        return <Badge className="bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300">Junk</Badge>;
      case 'actioned':
        return <Badge className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Actioned</Badge>;
      default:
        return <Badge variant="secondary">{status || 'New'}</Badge>;
    }
  };

  const handleEditField = (field, value) => {
    setEditField({ field, value });
    setEditModalOpen(true);
  };

  const renderField = (field) => {
    if (!field) return null;
    
    // Instructions fields are display-only, render them directly (no edit button)
    if (field.type === 'instructions') {
      return (
        <div key={field.id}>
          <FormRenderer
            field={field}
            value=""
            onChange={() => {}}
            disabled={true}
          />
        </div>
      );
    }
    
    const value = submissionData[field.id];
    const isEditable = field.type !== 'page_break';
    
    if (value === undefined || value === null || value === '') {
      return (
        <div key={field.id} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-1">{field.label || field.id}</p>
              <p className="text-slate-400 dark:text-slate-500 italic">Not provided</p>
            </div>
            {isEditable && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 flex-shrink-0"
                onClick={() => handleEditField(field, value)}
                data-testid={`button-edit-${field.id}`}
              >
                <Pencil className="w-4 h-4 text-slate-400 hover:text-slate-600" />
              </Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div key={field.id} className="p-4 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <FormRenderer
              field={field}
              value={value}
              onChange={() => {}}
              disabled={true}
            />
          </div>
          {isEditable && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 flex-shrink-0"
              onClick={() => handleEditField(field, value)}
              data-testid={`button-edit-${field.id}`}
            >
              <Pencil className="w-4 h-4 text-slate-400 hover:text-slate-600" />
            </Button>
          )}
        </div>
      </div>
    );
  };

  const renderAllFields = () => {
    if (hasPages) {
      return form.pages.map((page, pageIndex) => {
        const pageFields = getFieldsForPage(page);
        const isExpanded = expandedSections[`page-${page.id}`] !== false;
        
        // Skip pages with no fields
        if (pageFields.length === 0) return null;
        
        return (
          <div key={page.id || pageIndex} className="border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden">
            <button
              onClick={() => toggleSection(`page-${page.id}`)}
              className="w-full flex items-center justify-between p-4 bg-blue-100 dark:bg-blue-900/50 hover:bg-blue-200 dark:hover:bg-blue-800/50 transition-colors"
              data-testid={`section-toggle-${pageIndex}`}
            >
              <h3 className="font-semibold text-blue-900 dark:text-blue-100">
                {page.title || `Section ${pageIndex + 1}`}
              </h3>
              {isExpanded ? (
                <ChevronUp className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              ) : (
                <ChevronDown className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              )}
            </button>
            {isExpanded && (
              <div className="p-4 space-y-4 bg-white dark:bg-slate-900">
                {pageFields.map(field => renderField(field))}
              </div>
            )}
          </div>
        );
      }).filter(Boolean);
    }
    
    return (
      <div className="space-y-4">
        {visibleFields.map(field => renderField(field))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <Link to="/FormSubmissions">
            <Button variant="ghost" size="sm" className="mb-4" data-testid="button-back">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Submissions
            </Button>
          </Link>
          
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <FileText className="w-8 h-8 text-blue-600" />
                <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-slate-100">
                  {form?.name || 'Form Submission'}
                </h1>
              </div>
              {form?.description && (
                <p className="text-slate-600 dark:text-slate-400 mt-1">{form.description}</p>
              )}
            </div>
            {getStatusBadge(submission.status)}
          </div>
        </div>

        <Card className="mb-6 border-slate-200 dark:border-slate-700">
          <CardContent className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400" />
                <div>
                  <p className="text-slate-500 dark:text-slate-400">Submitted</p>
                  <p className="font-medium text-slate-900 dark:text-slate-100">
                    {submission.created_date 
                      ? format(new Date(submission.created_date), 'dd MMM yyyy, HH:mm')
                      : 'Unknown'}
                  </p>
                </div>
              </div>
              
              {submission.submitted_by_name && (
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Submitted by</p>
                    <p className="font-medium text-slate-900 dark:text-slate-100">
                      {submission.submitted_by_name}
                    </p>
                  </div>
                </div>
              )}
              
              {organization && (
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-slate-400" />
                  <div>
                    <p className="text-slate-500 dark:text-slate-400">Organisation</p>
                    <p className="font-medium text-slate-900 dark:text-slate-100">
                      {organization.name}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 dark:border-slate-700">
          <CardHeader>
            <CardTitle className="text-lg">Submitted Data</CardTitle>
            <CardDescription>
              Click the pencil icon next to any field to edit its value
            </CardDescription>
          </CardHeader>
          <CardContent>
            {visibleFields.length > 0 ? (
              <div className="space-y-4">
                {renderAllFields()}
              </div>
            ) : (
              <div className="space-y-4">
                {Object.entries(submissionData).map(([key, value]) => (
                  <div key={key} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
                    <p className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-1">
                      {key.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim()}
                    </p>
                    <p className="text-slate-900 dark:text-slate-100 whitespace-pre-wrap">
                      {Array.isArray(value) 
                        ? value.join(', ') 
                        : typeof value === 'object' 
                          ? JSON.stringify(value, null, 2)
                          : String(value)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <SingleFieldEditModal
        open={editModalOpen}
        onOpenChange={(open) => {
          setEditModalOpen(open);
          if (!open) setEditField(null);
        }}
        field={editField?.field}
        currentValue={editField?.value}
        submissionId={submissionId}
        formId={form?.id}
      />
    </div>
  );
}
