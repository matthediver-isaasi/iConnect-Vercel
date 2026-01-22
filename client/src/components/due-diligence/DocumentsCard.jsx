import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Image, FileSpreadsheet, File, Check, X, Clock, RefreshCw, Loader2 } from "lucide-react";

async function apiRequest(method, url, body = null) {
  const options = { method, credentials: 'include', headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: '#f59e0b', icon: Clock },
  approved: { label: 'Approved', color: '#22c55e', icon: Check },
  rejected: { label: 'Rejected', color: '#ef4444', icon: X },
  aged: { label: 'Aged', color: '#6b7280', icon: RefreshCw }
};

function getFileIcon(mimeType) {
  if (!mimeType) return File;
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType === 'application/pdf') return FileText;
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return FileSpreadsheet;
  return File;
}

function DocumentItem({ document, onClick }) {
  const statusConfig = STATUS_CONFIG[document.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const FileIcon = getFileIcon(document.mime_type);
  
  return (
    <div 
      className="flex items-center gap-3 p-3 rounded-lg border hover-elevate cursor-pointer"
      onClick={() => onClick(document)}
      data-testid={`document-item-${document.id}`}
    >
      <div className="p-2 bg-muted rounded-md">
        <FileIcon className="w-5 h-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{document.original_file_name}</p>
        <div className="flex items-center gap-2 mt-1">
          <Badge 
            variant="outline" 
            className="text-xs"
            style={{ borderColor: statusConfig.color, color: statusConfig.color }}
          >
            <StatusIcon className="w-3 h-3 mr-1" />
            {statusConfig.label}
          </Badge>
          {document.version > 1 && (
            <span className="text-xs text-muted-foreground">v{document.version}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DocumentsCard({ formSubmissionId, submissionData, formSchema, onDocumentClick }) {
  const { data: dbDocuments, isLoading: dbLoading } = useQuery({
    queryKey: ['submission-documents', formSubmissionId],
    queryFn: async () => {
      const result = await apiRequest('GET', `/api/due-diligence/documents/list?formSubmissionId=${formSubmissionId}`);
      return result.documents || [];
    },
    enabled: !!formSubmissionId
  });

  const fileFieldsFromForm = useMemo(() => {
    if (!formSchema?.schema || !submissionData) return [];
    if (!formSchema.schema.fields && !formSchema.schema.pages) return [];
    
    const files = [];
    const processFields = (fields) => {
      if (!fields) return;
      fields.forEach(field => {
        const fieldKey = field.name || field.id;
        if (field.type === 'file' && fieldKey && submissionData[fieldKey]) {
          const fileData = submissionData[fieldKey];
          files.push({
            fieldName: fieldKey,
            label: field.label || fieldKey,
            fileData: typeof fileData === 'object' ? fileData : { file_url: fileData, file_name: fileData }
          });
        }
      });
    };
    
    if (formSchema.schema.pages && formSchema.schema.pages.length > 0) {
      formSchema.schema.pages.forEach(page => {
        if (page.fields) processFields(page.fields);
      });
    }
    
    if (formSchema.schema.fields) {
      processFields(formSchema.schema.fields);
    }
    
    return files;
  }, [formSchema, submissionData]);

  const documents = useMemo(() => {
    const dbDocMap = new Map();
    (dbDocuments || []).forEach(doc => {
      if (doc.is_current_version) {
        dbDocMap.set(doc.field_name, doc);
      }
    });

    return fileFieldsFromForm.map(fileField => {
      const dbDoc = dbDocMap.get(fileField.fieldName);
      if (dbDoc) {
        return { ...dbDoc, label: fileField.label };
      }
      return {
        id: `form-${fileField.fieldName}`,
        field_name: fileField.fieldName,
        original_file_name: fileField.fileData.file_name || fileField.label,
        file_url: fileField.fileData.file_url,
        file_name: fileField.fileData.file_name,
        file_size: fileField.fileData.file_size,
        mime_type: fileField.fileData.mime_type,
        status: 'pending',
        version: 1,
        is_current_version: true,
        label: fileField.label,
        isFromForm: true
      };
    });
  }, [fileFieldsFromForm, dbDocuments]);

  if (dbLoading) {
    return (
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="text-lg">Documents</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="shadow-lg">
      <CardHeader>
        <CardTitle className="text-lg">Documents</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {documents.length > 0 ? (
          documents.map(doc => (
            <DocumentItem 
              key={doc.id} 
              document={doc} 
              onClick={onDocumentClick}
            />
          ))
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            No documents uploaded with this submission
          </p>
        )}
      </CardContent>
    </Card>
  );
}
