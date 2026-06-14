import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { 
  Upload, 
  FileSpreadsheet, 
  ArrowRight, 
  Check, 
  X, 
  Loader2, 
  User, 
  Building2,
  AlertCircle,
  ChevronRight,
  Trash2,
  RefreshCw,
  History,
  Users,
  Filter,
  Eye,
  Play,
  Copy
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function ImportManager() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('member');
  const [step, setStep] = useState(1); // 1: Upload, 2: Map, 3: Preview, 4: Execute
  const [csvFile, setCsvFile] = useState(null);
  const [csvData, setCsvData] = useState(null);
  const [mappings, setMappings] = useState([]);
  const [identifierField, setIdentifierField] = useState('email');
  
  // Deduplication state
  const [dedupeExcludeOrgs, setDedupeExcludeOrgs] = useState([]);
  const [dedupeExcludeRoles, setDedupeExcludeRoles] = useState([]);
  const [dedupePreview, setDedupePreview] = useState(null);
  const [isPreviewingDedupe, setIsPreviewingDedupe] = useState(false);
  const [isExecutingDedupe, setIsExecutingDedupe] = useState(false);
  const [dedupeResult, setDedupeResult] = useState(null);
  
  const DATE_FORMAT_OPTIONS = [
    { value: 'dd/mm/yyyy', label: 'DD/MM/YYYY (31/12/2024)' },
    { value: 'dd-mm-yyyy', label: 'DD-MM-YYYY (31-12-2024)' },
    { value: 'dd.mm.yyyy', label: 'DD.MM.YYYY (31.12.2024)' },
    { value: 'mm/dd/yyyy', label: 'MM/DD/YYYY (12/31/2024)' },
    { value: 'mm-dd-yyyy', label: 'MM-DD-YYYY (12-31-2024)' },
    { value: 'yyyy-mm-dd', label: 'YYYY-MM-DD (2024-12-31)' },
    { value: 'yyyy/mm/dd', label: 'YYYY/MM/DD (2024/12/31)' },
    { value: 'dd/mm/yy', label: 'DD/MM/YY (31/12/24)' },
    { value: 'dd-mm-yy', label: 'DD-MM-YY (31-12-24)' },
    { value: 'mm/dd/yy', label: 'MM/DD/YY (12/31/24)' },
    { value: 'yy-mm-dd', label: 'YY-MM-DD (24-12-31)' },
  ];
  const [previewResult, setPreviewResult] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const fileInputRef = useRef(null);

  // While an import is running we cannot safely resume after the tab closes, so
  // warn the user before they navigate away or close the tab. The native prompt
  // only appears when there is genuinely an import in flight.
  useEffect(() => {
    if (!isImporting) return;
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isImporting]);

  // Fetch available fields for mapping
  const { data: availableFields, isLoading: fieldsLoading } = useQuery({
    queryKey: ['/api/imports/fields', activeTab],
    queryFn: async () => {
      console.log('[ImportManager] Fetching fields for entity:', activeTab);
      const response = await fetch(`/api/imports/fields?entity=${activeTab}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch fields');
      const data = await response.json();
      console.log('[ImportManager] Received fields:', data.core?.slice(0, 3));
      return data;
    },
    staleTime: 0
  });

  // Fetch recent import jobs
  const { data: recentJobs = [], isLoading: jobsLoading, refetch: refetchJobs } = useQuery({
    queryKey: ['/api/imports/jobs', activeTab],
    queryFn: async () => {
      const response = await fetch(`/api/imports/jobs?entity=${activeTab}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch jobs');
      return response.json();
    }
  });

  // Fetch organizations for deduplication exclusion filter
  const { data: organizations = [] } = useQuery({
    queryKey: ['/api/admin/organizations'],
    queryFn: async () => {
      const response = await fetch('/api/admin/organizations?limit=1000', {
        credentials: 'include'
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || data || [];
    },
    enabled: activeTab === 'dedupe'
  });

  // Fetch roles for deduplication exclusion filter
  const { data: roles = [] } = useQuery({
    queryKey: ['/api/admin/roles'],
    queryFn: async () => {
      const response = await fetch('/api/admin/roles', {
        credentials: 'include'
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.data || data || [];
    },
    enabled: activeTab === 'dedupe'
  });

  // Deduplication functions
  const handleDedupePreview = async () => {
    setIsPreviewingDedupe(true);
    setDedupePreview(null);
    setDedupeResult(null);
    
    try {
      const response = await fetch('/api/admin/members/dedupe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'preview',
          excludeOrganizationIds: dedupeExcludeOrgs,
          excludeRoleIds: dedupeExcludeRoles
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to preview duplicates');
      }
      
      const data = await response.json();
      setDedupePreview(data);
      toast.success(`Found ${data.summary?.totalToDelete || 0} duplicate members to remove`);
    } catch (error) {
      toast.error(error.message || 'Failed to preview duplicates');
    } finally {
      setIsPreviewingDedupe(false);
    }
  };

  const handleDedupeExecute = async () => {
    if (!dedupePreview?.summary?.totalToDelete) {
      toast.error('No duplicates to remove. Run preview first.');
      return;
    }
    
    setIsExecutingDedupe(true);
    
    try {
      const response = await fetch('/api/admin/members/dedupe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'execute',
          excludeOrganizationIds: dedupeExcludeOrgs,
          excludeRoleIds: dedupeExcludeRoles
        })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove duplicates');
      }
      
      const data = await response.json();
      setDedupeResult(data);
      setDedupePreview(null);
      toast.success(`Successfully removed ${data.deleted || 0} duplicate members`);
      queryClient.invalidateQueries({ queryKey: ['/api/admin/members'] });
    } catch (error) {
      toast.error(error.message || 'Failed to remove duplicates');
    } finally {
      setIsExecutingDedupe(false);
    }
  };

  const resetDedupe = () => {
    setDedupePreview(null);
    setDedupeResult(null);
    setDedupeExcludeOrgs([]);
    setDedupeExcludeRoles([]);
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith('.csv') && !lowerName.endsWith('.xlsx')) {
      toast.error('Please upload a CSV or XLS (.xlsx) file');
      return;
    }

    setIsUploading(true);
    setCsvFile(file);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/imports/parse', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to parse file');
      }

      const data = await response.json();
      setCsvData(data);

      // Initialize mappings with empty values
      const initialMappings = data.columns.map(col => ({
        sourceColumn: col,
        targetField: '',
        targetScope: '',
        clearOnEmpty: false
      }));
      setMappings(initialMappings);
      setStep(2);
      toast.success(`File loaded: ${data.rowCount} rows, ${data.columns.length} columns`);
    } catch (error) {
      toast.error(error.message || 'Failed to parse file');
      setCsvFile(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleMappingChange = (index, field, value) => {
    setMappings(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      
      // If setting target field, also set scope, preferenceFieldId, and type for custom fields
      if (field === 'targetField' && value) {
        const allFields = [...(availableFields?.core || []), ...(availableFields?.custom || []), ...(availableFields?.communication || [])];
        const targetDef = allFields.find(f => f.key === value);
        if (targetDef) {
          updated[index].targetScope = targetDef.scope;
          updated[index].targetType = targetDef.type;
          // For custom fields, store the preferenceFieldId for the execute endpoint
          if (targetDef.preferenceFieldId) {
            updated[index].preferenceFieldId = targetDef.preferenceFieldId;
          } else {
            updated[index].preferenceFieldId = null;
          }
          // Set default date format for date fields
          if (targetDef.type === 'date' && !updated[index].dateFormat) {
            updated[index].dateFormat = 'dd/mm/yyyy';
          }
        }
      }
      
      return updated;
    });
  };

  const handlePreview = async () => {
    if (!csvFile) return;

    const activeMappings = mappings.filter(m => m.targetField);
    if (activeMappings.length === 0) {
      toast.error('Please map at least one column');
      return;
    }

    // Check identifier field is mapped
    const hasIdentifier = activeMappings.some(m => m.targetField === identifierField);
    if (!hasIdentifier) {
      toast.error(`Please map a column to the identifier field: ${identifierField}`);
      return;
    }

    setIsPreviewing(true);

    try {
      const formData = new FormData();
      formData.append('file', csvFile);
      formData.append('entityType', activeTab);
      formData.append('identifierField', identifierField);
      formData.append('mappings', JSON.stringify(activeMappings));

      const response = await fetch('/api/imports/preview', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Preview failed');
      }

      const result = await response.json();
      setPreviewResult(result);
      setStep(3);
    } catch (error) {
      toast.error(error.message || 'Preview failed');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleImport = async () => {
    if (!csvFile) return;

    const activeMappings = mappings.filter(m => m.targetField);

    setIsImporting(true);
    setImportProgress(null);

    // The backend processes only a time-budgeted slice of rows per request (to
    // stay under Vercel's 60s ceiling), returning a cursor + running totals. We
    // re-send the same file with that cursor until it reports done. Mirrors the
    // Zoho one-time-import loop.
    let offset = 0;
    let jobId = null;
    let forcePath = null;
    let totalRows = null;
    const totals = { created: 0, updated: 0, skipped: 0, errors: 0, notesCreated: 0 };
    let errorDetails = [];
    let safety = 0;

    // Transient failures (a dropped connection, a Vercel 504 gateway HTML page,
    // a brief 429/503) should NOT abort the whole import. We retry the SAME
    // cursor — offset, jobId, totals and forcePath are all unchanged — up to
    // MAX_RETRIES times with linear backoff. Because chunks are resumable and
    // idempotent on the server, re-sending the same cursor is safe.
    const MAX_RETRIES = 4;
    const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

    try {
      while (true) {
        safety += 1;
        if (safety > 10000) {
          throw new Error('Import did not complete (too many chunks). Please try again.');
        }

        const formData = new FormData();
        formData.append('file', csvFile);
        formData.append('entityType', activeTab);
        formData.append('identifierField', identifierField);
        formData.append('mappings', JSON.stringify(activeMappings));
        formData.append('offset', String(offset));
        if (jobId) formData.append('jobId', jobId);
        if (forcePath) formData.append('forcePath', forcePath);
        formData.append('created', String(totals.created));
        formData.append('updated', String(totals.updated));
        formData.append('skipped', String(totals.skipped));
        formData.append('errors', String(totals.errors));
        formData.append('notesCreated', String(totals.notesCreated));

        // Attempt this chunk, retrying transient failures from the same cursor.
        let result = null;
        let attempt = 0;
        while (true) {
          let response = null;
          let parseError = null;
          let networkError = null;
          try {
            response = await fetch('/api/imports/execute', {
              method: 'POST',
              credentials: 'include',
              body: formData
            });
          } catch (e) {
            networkError = e;
          }

          // Vercel returns an HTML gateway page (not JSON) when a function hits
          // the time ceiling. Parse defensively so the user sees a useful message
          // instead of "Unexpected token <".
          if (!networkError) {
            try {
              result = await response.json();
            } catch (e) {
              parseError = e;
              result = null;
            }
          }

          const status = response?.status ?? 0;
          const isTransient =
            !!networkError ||
            !!parseError ||
            (response && !response.ok && TRANSIENT_STATUSES.has(status));

          if (!networkError && !parseError && response && response.ok) {
            break; // success — proceed with `result`
          }

          if (isTransient && attempt < MAX_RETRIES) {
            attempt += 1;
            setImportProgress((prev) => ({
              processed: totalRows != null ? Math.min(offset, totalRows) : offset,
              total: totalRows,
              ...totals,
              retrying: true,
              retryAttempt: attempt,
            }));
            // Linear backoff: 0.8s, 1.6s, 2.4s, 3.2s.
            await new Promise((r) => setTimeout(r, 800 * attempt));
            continue;
          }

          // Non-transient (a structured 4xx like bad mappings), or we have
          // exhausted retries — abort with the most useful message available.
          const msg = networkError
            ? 'Network error — the import was interrupted. Please check your connection and try again.'
            : parseError
              ? `Server error (${status}) — the import may have timed out. Please try again.`
              : (result?.error || 'Import failed');
          throw new Error(msg);
        }

        jobId = result.jobId || jobId;
        if (result.path === 'js') forcePath = 'js';
        totals.created = result.created ?? totals.created;
        totals.updated = result.updated ?? totals.updated;
        totals.skipped = result.skipped ?? totals.skipped;
        totals.errors = result.errors ?? totals.errors;
        totals.notesCreated = result.notesCreated ?? totals.notesCreated;
        totalRows = result.totalRows ?? totalRows;
        offset = result.offset ?? offset;

        if (Array.isArray(result.errorDetails) && result.errorDetails.length > 0 && errorDetails.length < 50) {
          errorDetails = errorDetails.concat(result.errorDetails).slice(0, 50);
        }

        const processed = totalRows != null ? Math.min(offset, totalRows) : offset;
        setImportProgress({ processed, total: totalRows, ...totals });

        if (result.done) {
          const finalResult = {
            success: true,
            ...totals,
            totalRows,
            errorDetails,
            summary: result.summary || {
              totalRows,
              processedRows: totals.created + totals.updated,
              createdRows: totals.created,
              updatedRows: totals.updated,
              skippedRows: totals.skipped,
              errorRows: totals.errors,
              notesCreated: totals.notesCreated
            }
          };
          setImportResult(finalResult);
          setStep(4);
          toast.success(`Import complete: ${totals.created} created, ${totals.updated} updated`);
          refetchJobs();
          break;
        }
      }
    } catch (error) {
      toast.error(error.message || 'Import failed');
    } finally {
      setIsImporting(false);
      setImportProgress(null);
    }
  };

  const resetImport = () => {
    setCsvFile(null);
    setCsvData(null);
    setMappings([]);
    setPreviewResult(null);
    setImportResult(null);
    setImportProgress(null);
    setStep(1);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleReuseSetup = (job) => {
    const savedMappings = Array.isArray(job?.mappings) ? job.mappings : [];
    if (savedMappings.length === 0) {
      toast.error('This import has no saved setup to reuse');
      return;
    }
    if (!csvData?.columns?.length) {
      toast.error('Upload a file first, then reuse this setup');
      return;
    }

    const savedByColumn = new Map(
      savedMappings.filter(m => m && m.targetField).map(m => [m.sourceColumn, m])
    );

    // Compute the next mappings synchronously so the counts/toast reflect the
    // actual result (reading state right after setMappings would be stale).
    let applied = 0;
    const nextMappings = mappings.map(m => {
      const saved = savedByColumn.get(m.sourceColumn);
      if (saved) {
        applied += 1;
        return {
          ...m,
          targetField: saved.targetField,
          targetScope: saved.targetScope || '',
          targetType: saved.targetType,
          preferenceFieldId: saved.preferenceFieldId ?? null,
          dateFormat: saved.dateFormat,
          clearOnEmpty: !!saved.clearOnEmpty,
        };
      }
      return m;
    });
    setMappings(nextMappings);

    if (job.identifier_field) {
      setIdentifierField(job.identifier_field);
    }
    setStep(2);

    const currentColumns = new Set(csvData.columns);
    const unmatched = savedMappings
      .filter(m => m && m.targetField && !currentColumns.has(m.sourceColumn))
      .map(m => m.sourceColumn);

    if (applied === 0) {
      toast.error('None of the saved columns match this file');
    } else if (unmatched.length > 0) {
      toast.success(`Applied ${applied} mappings. Not found in this file: ${unmatched.join(', ')}`);
    } else {
      toast.success(`Applied ${applied} saved mappings`);
    }
  };

  const handleTabChange = (value) => {
    setActiveTab(value);
    resetImport();
    setIdentifierField(value === 'organization' ? 'name' : 'email');
    // Invalidate fields cache to ensure correct fields are fetched for the new entity type
    queryClient.invalidateQueries({ queryKey: ['/api/imports/fields', value] });
  };

  if (!isAccessReady) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const allFields = [...(availableFields?.core || []), ...(availableFields?.custom || []), ...(availableFields?.communication || [])];
  const identifierOptions = activeTab === 'organization' 
    ? ['name', 'id']
    : ['email', 'external_id'];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2 flex items-center gap-3" data-testid="text-page-title">
              <FileSpreadsheet className="w-8 h-8 text-blue-600" />
              Import Manager
            </h1>
            <p className="text-slate-600">
              Import members and organisations from CSV and XLS files
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 max-w-xl">
            <TabsTrigger value="member" className="gap-2" data-testid="tab-member-import">
              <User className="w-4 h-4" />
              Member Import
            </TabsTrigger>
            <TabsTrigger value="organization" className="gap-2" data-testid="tab-organization-import">
              <Building2 className="w-4 h-4" />
              Organisation Import
            </TabsTrigger>
            <TabsTrigger value="dedupe" className="gap-2" data-testid="tab-deduplicate">
              <Users className="w-4 h-4" />
              Deduplicate
            </TabsTrigger>
          </TabsList>

          {(activeTab === 'member' || activeTab === 'organization') && (
            <TabsContent value={activeTab}>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div>
                        <CardTitle>
                          {activeTab === 'organization' ? 'Organisation' : 'Member'} Import
                        </CardTitle>
                        <CardDescription>
                          Step {step} of 4: {
                            step === 1 ? 'Upload File' :
                            step === 2 ? 'Map Columns' :
                            step === 3 ? 'Preview Changes' :
                            'Import Complete'
                          }
                        </CardDescription>
                      </div>
                      {step > 1 && (
                        <Button variant="outline" size="sm" onClick={resetImport} data-testid="button-reset-import">
                          <RefreshCw className="w-4 h-4 mr-2" />
                          Start Over
                        </Button>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2 mt-4">
                      {[1, 2, 3, 4].map((s) => (
                        <div key={s} className="flex items-center">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                            s < step ? 'bg-green-500 text-white' :
                            s === step ? 'bg-blue-600 text-white' :
                            'bg-slate-200 text-slate-500'
                          }`}>
                            {s < step ? <Check className="w-4 h-4" /> : s}
                          </div>
                          {s < 4 && (
                            <ChevronRight className={`w-4 h-4 mx-1 ${s < step ? 'text-green-500' : 'text-slate-300'}`} />
                          )}
                        </div>
                      ))}
                    </div>
                  </CardHeader>
                  
                  <CardContent className="space-y-6">
                    {step === 1 && (
                      <div className="space-y-4">
                        <div 
                          className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                          <p className="text-lg font-medium text-slate-700">
                            {isUploading ? 'Parsing file...' : 'Click to upload CSV or XLS file'}
                          </p>
                          <p className="text-sm text-slate-500 mt-1">
                            Accepts .csv and .xlsx · Maximum file size: 10MB
                          </p>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv,.xlsx"
                            onChange={handleFileSelect}
                            className="hidden"
                            disabled={isUploading}
                            data-testid="input-csv-file"
                          />
                          {isUploading && <Loader2 className="w-6 h-6 animate-spin mx-auto mt-4 text-blue-600" />}
                        </div>

                        <Alert>
                          <AlertCircle className="w-4 h-4" />
                          <AlertDescription>
                            Your file should have column headers in the first row. 
                            Each row represents one {activeTab === 'organization' ? 'organisation' : 'member'} record.
                          </AlertDescription>
                        </Alert>
                      </div>
                    )}

                    {step === 2 && csvData && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between flex-wrap gap-2 bg-slate-50 p-3 rounded-lg">
                          <div className="flex items-center gap-2">
                            <FileSpreadsheet className="w-5 h-5 text-blue-600" />
                            <span className="font-medium">{csvFile?.name}</span>
                          </div>
                          <Badge variant="secondary">{csvData.rowCount} rows</Badge>
                        </div>

                        <div className="bg-blue-50 p-4 rounded-lg space-y-2">
                          <Label className="text-blue-800 font-medium">Identifier Field (for matching existing records)</Label>
                          <Select value={identifierField} onValueChange={setIdentifierField}>
                            <SelectTrigger className="w-full max-w-xs" data-testid="select-identifier-field">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {identifierOptions.map(opt => (
                                <SelectItem key={opt} value={opt}>
                                  {opt === 'id' ? 'UUID (Internal ID)' : opt.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-sm text-blue-700">
                            Records with matching {identifierField === 'id' ? 'UUID' : identifierField.replace(/_/g, ' ')} will be updated; new values will create records.
                          </p>
                        </div>

                        <Separator />

                        <div className="space-y-3">
                          <Label className="text-lg font-medium">Column Mappings</Label>
                          <div className="max-h-[400px] overflow-y-auto pr-4 space-y-3">
                            {mappings.map((mapping, index) => (
                              <div 
                                key={index} 
                                className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg"
                                data-testid={`mapping-row-${index}`}
                              >
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-sm truncate" title={mapping.sourceColumn}>
                                    {mapping.sourceColumn}
                                  </p>
                                  {csvData.preview?.[0]?.[mapping.sourceColumn] && (
                                    <p className="text-xs text-slate-500 truncate">
                                      e.g., "{csvData.preview[0][mapping.sourceColumn]}"
                                    </p>
                                  )}
                                </div>
                                
                                <ArrowRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                                
                                <Select 
                                  value={mapping.targetField || "__skip__"}
                                  onValueChange={(val) => handleMappingChange(index, 'targetField', val === "__skip__" ? "" : val)}
                                >
                                  <SelectTrigger className="w-48" data-testid={`select-target-${index}`}>
                                    <SelectValue placeholder="Select field..." />
                                  </SelectTrigger>
                                  <SelectContent position="popper" sideOffset={4}>
                                    <SelectItem value="__skip__">-- Skip this column --</SelectItem>
                                    <SelectItem disabled value="__actions_header__">
                                      <span className="font-semibold text-slate-500">Actions</span>
                                    </SelectItem>
                                    <SelectItem value="__add_note__">Add Note (create note from content)</SelectItem>
                                    {availableFields?.core?.filter(f => f.key !== '__add_note__').length > 0 && (
                                      <>
                                        <SelectItem disabled value="__core_header__">
                                          <span className="font-semibold text-slate-500">Core Fields</span>
                                        </SelectItem>
                                        {availableFields.core.filter(f => f.key !== '__add_note__').map(f => (
                                          <SelectItem key={f.key} value={f.key}>
                                            {f.label}
                                          </SelectItem>
                                        ))}
                                      </>
                                    )}
                                    {availableFields?.custom?.length > 0 && (
                                      <>
                                        <SelectItem disabled value="__custom_header__">
                                          <span className="font-semibold text-slate-500">Custom Fields</span>
                                        </SelectItem>
                                        {availableFields.custom.map(f => (
                                          <SelectItem key={f.key} value={f.key}>
                                            {f.label}
                                          </SelectItem>
                                        ))}
                                      </>
                                    )}
                                    {activeTab === 'member' && availableFields?.communication?.length > 0 && (
                                      <>
                                        <SelectItem disabled value="__comm_header__">
                                          <span className="font-semibold text-slate-500">Communication Preferences</span>
                                        </SelectItem>
                                        {availableFields.communication.map(f => (
                                          <SelectItem key={f.key} value={f.key}>
                                            {f.label}
                                          </SelectItem>
                                        ))}
                                      </>
                                    )}
                                  </SelectContent>
                                </Select>

                                <div className="flex items-center gap-2">
                                  <Checkbox
                                    id={`clear-${index}`}
                                    checked={mapping.clearOnEmpty}
                                    onCheckedChange={(checked) => handleMappingChange(index, 'clearOnEmpty', checked)}
                                    disabled={!mapping.targetField}
                                    data-testid={`checkbox-clear-${index}`}
                                  />
                                  <Label 
                                    htmlFor={`clear-${index}`} 
                                    className="text-xs text-slate-600 whitespace-nowrap"
                                  >
                                    Clear if empty
                                  </Label>
                                </div>
                                
                                {mapping.targetType === 'date' && mapping.targetField && (
                                  <Select
                                    value={mapping.dateFormat || 'dd/mm/yyyy'}
                                    onValueChange={(val) => handleMappingChange(index, 'dateFormat', val)}
                                  >
                                    <SelectTrigger className="w-44" data-testid={`select-date-format-${index}`}>
                                      <SelectValue placeholder="Date format..." />
                                    </SelectTrigger>
                                    <SelectContent position="popper" sideOffset={4}>
                                      {DATE_FORMAT_OPTIONS.map(opt => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="flex justify-end gap-3">
                          <Button variant="outline" onClick={() => setStep(1)}>
                            Back
                          </Button>
                          <Button 
                            onClick={handlePreview} 
                            disabled={isPreviewing || mappings.filter(m => m.targetField).length === 0}
                            data-testid="button-preview"
                          >
                            {isPreviewing ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Previewing...
                              </>
                            ) : (
                              'Preview Import'
                            )}
                          </Button>
                        </div>
                      </div>
                    )}

                    {step === 3 && previewResult && (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <Card className="bg-blue-50 border-blue-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-blue-700">{previewResult.totalRows}</p>
                              <p className="text-sm text-blue-600">Total Rows</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-green-50 border-green-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-green-700">{previewResult.toCreate}</p>
                              <p className="text-sm text-green-600">To Create</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-warning/10 border-warning/30">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-warning">{previewResult.toUpdate}</p>
                              <p className="text-sm text-warning">To Update</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-slate-50 border-slate-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-slate-700">{previewResult.toSkip}</p>
                              <p className="text-sm text-slate-600">To Skip</p>
                            </CardContent>
                          </Card>
                        </div>

                        {previewResult.errors?.length > 0 && (
                          <Alert variant="destructive">
                            <AlertCircle className="w-4 h-4" />
                            <AlertDescription>
                              {previewResult.errors.length} error(s) detected during preview.
                              <ul className="mt-2 list-disc pl-4">
                                {previewResult.errors.slice(0, 5).map((err, i) => (
                                  <li key={i}>Row {err.row}: {err.message}</li>
                                ))}
                              </ul>
                            </AlertDescription>
                          </Alert>
                        )}

                        <div className="bg-slate-50 p-4 rounded-lg">
                          <p className="font-medium mb-2">Field Mappings:</p>
                          <div className="flex flex-wrap gap-2">
                            {mappings.filter(m => m.targetField).map((m, i) => {
                              const fieldDef = allFields.find(f => f.key === m.targetField);
                              const displayLabel = fieldDef?.label || m.targetField;
                              return (
                                <Badge key={i} variant="secondary" className="gap-1">
                                  {m.sourceColumn} → {displayLabel}
                                  {m.clearOnEmpty && <Trash2 className="w-3 h-3 text-red-500" />}
                                </Badge>
                              );
                            })}
                          </div>
                        </div>

                        <div className="flex justify-end gap-3">
                          <Button variant="outline" onClick={() => setStep(2)}>
                            Back to Mapping
                          </Button>
                          <Button 
                            onClick={handleImport} 
                            disabled={isImporting}
                            className="bg-green-600 hover:bg-green-700"
                            data-testid="button-execute-import"
                          >
                            {isImporting ? (
                              <>
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                Importing...
                              </>
                            ) : (
                              <>
                                <Check className="w-4 h-4 mr-2" />
                                Execute Import
                              </>
                            )}
                          </Button>
                        </div>

                        {isImporting && (
                          <Alert variant="warning" data-testid="alert-import-in-progress">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription>
                              Import in progress — please keep this tab open and do
                              not navigate away or refresh until it finishes. Closing
                              the tab will interrupt the import.
                            </AlertDescription>
                          </Alert>
                        )}

                        {isImporting && importProgress && (
                          <div className="space-y-2" data-testid="import-progress">
                            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                              <span data-testid="text-import-progress">
                                {importProgress.total != null
                                  ? `Processed ${importProgress.processed} of ${importProgress.total} rows`
                                  : `Processed ${importProgress.processed} rows`}
                              </span>
                              <span data-testid="text-import-running-totals">
                                {importProgress.created} created · {importProgress.updated} updated
                                {importProgress.errors > 0 ? ` · ${importProgress.errors} errors` : ''}
                              </span>
                            </div>
                            {importProgress.retrying && (
                              <div className="flex items-center gap-2 text-sm text-warning" data-testid="text-import-retrying">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                <span>
                                  Connection hiccup — retrying (attempt {importProgress.retryAttempt} of 4)…
                                </span>
                              </div>
                            )}
                            {importProgress.total != null && importProgress.total > 0 && (
                              <div className="h-2 w-full overflow-hidden rounded-md bg-muted">
                                <div
                                  className="h-full bg-green-600 transition-all"
                                  style={{ width: `${Math.min(100, Math.round((importProgress.processed / importProgress.total) * 100))}%` }}
                                  data-testid="bar-import-progress"
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {step === 4 && importResult && (
                      <div className="space-y-4">
                        <div className="text-center py-6">
                          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Check className="w-8 h-8 text-green-600" />
                          </div>
                          <h3 className="text-xl font-bold text-slate-900">Import Complete!</h3>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <Card className="bg-blue-50 border-blue-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-blue-700">{importResult.summary?.totalRows || importResult.totalRows || 0}</p>
                              <p className="text-sm text-blue-600">Total Rows</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-green-50 border-green-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-green-700">{importResult.created}</p>
                              <p className="text-sm text-green-600">Created</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-warning/10 border-warning/30">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-warning">{importResult.updated}</p>
                              <p className="text-sm text-warning">Updated</p>
                            </CardContent>
                          </Card>
                          <Card className="bg-red-50 border-red-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-red-700">{importResult.errors}</p>
                              <p className="text-sm text-red-600">Errors</p>
                            </CardContent>
                          </Card>
                        </div>

                        {(importResult.errorDetails?.length > 0 || importResult.errorLog?.length > 0) && (
                          <Alert variant="destructive">
                            <AlertCircle className="w-4 h-4" />
                            <AlertDescription>
                              <p className="font-medium mb-2">Errors occurred during import:</p>
                              <div className="max-h-32 overflow-y-auto">
                                <ul className="list-disc pl-4 space-y-1">
                                  {(importResult.errorDetails || importResult.errorLog || []).map((err, i) => (
                                    <li key={i}>
                                      Row {err.row}{err.identifier ? ` (${err.identifier})` : ''}: {err.error || err.message}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            </AlertDescription>
                          </Alert>
                        )}

                        <div className="flex justify-center">
                          <Button onClick={resetImport} data-testid="button-new-import">
                            <Upload className="w-4 h-4 mr-2" />
                            Start New Import
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <div className="lg:col-span-1">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <History className="w-5 h-5" />
                      Recent Imports
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {jobsLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                      </div>
                    ) : recentJobs.length === 0 ? (
                      <p className="text-sm text-slate-500 text-center py-8">
                        No recent imports
                      </p>
                    ) : (
                      <ScrollArea className="h-[400px]">
                        <div className="space-y-3">
                          {recentJobs.map((job) => (
                            <div 
                              key={job.id} 
                              className="p-3 bg-slate-50 rounded-lg space-y-2"
                              data-testid={`job-card-${job.id}`}
                            >
                              <div className="flex items-center justify-between flex-wrap gap-1">
                                <p className="text-sm font-medium truncate" title={job.file_name}>
                                  {job.file_name || 'Import'}
                                </p>
                                <Badge 
                                  variant={
                                    job.status === 'completed' ? 'default' :
                                    job.status === 'completed_with_errors' ? 'secondary' :
                                    job.status === 'failed' ? 'destructive' : 'outline'
                                  }
                                  className="text-xs"
                                >
                                  {job.status}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-slate-500">
                                <span className="text-green-600" data-testid={`text-created-${job.id}`}>+{job.created_count || 0}</span>
                                <span className="text-warning" data-testid={`text-updated-${job.id}`}>~{job.updated_count || 0}</span>
                                {job.error_count > 0 && (
                                  <span className="text-red-600" data-testid={`text-errors-${job.id}`}>!{job.error_count}</span>
                                )}
                              </div>
                              <p className="text-xs text-slate-400">
                                {new Date(job.created_at).toLocaleDateString()} {new Date(job.created_at).toLocaleTimeString()}
                              </p>
                              {Array.isArray(job.mappings) && job.mappings.length > 0 && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="w-full gap-2"
                                  onClick={() => handleReuseSetup(job)}
                                  data-testid={`button-reuse-setup-${job.id}`}
                                >
                                  <Copy className="w-3 h-3" />
                                  Reuse setup
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>

                <Card className="mt-4 border-blue-200 bg-blue-50">
                  <CardContent className="p-4">
                    <div className="text-sm text-blue-800 space-y-2">
                      <p className="font-medium">Tips:</p>
                      <ul className="list-disc pl-5 space-y-1">
                        <li><strong>Clear if empty:</strong> When checked, empty file values will clear existing data</li>
                        <li><strong>Identifier:</strong> Used to match existing records for updates</li>
                        <li><strong>Custom fields:</strong> Map to fields defined in Custom Fields admin</li>
                      </ul>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>
          )}

          {/* Deduplicate Tab Content */}
          <TabsContent value="dedupe">
            <div className="max-w-4xl">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Users className="w-5 h-5" />
                        Deduplicate Members
                      </CardTitle>
                      <CardDescription>
                        Remove duplicate member records based on email address. 
                        The member with a role assigned will be kept.
                      </CardDescription>
                    </div>
                    {(dedupePreview || dedupeResult) && (
                      <Button variant="outline" size="sm" onClick={resetDedupe} data-testid="button-reset-dedupe">
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Start Over
                      </Button>
                    )}
                  </div>
                </CardHeader>
                
                <CardContent className="space-y-6">
                  {/* Filters Section */}
                  {!dedupeResult && (
                    <div className="space-y-4">
                      <div className="bg-slate-50 p-4 rounded-lg space-y-4">
                        <div className="flex items-center gap-2 text-slate-700 font-medium">
                          <Filter className="w-4 h-4" />
                          Exclusion Filters (Optional)
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Exclude Organizations */}
                          <div className="space-y-2">
                            <Label>Exclude Organisations</Label>
                            <Select
                              value={dedupeExcludeOrgs.length > 0 ? "selected" : "none"}
                              onValueChange={(val) => {
                                if (val === "none") setDedupeExcludeOrgs([]);
                              }}
                            >
                              <SelectTrigger data-testid="select-exclude-orgs">
                                <SelectValue placeholder="Select organisations to exclude..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No exclusions</SelectItem>
                                {organizations.map((org) => (
                                  <div 
                                    key={org.id} 
                                    className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-slate-100"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDedupeExcludeOrgs(prev => 
                                        prev.includes(org.id) 
                                          ? prev.filter(id => id !== org.id)
                                          : [...prev, org.id]
                                      );
                                    }}
                                  >
                                    <Checkbox checked={dedupeExcludeOrgs.includes(org.id)} />
                                    <span className="text-sm">{org.name}</span>
                                  </div>
                                ))}
                              </SelectContent>
                            </Select>
                            {dedupeExcludeOrgs.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {dedupeExcludeOrgs.map(orgId => {
                                  const org = organizations.find(o => o.id === orgId);
                                  return (
                                    <Badge key={orgId} variant="secondary" className="text-xs">
                                      {org?.name || orgId}
                                      <X 
                                        className="w-3 h-3 ml-1 cursor-pointer" 
                                        onClick={() => setDedupeExcludeOrgs(prev => prev.filter(id => id !== orgId))}
                                      />
                                    </Badge>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                          
                          {/* Exclude Roles */}
                          <div className="space-y-2">
                            <Label>Exclude Roles</Label>
                            <Select
                              value={dedupeExcludeRoles.length > 0 ? "selected" : "none"}
                              onValueChange={(val) => {
                                if (val === "none") setDedupeExcludeRoles([]);
                              }}
                            >
                              <SelectTrigger data-testid="select-exclude-roles">
                                <SelectValue placeholder="Select roles to exclude..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No exclusions</SelectItem>
                                {roles.map((role) => (
                                  <div 
                                    key={role.id} 
                                    className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-slate-100"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDedupeExcludeRoles(prev => 
                                        prev.includes(role.id) 
                                          ? prev.filter(id => id !== role.id)
                                          : [...prev, role.id]
                                      );
                                    }}
                                  >
                                    <Checkbox checked={dedupeExcludeRoles.includes(role.id)} />
                                    <span className="text-sm">{role.name}</span>
                                  </div>
                                ))}
                              </SelectContent>
                            </Select>
                            {dedupeExcludeRoles.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {dedupeExcludeRoles.map(roleId => {
                                  const role = roles.find(r => r.id === roleId);
                                  return (
                                    <Badge key={roleId} variant="secondary" className="text-xs">
                                      {role?.name || roleId}
                                      <X 
                                        className="w-3 h-3 ml-1 cursor-pointer" 
                                        onClick={() => setDedupeExcludeRoles(prev => prev.filter(id => id !== roleId))}
                                      />
                                    </Badge>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                        
                        <p className="text-sm text-slate-500">
                          Members belonging to excluded organisations or with excluded roles will not be affected by deduplication.
                        </p>
                      </div>
                      
                      {/* Preview Button */}
                      <Button 
                        onClick={handleDedupePreview} 
                        disabled={isPreviewingDedupe}
                        className="w-full"
                        data-testid="button-preview-dedupe"
                      >
                        {isPreviewingDedupe ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Eye className="w-4 h-4 mr-2" />
                        )}
                        {isPreviewingDedupe ? 'Scanning for duplicates...' : 'Preview Duplicates'}
                      </Button>
                    </div>
                  )}
                  
                  {/* Preview Results */}
                  {dedupePreview && (
                    <div className="space-y-4">
                      <Alert className="border-warning/30 bg-warning/10">
                        <AlertCircle className="w-4 h-4 text-warning" />
                        <AlertDescription className="text-warning">
                          Found <strong>{dedupePreview.summary?.totalToDelete || 0}</strong> duplicate members to remove.
                          <strong> {dedupePreview.summary?.totalKeepers || 0}</strong> unique email addresses with duplicates.
                        </AlertDescription>
                      </Alert>
                      
                      {dedupePreview.groups?.length > 0 && (
                        <div className="border rounded-lg overflow-hidden">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Email</TableHead>
                                <TableHead>Keeper</TableHead>
                                <TableHead>Duplicates to Remove</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {dedupePreview.groups.slice(0, 50).map((group, idx) => (
                                <TableRow key={idx}>
                                  <TableCell className="font-medium">{group.email}</TableCell>
                                  <TableCell>
                                    <div className="text-sm">
                                      <p>{group.keeper?.first_name} {group.keeper?.last_name}</p>
                                      {group.keeper?.role_name && (
                                        <Badge variant="outline" className="text-xs mt-1">
                                          {group.keeper.role_name}
                                        </Badge>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell>
                                    <div className="space-y-1">
                                      {group.duplicates.map((dup, i) => (
                                        <div key={i} className="text-sm text-slate-500">
                                          {dup.first_name} {dup.last_name}
                                          {dup.role_name && <span className="text-xs ml-1">({dup.role_name})</span>}
                                        </div>
                                      ))}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          {dedupePreview.groups.length > 50 && (
                            <div className="p-3 bg-slate-50 text-sm text-slate-600 text-center">
                              Showing 50 of {dedupePreview.groups.length} duplicate groups
                            </div>
                          )}
                        </div>
                      )}
                      
                      <div className="flex gap-3">
                        <Button 
                          variant="outline" 
                          onClick={resetDedupe}
                          className="flex-1"
                          data-testid="button-cancel-dedupe"
                        >
                          Cancel
                        </Button>
                        <Button 
                          onClick={handleDedupeExecute}
                          disabled={isExecutingDedupe || !dedupePreview.summary?.totalToDelete}
                          className="flex-1 bg-red-600 hover:bg-red-700"
                          data-testid="button-execute-dedupe"
                        >
                          {isExecutingDedupe ? (
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4 mr-2" />
                          )}
                          {isExecutingDedupe ? 'Removing duplicates...' : `Remove ${dedupePreview.summary?.totalToDelete || 0} Duplicates`}
                        </Button>
                      </div>
                    </div>
                  )}
                  
                  {/* Execution Result */}
                  {dedupeResult && (
                    <div className="space-y-4">
                      <Alert className="border-green-200 bg-green-50">
                        <Check className="w-4 h-4 text-green-600" />
                        <AlertDescription className="text-green-800">
                          Successfully removed <strong>{dedupeResult.deleted || 0}</strong> duplicate member records.
                        </AlertDescription>
                      </Alert>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <Card className="bg-green-50 border-green-200">
                          <CardContent className="p-4 text-center">
                            <p className="text-2xl font-bold text-green-700">{dedupeResult.deleted || 0}</p>
                            <p className="text-sm text-green-600">Duplicates Removed</p>
                          </CardContent>
                        </Card>
                        <Card className="bg-blue-50 border-blue-200">
                          <CardContent className="p-4 text-center">
                            <p className="text-2xl font-bold text-blue-700">{dedupeResult.summary?.totalDuplicateEmails || 0}</p>
                            <p className="text-sm text-blue-600">Unique Members Kept</p>
                          </CardContent>
                        </Card>
                      </div>
                      
                      {dedupeResult.errors?.length > 0 && (
                        <Alert variant="destructive">
                          <AlertCircle className="w-4 h-4" />
                          <AlertDescription>
                            Some errors occurred during deduplication:
                            <ul className="list-disc pl-4 mt-2">
                              {dedupeResult.errors.map((err, i) => (
                                <li key={i}>Batch {err.batch}: {err.error}</li>
                              ))}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}
                      
                      <Button onClick={resetDedupe} className="w-full" data-testid="button-new-dedupe">
                        <RefreshCw className="w-4 h-4 mr-2" />
                        Run Another Deduplication
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
              
              {/* Help Card */}
              <Card className="mt-4 border-blue-200 bg-blue-50">
                <CardContent className="p-4">
                  <div className="text-sm text-blue-800 space-y-2">
                    <p className="font-medium">How Deduplication Works:</p>
                    <ul className="list-disc pl-5 space-y-1">
                      <li><strong>Matching:</strong> Members are matched by email address (case-insensitive)</li>
                      <li><strong>Priority:</strong> Members with a role assigned are kept over those without</li>
                      <li><strong>Tiebreaker:</strong> If both/neither have roles, the older record is kept</li>
                      <li><strong>Exclusions:</strong> Members in excluded organisations or with excluded roles are skipped</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
