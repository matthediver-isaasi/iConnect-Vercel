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

function getFileIcon(mimeTypeOrFilename) {
  if (!mimeTypeOrFilename) return File;
  
  // Check if it's a mime type
  if (mimeTypeOrFilename.startsWith('image/')) return Image;
  if (mimeTypeOrFilename === 'application/pdf') return FileText;
  if (mimeTypeOrFilename.includes('spreadsheet') || mimeTypeOrFilename.includes('excel')) return FileSpreadsheet;
  
  // Check if it's a filename with extension
  const lower = mimeTypeOrFilename.toLowerCase();
  if (lower.endsWith('.pdf')) return FileText;
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.gif') || lower.endsWith('.webp')) return Image;
  if (lower.endsWith('.xls') || lower.endsWith('.xlsx') || lower.endsWith('.csv')) return FileSpreadsheet;
  if (lower.endsWith('.doc') || lower.endsWith('.docx') || lower.endsWith('.txt')) return FileText;
  
  return File;
}

function DocumentItem({ document, onClick }) {
  const statusConfig = STATUS_CONFIG[document.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const FileIcon = getFileIcon(document.mime_type || document.original_file_name);
  const hasUrl = !!document.file_url;
  
  return (
    <div 
      className={`flex items-center gap-3 p-3 rounded-lg border ${hasUrl ? 'hover-elevate cursor-pointer' : 'opacity-70'}`}
      onClick={() => hasUrl && onClick(document)}
      data-testid={`document-item-${document.id}`}
    >
      <div className="p-2 bg-muted rounded-md">
        <FileIcon className="w-5 h-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{document.original_file_name}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
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
          {!hasUrl && (
            <span className="text-xs text-amber-600">No file URL available</span>
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
    if (!formSchema || !submissionData) return [];
    
    // Support both formSchema.schema.fields and formSchema.fields structures
    const schema = formSchema.schema || formSchema;
    if (!schema.fields && !schema.pages) return [];
    
    const files = [];
    const processFields = (fields) => {
      if (!fields) return;
      fields.forEach(field => {
        const fieldKey = field.name || field.id;
        if (!fieldKey || !submissionData[fieldKey]) return;
        
        let rawValue = submissionData[fieldKey];
        let fileData = null;
        let isFileField = false;
        
        // Check if this is a file type field
        if (field.type === 'file') {
          isFileField = true;
          if (typeof rawValue === 'string') {
            try {
              if (rawValue.startsWith('{')) {
                fileData = JSON.parse(rawValue);
              } else if (rawValue) {
                // Plain filename - still include it (might be useful to show)
                fileData = { file_name: rawValue, file_url: null };
              }
            } catch {
              fileData = { file_name: rawValue, file_url: null };
            }
          } else if (typeof rawValue === 'object') {
            fileData = rawValue;
          }
        }
        
        // Also check custom_field types that might contain file upload data
        if (field.type === 'custom_field' && typeof rawValue === 'string' && rawValue.startsWith('{')) {
          try {
            const parsed = JSON.parse(rawValue);
            // Check if it looks like file upload data
            if (parsed.file_url || parsed.file_name) {
              isFileField = true;
              fileData = parsed;
            }
          } catch {
            // Not JSON, skip
          }
        }
        
        if (isFileField && fileData) {
          files.push({
            fieldName: fieldKey,
            label: field.label || fieldKey,
            fileData
          });
        }
      });
    };
    
    if (schema.pages && schema.pages.length > 0) {
      schema.pages.forEach(page => {
        if (page.fields) processFields(page.fields);
      });
    }
    
    if (schema.fields) {
      processFields(schema.fields);
    }
    
    return files;
  }, [formSchema, submissionData]);

  const documents = useMemo(() => {
    const result = [];
    const usedFieldNames = new Set();
    
    // Build a map of db documents by field_name for quick lookup
    const dbDocMap = new Map();
    (dbDocuments || []).forEach(doc => {
      if (doc.is_current_version) {
        dbDocMap.set(doc.field_name, doc);
      }
    });

    // First, add documents matched from form fields (enriched with db data if available)
    fileFieldsFromForm.forEach(fileField => {
      usedFieldNames.add(fileField.fieldName);
      const dbDoc = dbDocMap.get(fileField.fieldName);
      if (dbDoc) {
        result.push({ ...dbDoc, label: fileField.label });
      } else {
        result.push({
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
        });
      }
    });

    // Second, add any db documents that weren't matched to form fields
    // This ensures documents in the database are always displayed
    (dbDocuments || []).forEach(doc => {
      if (doc.is_current_version && !usedFieldNames.has(doc.field_name)) {
        result.push(doc);
      }
    });

    return result;
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
