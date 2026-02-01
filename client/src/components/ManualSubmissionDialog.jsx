import { useState, useEffect } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, AlertCircle, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { COUNTRIES } from "@/data/countries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

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

export default function ManualSubmissionDialog({ open, onOpenChange, form }) {
  const [formValues, setFormValues] = useState({});
  const [submitterName, setSubmitterName] = useState("");
  const [submitterEmail, setSubmitterEmail] = useState("");
  const queryClient = useQueryClient();

  useEffect(() => {
    if (open && form) {
      setFormValues({});
      setSubmitterName("");
      setSubmitterEmail("");
    }
  }, [open, form]);

  const submitMutation = useMutation({
    mutationFn: async (data) => {
      const response = await fetch('/api/admin/manual-form-submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to create submission');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['form-submissions-all'] });
      toast.success('Submission created successfully');
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create submission');
    },
  });

  const handleSubmit = () => {
    const fields = form?.fields || [];
    const requiredFields = fields.filter(f => f.required && f.type !== 'instructions' && f.type !== 'page_break');
    const missingFields = [];
    
    for (const field of requiredFields) {
      const value = formValues[field.id];
      const isEmpty = value === undefined || value === null || value === '' || 
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
      
      if (isEmpty) {
        missingFields.push(field.label);
      }
    }
    
    if (missingFields.length > 0) {
      toast.error(`Please fill in required fields: ${missingFields.slice(0, 3).join(', ')}${missingFields.length > 3 ? '...' : ''}`);
      return;
    }
    
    submitMutation.mutate({
      form_id: form.id,
      form_name: form.name,
      submitted_by_name: submitterName || null,
      submitted_by_email: submitterEmail || null,
      submission_data: formValues,
    });
  };

  const updateValue = (fieldId, value) => {
    setFormValues(prev => ({ ...prev, [fieldId]: value }));
  };

  const renderField = (field) => {
    const value = formValues[field.id];

    if (field.type === 'instructions' || field.type === 'page_break') {
      return null;
    }

    switch (field.type) {
      case 'text':
      case 'email':
      case 'url':
      case 'phone':
        return (
          <Input
            type={field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            value={value || ''}
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.placeholder || ''}
            data-testid={`input-${field.id}`}
          />
        );

      case 'number':
      case 'percentage':
        return (
          <Input
            type="number"
            value={value || ''}
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.placeholder || ''}
            data-testid={`input-${field.id}`}
          />
        );

      case 'textarea':
        return (
          <Textarea
            value={value || ''}
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.placeholder || ''}
            rows={3}
            data-testid={`textarea-${field.id}`}
          />
        );

      case 'select':
        return (
          <Select value={value || ''} onValueChange={(val) => updateValue(field.id, val)}>
            <SelectTrigger data-testid={`select-${field.id}`}>
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
          <RadioGroup value={value || ''} onValueChange={(val) => updateValue(field.id, val)}>
            {(field.options || []).map((option, idx) => (
              <div key={idx} className="flex items-center space-x-2">
                <RadioGroupItem value={option} id={`${field.id}-${idx}`} />
                <Label htmlFor={`${field.id}-${idx}`} className="font-normal">{option}</Label>
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
                  id={`${field.id}-${idx}`}
                  checked={checkboxValues.includes(option)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      updateValue(field.id, [...checkboxValues, option]);
                    } else {
                      updateValue(field.id, checkboxValues.filter(v => v !== option));
                    }
                  }}
                />
                <Label htmlFor={`${field.id}-${idx}`} className="font-normal">{option}</Label>
              </div>
            ))}
          </div>
        );

      case 'country':
        return (
          <Select value={value || ''} onValueChange={(val) => updateValue(field.id, val)}>
            <SelectTrigger data-testid={`select-country-${field.id}`}>
              <SelectValue placeholder="Select a country" />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.map((country) => (
                <SelectItem key={country.code} value={country.name}>{country.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'date':
        return (
          <Input
            type="date"
            value={value || ''}
            onChange={(e) => updateValue(field.id, e.target.value)}
            data-testid={`input-date-${field.id}`}
          />
        );

      case 'countries':
        const countriesValue = Array.isArray(value) ? value : [];
        return (
          <MultiCountrySelect
            value={countriesValue}
            onChange={(val) => updateValue(field.id, val)}
            fieldId={field.id}
          />
        );

      case 'switch':
        return (
          <div className="flex items-center space-x-2">
            <Switch
              checked={!!value}
              onCheckedChange={(checked) => updateValue(field.id, checked)}
              data-testid={`switch-${field.id}`}
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
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.type === 'user_email' ? 'user@example.com' : 'User name'}
            data-testid={`input-${field.id}`}
          />
        );

      case 'custom_field':
      case 'organisation_dropdown':
      case 'member_dropdown':
        return (
          <Input
            type="text"
            value={value || ''}
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.placeholder || 'Enter value'}
            data-testid={`input-${field.id}`}
          />
        );

      case 'file':
      case 'signature':
        return (
          <div className="text-sm text-muted-foreground italic">
            {field.type === 'file' ? 'File uploads' : 'Signatures'} not supported in manual entry
          </div>
        );

      case 'contact':
        const contactValue = value || {};
        return (
          <div className="space-y-2 pl-4 border-l-2 border-muted">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="First name"
                value={contactValue.first_name || ''}
                onChange={(e) => updateValue(field.id, { ...contactValue, first_name: e.target.value })}
              />
              <Input
                placeholder="Last name"
                value={contactValue.last_name || ''}
                onChange={(e) => updateValue(field.id, { ...contactValue, last_name: e.target.value })}
              />
            </div>
            <Input
              type="email"
              placeholder="Email"
              value={contactValue.email || ''}
              onChange={(e) => updateValue(field.id, { ...contactValue, email: e.target.value })}
            />
          </div>
        );

      default:
        return (
          <Input
            type="text"
            value={value || ''}
            onChange={(e) => updateValue(field.id, e.target.value)}
            placeholder={field.placeholder || ''}
            data-testid={`input-${field.id}`}
          />
        );
    }
  };

  const fields = form?.fields || [];
  const renderableFields = fields.filter(f => f.type !== 'instructions' && f.type !== 'page_break');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Manual Submission: {form?.name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>This creates a submission directly without triggering workflows or notifications.</span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Submitter Name (optional)</Label>
              <Input
                value={submitterName}
                onChange={(e) => setSubmitterName(e.target.value)}
                placeholder="Name of submitter"
                data-testid="input-submitter-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Submitter Email (optional)</Label>
              <Input
                type="email"
                value={submitterEmail}
                onChange={(e) => setSubmitterEmail(e.target.value)}
                placeholder="email@example.com"
                data-testid="input-submitter-email"
              />
            </div>
          </div>
        </div>

        <ScrollArea className="h-[400px] pr-4">
          <div className="space-y-4">
            {renderableFields.map((field) => (
              <div key={field.id} className="space-y-2">
                <Label className="flex items-center gap-1">
                  {field.label}
                  {field.required && <span className="text-destructive">*</span>}
                </Label>
                {renderField(field)}
              </div>
            ))}
            {renderableFields.length === 0 && (
              <div className="text-center text-muted-foreground py-8">
                This form has no input fields.
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleSubmit} 
            disabled={submitMutation.isPending}
            data-testid="button-submit-manual"
          >
            {submitMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Create Submission
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
