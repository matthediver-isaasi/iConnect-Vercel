import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Image, FileSpreadsheet, File, Check, X, Clock, Loader2, Upload } from "lucide-react";

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
  rejected: { label: 'Rejected', color: '#ef4444', icon: X }
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
  const isEmpty = document.isEmpty;
  
  // Empty placeholder for fields with no data
  if (isEmpty) {
    return (
      <div 
        className="flex items-center gap-3 p-3 rounded-lg border border-dashed opacity-60"
        data-testid={`document-item-empty-${document.id}`}
      >
        <div className="p-2 bg-muted rounded-md">
          <Upload className="w-5 h-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground mb-0.5">{document.label}</p>
          <p className="text-sm font-medium text-muted-foreground italic">No file uploaded</p>
        </div>
      </div>
    );
  }
  
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
        {document.label && (
          <p className="text-xs text-muted-foreground mb-0.5">{document.label}</p>
        )}
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
  // DEBUG: Trace document detection issue
  console.log('[DocumentsCard] Input props:', {
    formSubmissionId,
    hasSubmissionData: !!submissionData,
    submissionDataType: typeof submissionData,
    submissionDataKeys: submissionData ? Object.keys(submissionData) : [],
    submissionDataSample: submissionData ? JSON.stringify(submissionData).substring(0, 500) : 'null',
    hasFormSchema: !!formSchema,
    formSchemaKeys: formSchema ? Object.keys(formSchema) : [],
    formHasFields: !!formSchema?.fields,
    formFieldsCount: formSchema?.fields?.length,
    formHasPages: !!formSchema?.pages,
    formPagesCount: formSchema?.pages?.length
  });

  const { data: dbDocuments, isLoading: dbLoading } = useQuery({
    queryKey: ['submission-documents', formSubmissionId],
    queryFn: async () => {
      const result = await apiRequest('GET', `/api/due-diligence/documents/list?formSubmissionId=${formSubmissionId}`);
      return result.documents || [];
    },
    enabled: !!formSubmissionId
  });

  // Collect all custom_field type fields that have a custom_field_id
  const customFieldIds = useMemo(() => {
    if (!formSchema) return [];
    
    const schema = formSchema.schema || formSchema;
    const ids = [];
    
    const collectCustomFieldIds = (fields) => {
      if (!fields) return;
      fields.forEach(field => {
        if (field.type === 'custom_field' && field.custom_field_id) {
          ids.push({
            customFieldId: field.custom_field_id,
            formFieldId: field.id,
            formFieldName: field.name,
            label: field.label
          });
        }
      });
    };
    
    if (schema.pages && schema.pages.length > 0) {
      schema.pages.forEach(page => {
        if (page.fields) collectCustomFieldIds(page.fields);
      });
    }
    if (schema.fields) {
      collectCustomFieldIds(schema.fields);
    }
    
    console.log('[DocumentsCard] Found custom_field type fields:', ids.length, ids.map(cf => ({ id: cf.customFieldId, label: cf.label })));
    return ids;
  }, [formSchema]);

  // Fetch custom field definitions to check which ones are file types
  const customFieldQueries = useQueries({
    queries: customFieldIds.map(cf => ({
      queryKey: ['public-custom-field', cf.customFieldId, formSchema?.id],
      queryFn: async () => {
        try {
          const response = await fetch(`/api/public/custom-field/${cf.customFieldId}?form_id=${formSchema?.id || ''}`, {
            credentials: 'include'
          });
          if (!response.ok) return null;
          const data = await response.json();
          return { ...data, formFieldId: cf.formFieldId, formFieldName: cf.formFieldName, formFieldLabel: cf.label };
        } catch {
          return null;
        }
      },
      enabled: !!cf.customFieldId,
      staleTime: 60000 // Cache for 1 minute
    }))
  });

  // Map of custom field IDs to their definitions (for file type detection)
  const fileTypeCustomFields = useMemo(() => {
    const fileFields = new Map();
    customFieldQueries.forEach(query => {
      if (query.data && query.data.field_type === 'file') {
        const fieldKey = query.data.formFieldName || query.data.formFieldId;
        console.log('[DocumentsCard] File-type custom field found:', {
          customFieldId: query.data.id,
          label: query.data.label || query.data.formFieldLabel,
          fieldKey,
          field_type: query.data.field_type
        });
        fileFields.set(fieldKey, {
          customFieldId: query.data.id,
          label: query.data.formFieldLabel || query.data.label,
          fieldKey
        });
      }
    });
    return fileFields;
  }, [customFieldQueries]);

  const customFieldsLoading = customFieldQueries.some(q => q.isLoading);

  const fileFieldsFromForm = useMemo(() => {
    if (!formSchema) {
      console.log('[DocumentsCard] fileFieldsFromForm: Early return - missing formSchema');
      return [];
    }
    
    // Support both formSchema.schema.fields and formSchema.fields structures
    const schema = formSchema.schema || formSchema;
    console.log('[DocumentsCard] Processing schema:', {
      hasSchemaFields: !!schema.fields,
      schemaFieldsCount: schema.fields?.length,
      hasSchemaPages: !!schema.pages,
      schemaPagesCount: schema.pages?.length,
      allFieldTypes: schema.fields?.map(f => f.type) || [],
      pageFieldTypes: schema.pages?.flatMap(p => p.fields?.map(f => f.type) || []),
      fileTypeCustomFieldsCount: fileTypeCustomFields.size
    });
    if (!schema.fields && !schema.pages) return [];
    
    const files = [];
    const processedKeys = new Set();
    
    const processFields = (fields) => {
      if (!fields) return;
      fields.forEach(field => {
        const fieldKey = field.name || field.id;
        if (!fieldKey || processedKeys.has(fieldKey)) return;
        
        let rawValue = submissionData ? submissionData[fieldKey] : null;
        let fileData = null;
        let isFileField = false;
        let isEmpty = false;
        
        // Check if this is a native file type field
        if (field.type === 'file') {
          console.log('[DocumentsCard] Native file field found:', {
            fieldName: field.name,
            fieldId: field.id,
            fieldKey,
            hasMatch: !!rawValue,
            submissionValue: rawValue ? 'present' : 'missing'
          });
          
          isFileField = true;
          if (!rawValue) {
            isEmpty = true;
            fileData = { file_name: null, file_url: null };
          } else if (typeof rawValue === 'string') {
            try {
              if (rawValue.startsWith('{')) {
                fileData = JSON.parse(rawValue);
              } else if (rawValue) {
                fileData = { file_name: rawValue, file_url: null };
              }
            } catch {
              fileData = { file_name: rawValue, file_url: null };
            }
          } else if (typeof rawValue === 'object') {
            fileData = rawValue;
          }
        }
        
        // Check if this is a custom_field that's a file upload type
        if (field.type === 'custom_field' && fileTypeCustomFields.has(fieldKey)) {
          const customFieldInfo = fileTypeCustomFields.get(fieldKey);
          console.log('[DocumentsCard] Custom field file upload detected:', {
            fieldKey,
            customFieldInfo,
            hasValue: !!rawValue
          });
          
          isFileField = true;
          if (!rawValue) {
            isEmpty = true;
            fileData = { file_name: null, file_url: null };
          } else if (typeof rawValue === 'string') {
            try {
              if (rawValue.startsWith('{')) {
                fileData = JSON.parse(rawValue);
              } else if (rawValue) {
                fileData = { file_name: rawValue, file_url: null };
              }
            } catch {
              fileData = { file_name: rawValue, file_url: null };
            }
          } else if (typeof rawValue === 'object') {
            fileData = rawValue;
          }
        }
        
        // Also handle custom_field types where the value looks like file data (fallback)
        if (!isFileField && field.type === 'custom_field' && rawValue) {
          // Handle string JSON values
          if (typeof rawValue === 'string' && rawValue.startsWith('{')) {
            try {
              const parsed = JSON.parse(rawValue);
              if (parsed.file_url || parsed.file_name) {
                isFileField = true;
                fileData = parsed;
              }
            } catch {
              // Not JSON, skip
            }
          }
          // Handle object values directly (fallback if custom field definition fetch failed)
          else if (typeof rawValue === 'object' && (rawValue.file_url || rawValue.file_name)) {
            isFileField = true;
            fileData = rawValue;
          }
        }
        
        if (isFileField) {
          processedKeys.add(fieldKey);
          console.log('[DocumentsCard] Adding file field:', { fieldKey, type: field.type, isEmpty, hasData: !!fileData?.file_url });
          files.push({
            fieldName: fieldKey,
            label: field.label || fieldKey,
            fileData: fileData || { file_name: null, file_url: null },
            isEmpty
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
    
    console.log('[DocumentsCard] fileFieldsFromForm result:', files.length, 'files found', files.map(f => ({ key: f.fieldName, label: f.label, isEmpty: f.isEmpty })));
    return files;
  }, [formSchema, submissionData, fileTypeCustomFields]);

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
        return { ...dbDoc, label: fileField.label, isEmpty: false };
      }
      
      // If field has no data (isEmpty), show placeholder
      if (fileField.isEmpty) {
        return {
          id: `empty-${fileField.fieldName}`,
          field_name: fileField.fieldName,
          original_file_name: null,
          file_url: null,
          file_name: null,
          status: 'pending',
          version: 1,
          is_current_version: true,
          label: fileField.label,
          isFromForm: true,
          isEmpty: true
        };
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
        isFromForm: true,
        isEmpty: false
      };
    });
  }, [fileFieldsFromForm, dbDocuments]);

  if (dbLoading || customFieldsLoading) {
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
