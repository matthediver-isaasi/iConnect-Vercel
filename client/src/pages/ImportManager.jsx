import { useState, useRef } from "react";
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
  History
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
  const [previewResult, setPreviewResult] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef(null);

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

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.csv')) {
      toast.error('Please upload a CSV file');
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
        throw new Error(error.error || 'Failed to parse CSV');
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
      toast.success(`CSV loaded: ${data.rowCount} rows, ${data.columns.length} columns`);
    } catch (error) {
      toast.error(error.message || 'Failed to parse CSV');
      setCsvFile(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleMappingChange = (index, field, value) => {
    setMappings(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      
      // If setting target field, also set scope
      if (field === 'targetField' && value) {
        const allFields = [...(availableFields?.core || []), ...(availableFields?.custom || [])];
        const targetDef = allFields.find(f => f.key === value);
        if (targetDef) {
          updated[index].targetScope = targetDef.scope;
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

    try {
      const formData = new FormData();
      formData.append('file', csvFile);
      formData.append('entityType', activeTab);
      formData.append('identifierField', identifierField);
      formData.append('mappings', JSON.stringify(activeMappings));

      const response = await fetch('/api/imports/execute', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Import failed');
      }

      const result = await response.json();
      setImportResult(result);
      setStep(4);
      toast.success(`Import complete: ${result.created} created, ${result.updated} updated`);
      refetchJobs();
    } catch (error) {
      toast.error(error.message || 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  const resetImport = () => {
    setCsvFile(null);
    setCsvData(null);
    setMappings([]);
    setPreviewResult(null);
    setImportResult(null);
    setStep(1);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
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

  const allFields = [...(availableFields?.core || []), ...(availableFields?.custom || [])];
  const identifierOptions = activeTab === 'organization' 
    ? ['name', 'email', 'external_id', 'slug']
    : ['email', 'external_id'];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2 flex items-center gap-3" data-testid="text-page-title">
              <FileSpreadsheet className="w-8 h-8 text-blue-600" />
              CSV Import Manager
            </h1>
            <p className="text-slate-600">
              Import members and organisations from CSV files
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 max-w-md">
            <TabsTrigger value="member" className="gap-2" data-testid="tab-member-import">
              <User className="w-4 h-4" />
              Member Import
            </TabsTrigger>
            <TabsTrigger value="organization" className="gap-2" data-testid="tab-organization-import">
              <Building2 className="w-4 h-4" />
              Organisation Import
            </TabsTrigger>
          </TabsList>

          <TabsContent value={activeTab}>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Main Import Panel */}
              <div className="lg:col-span-2">
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle>
                          {activeTab === 'organization' ? 'Organisation' : 'Member'} Import
                        </CardTitle>
                        <CardDescription>
                          Step {step} of 4: {
                            step === 1 ? 'Upload CSV' :
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
                    
                    {/* Progress Steps */}
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
                    {/* Step 1: Upload */}
                    {step === 1 && (
                      <div className="space-y-4">
                        <div 
                          className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-blue-400 transition-colors cursor-pointer"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Upload className="w-12 h-12 mx-auto text-slate-400 mb-4" />
                          <p className="text-lg font-medium text-slate-700">
                            {isUploading ? 'Parsing CSV...' : 'Click to upload CSV file'}
                          </p>
                          <p className="text-sm text-slate-500 mt-1">
                            Maximum file size: 10MB
                          </p>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv"
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
                            Your CSV file should have column headers in the first row. 
                            Each row represents one {activeTab === 'organization' ? 'organisation' : 'member'} record.
                          </AlertDescription>
                        </Alert>
                      </div>
                    )}

                    {/* Step 2: Map Columns */}
                    {step === 2 && csvData && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between bg-slate-50 p-3 rounded-lg">
                          <div className="flex items-center gap-2">
                            <FileSpreadsheet className="w-5 h-5 text-blue-600" />
                            <span className="font-medium">{csvFile?.name}</span>
                          </div>
                          <Badge variant="secondary">{csvData.rowCount} rows</Badge>
                        </div>

                        {/* Identifier Field Selection */}
                        <div className="bg-blue-50 p-4 rounded-lg space-y-2">
                          <Label className="text-blue-800 font-medium">Identifier Field (for matching existing records)</Label>
                          <Select value={identifierField} onValueChange={setIdentifierField}>
                            <SelectTrigger className="w-full max-w-xs" data-testid="select-identifier-field">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {identifierOptions.map(opt => (
                                <SelectItem key={opt} value={opt}>
                                  {opt.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-sm text-blue-700">
                            Records with matching {identifierField} will be updated; new values will create records.
                          </p>
                        </div>

                        <Separator />

                        {/* Column Mappings */}
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
                                    {availableFields?.core?.length > 0 && (
                                      <>
                                        <SelectItem disabled value="__core_header__">
                                          <span className="font-semibold text-slate-500">Core Fields</span>
                                        </SelectItem>
                                        {availableFields.core.map(f => (
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

                    {/* Step 3: Preview */}
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
                          <Card className="bg-amber-50 border-amber-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-amber-700">{previewResult.toUpdate}</p>
                              <p className="text-sm text-amber-600">To Update</p>
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

                        {/* Mapping Summary */}
                        <div className="bg-slate-50 p-4 rounded-lg">
                          <p className="font-medium mb-2">Field Mappings:</p>
                          <div className="flex flex-wrap gap-2">
                            {mappings.filter(m => m.targetField).map((m, i) => (
                              <Badge key={i} variant="secondary" className="gap-1">
                                {m.sourceColumn} → {m.targetField}
                                {m.clearOnEmpty && <Trash2 className="w-3 h-3 text-red-500" />}
                              </Badge>
                            ))}
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
                      </div>
                    )}

                    {/* Step 4: Results */}
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
                          <Card className="bg-amber-50 border-amber-200">
                            <CardContent className="p-4 text-center">
                              <p className="text-2xl font-bold text-amber-700">{importResult.updated}</p>
                              <p className="text-sm text-amber-600">Updated</p>
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

              {/* Recent Imports Sidebar */}
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
                              <div className="flex items-center justify-between">
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
                                <span className="text-green-600">+{job.created_rows || 0}</span>
                                <span className="text-amber-600">~{job.updated_rows || 0}</span>
                                {job.error_rows > 0 && (
                                  <span className="text-red-600">!{job.error_rows}</span>
                                )}
                              </div>
                              <p className="text-xs text-slate-400">
                                {new Date(job.created_at).toLocaleDateString()} {new Date(job.created_at).toLocaleTimeString()}
                              </p>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>

                {/* Help Card */}
                <Card className="mt-4 border-blue-200 bg-blue-50">
                  <CardContent className="p-4">
                    <div className="text-sm text-blue-800 space-y-2">
                      <p className="font-medium">Tips:</p>
                      <ul className="list-disc pl-5 space-y-1">
                        <li><strong>Clear if empty:</strong> When checked, empty CSV values will clear existing data</li>
                        <li><strong>Identifier:</strong> Used to match existing records for updates</li>
                        <li><strong>Custom fields:</strong> Map to fields defined in Custom Fields admin</li>
                      </ul>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
