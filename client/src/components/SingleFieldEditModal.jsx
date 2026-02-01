import { useState, useRef, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Upload, X, Check, ChevronsUpDown, FileText, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { COUNTRIES } from "@/data/countries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { uploadFormSubmissionFile } from "@/lib/tenantUpload";

function MultiCountrySelect({ value = [], onChange, fieldId }) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  
  const selectedCountries = COUNTRIES.filter(c => value.includes(c.name) || value.includes(c.code));
  const filteredCountries = searchQuery
    ? COUNTRIES.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : COUNTRIES;
  
  const toggleCountry = (name) => {
    const country = COUNTRIES.find(c => c.name === name);
    const code = country?.code;
    const isSelected = value.includes(name) || (code && value.includes(code));
    
    if (isSelected) {
      const newValue = value.filter(c => c !== name && c !== code);
      onChange(newValue);
    } else {
      onChange([...value, name]);
    }
  };
  
  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) setSearchQuery("");
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal min-h-9 h-auto"
          data-testid={`select-countries-${fieldId}`}
        >
          <span className="flex flex-wrap gap-1 flex-1 text-left">
            {selectedCountries.length > 0 ? (
              selectedCountries.length <= 3 ? (
                selectedCountries.map(c => c.name).join(', ')
              ) : (
                `${selectedCountries.length} countries selected`
              )
            ) : (
              <span className="text-muted-foreground">Select countries</span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search countries..." 
            value={searchQuery}
            onValueChange={setSearchQuery}
          />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {filteredCountries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.name}
                  onSelect={() => toggleCountry(country.name)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      (value.includes(country.name) || value.includes(country.code)) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {country.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function SingleFieldEditModal({ 
  open, 
  onOpenChange, 
  field, 
  currentValue, 
  submissionId,
  formId 
}) {
  const [value, setValue] = useState(currentValue);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [resolvedFileUrl, setResolvedFileUrl] = useState(null);
  const fileInputRef = useRef(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    setValue(currentValue);
    setResolvedFileUrl(null);
  }, [currentValue, field?.id, open]);

  useEffect(() => {
    const resolveUrl = async () => {
      if ((field?.type === 'file' || field?.type === 'image' || field?.type === 'logo') && value?.file_url) {
        try {
          const { resolveFileUrl } = await import('@/lib/tenantUpload');
          const url = await resolveFileUrl(value.file_url);
          setResolvedFileUrl(url);
        } catch {
          setResolvedFileUrl(value.file_url);
        }
      }
    };
    resolveUrl();
  }, [value, field?.type]);

  const updateMutation = useMutation({
    mutationFn: async (data) => {
      const response = await fetch('/api/admin/update-submission-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to update field');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['form-submission', submissionId] });
      queryClient.invalidateQueries({ queryKey: ['due-diligence-submission', submissionId] });
      toast.success('Field updated successfully');
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update field');
    },
  });

  const handleSave = () => {
    if (!field?.id) {
      toast.error('No field selected');
      return;
    }
    updateMutation.mutate({
      submission_id: submissionId,
      field_id: field.id,
      value: value,
    });
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const result = await uploadFormSubmissionFile(file, formId, (progress) => {
        setUploadProgress(progress);
      });

      setValue({
        file_url: result.file_url,
        storage_path: result.storage_path,
        file_name: result.file_name,
        file_size: result.file_size,
        mime_type: result.mime_type,
      });
      toast.success('File uploaded successfully');
    } catch (error) {
      toast.error(error.message || 'Failed to upload file');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const renderInput = () => {
    if (!field) return null;

    switch (field.type) {
      case 'text':
      case 'email':
      case 'url':
      case 'phone':
        return (
          <Input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            value={value || ''}
            onChange={(e) => setValue(e.target.value)}
            placeholder={field.placeholder || ''}
            data-testid="input-edit-field"
          />
        );

      case 'number':
      case 'percentage':
        return (
          <Input
            type="number"
            value={value || ''}
            onChange={(e) => setValue(e.target.value)}
            placeholder={field.placeholder || ''}
            data-testid="input-edit-field"
          />
        );

      case 'textarea':
        return (
          <Textarea
            value={value || ''}
            onChange={(e) => setValue(e.target.value)}
            placeholder={field.placeholder || ''}
            rows={4}
            data-testid="textarea-edit-field"
          />
        );

      case 'select':
        return (
          <Select value={value || ''} onValueChange={setValue}>
            <SelectTrigger data-testid="select-edit-field">
              <SelectValue placeholder={field.placeholder || 'Select an option'} />
            </SelectTrigger>
            <SelectContent>
              {(field.options || []).map((option, idx) => (
                <SelectItem key={idx} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'radio':
        return (
          <RadioGroup value={value || ''} onValueChange={setValue}>
            {(field.options || []).map((option, idx) => (
              <div key={idx} className="flex items-center space-x-2">
                <RadioGroupItem value={option} id={`edit-${field.id}-${idx}`} />
                <Label htmlFor={`edit-${field.id}-${idx}`} className="font-normal">{option}</Label>
              </div>
            ))}
          </RadioGroup>
        );

      case 'checkbox':
        const checkboxValues = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-2">
            {(field.options || []).map((option, idx) => (
              <div key={idx} className="flex items-center space-x-2">
                <Checkbox
                  id={`edit-${field.id}-${idx}`}
                  checked={checkboxValues.includes(option)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setValue([...checkboxValues, option]);
                    } else {
                      setValue(checkboxValues.filter(v => v !== option));
                    }
                  }}
                />
                <Label htmlFor={`edit-${field.id}-${idx}`} className="font-normal">{option}</Label>
              </div>
            ))}
          </div>
        );

      case 'country':
        return (
          <Select value={value || ''} onValueChange={setValue}>
            <SelectTrigger data-testid="select-edit-country">
              <SelectValue placeholder="Select a country" />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((country) => (
                <SelectItem key={country.code} value={country.name}>{country.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'countries':
        const countriesValue = Array.isArray(value) ? value : [];
        return (
          <MultiCountrySelect
            value={countriesValue}
            onChange={setValue}
            fieldId={field.id}
          />
        );

      case 'date':
        return (
          <Input
            type="date"
            value={value || ''}
            onChange={(e) => setValue(e.target.value)}
            data-testid="input-edit-date"
          />
        );

      case 'switch':
        return (
          <div className="flex items-center space-x-2">
            <Switch
              checked={!!value}
              onCheckedChange={setValue}
              data-testid="switch-edit-field"
            />
            <span className="text-sm text-muted-foreground">{value ? 'Yes' : 'No'}</span>
          </div>
        );

      case 'user_name':
      case 'user_email':
        return (
          <Input
            type={field.type === 'user_email' ? 'email' : 'text'}
            value={value || ''}
            onChange={(e) => setValue(e.target.value)}
            placeholder={field.type === 'user_email' ? 'user@example.com' : 'User name'}
            data-testid="input-edit-field"
          />
        );

      case 'contact':
        const contactValue = value || {};
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="First name"
                value={contactValue.first_name || ''}
                onChange={(e) => setValue({ ...contactValue, first_name: e.target.value })}
              />
              <Input
                placeholder="Last name"
                value={contactValue.last_name || ''}
                onChange={(e) => setValue({ ...contactValue, last_name: e.target.value })}
              />
            </div>
            <Input
              type="email"
              placeholder="Email"
              value={contactValue.email || ''}
              onChange={(e) => setValue({ ...contactValue, email: e.target.value })}
            />
          </div>
        );

      case 'file':
      case 'image':
      case 'logo':
        const fileValue = value || {};
        const isImageField = field?.type === 'image' || field?.type === 'logo';
        const acceptTypes = isImageField ? 'image/*' : undefined;
        return (
          <div className="space-y-3">
            {isImageField && fileValue.file_url && (
              <div className="relative">
                <img 
                  src={resolvedFileUrl || fileValue.file_url} 
                  alt={fileValue.file_name || 'Uploaded image'}
                  className="max-w-full h-auto max-h-48 rounded-md object-contain bg-muted"
                />
                <Button
                  variant="destructive"
                  size="icon"
                  className="absolute top-2 right-2 h-6 w-6"
                  onClick={() => setValue(null)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            )}
            {!isImageField && fileValue.file_name && (
              <div className="flex items-center gap-2 p-3 bg-muted rounded-md">
                <FileText className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm flex-1 truncate">{fileValue.file_name}</span>
                {(resolvedFileUrl || fileValue.file_url) && (
                  <a 
                    href={resolvedFileUrl || fileValue.file_url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setValue(null)}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            )}
            
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept={acceptTypes}
              className="hidden"
            />
            
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="w-full"
              data-testid="button-upload-file"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Uploading... {uploadProgress}%
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  {fileValue.file_name ? (isImageField ? (field?.type === 'logo' ? 'Replace Logo' : 'Replace Image') : 'Replace File') : (isImageField ? (field?.type === 'logo' ? 'Upload Logo' : 'Upload Image') : 'Upload File')}
                </>
              )}
            </Button>
          </div>
        );

      case 'signature':
        return (
          <div className="text-sm text-muted-foreground italic p-4 bg-muted rounded-md">
            Signature editing is not supported. Signatures must be captured through the form.
          </div>
        );

      default:
        return (
          <Input
            type="text"
            value={typeof value === 'object' ? JSON.stringify(value) : (value || '')}
            onChange={(e) => setValue(e.target.value)}
            placeholder={field.placeholder || ''}
            data-testid="input-edit-field"
          />
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit: {field?.label}</DialogTitle>
        </DialogHeader>

        <div className="py-4">
          {renderInput()}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={updateMutation.isPending || isUploading}
            data-testid="button-save-field"
          >
            {updateMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
