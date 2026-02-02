import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, FileEdit, Calendar, AlertCircle, ArrowLeft, Check } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import FormRenderer from "@/components/forms/FormRenderer";

export default function ManualContractOverrideForm({
  contractFormId,
  signer,
  onSubmit,
  onCancel,
  isSubmitting
}) {
  const [formValues, setFormValues] = useState({});
  const [overrideDate, setOverrideDate] = useState('');

  const { data: contractForm, isLoading } = useQuery({
    queryKey: ['/api/entities/form', contractFormId],
    queryFn: () => apiRequest('GET', `/api/entities/form/${contractFormId}`),
    enabled: !!contractFormId
  });

  useEffect(() => {
    const now = new Date();
    const localISOTime = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    setOverrideDate(localISOTime);
  }, []);

  useEffect(() => {
    if (signer) {
      setFormValues(prev => ({
        ...prev,
        signer_first_name: signer.firstName || signer.first_name || '',
        signer_last_name: signer.lastName || signer.last_name || '',
        signer_email: signer.email || ''
      }));
    }
  }, [signer]);

  const handleFieldChange = (fieldId, value) => {
    setFormValues(prev => ({
      ...prev,
      [fieldId]: value
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      submissionData: formValues,
      overrideDate: overrideDate ? new Date(overrideDate).toISOString() : null
    });
  };

  const formSchema = contractForm?.schema || contractForm;
  const fields = formSchema?.fields || formSchema?.pages?.[0]?.fields || [];

  const renderableFields = fields.filter(field => 
    field.type !== 'instructions' && 
    field.type !== 'page_break' &&
    field.type !== 'hidden'
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading contract form...</span>
      </div>
    );
  }

  if (!contractForm) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="w-4 h-4" />
        <AlertDescription>
          Contract form not found. Unable to create manual override.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onCancel}
          data-testid="button-cancel-override"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-2">
          <FileEdit className="w-4 h-4 text-amber-500" />
          <h4 className="text-sm font-semibold">Manual Contract Override</h4>
        </div>
      </div>

      <Alert className="bg-amber-50 border-amber-200">
        <AlertCircle className="w-4 h-4 text-amber-600" />
        <AlertDescription className="text-amber-700 text-xs">
          This will create a signed contract submission for <strong>{signer?.email}</strong> using the data you enter below.
          Use this for migrating contracts from a previous system.
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <Label htmlFor="override-date" className="text-sm font-medium flex items-center gap-2">
          <Calendar className="w-4 h-4" />
          Submission Date Override
        </Label>
        <Input
          id="override-date"
          type="datetime-local"
          value={overrideDate}
          onChange={(e) => setOverrideDate(e.target.value)}
          className="w-full"
          data-testid="input-override-date"
        />
        <p className="text-xs text-muted-foreground">
          Set the date when this contract was originally signed
        </p>
      </div>

      <div className="border rounded-lg p-4 bg-muted/30">
        <h5 className="text-sm font-medium mb-4">Contract Fields</h5>
        <ScrollArea className="max-h-[400px] pr-3">
          <div className="space-y-4">
            {renderableFields.length > 0 ? (
              renderableFields.map((field) => (
                <FormRenderer
                  key={field.id}
                  field={field}
                  value={formValues[field.id] || formValues[field.name] || ''}
                  onChange={(value) => handleFieldChange(field.id || field.name, value)}
                  disabled={false}
                />
              ))
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No form fields defined for this contract
              </p>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
          data-testid="button-cancel-override-bottom"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="gap-2"
          data-testid="button-submit-override"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          Save Override
        </Button>
      </div>
    </form>
  );
}
