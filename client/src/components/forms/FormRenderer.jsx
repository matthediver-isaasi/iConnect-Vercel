import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, X, Trash2, Check, ChevronsUpDown } from "lucide-react";
import CustomFieldFileUpload from "@/components/CustomFieldFileUpload";
import SignatureField from "@/components/forms/SignatureField";
import ScoreField from "@/components/forms/ScoreField";
import MembershipPaymentField from "@/components/forms/MembershipPaymentField";
import AddressLookupField from "@/components/forms/AddressLookupField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { publicClient } from "@/api/publicClient";
import { COUNTRIES } from "@/data/countries";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import DOMPurify from 'dompurify';
import {
  isConfirmedEmptyRelationshipResult,
  normalizeRelationshipOptions,
  getSavedFormFieldValue,
  resolveSavedFormField,
  resolveFormRendererFieldValue,
  resolveRelationshipDropdownValues,
  resolveRelationshipParentTransition,
  shouldClearFilteredOrganisationValue,
} from "@/lib/formRelationshipDropdown";
import {
  intersectConditionalOptions,
  projectConditionalSourceValues,
  removeInvalidConditionalValue,
  resolveConditionalFilters,
} from "@/lib/formConditionalFilters";
import { labelSpreadsheetControls } from "@/lib/repeatableRowsLayout";
import { initializeCommunicationPreferenceDefaults } from "@/lib/formCommunicationPreferenceDefaults";
import {
  FORM_NOT_LISTED_VALUE,
  FORM_NOT_LISTED_TEXT_MAX_LENGTH,
  FORM_NOT_LISTED_TEXT_KEY,
  applyExclusiveFormNotListedSelection,
  containsFormNotListedValue,
  formNotListedChoiceLabel,
  hasEnabledFormNotListedChoice,
  isFormNotListedValue,
  prependFormNotListedOption,
  resolveFormNotListedText,
  setRepeatableRowNotListedText,
  supportsFormNotListedChoice,
} from "../../../../shared/formNotListedChoice.js";
import { formNoRelationshipLabel } from "../../../../shared/formNoRelationshipChoice.js";
import {
  createRepeatableRowId,
  ensureRepeatableRowIds,
  isRepeatableUniqueOptionAvailable,
  isRepeatableRowField,
  normalizeRepeatableRowField,
  reconcilePendingRepeatableRows,
  repeatableSiblingUniqueValues,
  repeatableUniqueValueKey,
  REPEATABLE_ROW_LAYOUT_SPREADSHEET,
  validateRepeatableRows,
} from "../../../../shared/formRepeatableRows.js";

let organizationQueryInstanceSequence = 0;

function SpreadsheetCell({ headingId, contextId, testId, children }) {
  const cellRef = useRef(null);
  useEffect(() => {
    labelSpreadsheetControls(cellRef.current, headingId, contextId);
  });
  return (
    <div
      ref={cellRef}
      className="min-w-0"
      role="group"
      aria-labelledby={headingId}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function RepeatableRowsField({
  field,
  value,
  onChange,
  disabled,
  onValidityChange,
  memberInfo,
  organizationInfo,
  selectedOrgGuestAccess,
  formId,
  formSlug,
  formMemberRoleId,
  prefillData,
  membershipFeeQuote,
  notListedDisplayLabel,
  rootAllFields,
  rootAllFormValues,
}) {
  const config = useMemo(() => normalizeRepeatableRowField(field), [field]);
  const [childValidity, setChildValidity] = useState({});
  const lastReportedValidity = useRef();
  const initializedRows = useRef(false);
  const controlledRows = useMemo(() => (Array.isArray(value) ? value : []), [value]);
  const incomingRows = useMemo(() => ensureRepeatableRowIds(controlledRows).map(row => Object.fromEntries([
    ['_row_id', row._row_id],
    ...config.children.map(child => [
      child.id,
      row[child.id] ?? (Array.isArray(child.default_value) ? [...child.default_value] : (child.default_value ?? '')),
    ]),
    ...(row[FORM_NOT_LISTED_TEXT_KEY] && typeof row[FORM_NOT_LISTED_TEXT_KEY] === 'object'
      ? [[FORM_NOT_LISTED_TEXT_KEY, row[FORM_NOT_LISTED_TEXT_KEY]]]
      : []),
  ])), [controlledRows, config.children]);
  const latestRows = useRef(incomingRows);
  const pendingRows = useRef(null);
  const reconciledRows = reconcilePendingRepeatableRows(incomingRows, pendingRows.current);
  const rows = reconciledRows.currentRows;
  latestRows.current = reconciledRows.currentRows;
  pendingRows.current = reconciledRows.pendingRows;
  const targetInitialRows = Math.max(config.min_rows, 1);
  const createRow = () => Object.fromEntries([
    ['_row_id', createRepeatableRowId()],
    ...config.children.map(child => [
      child.id,
      Array.isArray(child.default_value) ? [...child.default_value] : (child.default_value ?? ''),
    ]),
  ]);

  useEffect(() => {
    if (!initializedRows.current && controlledRows.length === 0) {
      initializedRows.current = true;
      onChange(Array.from(
        { length: targetInitialRows },
        createRow,
      ));
      return;
    }
    initializedRows.current = true;
    const needsCanonicalValue = incomingRows.length !== controlledRows.length || incomingRows.some((row, index) => (
      row._row_id !== controlledRows[index]?._row_id
      || config.children.some(child => !Object.prototype.hasOwnProperty.call(controlledRows[index] || {}, child.id))
    ));
    if (needsCanonicalValue) onChange(incomingRows);
  }, [controlledRows, incomingRows, targetInitialRows, config.children, onChange]);

  const validation = useMemo(() => validateRepeatableRows(field, rows, {
      rootFields: rootAllFields || [],
      validateChild: ({ child, row }) => childValidity[row._row_id]?.[child.id] !== false,
      isAllowedSpecialSelection: ({ child, value: selected }) => (
        isFormNotListedValue(selected) && hasEnabledFormNotListedChoice(child)
      ),
    }), [field, rows, childValidity, rootAllFields]);
  const duplicateErrors = useMemo(() => {
    const byCell = new Map();
    validation.errors
      .filter(error => error.code === 'duplicate_child_value')
      .forEach(error => byCell.set(`${error.row}:${error.child_id}`, error.message));
    return byCell;
  }, [validation.errors]);

  useEffect(() => {
    if (lastReportedValidity.current !== validation.valid) {
      lastReportedValidity.current = validation.valid;
      onValidityChange?.(field.id, validation.valid);
    }
  }, [field.id, validation.valid, onValidityChange]);

  const commitRows = (update) => {
    const nextRows = update(latestRows.current);
    latestRows.current = nextRows;
    pendingRows.current = nextRows;
    onChange(nextRows);
  };
  const updateRow = (rowId, childId, nextValue) => {
    const child = config.children.find(candidate => candidate.id === childId);
    commitRows(currentRows => currentRows.map((row) => {
      if (row._row_id !== rowId) return row;
      const updated = { ...row, [childId]: nextValue };
      return supportsFormNotListedChoice(child) && !containsFormNotListedValue(nextValue)
        ? setRepeatableRowNotListedText(updated, childId, '')
        : updated;
    }));
  };
  const updateRowNotListedText = (rowId, childId, text) => {
    commitRows(currentRows => currentRows.map(current => (
      current._row_id === rowId
        ? setRepeatableRowNotListedText(current, childId, text)
        : current
    )));
  };
  const addRow = () => {
    if (latestRows.current.length >= config.max_rows) return;
    commitRows(currentRows => [...currentRows, createRow()]);
  };
  const removeRow = (rowId) => {
    if (latestRows.current.length <= config.min_rows) return;
    commitRows(currentRows => currentRows.filter(row => row._row_id !== rowId));
    setChildValidity(current => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  };

  if (config.children.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        No row fields have been configured.
      </div>
    );
  }

  const renderChild = (child, row, rowId, rowIndex, spreadsheet = false) => {
    const siblingUniqueValues = repeatableSiblingUniqueValues(rows, child, rowId);
    const content = (
      <>
      {spreadsheet
        ? <span className="sr-only">{child.label || 'Untitled field'}{child.required ? ' (required)' : ''}</span>
        : (
          <>
            <Label>
              {child.label || 'Untitled field'}
              {child.required && <span className="ml-1 text-red-500">*</span>}
            </Label>
            {child.description && <p className="text-xs text-slate-500">{child.description}</p>}
          </>
        )}
      <FormRenderer
        field={{ ...child, repeatable_container_field_id: field.id }}
        value={row[child.id]}
        onChange={nextValue => updateRow(rowId, child.id, nextValue)}
        onFormNotListedTextChange={text => updateRowNotListedText(rowId, child.id, text)}
        onValidityChange={(childId, valid) => setChildValidity(current => (
          current[rowId]?.[childId] === valid
            ? current
            : { ...current, [rowId]: { ...(current[rowId] || {}), [childId]: valid } }
        ))}
        memberInfo={memberInfo}
        organizationInfo={organizationInfo}
        selectedOrgGuestAccess={selectedOrgGuestAccess}
        disabled={disabled}
        hideLabel
        formId={formId}
        formSlug={formSlug}
        formMemberRoleId={formMemberRoleId}
        allFormValues={row}
        allFields={config.children}
        rootAllFields={rootAllFields}
        rootAllFormValues={rootAllFormValues}
        prefillData={prefillData}
        membershipFeeQuote={membershipFeeQuote}
        notListedDisplayLabel={notListedDisplayLabel}
        repeatableSiblingUniqueValues={siblingUniqueValues}
      />
      {duplicateErrors.has(`${rowIndex}:${child.id}`) && (
        <p
          className="text-xs text-slate-500"
          aria-live="polite"
          data-testid={`repeatable-duplicate-error-${field.id}-${rowIndex}-${child.id}`}
        >
          That value is already used in another row.
        </p>
      )}
      </>
    );
    return spreadsheet ? (
      <SpreadsheetCell
        key={child.id}
        headingId={`repeatable-heading-${field.id}-${child.id}`}
        contextId={`repeatable-cell-${field.id}-${rowId}-${child.id}`}
        testId={`repeatable-spreadsheet-cell-${field.id}-${rowIndex}-${child.id}`}
      >
        {content}
      </SpreadsheetCell>
    ) : (
      <div key={child.id} className="space-y-2">{content}</div>
    );
  };

  const spreadsheet = config.layout === REPEATABLE_ROW_LAYOUT_SPREADSHEET;
  const spreadsheetGridStyle = {
    gridTemplateColumns: `repeat(${config.children.length}, minmax(12rem, 1fr)) 2.75rem`,
  };
  const spreadsheetMinWidth = `${Math.max(28, (config.children.length * 12) + 2.75)}rem`;

  return (
    <div className="space-y-3" data-testid={`repeatable-rows-${field.id}`}>
      {spreadsheet ? (
        <div
          className="overflow-x-auto rounded-lg border border-slate-200"
          data-testid={`repeatable-spreadsheet-${field.id}`}
        >
          <div style={{ minWidth: spreadsheetMinWidth }}>
            <div
              className="grid items-end gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2"
              style={spreadsheetGridStyle}
              data-testid={`repeatable-spreadsheet-header-${field.id}`}
            >
              {config.children.map(child => (
                <div
                  key={child.id}
                  id={`repeatable-heading-${field.id}-${child.id}`}
                  className="text-xs font-medium text-slate-700"
                >
                  {child.label || 'Untitled field'}
                  {child.required && <span className="ml-1 text-red-500">*</span>}
                  {child.description && (
                    <p className="mt-0.5 font-normal text-slate-500">{child.description}</p>
                  )}
                </div>
              ))}
              <span className="sr-only">Actions</span>
            </div>
            {rows.map((row, rowIndex) => {
              const rowId = row._row_id;
              return (
                <fieldset
                  key={rowId}
                  className="grid items-start gap-3 border-b border-slate-100 px-3 py-3 last:border-b-0"
                  style={spreadsheetGridStyle}
                  data-testid={`repeatable-row-${field.id}-${rowIndex}`}
                >
                  <legend className="sr-only">{field.label || 'Repeated row'} {rowIndex + 1}</legend>
                  {config.children.map(child => renderChild(child, row, rowId, rowIndex, true))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-0.5 text-slate-500 hover:text-red-600"
                    disabled={disabled || rows.length <= config.min_rows}
                    onClick={() => removeRow(rowId)}
                    aria-label={`Remove row ${rowIndex + 1}`}
                    title={`Remove row ${rowIndex + 1}`}
                    data-testid={`button-remove-repeatable-row-${field.id}-${rowIndex}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </fieldset>
              );
            })}
          </div>
        </div>
      ) : rows.map((row, rowIndex) => {
        const rowId = row._row_id;
        return (
          <fieldset
            key={rowId}
            className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4"
            data-testid={`repeatable-row-${field.id}-${rowIndex}`}
          >
            <legend className="sr-only">{field.label || 'Repeated row'} {rowIndex + 1}</legend>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-700" aria-hidden="true">Row {rowIndex + 1}</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || rows.length <= config.min_rows}
                onClick={() => removeRow(rowId)}
                aria-label={`Remove row ${rowIndex + 1}`}
                data-testid={`button-remove-repeatable-row-${field.id}-${rowIndex}`}
              >
                <X className="mr-1 h-4 w-4" /> Remove
              </Button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {config.children.map(child => renderChild(child, row, rowId, rowIndex))}
            </div>
          </fieldset>
        );
      })}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || rows.length >= config.max_rows}
        onClick={addRow}
        aria-label={`${config.add_row_label}; ${rows.length} of ${config.max_rows} rows`}
        data-testid={`button-add-repeatable-row-${field.id}`}
      >
        <Plus className="mr-2 h-4 w-4" /> {config.add_row_label}
      </Button>
      <p className="text-xs text-slate-500" aria-live="polite">
        {rows.length} of {config.max_rows} rows
      </p>
    </div>
  );
}

function CountryCombobox({ countries, value, onChange, disabled, placeholder, fieldId, notListedLabel = '' }) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Support both country codes (legacy) and country names for backwards compatibility
  const selectedCountry = countries.find(c => c.name === value || c.code === value);
  const selectedLabel = value === FORM_NOT_LISTED_VALUE ? notListedLabel : selectedCountry?.name;
  
  // Filter countries based on search query while maintaining alphabetical order
  const filteredCountries = searchQuery
    ? countries.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : countries;
  
  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) setSearchQuery(""); // Reset search when closing
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
          data-testid={`select-country-${fieldId}`}
        >
          {selectedLabel || placeholder}
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
              {notListedLabel && (
                <CommandItem
                  value={FORM_NOT_LISTED_VALUE}
                  onSelect={() => {
                    onChange(FORM_NOT_LISTED_VALUE);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === FORM_NOT_LISTED_VALUE ? "opacity-100" : "opacity-0")} />
                  {notListedLabel}
                </CommandItem>
              )}
              {filteredCountries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.name}
                  onSelect={() => {
                    onChange(country.name);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      (value === country.name || value === country.code) ? "opacity-100" : "opacity-0"
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

function MultiCountryCombobox({ countries, value = [], onChange, disabled, placeholder, fieldId, notListedLabel = '', isSelectionAllowed = () => true }) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Support both country codes (legacy) and country names for backwards compatibility
  const selectedCountries = countries.filter(c => value.includes(c.name) || value.includes(c.code));

  const nextValueForCountry = (country) => {
    const isSelected = value.includes(country.name) || value.includes(country.code);
    if (isSelected) return value.filter(item => item !== country.name && item !== country.code);
    return [...value.filter(item => item !== FORM_NOT_LISTED_VALUE), country.name];
  };
  const canToggleCountry = (country) => isSelectionAllowed(nextValueForCountry(country));
  const nextNotListedValue = applyExclusiveFormNotListedSelection(value, FORM_NOT_LISTED_VALUE);
  const canToggleNotListed = isSelectionAllowed(nextNotListedValue);

  const searchedCountries = searchQuery
    ? countries.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : countries;
  const filteredCountries = searchedCountries.filter(country => (
    value.includes(country.name)
    || value.includes(country.code)
    || canToggleCountry(country)
  ));

  const allFilteredSelected = filteredCountries.length > 0 && filteredCountries.every(
    c => value.includes(c.name) || value.includes(c.code)
  );

  const toggleAll = () => {
    let newValue;
    if (allFilteredSelected) {
      const filteredNames = new Set(filteredCountries.map(c => c.name));
      const filteredCodes = new Set(filteredCountries.map(c => c.code));
      newValue = value.filter(v => !filteredNames.has(v) && !filteredCodes.has(v));
    } else {
      const currentWithoutNotListed = value.filter(entry => entry !== FORM_NOT_LISTED_VALUE);
      const currentSet = new Set(currentWithoutNotListed);
      newValue = [...currentWithoutNotListed];
      for (const c of filteredCountries) {
        if (!currentSet.has(c.name) && !currentSet.has(c.code)) {
          newValue.push(c.name);
        }
      }
    }
    if (isSelectionAllowed(newValue)) onChange(newValue);
  };
  const canToggleAll = (() => {
    if (allFilteredSelected) {
      const names = new Set(filteredCountries.map(country => country.name));
      const codes = new Set(filteredCountries.map(country => country.code));
      return isSelectionAllowed(value.filter(item => !names.has(item) && !codes.has(item)));
    }
    const next = value.filter(item => item !== FORM_NOT_LISTED_VALUE);
    const selected = new Set(next);
    for (const country of filteredCountries) {
      if (!selected.has(country.name) && !selected.has(country.code)) next.push(country.name);
    }
    return isSelectionAllowed(next);
  })();
  
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
          disabled={disabled}
          className="w-full justify-between font-normal min-h-9 h-auto"
          data-testid={`select-countries-${fieldId}`}
        >
          <span className="flex flex-wrap gap-1 flex-1 text-left">
            {value.includes(FORM_NOT_LISTED_VALUE) ? notListedLabel : selectedCountries.length > 0 ? (
              selectedCountries.length <= 3 ? (
                selectedCountries.map(c => c.name).join(', ')
              ) : (
                `${selectedCountries.length} countries selected`
              )
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
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
              {notListedLabel && (value.includes(FORM_NOT_LISTED_VALUE) || canToggleNotListed) && (
                <CommandItem
                  value={FORM_NOT_LISTED_VALUE}
                  disabled={!canToggleNotListed}
                  onSelect={() => canToggleNotListed && onChange(nextNotListedValue)}
                >
                  <Check className={cn("mr-2 h-4 w-4", value.includes(FORM_NOT_LISTED_VALUE) ? "opacity-100" : "opacity-0")} />
                  {notListedLabel}
                </CommandItem>
              )}
              <CommandItem
                onSelect={toggleAll}
                disabled={!canToggleAll}
                className="font-medium text-primary"
                data-testid={`toggle-all-countries-${fieldId}`}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    allFilteredSelected ? "opacity-100" : "opacity-0"
                  )}
                />
                {allFilteredSelected ? 'Deselect All' : 'Select All'}
              </CommandItem>
              {filteredCountries.map((country) => (
                <CommandItem
                  key={country.code}
                  value={country.name}
                  disabled={!canToggleCountry(country)}
                  onSelect={() => canToggleCountry(country) && onChange(nextValueForCountry(country))}
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

function CommunicationPreferencesField({ field, value, onChange, disabled, memberInfo, formMemberRoleId, communicationEligibilityReady, conditionalResolution }) {
  const initializedDefaults = useRef(false);
  const { data: allCategories = [], isLoading } = useQuery({
    queryKey: ['public-communication-categories'],
    queryFn: async () => await publicClient.listCommunicationCategories() || [],
    staleTime: 5 * 60 * 1000
  });

  const allowedIds = Array.isArray(field.allowed_category_ids) ? field.allowed_category_ids : [];
  const allowedIdsKey = allowedIds.join(',');
  const defaultSelectedIds = Array.isArray(field.default_selected_category_ids)
    ? field.default_selected_category_ids
    : [];
  const defaultSelectedIdsKey = defaultSelectedIds.join(',');

  const categories = useMemo(() => {
    const effectiveRoleId = formMemberRoleId || memberInfo?.role_id;
    const roleFiltered = allCategories.filter(cat => {
      if ((effectiveRoleId || memberInfo?.id) && cat.member_enabled === false) return false;
      const hasRoleScope = cat.role_ids && cat.role_ids.length > 0;
      if (!hasRoleScope) return true;
      if (!effectiveRoleId) return false;
      return cat.role_ids.includes(effectiveRoleId);
    });
    const staticallyFiltered = allowedIds.length === 0
      ? roleFiltered
      : roleFiltered.filter(cat => new Set(allowedIds).has(cat.id));
    return intersectConditionalOptions(staticallyFiltered, conditionalResolution, cat => cat.id);
  }, [allCategories, formMemberRoleId, memberInfo?.id, memberInfo?.role_id, allowedIdsKey, conditionalResolution]);

  useEffect(() => {
    if (!communicationEligibilityReady || initializedDefaults.current || isLoading || categories.length === 0) return;
    initializedDefaults.current = true;
    const initialValue = initializeCommunicationPreferenceDefaults({
      value,
      categories,
      defaultSelectedCategoryIds: defaultSelectedIds,
    });
    if (initialValue) onChange(initialValue);
  }, [categories, communicationEligibilityReady, defaultSelectedIdsKey, isLoading, onChange, value]);

  useEffect(() => {
    if (isLoading || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const allowed = new Set(categories.map((category) => category.id));
    const next = Object.fromEntries(Object.entries(value).filter(([id]) => allowed.has(id)));
    if (Object.keys(next).length !== Object.keys(value).length) onChange(next);
  }, [categories, isLoading, value, onChange]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading communication preferences...
      </div>
    );
  }

  if (categories.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No communication preferences available.
      </p>
    );
  }

  const currentPrefs = value || {};

  const handleToggle = (categoryId, isSubscribed) => {
    onChange({
      ...currentPrefs,
      [categoryId]: isSubscribed
    });
  };

  return (
    <div className="space-y-3">
      {categories.map((category) => {
        const isSubscribed = currentPrefs[category.id] === true;
        return (
          <div 
            key={category.id} 
            className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200"
            data-testid={`comm-pref-category-${category.id}`}
          >
            <Checkbox
              id={`comm-pref-${category.id}`}
              checked={isSubscribed}
              disabled={disabled}
              onCheckedChange={(checked) => handleToggle(category.id, checked)}
              className="mt-0.5"
              data-testid={`checkbox-comm-pref-${category.id}`}
            />
            <div className="flex-1">
              <Label 
                htmlFor={`comm-pref-${category.id}`} 
                className="font-medium cursor-pointer"
              >
                {category.name}
              </Label>
              {category.description && (
                <p className="text-xs text-slate-500 mt-0.5">{category.description}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function FormRenderer({ field, value: suppliedValue, onChange, onFormNotListedTextChange, memberInfo, organizationInfo, selectedOrgGuestAccess = null, disabled = false, onValidityChange, onRelationshipEmptyStateChange, autoFocus = false, hideLabel = false, formId = null, formSlug = null, formMemberRoleId = null, communicationEligibilityReady = true, allFormValues = {}, prefillData = null, allFields = [], membershipFeeQuote = null, notListedDisplayLabel = '', rootAllFields = null, rootAllFormValues = null, repeatableSiblingUniqueValues: siblingUniqueValues = [] }) {
  const resolvedFieldValue = resolveFormRendererFieldValue({
    field,
    fields: allFields,
    values: allFormValues,
    value: suppliedValue,
  });
  const value = resolvedFieldValue.value;
  const hasNotListedSelection = supportsFormNotListedChoice(field)
    && containsFormNotListedValue(value);
  const notListedText = resolveFormNotListedText(field, allFormValues);
  const hasStoredNotListedText = allFormValues?.[FORM_NOT_LISTED_TEXT_KEY]?.[field.id] !== undefined;
  const [showOtherInput, setShowOtherInput] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const [domainError, setDomainError] = useState('');
  const [domainInfoMessage, setDomainInfoMessage] = useState('');
  const [emailFormatError, setEmailFormatError] = useState('');
  const [urlFormatError, setUrlFormatError] = useState('');
  const lastNotListedValidity = useRef();
  const conditionalResolution = useMemo(
    () => resolveConditionalFilters({ field, fields: allFields, values: allFormValues }),
    [field, allFields, allFormValues],
  );

  useEffect(() => {
    if (resolvedFieldValue.needsCanonicalValue) {
      onChange(value);
    }
  }, [resolvedFieldValue.needsCanonicalValue, onChange, value]);

  useEffect(() => {
    if (!supportsFormNotListedChoice(field) || hasNotListedSelection) return;
    if (hasStoredNotListedText) onFormNotListedTextChange?.('');
  }, [field, hasNotListedSelection, hasStoredNotListedText, onFormNotListedTextChange]);

  useEffect(() => {
    if (!supportsFormNotListedChoice(field)) return;
    const valid = !hasNotListedSelection || (
      Boolean(notListedText.trim())
        && notListedText.trim().length <= FORM_NOT_LISTED_TEXT_MAX_LENGTH
    );
    if (lastNotListedValidity.current === valid) return;
    lastNotListedValidity.current = valid;
    onValidityChange?.(field.id, valid);
  }, [field, hasNotListedSelection, notListedText, onValidityChange]);
  
  // Combine field.locked with disabled prop - either makes the field non-editable
  const isFieldDisabled = field.locked || disabled;

  const domainErrorRef = useRef('');
  const emailFormatErrorRef = useRef('');

  // Basic email format validation
  const validateEmailFormat = (email) => {
    if (!email) {
      setEmailFormatError('');
      emailFormatErrorRef.current = '';
      onValidityChange?.(field.id, !domainErrorRef.current);
      return true;
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      setEmailFormatError('Please enter a valid email address');
      emailFormatErrorRef.current = 'Please enter a valid email address';
      onValidityChange?.(field.id, false);
      return false;
    }
    setEmailFormatError('');
    emailFormatErrorRef.current = '';
    onValidityChange?.(field.id, !domainErrorRef.current);
    return true;
  };

  // Basic URL format validation
  const validateUrlFormat = (url) => {
    if (!url) {
      setUrlFormatError('');
      onValidityChange?.(field.id, true);
      return true;
    }
    const urlPattern = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(\/.*)?$/;
    if (!urlPattern.test(url)) {
      setUrlFormatError('Please enter a valid web address (e.g., https://example.com)');
      onValidityChange?.(field.id, false);
      return false;
    }
    setUrlFormatError('');
    onValidityChange?.(field.id, true);
    return true;
  };

  // Domain validation helper for email fields
  const validateEmailDomain = (email) => {
    if (!field.validate_org_domain) {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      return;
    }
    
    if (!organizationInfo) {
      const err = 'Domain validation requires an organisation. Please ensure you are associated with an organisation.';
      setDomainError(err);
      setDomainInfoMessage('');
      domainErrorRef.current = err;
      onValidityChange?.(field.id, false);
      return;
    }
    
    if (!email) {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      onValidityChange?.(field.id, !emailFormatErrorRef.current);
      return;
    }
    
    const emailParts = email.split('@');
    if (emailParts.length !== 2 || !emailParts[1]) {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      return;
    }
    const emailDomain = emailParts[1].toLowerCase();
    
    const allowedDomains = [];
    if (organizationInfo.verified_domains && Array.isArray(organizationInfo.verified_domains)) {
      organizationInfo.verified_domains.forEach(d => {
        if (d) allowedDomains.push(d.toLowerCase());
      });
    }

    // Helper: when an org is selected and that org accepts guests, the domain
    // restriction is bypassed with a friendly info message instead of an error.
    // Mirrors the backend (resolveGuestStampForNewMember) which falls back to
    // the tenant default period when the org has no override — so we must not
    // block here just because period_days is missing.
    const tryGuestBypass = () => {
      if (!selectedOrgGuestAccess?.accepts_guests) return false;
      let msg;
      if (selectedOrgGuestAccess.unlimited) {
        msg = "Your email isn't on this organisation's verified domain list — a guest account will be created with permanent access.";
      } else {
        const days = Number(selectedOrgGuestAccess.default_period_days);
        if (Number.isFinite(days) && days > 0) {
          msg = `Your email isn't on this organisation's verified domain list — a guest account will be created with ${days} day${days === 1 ? '' : 's'} of access.`;
        } else {
          msg = "Your email isn't on this organisation's verified domain list — a guest account will be created for this organisation.";
        }
      }
      setDomainError('');
      setDomainInfoMessage(msg);
      domainErrorRef.current = '';
      onValidityChange?.(field.id, !emailFormatErrorRef.current);
      return true;
    };

    const orgLabel = organizationInfo?.name ? `${organizationInfo.name}` : 'the selected organisation';

    if (allowedDomains.length === 0) {
      if (tryGuestBypass()) return;
      const err = `${orgLabel} isn't currently accepting registrations through this form.`;
      setDomainError(err);
      setDomainInfoMessage('');
      domainErrorRef.current = err;
      onValidityChange?.(field.id, false);
      return;
    }
    
    if (!allowedDomains.includes(emailDomain)) {
      if (tryGuestBypass()) return;
      const domainList = allowedDomains.join(', ');
      const err = `Email domain must be one of the verified domains for ${orgLabel}: ${domainList}`;
      setDomainError(err);
      setDomainInfoMessage('');
      domainErrorRef.current = err;
      onValidityChange?.(field.id, false);
    } else {
      setDomainError('');
      setDomainInfoMessage('');
      domainErrorRef.current = '';
      onValidityChange?.(field.id, !emailFormatErrorRef.current);
    }
  };

  const organizationSourceAnswers = useMemo(
    () => projectConditionalSourceValues({ field, fields: allFields, values: allFormValues }),
    [field, allFields, allFormValues],
  );
  // A repeatable organisation field may explicitly depend on an earlier
  // form-level group. Add only that persisted dependency to the request; row
  // values must not be populated with unrelated root answers.
  const scopedOrganizationSourceAnswers = useMemo(() => {
    if (
      field.type !== 'organisation_dropdown'
      || field.organisation_group_parent_scope !== 'form'
      || !field.organisation_group_parent_field_id
    ) return organizationSourceAnswers;
    const parent = resolveSavedFormField(rootAllFields || allFields, field.organisation_group_parent_field_id);
    return {
      ...organizationSourceAnswers,
      [field.organisation_group_parent_field_id]: getSavedFormFieldValue(rootAllFormValues || allFormValues, parent) ?? null,
    };
  }, [field, organizationSourceAnswers, rootAllFields, rootAllFormValues]);
  const [organizationQueryInstance] = useState(() => {
    organizationQueryInstanceSequence += 1;
    return organizationQueryInstanceSequence;
  });
  const organizationAnswersSignature = JSON.stringify(scopedOrganizationSourceAnswers);
  const previousOrganizationAnswersSignature = useRef(organizationAnswersSignature);
  const organizationAnswersRevision = useRef(0);
  if (previousOrganizationAnswersSignature.current !== organizationAnswersSignature) {
    previousOrganizationAnswersSignature.current = organizationAnswersSignature;
    organizationAnswersRevision.current += 1;
  }
  const { data: organisations = [], isLoading: orgsLoading } = useQuery({
    queryKey: [
      'public-form-organization-options',
      formSlug,
      formId,
      field.id,
      field.repeatable_container_field_id,
      organizationQueryInstance,
      organizationAnswersRevision.current,
    ],
    queryFn: () => publicClient.listFormOrganizationOptions(
      formSlug,
      formId,
      field.id,
      scopedOrganizationSourceAnswers,
      field.repeatable_container_field_id,
    ),
    enabled: field.type === 'organisation_dropdown' && !!(formSlug || formId),
    staleTime: 5 * 60 * 1000
  });
  useEffect(() => {
    if (shouldClearFilteredOrganisationValue({
      field,
      value,
      organisations,
      optionsLoaded: !orgsLoading,
    })) {
      onChange('');
    }
  }, [
    field.type,
    field.organisation_group_parent_field_id,
    field.not_listed_choice,
    organisations,
    orgsLoading,
    value,
    onChange,
  ]);

  const { data: organisationGroups = [], isLoading: organisationGroupsLoading } = useQuery({
    queryKey: ['public-form-organisation-group-options', formSlug, formId, field.id, field.repeatable_container_field_id],
    queryFn: () => publicClient.listFormOrganisationGroupOptions(
      formSlug,
      formId,
      field.id,
      field.repeatable_container_field_id,
    ),
    enabled: field.type === 'organisation_group_dropdown' && !!(formSlug || formId),
    staleTime: 5 * 60 * 1000,
  });

  const relationshipValues = field.type === 'relationship_dropdown'
    ? resolveRelationshipDropdownValues({
      field,
      fields: allFields,
      values: allFormValues,
      value,
      rootFields: rootAllFields,
      rootValues: rootAllFormValues,
    })
    : {};
  const relationshipParentValue = relationshipValues.parentValue;
  const relationshipCurrentValue = relationshipValues.currentValue;
  const {
    data: relationshipOptionPayload,
    isLoading: relationshipOptionsLoading,
    isError: relationshipOptionsError,
    isSuccess: relationshipOptionsLoaded,
  } = useQuery({
    queryKey: ['public-form-relationship-options', formSlug, field.id, relationshipParentValue, field.repeatable_container_field_id],
    queryFn: () => publicClient.listFormRelationshipOptions(
      formSlug,
      field.id,
      relationshipParentValue,
      field.repeatable_container_field_id,
    ),
    enabled: field.type === 'relationship_dropdown' && !!formSlug && !!field.parent_field_id
      && !!relationshipParentValue && relationshipParentValue !== FORM_NOT_LISTED_VALUE,
    staleTime: 60 * 1000,
  });
  const rawRelationshipOptions = useMemo(
    () => normalizeRelationshipOptions(relationshipOptionPayload),
    [relationshipOptionPayload],
  );
  const relationshipOptions = useMemo(
    () => intersectConditionalOptions(
      prependFormNotListedOption(
        field,
        rawRelationshipOptions,
        (id, label) => ({ id, label }),
      ),
      conditionalResolution,
      option => option.id,
    ),
    [field, rawRelationshipOptions, conditionalResolution],
  );
  const relationshipResultIsEmpty = isConfirmedEmptyRelationshipResult({
    fieldType: field.type,
    parentValue: relationshipParentValue,
    options: rawRelationshipOptions,
    optionsLoaded: relationshipOptionsLoaded,
    optionsError: relationshipOptionsError,
  });
  const previousRelationshipParent = useRef();

  useEffect(() => {
    if (field.type !== 'relationship_dropdown' || !onRelationshipEmptyStateChange) return;
    onRelationshipEmptyStateChange(
      field.id,
      relationshipResultIsEmpty ? relationshipParentValue : null,
    );
  }, [
    field.id,
    field.type,
    onRelationshipEmptyStateChange,
    relationshipParentValue,
    relationshipResultIsEmpty,
  ]);

  useEffect(() => {
    if (field.type !== 'relationship_dropdown') return;
    const previousParentValue = previousRelationshipParent.current;
    const parentTransitionValue = resolveRelationshipParentTransition({
      field,
      value: relationshipCurrentValue,
      parentValue: relationshipParentValue,
      previousParentValue,
      options: relationshipOptions,
      optionsLoaded: relationshipOptionsLoaded,
    });
    if (parentTransitionValue !== null) {
      onChange(parentTransitionValue);
    } else if (relationshipValues.needsCanonicalValue) {
      onChange(relationshipCurrentValue);
    }
    previousRelationshipParent.current = relationshipParentValue;
  }, [
    field.type,
    field.not_listed_choice,
    relationshipParentValue,
    relationshipOptions,
    relationshipOptionsLoaded,
    relationshipCurrentValue,
    relationshipValues.needsCanonicalValue,
    onChange,
  ]);

  // Fetch resource categories for category_multiselect and category_dropdown field types (uses public endpoint)
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['public-resource-categories-for-form'],
    queryFn: async () => await publicClient.listResourceCategories() || [],
    enabled: field.type === 'category_multiselect' || field.type === 'category_dropdown',
    staleTime: 5 * 60 * 1000 // Cache for 5 minutes
  });

  const staticOptions = useMemo(
    () => intersectConditionalOptions(
      (field.options || []).filter(option => typeof option !== 'string' || option.trim() !== ''),
      conditionalResolution,
    ),
    [field.options, conditionalResolution],
  );
  const organisationOptions = useMemo(
    () => intersectConditionalOptions(
      prependFormNotListedOption(field, organisations, (id, name) => ({ id, name })),
      conditionalResolution,
      org => org.id,
    ),
    [field, organisations, conditionalResolution],
  );
  const organisationGroupOptions = useMemo(
    () => intersectConditionalOptions(
      prependFormNotListedOption(field, organisationGroups, (id, name) => ({ id, name })),
      conditionalResolution,
      group => group.id,
    ),
    [field, organisationGroups, conditionalResolution],
  );
  const imageButtonOptions = useMemo(
    () => intersectConditionalOptions(field.image_options || [], conditionalResolution, option => option.value),
    [field.image_options, conditionalResolution],
  );
  const availableCountryOptions = useMemo(() => {
    const restricted = field.all_countries !== false
      ? COUNTRIES
      : COUNTRIES.filter(country => (field.selected_countries || []).includes(country.code));
    return intersectConditionalOptions(restricted, conditionalResolution, country => [country.code, country.name]);
  }, [field.all_countries, field.selected_countries, conditionalResolution]);
  const availableCountryNotListedLabel = useMemo(() => {
    const label = notListedDisplayLabel || formNotListedChoiceLabel(field);
    if (!label) return '';
    const options = intersectConditionalOptions(
      [{ code: FORM_NOT_LISTED_VALUE, name: label }],
      conditionalResolution,
      option => option.code,
    );
    return options.length > 0 ? label : '';
  }, [field, conditionalResolution, notListedDisplayLabel]);
  const categoryDropdownOptions = useMemo(() => {
    const selected = categories.find(category => category.id === field.category_id);
    return intersectConditionalOptions(
      prependFormNotListedOption(
        field,
        selected?.subcategories || [],
        (value, label) => ({ value, label, synthetic: true }),
      ),
      conditionalResolution,
      option => option?.value ?? option,
    );
  }, [categories, field, conditionalResolution]);
  const categoryMultiselectAllowedValues = useMemo(() => {
    const filtered = field.allowed_category_ids?.length > 0
      ? categories.filter(category => field.allowed_category_ids.includes(category.id))
      : categories;
    const values = filtered.flatMap(category => category.subcategories || []);
    return intersectConditionalOptions(
      prependFormNotListedOption(field, values, value => value),
      conditionalResolution,
    );
  }, [categories, field, conditionalResolution]);
  const { data: customFieldDef, isLoading: customFieldLoading } = useQuery({
    queryKey: ['public-custom-field', field.custom_field_id, formId],
    queryFn: async () => await publicClient.getCustomField(field.custom_field_id, formId) || null,
    enabled: field.type === 'custom_field' && !!field.custom_field_id,
    staleTime: 5 * 60 * 1000,
  });
  const customFieldOptions = useMemo(
    () => intersectConditionalOptions(
      customFieldDef?.options || field.options || [],
      conditionalResolution,
      option => option?.value ?? option?.label ?? option,
    ),
    [customFieldDef?.options, field.options, conditionalResolution],
  );
  const repeatableComparisonField = field.type === 'custom_field' && customFieldDef?.field_type
    ? { ...field, custom_field_type: customFieldDef.field_type }
    : field;
  const repeatableExcludedValueKeys = new Set(
    siblingUniqueValues.map(item => repeatableUniqueValueKey(item, repeatableComparisonField)),
  );
  const repeatableOptionIsAvailable = (optionValue) => isRepeatableUniqueOptionAvailable(
    optionValue,
    value,
    repeatableComparisonField,
    repeatableExcludedValueKeys,
  );
  const repeatableSelectionIsAvailable = (nextValue) => isRepeatableUniqueOptionAvailable(
    nextValue,
    value,
    repeatableComparisonField,
    repeatableExcludedValueKeys,
  );
  const customCountryOptions = useMemo(() => {
    const restricted = customFieldDef?.all_countries !== false
      ? COUNTRIES
      : COUNTRIES.filter(country => (customFieldDef?.selected_countries || []).includes(country.code));
    return intersectConditionalOptions(restricted, conditionalResolution, country => [country.code, country.name]);
  }, [customFieldDef?.all_countries, customFieldDef?.selected_countries, conditionalResolution]);

  useEffect(() => {
    if (!conditionalResolution.configured) return;
    let options;
    let loading = false;
    let getValue;
    if (['dropdown', 'select', 'radio', 'checkbox'].includes(field.type)) options = staticOptions;
    else if (field.type === 'image_buttons') {
      options = imageButtonOptions;
      getValue = option => option.value;
    } else if (field.type === 'organisation_dropdown') {
      options = organisationOptions;
      getValue = option => option.id;
      loading = orgsLoading;
    } else if (field.type === 'organisation_group_dropdown') {
      options = organisationGroupOptions;
      getValue = option => option.id;
      loading = organisationGroupsLoading;
    } else if (field.type === 'relationship_dropdown') {
      options = relationshipOptions;
      getValue = option => option.id;
      loading = relationshipOptionsLoading || (!relationshipOptionsLoaded && !!relationshipParentValue);
    } else if (field.type === 'country' || field.type === 'countries') {
      options = availableCountryNotListedLabel
        ? [{ code: FORM_NOT_LISTED_VALUE, name: availableCountryNotListedLabel }, ...availableCountryOptions]
        : availableCountryOptions;
      getValue = option => [option.code, option.name];
    } else if (field.type === 'category_dropdown') {
      options = categoryDropdownOptions;
      loading = categoriesLoading;
    } else if (field.type === 'category_multiselect') {
      options = categoryMultiselectAllowedValues;
      loading = categoriesLoading;
    } else if (field.type === 'custom_field' && ['checkbox', 'picklist', 'radio'].includes(customFieldDef?.field_type)) {
      options = customFieldOptions;
      getValue = option => option?.value ?? option?.label ?? option;
      loading = customFieldLoading;
    } else if (field.type === 'custom_field' && ['country', 'countries'].includes(customFieldDef?.field_type)) {
      options = customCountryOptions;
      getValue = option => [option.code, option.name];
      loading = customFieldLoading;
    } else {
      return;
    }
    if (loading) return;
    const next = removeInvalidConditionalValue(value, options, getValue);
    if (next !== value) onChange(next);
  }, [
    field.type, value, staticOptions, imageButtonOptions, organisationOptions, orgsLoading,
    organisationGroupOptions, organisationGroupsLoading,
    relationshipOptions, relationshipOptionsLoading, relationshipOptionsLoaded,
    relationshipParentValue, availableCountryOptions, availableCountryNotListedLabel, onChange,
    categoryDropdownOptions, categoryMultiselectAllowedValues, categoriesLoading,
    customFieldDef?.field_type, customFieldOptions, customCountryOptions, customFieldLoading,
  ]);

  // Auto-populate user fields
  useEffect(() => {
    if (!memberInfo) return;
    
    let autoValue = null;
    switch (field.type) {
      case 'user_name':
        autoValue = `${memberInfo.first_name || ''} ${memberInfo.last_name || ''}`.trim();
        break;
      case 'user_email':
        autoValue = memberInfo.email || '';
        break;
      case 'user_organization':
        autoValue = organizationInfo?.name || '';
        break;
      case 'user_job_title':
        autoValue = memberInfo.job_title || '';
        break;
    }
    
    if (autoValue && !value) {
      onChange(autoValue);
    }
  }, [field.type, field.id, memberInfo?.first_name, memberInfo?.last_name, memberInfo?.email, memberInfo?.job_title, organizationInfo?.name, value]);

  // Check if current value is "Other" or a custom value when component mounts
  useEffect(() => {
    if (field.type === 'select' && field.allow_other && value) {
      const isExistingOption = (field.options || []).includes(value);
      if (!isExistingOption && value !== '') {
        setShowOtherInput(true);
        setOtherValue(value);
      }
    }
  }, []);

  useEffect(() => {
    if (field.type === 'custom_field' && customFieldDef?.field_type === 'boolean' && value === undefined) {
      onChange(false);
    }
  }, [field.type, customFieldDef?.field_type]);


  // Revalidate email domain when dependencies change
  useEffect(() => {
    if (field.type === 'email') {
      validateEmailDomain(value);
    }
  }, [field.validate_org_domain, organizationInfo?.verified_domains, organizationInfo?.name, value, field.type, selectedOrgGuestAccess?.accepts_guests, selectedOrgGuestAccess?.unlimited, selectedOrgGuestAccess?.default_period_days]);

  const renderRepeatableRows = () => (
    <RepeatableRowsField
      field={field}
      value={value}
      onChange={onChange}
      disabled={isFieldDisabled}
      onValidityChange={onValidityChange}
      memberInfo={memberInfo}
      organizationInfo={organizationInfo}
      selectedOrgGuestAccess={selectedOrgGuestAccess}
      formId={formId}
      formSlug={formSlug}
      formMemberRoleId={formMemberRoleId}
      prefillData={prefillData}
      membershipFeeQuote={membershipFeeQuote}
      notListedDisplayLabel={notListedDisplayLabel}
      rootAllFields={allFields}
      rootAllFormValues={allFormValues}
    />
  );

  const renderField = () => {
    // Handle auto-populated user fields
    if (['user_name', 'user_email', 'user_organization', 'user_job_title'].includes(field.type)) {
      // If user is logged in, show as read-only auto-populated field
      if (memberInfo) {
        return (
          <Input
            type="text"
            value={value || ''}
            readOnly
            className="bg-slate-50 cursor-not-allowed"
            placeholder={field.placeholder || 'Auto-populated from your profile'}
          />
        );
      }
      // If no user is logged in, allow manual input based on field type
      const inputType = field.type === 'user_email' ? 'email' : 'text';
      const placeholder = field.placeholder || (
        field.type === 'user_name' ? 'Enter your name' :
        field.type === 'user_email' ? 'Enter your email' :
        field.type === 'user_organization' ? 'Enter your organisation' :
        field.type === 'user_job_title' ? 'Enter your job title' : ''
      );
      return (
        <Input
          type={inputType}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={field.required}
          disabled={isFieldDisabled}
          className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
        />
      );
    }

    // The canonical field type remains in the switch below. Older saved forms
    // can use either shared alias and must receive the same row renderer.
    if (field.type !== 'repeatable_rows' && isRepeatableRowField(field)) {
      return renderRepeatableRows();
    }

    switch (field.type) {
      case 'text':
        return (
          <Input
            type="text"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            required={field.required}
            disabled={isFieldDisabled}
            autoFocus={autoFocus}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
        );

      case 'address_lookup':
        return (
          <AddressLookupField
            field={field}
            value={value}
            onChange={onChange}
            disabled={isFieldDisabled}
            formId={formId}
            formSlug={formSlug}
          />
        );

      case 'url':
        return (
          <div className="space-y-1">
            <Input
              type="url"
              value={value || ''}
              onChange={(e) => onChange(e.target.value)}
              onBlur={(e) => validateUrlFormat(e.target.value)}
              placeholder={field.placeholder || 'https://example.com'}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${urlFormatError ? 'border-warning/50' : ''}`}
              data-testid={`input-url-${field.id}`}
            />
            {urlFormatError && (
              <p className="text-xs text-warning" data-testid={`error-url-format-${field.id}`}>
                {urlFormatError}
              </p>
            )}
          </div>
        );

      case 'email':
        return (
          <div className="space-y-1">
            <Input
              type="email"
              value={value || ''}
              onChange={(e) => {
                onChange(e.target.value);
                validateEmailDomain(e.target.value);
              }}
              onBlur={(e) => {
                validateEmailFormat(e.target.value);
                validateEmailDomain(e.target.value);
              }}
              placeholder={field.placeholder}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${domainError || emailFormatError ? 'border-warning/50' : ''}`}
              data-testid={`input-email-${field.id}`}
            />
            {emailFormatError && (
              <p className="text-xs text-warning" data-testid={`error-email-format-${field.id}`}>
                {emailFormatError}
              </p>
            )}
            {domainError && (
              <p className="text-xs text-warning" data-testid={`error-domain-${field.id}`}>
                {domainError}
              </p>
            )}
            {!domainError && domainInfoMessage && (
              <p className="text-xs text-slate-600" data-testid={`info-domain-guest-${field.id}`}>
                {domainInfoMessage}
              </p>
            )}
          </div>
        );

      case 'score': {
        // Survey Score / Rating field (Task #3330). Question number is its
        // position among the survey's question fields (display-only).
        let questionNumber = null;
        if (Array.isArray(allFields) && allFields.length > 0) {
          const questionFields = allFields.filter(f => !['instructions', 'image'].includes(f.type));
          const idx = questionFields.findIndex(f => f.id === field.id);
          if (idx >= 0) questionNumber = idx + 1;
        }
        return (
          <ScoreField
            field={field}
            value={value}
            onChange={onChange}
            disabled={isFieldDisabled}
            questionNumber={field.show_question_number ? questionNumber : null}
          />
        );
      }

      case 'tel':
      case 'number':
        return (
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={value || ''}
            onChange={(e) => {
              const numericValue = e.target.value.replace(/[^0-9]/g, '');
              onChange(numericValue);
            }}
            placeholder={field.placeholder}
            required={field.required}
            disabled={isFieldDisabled}
            autoFocus={autoFocus}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
        );

      case 'percentage':
        return (
          <div className="relative">
            <Input
              type="text"
              inputMode="decimal"
              value={value || ''}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.]/g, '');
                const parts = val.split('.');
                const sanitized = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : val;
                onChange(sanitized);
              }}
              placeholder={field.placeholder || '0'}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              className={`pr-8 ${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}`}
              data-testid={`input-percentage-${field.id}`}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
          </div>
        );

      case 'currency': {
        // Currency field (Task #3480): decimal input with configurable symbol
        // adornment; values sanitize to at most 2 decimal places.
        const currencySymbol = field.currency_symbol || '£';
        return (
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" data-testid={`symbol-currency-${field.id}`}>
              {currencySymbol}
            </span>
            <Input
              type="text"
              inputMode="decimal"
              value={value || ''}
              onChange={(e) => {
                let val = e.target.value.replace(/[^0-9.]/g, '');
                const parts = val.split('.');
                if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
                const [intPart, decPart] = val.split('.');
                if (decPart !== undefined) val = intPart + '.' + decPart.slice(0, 2);
                onChange(val);
              }}
              placeholder={field.placeholder || '0.00'}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              style={{ paddingLeft: `${Math.max(2, 1.25 + currencySymbol.length * 0.6)}rem` }}
              className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
              data-testid={`input-currency-${field.id}`}
            />
          </div>
        );
      }

      case 'textarea': {
        const isWordLimit = field.limit_type === 'words';
        const maxLimit = field.max_characters;
        const textVal = value || '';
        const currentCount = isWordLimit
          ? (textVal.trim() === '' ? 0 : textVal.trim().split(/\s+/).length)
          : textVal.length;
        const isOverLimit = maxLimit && currentCount > maxLimit;
        return (
          <div className="space-y-1">
            <Textarea
              value={textVal}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.placeholder}
              required={field.required}
              disabled={isFieldDisabled}
              autoFocus={autoFocus}
              maxLength={(!isWordLimit && maxLimit) ? maxLimit : undefined}
              className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${isOverLimit ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
              rows={5}
            />
            {maxLimit && (
              <p className={`text-xs text-right ${isOverLimit ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
                {currentCount} / {maxLimit}{isWordLimit ? ' words' : ''}
              </p>
            )}
          </div>
        );
      }

      case 'date':
      case 'time':
        return (
          <Input
            type={field.type}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            required={field.required}
            disabled={isFieldDisabled}
            className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
          />
        );

      case 'boolean':
        const booleanValue = value !== undefined && value !== null 
          ? (value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true'))
          : (field.default_value === true);
        return (
          <div className="flex items-center space-x-3">
            <Switch
              id={field.id}
              checked={booleanValue}
              onCheckedChange={(checked) => onChange(checked)}
              disabled={isFieldDisabled}
              data-testid={`switch-boolean-${field.id}`}
            />
            <Label 
              htmlFor={field.id} 
              className={`font-normal cursor-pointer ${isFieldDisabled ? 'text-slate-400' : ''}`}
            >
              {booleanValue ? 'Yes' : 'No'}
            </Label>
          </div>
        );

      case 'terms_conditions':
        const tcValue = value !== undefined && value !== null 
          ? (value === true || value === 'true')
          : false;
        return (
          <div className="space-y-2">
            <div className="flex items-center space-x-3">
              <Switch
                id={field.id}
                checked={tcValue}
                onCheckedChange={(checked) => onChange(checked)}
                disabled={isFieldDisabled}
                data-testid={`switch-terms-${field.id}`}
              />
              <Label 
                htmlFor={field.id} 
                className={`font-normal cursor-pointer ${isFieldDisabled ? 'text-slate-400' : ''}`}
              >
                I accept the Terms & Conditions
              </Label>
            </div>
            {field.terms_url && (
              <a 
                href={field.terms_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline inline-block"
                data-testid={`link-terms-${field.id}`}
              >
                {field.terms_link_text || 'View Terms & Conditions'}
              </a>
            )}
          </div>
        );

      case 'dropdown':
      case 'select': {
        const effectiveStaticOptions = staticOptions.filter(repeatableOptionIsAvailable);
        const otherChoiceAvailable = field.allow_other && repeatableOptionIsAvailable('other');
        const noRemainingStaticOptions = staticOptions.length > 0
          && effectiveStaticOptions.length === 0
          && !otherChoiceAvailable;
        return (
          <div className="space-y-2">
            <Select 
              value={showOtherInput ? 'other' : (value || '')} 
              onValueChange={(val) => {
                if (isFieldDisabled) return;
                if (val === 'other') {
                  setShowOtherInput(true);
                  onChange('');
                } else {
                  setShowOtherInput(false);
                  setOtherValue('');
                  onChange(val);
                }
              }}
              disabled={isFieldDisabled || noRemainingStaticOptions}
            >
              <SelectTrigger className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
                <SelectValue placeholder={noRemainingStaticOptions
                  ? 'All available choices are already used in another row'
                  : (field.placeholder || 'Select an option')} />
              </SelectTrigger>
              <SelectContent side="bottom">
                {effectiveStaticOptions.map((option, index) => (
                  <SelectItem key={index} value={option}>
                    {option}
                  </SelectItem>
                ))}
                {otherChoiceAvailable && (
                  !conditionalResolution.configured
                  || intersectConditionalOptions(
                    ['Other'],
                    conditionalResolution,
                  ).length > 0
                ) && (
                  <SelectItem value="other">Other</SelectItem>
                )}
              </SelectContent>
            </Select>
            {showOtherInput && (
              <Input
                type="text"
                value={otherValue}
                onChange={(e) => {
                  setOtherValue(e.target.value);
                  onChange(e.target.value);
                }}
                placeholder="Please specify..."
                className="mt-2"
              />
            )}
          </div>
        );
      }

      case 'radio':
        return (
          <RadioGroup value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            {staticOptions.map((option, index) => (
              <div key={index} className="flex items-center space-x-2">
                <RadioGroupItem value={option} id={`${field.id}-${index}`} />
                <Label htmlFor={`${field.id}-${index}`} className="font-normal">
                  {option}
                </Label>
              </div>
            ))}
          </RadioGroup>
        );

      case 'checkbox':
        const checkboxSelectedValues = Array.isArray(value) ? value : [];
        const checkboxMinSelections = field.min_selections;
        const checkboxMaxSelections = field.max_selections;
        const checkboxHasMin = checkboxMinSelections != null && checkboxMinSelections > 0;
        const checkboxHasMax = checkboxMaxSelections != null && checkboxMaxSelections > 0;
        const checkboxIsMaxReached = checkboxHasMax && checkboxSelectedValues.length >= checkboxMaxSelections;
        
        // Build help text
        let checkboxHelpText = '';
        if (checkboxHasMin && checkboxHasMax) {
          if (checkboxMinSelections === checkboxMaxSelections) {
            checkboxHelpText = `Please select exactly ${checkboxMinSelections} option${checkboxMinSelections > 1 ? 's' : ''}`;
          } else {
            checkboxHelpText = `Please select between ${checkboxMinSelections} and ${checkboxMaxSelections} options`;
          }
        } else if (checkboxHasMin) {
          checkboxHelpText = `Please select at least ${checkboxMinSelections} option${checkboxMinSelections > 1 ? 's' : ''}`;
        } else if (checkboxHasMax) {
          checkboxHelpText = `Please select up to ${checkboxMaxSelections} option${checkboxMaxSelections > 1 ? 's' : ''}`;
        }
        
        return (
          <div className="space-y-2">
            {(checkboxHasMin || checkboxHasMax) && (
              <p className="text-xs text-slate-500">
                {checkboxHelpText} ({checkboxSelectedValues.length} selected)
              </p>
            )}
            <div className="space-y-2 p-3 bg-slate-50 rounded-lg border">
              {staticOptions.map((option, index) => {
                const isChecked = checkboxSelectedValues.includes(option);
                const isOptionDisabled = isFieldDisabled || (checkboxIsMaxReached && !isChecked);
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-${index}`}
                      checked={isChecked}
                      disabled={isOptionDisabled}
                      onCheckedChange={(checked) => {
                        if (isOptionDisabled) return;
                        if (checked) {
                          onChange([...checkboxSelectedValues, option]);
                        } else {
                          onChange(checkboxSelectedValues.filter(v => v !== option));
                        }
                      }}
                    />
                    <Label 
                      htmlFor={`${field.id}-${index}`} 
                      className={`font-normal cursor-pointer ${isOptionDisabled && !isChecked ? 'text-slate-400' : ''}`}
                    >
                      {option}
                    </Label>
                  </div>
                );
              })}
            </div>
          </div>
        );

      case 'file':
        return (
          <CustomFieldFileUpload
            fieldId={field.id}
            formId={formId}
            value={value}
            onChange={onChange}
            allowedTypes={field.allowed_file_types || []}
            publicAccess={field.public_access === true}
            disabled={isFieldDisabled}
            label={field.label || "Upload File"}
          />
        );

      case 'organisation_dropdown':
        if (!formSlug && !formId) {
          return <p className="text-sm text-slate-500">Organisation options require a persisted form.</p>;
        }
        if (orgsLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading organisations...
            </div>
          );
        }
        const effectiveOrganisationOptions = organisationOptions.filter(
          org => repeatableOptionIsAvailable(org.id),
        );
        if (effectiveOrganisationOptions.length === 0) {
          return <p className="text-sm text-slate-500">
            {conditionalResolution.configured && !conditionalResolution.matchedRule
              ? 'No organisations are available until a conditional rule matches.'
              : organisationOptions.length > 0
                ? 'All available organisations are already used in another row.'
              : 'No organisations are available.'}
          </p>;
        }
        // Find current org name for display (value stores ID)
        const selectedOrg = organisationOptions.find(org => org.id === value);
        return (
          <Select value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            <SelectTrigger data-testid={`select-organisation-${field.id}`} className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
              <SelectValue placeholder={field.placeholder || 'Select an organisation'}>
                {selectedOrg?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="bottom">
              {effectiveOrganisationOptions.map((org) => (
                <SelectItem key={org.id} value={org.id} data-testid={`option-organisation-${org.id}`}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'organisation_group_dropdown': {
        if (!formSlug && !formId) {
          return <p className="text-sm text-slate-500">Organisation group options require a persisted form.</p>;
        }
        if (organisationGroupsLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading organisation groups...
            </div>
          );
        }
        const effectiveOrganisationGroupOptions = organisationGroupOptions.filter(
          group => repeatableOptionIsAvailable(group.id),
        );
        if (effectiveOrganisationGroupOptions.length === 0) {
          return <p className="text-sm text-slate-500">
            {conditionalResolution.configured && !conditionalResolution.matchedRule
              ? 'No organisation groups are available until a conditional rule matches.'
              : organisationGroupOptions.length > 0
                ? 'All available organisation groups are already used in another row.'
              : 'No organisation groups are available.'}
          </p>;
        }
        const selectedGroup = organisationGroupOptions.find(group => group.id === value);
        return (
          <Select value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            <SelectTrigger data-testid={`select-organisation-group-${field.id}`} className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
              <SelectValue placeholder={field.placeholder || 'Select an organisation group'}>
                {selectedGroup?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="bottom">
              {effectiveOrganisationGroupOptions.map(group => (
                <SelectItem key={group.id} value={group.id} data-testid={`option-organisation-group-${group.id}`}>
                  {group.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }

      case 'relationship_dropdown': {
        const effectiveRelationshipOptions = relationshipOptions.filter(
          option => repeatableOptionIsAvailable(option.id),
        );
        const selectedOption = effectiveRelationshipOptions.find((option) => option.id === relationshipCurrentValue);
        const missingConfiguration = !formSlug || !field.parent_field_id || !field.relationship_definition_id;
        const canChooseNotListed = effectiveRelationshipOptions.some(option => option.id === FORM_NOT_LISTED_VALUE);
        const relationshipDisabled = isFieldDisabled || missingConfiguration || (!relationshipParentValue && !canChooseNotListed)
          || relationshipOptionsLoading || relationshipOptionsError || effectiveRelationshipOptions.length === 0;
        let placeholder = field.placeholder || 'Select an option';
        if (missingConfiguration) placeholder = 'This field is not configured';
        else if (!relationshipParentValue && !canChooseNotListed) placeholder = 'Select a parent record first';
        else if (relationshipOptionsLoading) placeholder = 'Loading options…';
        else if (relationshipOptionsError) placeholder = 'Options could not be loaded';
        else if (relationshipResultIsEmpty) placeholder = formNoRelationshipLabel(field);
        else if (effectiveRelationshipOptions.length === 0) {
          placeholder = relationshipOptions.length > 0
            ? 'All available choices are already used in another row'
            : 'No related records available';
        }
        return (
          <div className="space-y-1">
            <Select
              value={relationshipCurrentValue || ''}
              onValueChange={relationshipDisabled ? undefined : onChange}
              disabled={relationshipDisabled}
            >
              <SelectTrigger
                id={field.id}
                data-testid={`select-relationship-${field.id}`}
                className={relationshipDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
              >
                <SelectValue placeholder={placeholder}>{selectedOption?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent side="bottom">
                {effectiveRelationshipOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id} data-testid={`option-relationship-${field.id}-${option.id}`}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {relationshipOptionsLoading && <p className="text-xs text-slate-500">Loading related records…</p>}
            {relationshipOptionsError && <p className="text-xs text-red-600">Related records could not be loaded. Please try again.</p>}
            {relationshipResultIsEmpty && (
              <p className="text-xs text-slate-500" data-testid={`relationship-empty-message-${field.id}`}>
                {formNoRelationshipLabel(field)}
              </p>
            )}
          </div>
        );
      }

      case 'category_multiselect':
        if (categoriesLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading categories...
            </div>
          );
        }
        
        // Filter categories based on field configuration
        // If allowed_category_ids is empty/undefined, show all categories
        const filteredCategories = field.allowed_category_ids?.length > 0
          ? categories.filter(cat => field.allowed_category_ids.includes(cat.id))
          : categories;
        
        // Extract all subcategory options from the filtered categories
        // Each category has a subcategories array of strings
        const allSubcategoryOptions = [];
        filteredCategories.forEach(category => {
          if (category.subcategories && Array.isArray(category.subcategories)) {
            category.subcategories.forEach(subcat => {
              if (categoryMultiselectAllowedValues.includes(subcat)) allSubcategoryOptions.push({
                categoryId: category.id,
                categoryName: category.name,
                subcategory: subcat
              });
            });
          }
        });
        
        const notListedLabel = categoryMultiselectAllowedValues.includes(FORM_NOT_LISTED_VALUE)
          ? (notListedDisplayLabel || formNotListedChoiceLabel(field))
          : '';
        if (allSubcategoryOptions.length === 0 && !notListedLabel) {
          return (
            <p className="text-sm text-slate-500">
              {conditionalResolution.configured && !conditionalResolution.matchedRule
                ? 'No options are available until a conditional rule matches.'
                : 'No options available. Please add subcategories in Category Management.'}
            </p>
          );
        }
        
        // Min/max selection logic for category_multiselect
        const selectedValues = Array.isArray(value) ? value : [];
        const nextNotListedCategories = applyExclusiveFormNotListedSelection(selectedValues, FORM_NOT_LISTED_VALUE);
        const canToggleNotListedCategory = repeatableSelectionIsAvailable(nextNotListedCategories);
        const minSelections = field.min_selections;
        const maxSelections = field.max_selections;
        const hasMin = minSelections != null && minSelections > 0;
        const hasMax = maxSelections != null && maxSelections > 0;
        const isMaxReached = hasMax && selectedValues.length >= maxSelections;
        
        // Build help text
        let helpText = '';
        if (hasMin && hasMax) {
          if (minSelections === maxSelections) {
            helpText = `Please select exactly ${minSelections} option${minSelections > 1 ? 's' : ''}`;
          } else {
            helpText = `Please select between ${minSelections} and ${maxSelections} options`;
          }
        } else if (hasMin) {
          helpText = `Please select at least ${minSelections} option${minSelections > 1 ? 's' : ''}`;
        } else if (hasMax) {
          helpText = `Please select up to ${maxSelections} option${maxSelections > 1 ? 's' : ''}`;
        }
        
        // Group subcategories by category for display
        const groupedByCategory = filteredCategories.map(category => ({
          ...category,
          options: allSubcategoryOptions.filter(opt => opt.categoryId === category.id)
        })).filter(cat => cat.options.length > 0);
        
        return (
          <div className="space-y-4">
            {notListedLabel && (selectedValues.includes(FORM_NOT_LISTED_VALUE) || canToggleNotListedCategory) && (
              <div className="flex items-start space-x-2">
                <Checkbox
                  id={`${field.id}-not-listed`}
                  checked={selectedValues.includes(FORM_NOT_LISTED_VALUE)}
                  disabled={isFieldDisabled || !canToggleNotListedCategory}
                  onCheckedChange={() => canToggleNotListedCategory && onChange(nextNotListedCategories)}
                  data-testid={`checkbox-not-listed-${field.id}`}
                />
                <Label htmlFor={`${field.id}-not-listed`} className="font-normal cursor-pointer">{notListedLabel}</Label>
              </div>
            )}
            {groupedByCategory.map((category) => (
              <div key={category.id} className="space-y-2">
                {/* Category header - only show if multiple categories */}
                {groupedByCategory.length > 1 && (
                  <p className="text-sm font-medium text-slate-700">{category.name}</p>
                )}
                {/* Subcategory options */}
                <div className="space-y-2 pl-0">
                  {category.options.map((opt, optIndex) => {
                    const isChecked = selectedValues.includes(opt.subcategory);
                    const nextSelection = isChecked
                      ? selectedValues.filter(v => v !== opt.subcategory)
                      : applyExclusiveFormNotListedSelection(selectedValues, opt.subcategory);
                    const selectionIsAvailable = repeatableSelectionIsAvailable(nextSelection);
                    const isOptionDisabled = isFieldDisabled
                      || (isMaxReached && !isChecked)
                      || !selectionIsAvailable;
                    return (
                      <div key={`${category.id}-${optIndex}`} className="flex items-start space-x-2">
                        <Checkbox
                          id={`${field.id}-${category.id}-${optIndex}`}
                          checked={isChecked}
                          disabled={isOptionDisabled}
                          onCheckedChange={(checked) => {
                            if (isOptionDisabled) return;
                            onChange(checked
                              ? applyExclusiveFormNotListedSelection(selectedValues, opt.subcategory)
                              : selectedValues.filter(v => v !== opt.subcategory));
                          }}
                          data-testid={`checkbox-subcategory-${category.id}-${optIndex}`}
                        />
                        <Label 
                          htmlFor={`${field.id}-${category.id}-${optIndex}`} 
                          className={`font-normal cursor-pointer ${isOptionDisabled && !isChecked ? 'text-slate-400' : ''}`}
                        >
                          {opt.subcategory}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {helpText && (
              <p className="text-xs text-slate-500 pt-2 border-t border-slate-200 mt-2">
                {helpText} ({selectedValues.length} selected)
              </p>
            )}
          </div>
        );

      case 'category_dropdown':
        if (categoriesLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading options...
            </div>
          );
        }
        
        // Find the selected category and get its subcategories as options
        const selectedCategory = categories.find(cat => cat.id === field.category_id);
        const subcategoryOptions = categoryDropdownOptions;
        const effectiveSubcategoryOptions = subcategoryOptions.filter(option => (
          option !== '' && repeatableOptionIsAvailable(option?.value || option)
        ));
        
        if (!selectedCategory) {
          return (
            <p className="text-sm text-slate-500">
              No category configured for this field.
            </p>
          );
        }
        
        if (effectiveSubcategoryOptions.length === 0) {
          return (
            <p className="text-sm text-slate-500">
              {conditionalResolution.configured && !conditionalResolution.matchedRule
                ? 'No options are available until a conditional rule matches.'
                : subcategoryOptions.length > 0
                  ? 'All available options are already used in another row.'
                : `No options available for "${selectedCategory.name}".`}
            </p>
          );
        }
        
        return (
          <Select value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            <SelectTrigger data-testid={`select-category-dropdown-${field.id}`} className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
              <SelectValue placeholder={field.placeholder || 'Select an option'} />
            </SelectTrigger>
            <SelectContent side="bottom">
              {effectiveSubcategoryOptions.map((option, index) => (
                <SelectItem key={option?.value || option || index} value={option?.value || option} data-testid={`option-subcategory-${index}`}>
                  {option?.label || option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case 'custom_field':
        if (customFieldLoading) {
          return (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading options...
            </div>
          );
        }
        
        if (!customFieldDef) {
          return (
            <p className="text-sm text-slate-500">
              Custom field not found.
            </p>
          );
        }
        
        // Handle file upload custom field type
        if (customFieldDef.field_type === 'file') {
          return (
            <CustomFieldFileUpload
              fieldId={field.id}
              formId={formId}
              value={value}
              onChange={(fileData) => !isFieldDisabled && onChange(fileData)}
              allowedTypes={customFieldDef.allowed_file_types || []}
              publicAccess={customFieldDef.public_access === true}
              disabled={isFieldDisabled}
              label={field.label || customFieldDef.label || 'Upload File'}
            />
          );
        }
        
        // Handle text-based custom field types that don't need options
        const textBasedTypes = ['text', 'email', 'url', 'number', 'textarea', 'long_text', 'phone', 'date'];
        if (textBasedTypes.includes(customFieldDef.field_type)) {
          // Render appropriate input based on field_type
          if (customFieldDef.field_type === 'textarea' || customFieldDef.field_type === 'long_text') {
            const cfCharCount = (value || '').length;
            const cfMaxLen = customFieldDef.max_length;
            const cfMinLen = customFieldDef.min_length;
            const cfOverLimit = cfMaxLen && cfCharCount > cfMaxLen;
            const cfUnderLimit = cfMinLen && cfCharCount > 0 && cfCharCount < cfMinLen;
            return (
              <div className="space-y-1">
                <Textarea
                  value={value || ''}
                  onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
                  placeholder={field.placeholder}
                  disabled={isFieldDisabled}
                  maxLength={cfMaxLen || undefined}
                  className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''} ${cfOverLimit ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
                  data-testid={`textarea-custom-${field.id}`}
                />
                {(cfMaxLen || cfMinLen) && (
                  <div className="flex justify-between text-xs">
                    {cfMinLen ? (
                      <span className={cfUnderLimit ? 'text-red-500 font-medium' : 'text-slate-400'}>
                        Min: {cfMinLen} characters
                      </span>
                    ) : <span />}
                    {cfMaxLen ? (
                      <span className={cfOverLimit ? 'text-red-500 font-medium' : 'text-slate-400'}>
                        {cfCharCount} / {cfMaxLen}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            );
          }
          
          if (customFieldDef.field_type === 'number') {
            return (
              <Input
                type="number"
                value={value || ''}
                onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
                placeholder={field.placeholder}
                disabled={isFieldDisabled}
                className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
                data-testid={`input-custom-number-${field.id}`}
              />
            );
          }
          
          if (customFieldDef.field_type === 'date') {
            return (
              <Input
                type="date"
                value={value || ''}
                onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
                disabled={isFieldDisabled}
                className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
                data-testid={`input-custom-date-${field.id}`}
              />
            );
          }
          
          // Default to text input for text, email, url, phone
          return (
            <Input
              type={customFieldDef.field_type === 'email' ? 'email' : customFieldDef.field_type === 'url' ? 'url' : 'text'}
              value={value || ''}
              onChange={(e) => !isFieldDisabled && onChange(e.target.value)}
              placeholder={field.placeholder}
              disabled={isFieldDisabled}
              className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
              data-testid={`input-custom-${customFieldDef.field_type}-${field.id}`}
            />
          );
        }
        
        if (customFieldDef.field_type === 'boolean') {
          const boolVal = value !== undefined && value !== null
            ? (value === true || value === 'true')
            : false;
          return (
            <div className="flex items-center space-x-3">
              <Switch
                id={field.id}
                checked={boolVal}
                onCheckedChange={(checked) => !isFieldDisabled && onChange(checked)}
                disabled={isFieldDisabled}
                data-testid={`switch-custom-boolean-${field.id}`}
              />
              <Label
                htmlFor={field.id}
                className={`font-normal cursor-pointer ${isFieldDisabled ? 'text-slate-400' : ''}`}
              >
                {boolVal ? 'Yes' : 'No'}
              </Label>
            </div>
          );
        }

        if (customFieldDef.field_type === 'countries') {
          const allowedCountries = customCountryOptions;
          let countriesValue;
          if (Array.isArray(value)) {
            countriesValue = value;
          } else if (value === null || value === undefined || value === '') {
            countriesValue = [];
          } else if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
              try {
                const parsed = JSON.parse(trimmed);
                countriesValue = Array.isArray(parsed) ? parsed : [value];
              } catch {
                countriesValue = [value];
              }
            } else {
              countriesValue = [value];
            }
          } else {
            countriesValue = [value];
          }
          if (customCountryOptions.length === 0) {
            return <p className="text-sm text-slate-500">
              {conditionalResolution.configured && !conditionalResolution.matchedRule
                ? 'No countries are available until a conditional rule matches.'
                : 'No countries are available.'}
            </p>;
          }
          return (
            <MultiCountryCombobox
              countries={allowedCountries}
              value={countriesValue}
              onChange={(v) => !isFieldDisabled && onChange(v)}
              disabled={isFieldDisabled}
              placeholder={field.placeholder || 'Select countries...'}
              fieldId={field.id}
              isSelectionAllowed={repeatableSelectionIsAvailable}
            />
          );
        }

        if (customFieldDef.field_type === 'country') {
          const singleValue = Array.isArray(value) ? (value[0] || '') : (value || '');
          const allowedCountriesSingle = customCountryOptions.filter(country => (
            repeatableOptionIsAvailable(country.name)
            || (singleValue === country.code && repeatableOptionIsAvailable(country.code))
          ));
          if (allowedCountriesSingle.length === 0) {
            return <p className="text-sm text-slate-500">
              {conditionalResolution.configured && !conditionalResolution.matchedRule
                ? 'No countries are available until a conditional rule matches.'
                : customCountryOptions.length > 0
                  ? 'All available countries are already used in another row.'
                : 'No countries are available.'}
            </p>;
          }
          return (
            <CountryCombobox
              countries={allowedCountriesSingle}
              value={singleValue}
              onChange={(v) => !isFieldDisabled && onChange(v)}
              disabled={isFieldDisabled}
              placeholder={field.placeholder || 'Select a country...'}
              fieldId={field.id}
            />
          );
        }

        // For option-based types (checkbox, radio, picklist, dropdown), require options
        if (customFieldOptions.length === 0) {
          return (
            <p className="text-sm text-slate-500">
              {conditionalResolution.configured && !conditionalResolution.matchedRule
                ? 'No options are available until a conditional rule matches.'
                : 'No options configured for this field.'}
            </p>
          );
        }
        
        // Render based on custom field type
        // Options are objects with {label, value} properties
        if (customFieldDef.field_type === 'checkbox') {
          return (
            <div className="space-y-2">
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-${index}`}
                      checked={(value || []).includes(optValue)}
                      disabled={isFieldDisabled}
                      onCheckedChange={(checked) => {
                        if (isFieldDisabled) return;
                        const currentValues = value || [];
                        if (checked) {
                          onChange([...currentValues, optValue]);
                        } else {
                          onChange(currentValues.filter(v => v !== optValue));
                        }
                      }}
                      data-testid={`checkbox-custom-${field.id}-${index}`}
                    />
                    <Label htmlFor={`${field.id}-${index}`} className="font-normal cursor-pointer">
                      {optLabel}
                    </Label>
                  </div>
                );
              })}
            </div>
          );
        }
        
        if (customFieldDef.field_type === 'radio') {
          return (
            <RadioGroup value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <RadioGroupItem 
                      value={optValue} 
                      id={`${field.id}-${index}`}
                      disabled={isFieldDisabled}
                      data-testid={`radio-custom-${field.id}-${index}`}
                    />
                    <Label htmlFor={`${field.id}-${index}`} className="font-normal cursor-pointer">
                      {optLabel}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          );
        }
        
        // Picklist: multi-select checkbox group
        if (customFieldDef.field_type === 'picklist') {
          const selectedValues = Array.isArray(value) ? value : [];
          const minSelections = customFieldDef.min_selections;
          const maxSelections = customFieldDef.max_selections;
          const hasMin = minSelections != null && minSelections > 0;
          const hasMax = maxSelections != null && maxSelections > 0;
          const isMaxReached = hasMax && selectedValues.length >= maxSelections;
          
          // Build help text
          let helpText = '';
          if (hasMin && hasMax) {
            if (minSelections === maxSelections) {
              helpText = `Please select exactly ${minSelections} option${minSelections > 1 ? 's' : ''}`;
            } else {
              helpText = `Please select between ${minSelections} and ${maxSelections} options`;
            }
          } else if (hasMin) {
            helpText = `Please select at least ${minSelections} option${minSelections > 1 ? 's' : ''}`;
          } else if (hasMax) {
            helpText = `Please select up to ${maxSelections} option${maxSelections > 1 ? 's' : ''}`;
          }
          
          return (
            <div className="space-y-2 p-3 bg-slate-50 rounded-lg border">
              {customFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                const isChecked = selectedValues.includes(optValue);
                // Disable unselected options when max is reached
                const isOptionDisabled = isFieldDisabled || (isMaxReached && !isChecked);
                return (
                  <div key={index} className="flex items-center space-x-2">
                    <Checkbox
                      id={`${field.id}-${index}`}
                      checked={isChecked}
                      disabled={isOptionDisabled}
                      onCheckedChange={(checked) => {
                        if (isOptionDisabled) return;
                        if (checked) {
                          onChange([...selectedValues, optValue]);
                        } else {
                          onChange(selectedValues.filter(v => v !== optValue));
                        }
                      }}
                      data-testid={`checkbox-picklist-${field.id}-${index}`}
                    />
                    <Label 
                      htmlFor={`${field.id}-${index}`} 
                      className={`font-normal cursor-pointer ${isOptionDisabled && !isChecked ? 'text-slate-400' : ''}`}
                    >
                      {optLabel}
                    </Label>
                  </div>
                );
              })}
              {helpText && (
                <p className="text-xs text-slate-500 pt-2 border-t border-slate-200 mt-2">
                  {helpText} ({selectedValues.length} selected)
                </p>
              )}
            </div>
          );
        }
        
        // Default: dropdown/select
        const effectiveCustomFieldOptions = customFieldOptions.filter((option) => {
          const optValue = option.value || option.label || option;
          return optValue && repeatableOptionIsAvailable(optValue);
        });
        if (effectiveCustomFieldOptions.length === 0 && customFieldOptions.length > 0) {
          return <p className="text-sm text-slate-500">
            All available options are already used in another row.
          </p>;
        }
        return (
          <Select value={value || ''} onValueChange={isFieldDisabled ? undefined : onChange} disabled={isFieldDisabled}>
            <SelectTrigger data-testid={`select-custom-field-${field.id}`} className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}>
              <SelectValue placeholder={field.placeholder || 'Select an option'} />
            </SelectTrigger>
            <SelectContent side="bottom">
              {effectiveCustomFieldOptions.map((option, index) => {
                const optValue = option.value || option.label || option;
                const optLabel = option.label || option.value || option;
                return (
                  <SelectItem key={index} value={optValue} data-testid={`option-custom-${field.id}-${index}`}>
                    {optLabel}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        );

      case 'communication_preferences':
        return (
          <CommunicationPreferencesField
            field={field}
            value={value}
            onChange={onChange}
            disabled={isFieldDisabled}
            memberInfo={memberInfo}
            formMemberRoleId={formMemberRoleId}
            communicationEligibilityReady={communicationEligibilityReady}
            conditionalResolution={conditionalResolution}
          />
        );

      case 'list':
        const listValues = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-2">
            {listValues.map((item, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={item}
                  onChange={(e) => {
                    if (isFieldDisabled) return;
                    const newValues = [...listValues];
                    newValues[index] = e.target.value;
                    onChange(newValues);
                  }}
                  placeholder={field.placeholder || 'Enter value...'}
                  disabled={isFieldDisabled}
                  className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : ''}
                  data-testid={`input-list-item-${field.id}-${index}`}
                />
                {!isFieldDisabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const newValues = listValues.filter((_, i) => i !== index);
                      onChange(newValues);
                    }}
                    className="h-9 w-9 text-red-600 hover:text-red-700 hover:bg-red-50"
                    data-testid={`button-remove-list-item-${field.id}-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {!isFieldDisabled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChange([...listValues, ''])}
                className="gap-1"
                data-testid={`button-add-list-item-${field.id}`}
              >
                <Plus className="h-4 w-4" />
                Add Item
              </Button>
            )}
            {listValues.length === 0 && isFieldDisabled && (
              <p className="text-sm text-slate-500">No items added</p>
            )}
          </div>
        );

      case 'country':
        const availableCountries = availableCountryOptions.filter(country => (
          repeatableOptionIsAvailable(country.name)
          || (value === country.code && repeatableOptionIsAvailable(country.code))
        ));
        const defaultCountryName = field.default_country 
          ? (COUNTRIES.find(c => c.code === field.default_country)?.name || '') 
          : '';
        
        return (
          <CountryCombobox
            countries={availableCountries}
            value={value || defaultCountryName}
            onChange={onChange}
            disabled={isFieldDisabled}
            placeholder="Select a country..."
            fieldId={field.id}
            notListedLabel={repeatableOptionIsAvailable(FORM_NOT_LISTED_VALUE)
              ? (notListedDisplayLabel || availableCountryNotListedLabel)
              : ''}
          />
        );

      case 'countries':
        const availableCountriesMulti = availableCountryOptions;
        const defaultCountriesNames = (field.default_countries || [])
          .map(code => COUNTRIES.find(c => c.code === code)?.name)
          .filter(Boolean);
        const countriesValue = Array.isArray(value) && value.length > 0 ? value : defaultCountriesNames;
        
        return (
          <MultiCountryCombobox
            countries={availableCountriesMulti}
            value={countriesValue}
            onChange={onChange}
            disabled={isFieldDisabled}
            placeholder="Select countries..."
            fieldId={field.id}
            notListedLabel={notListedDisplayLabel || availableCountryNotListedLabel}
            isSelectionAllowed={repeatableSelectionIsAvailable}
          />
        );

      case 'contact':
        const contactValue = typeof value === 'object' && value !== null ? value : {};
        
        const contactSubFieldDefaults = {
          firstName: { visible: true, required: true },
          lastName: { visible: true, required: true },
          jobTitle: { visible: true, required: false },
          organisation: { visible: true, required: false },
          email: { visible: true, required: true },
        };
        const contactSubFields = field.contact_sub_fields || contactSubFieldDefaults;
        const getSubFieldConfig = (key) => contactSubFields[key] || contactSubFieldDefaults[key];
        const isSubVisible = (key) => getSubFieldConfig(key).visible !== false;
        const isSubRequired = (key) => field.required && getSubFieldConfig(key).required === true;
        
        const validateContactField = (contactData) => {
          if (!field.required) {
            onValidityChange?.(field.id, true);
            return true;
          }
          const requiredSubs = ['firstName', 'lastName', 'jobTitle', 'organisation', 'email'].filter(k => isSubVisible(k) && isSubRequired(k));
          const isValid = requiredSubs.every(k => !!contactData[k]?.trim());
          onValidityChange?.(field.id, isValid);
          return isValid;
        };
        
        const handleContactChange = (subField, subValue) => {
          const newContactValue = {
            ...contactValue,
            [subField]: subValue
          };
          onChange(newContactValue);
          validateContactField(newContactValue);
        };

        const contactSubFieldDefs = [
          { key: 'firstName', label: 'First name', type: 'text', placeholder: 'First name' },
          { key: 'lastName', label: 'Last name', type: 'text', placeholder: 'Last name' },
          { key: 'jobTitle', label: 'Job title', type: 'text', placeholder: 'Job title' },
          { key: 'organisation', label: 'Organisation', type: 'text', placeholder: 'Organisation' },
          { key: 'email', label: 'Email', type: 'email', placeholder: 'Email address' },
        ];
        const visibleSubFields = contactSubFieldDefs.filter(sf => isSubVisible(sf.key));
        if (visibleSubFields.length === 0) return null;
        const topRowFields = visibleSubFields.filter(sf => sf.key === 'firstName' || sf.key === 'lastName');
        const restFields = visibleSubFields.filter(sf => sf.key !== 'firstName' && sf.key !== 'lastName');
        
        return (
          <div 
            className="space-y-4 p-4 bg-slate-50 border border-slate-200 rounded-lg"
            data-testid={`contact-field-${field.id}`}
          >
            {topRowFields.length > 0 && (
              <div className={`grid grid-cols-1 ${topRowFields.length > 1 ? 'sm:grid-cols-2' : ''} gap-4`}>
                {topRowFields.map(sf => (
                  <div key={sf.key} className="space-y-1.5">
                    <Label htmlFor={`${field.id}-${sf.key}`} className="text-sm">
                      {sf.label}
                      {isSubRequired(sf.key) && <span className="text-red-500 ml-1">*</span>}
                    </Label>
                    <Input
                      id={`${field.id}-${sf.key}`}
                      type={sf.type}
                      value={contactValue[sf.key] || ''}
                      onChange={(e) => handleContactChange(sf.key, e.target.value)}
                      placeholder={sf.placeholder}
                      disabled={isFieldDisabled}
                      className={`${isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}`}
                      data-testid={`input-contact-${sf.key.toLowerCase()}-${field.id}`}
                    />
                  </div>
                ))}
              </div>
            )}
            {restFields.map(sf => (
              <div key={sf.key} className="space-y-1.5">
                <Label htmlFor={`${field.id}-${sf.key}`} className="text-sm">
                  {sf.label}
                  {isSubRequired(sf.key) && <span className="text-red-500 ml-1">*</span>}
                </Label>
                <Input
                  id={`${field.id}-${sf.key}`}
                  type={sf.type}
                  value={contactValue[sf.key] || ''}
                  onChange={(e) => handleContactChange(sf.key, e.target.value)}
                  placeholder={sf.placeholder}
                  disabled={isFieldDisabled}
                  className={isFieldDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}
                  data-testid={`input-contact-${sf.key.toLowerCase()}-${field.id}`}
                />
              </div>
            ))}
          </div>
        );

      case 'grouped_question': {
        const groupedValue = (value && typeof value === 'object') ? value : {};
        const subQuestions = Array.isArray(field.sub_questions) ? field.sub_questions : [];
        const rawMin = Number(field.min_completed);
        const minRequired = Number.isFinite(rawMin)
          ? Math.max(0, Math.min(rawMin, subQuestions.length))
          : subQuestions.length;
        const rawMax = Number(field.max_completed);
        const maxAllowed = Number.isFinite(rawMax)
          ? Math.max(minRequired, Math.min(rawMax, subQuestions.length))
          : subQuestions.length;
        const answeredCount = subQuestions.reduce((count, sq) => {
          const answer = groupedValue[sq.id];
          return count + (typeof answer === 'string' && answer.trim() ? 1 : 0);
        }, 0);

        const groupedHelperText = minRequired === maxAllowed
          ? `Answer exactly ${minRequired} of ${subQuestions.length}`
          : maxAllowed >= subQuestions.length
            ? `Answer at least ${minRequired} of ${subQuestions.length}`
            : `Answer between ${minRequired} and ${maxAllowed} of ${subQuestions.length}`;

        const handleSubQuestionChange = (subId, subValue) => {
          onChange({ ...groupedValue, [subId]: subValue });
        };

        if (subQuestions.length === 0) {
          return (
            <div
              className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500"
              data-testid={`grouped-question-${field.id}`}
            >
              No sub-questions configured.
            </div>
          );
        }

        return (
          <div
            className="space-y-4 p-4 bg-slate-50 border border-slate-200 rounded-lg"
            data-testid={`grouped-question-${field.id}`}
          >
            {(minRequired > 0 || maxAllowed < subQuestions.length) && (
              <p className="text-sm text-slate-500" data-testid={`grouped-question-helper-${field.id}`}>
                {groupedHelperText}
              </p>
            )}
            {subQuestions.map((sq) => {
              const isEmpty = !(typeof groupedValue[sq.id] === 'string' && groupedValue[sq.id].trim());
              const subDisabled = isFieldDisabled || (isEmpty && answeredCount >= maxAllowed);
              return (
                <div key={sq.id} className="space-y-1.5">
                  <Label htmlFor={`${field.id}-${sq.id}`} className="text-sm">
                    {sq.label || 'Untitled question'}
                  </Label>
                  <Textarea
                    id={`${field.id}-${sq.id}`}
                    value={groupedValue[sq.id] || ''}
                    onChange={(e) => handleSubQuestionChange(sq.id, e.target.value)}
                    placeholder={sq.placeholder || ''}
                    disabled={subDisabled}
                    rows={3}
                    className={subDisabled ? 'bg-slate-100 cursor-not-allowed opacity-60' : 'bg-white'}
                    data-testid={`textarea-grouped-${field.id}-${sq.id}`}
                  />
                </div>
              );
            })}
          </div>
        );
      }

      case 'repeatable_rows':
        return renderRepeatableRows();

      case 'instructions':
        return null;

      case 'image':
        return null;

      case 'signature':
        return (
          <SignatureField
            fieldId={field.id}
            value={value?.data || value}
            onChange={onChange}
            disabled={isFieldDisabled}
            required={field.required}
            label={field.label}
          />
        );

      case 'membership_payment':
        return (
          <MembershipPaymentField
            value={value}
            onChange={onChange}
            disabled={isFieldDisabled}
            field={field}
            allFormValues={allFormValues}
          />
        );

      // Task #3483: generic Payment field. The actual payment UI replaces
      // the Submit button (FormPaymentSubmit); here we render an
      // informational summary card showing the derived amount.
      case 'payment': {
        const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac', AUD: 'A$', NZD: 'NZ$' };
        const cur = (field.payment_currency || 'GBP').toUpperCase();
        let raw = field.price_field_id ? allFormValues?.[field.price_field_id] : null;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = raw.amount ?? raw.value ?? null;
        if (typeof raw === 'string') raw = raw.replace(/[^0-9.\-]/g, '');
        const amt = Number(raw);
        const derived = Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : 0;
        // Task #3498: when a conditional membership rule matches, the real
        // amount is the server-derived membership fee — never the (usually
        // absent) price-source answer.
        const mq = membershipFeeQuote;
        const useQuote = !!mq?.matched;
        const quoteAmount = useQuote && mq.quote?.required !== false ? Number(mq.quote?.amount) : null;
        const displayCur = (useQuote && mq.quote?.currency) ? mq.quote.currency.toUpperCase() : cur;
        const amount = useQuote ? (Number.isFinite(quoteAmount) ? quoteAmount : null) : derived;
        const membership = useQuote ? (mq.quote?.membership || null) : null;
        return (
          <div className="border rounded-md p-4 bg-slate-50 space-y-1" data-testid={`payment-summary-${field.id}`}>
            <p className="text-sm font-medium">{field.payment_label || 'Payment'}</p>
            {field.payment_description && (
              <p className="text-xs text-slate-500">{field.payment_description}</p>
            )}
            {useQuote && mq.loading ? (
              <p className="text-sm text-slate-500" data-testid={`payment-summary-amount-${field.id}`}>
                Calculating the amount due…
              </p>
            ) : useQuote && mq.error ? (
              <p className="text-sm text-red-600" data-testid={`payment-summary-amount-${field.id}`}>
                {mq.error}
              </p>
            ) : (
              <p className="text-sm">
                Amount due:{' '}
                <span className="font-semibold" data-testid={`payment-summary-amount-${field.id}`}>
                  {`${symbols[displayCur] || displayCur + ' '}${(amount ?? 0).toFixed(2)}`}
                </span>
              </p>
            )}
            {membership && (
              <p className="text-xs text-slate-500" data-testid={`payment-summary-membership-${field.id}`}>
                {[membership.config_name, membership.tier_label, membership.membership_year].filter(Boolean).join(' — ')}
              </p>
            )}
            <p className="text-xs text-slate-500">You'll be asked to pay when you submit this form.</p>
          </div>
        );
      }

      default:
        return <p className="text-sm text-slate-500">Unsupported field type: {field.type}</p>;
    }
  };

  const renderNotListedText = () => {
    if (!hasNotListedSelection) return null;
    const invalid = !notListedText.trim()
      || notListedText.trim().length > FORM_NOT_LISTED_TEXT_MAX_LENGTH;
    return (
      <div className="space-y-1">
        <Label htmlFor={`${field.id}-not-listed-text`}>Please specify</Label>
        <Input
          id={`${field.id}-not-listed-text`}
          type="text"
          value={notListedText}
          onChange={event => onFormNotListedTextChange?.(event.target.value)}
          required
          maxLength={FORM_NOT_LISTED_TEXT_MAX_LENGTH}
          disabled={isFieldDisabled}
          aria-invalid={invalid}
          data-testid={`input-not-listed-text-${field.id}`}
        />
      </div>
    );
  };

  const renderFieldWithNotListedText = () => (
    <>
      {renderField()}
      {renderNotListedText()}
    </>
  );

  if (field.type === 'image_buttons') {
    const imageOptions = imageButtonOptions;
    return (
      <div className="space-y-2">
        {field.label && (
          <div>
            <Label>{field.label}</Label>
            {field.description && (
              <p className="text-sm text-slate-500 mt-1">{field.description}</p>
            )}
          </div>
        )}
        <div 
          className="flex flex-wrap gap-3 justify-center"
          data-testid={`image-buttons-${field.id}`}
        >
          {imageOptions.map((option, idx) => {
            const isSelected = value === option.value;
            return (
              <button
                key={idx}
                type="button"
                disabled={isFieldDisabled}
                onClick={() => {
                  if (!isFieldDisabled) {
                    onChange(option.value);
                  }
                }}
                className={cn(
                  "relative flex flex-col items-center gap-2 p-2 rounded-md border-2 transition-all cursor-pointer",
                  "hover-elevate active-elevate-2",
                  "flex-1 min-w-[100px] max-w-[200px]",
                  isSelected 
                    ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200" 
                    : "border-slate-200 bg-white",
                  isFieldDisabled && "opacity-50 cursor-not-allowed"
                )}
                data-testid={`image-button-${field.id}-${idx}`}
              >
                {isSelected && (
                  <div className="absolute top-1 right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center z-10">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}
                {option.image_url ? (
                  <img 
                    src={option.image_url} 
                    alt={option.label || `Option ${idx + 1}`}
                    className="w-full h-24 object-cover rounded"
                  />
                ) : (
                  <div className="w-full h-24 bg-slate-100 rounded flex items-center justify-center text-slate-400 text-xs">
                    No image
                  </div>
                )}
                {option.label && (
                  <span className={cn(
                    "text-xs font-medium text-center",
                    isSelected ? "text-blue-700" : "text-slate-600"
                  )}>
                    {option.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === 'image') {
    return (
      <div 
        className="w-full rounded-lg overflow-hidden"
        data-testid={`image-display-${field.id}`}
      >
        {field.image_url ? (
          <img 
            src={field.image_url} 
            alt={field.image_alt || ''} 
            className="w-full rounded-lg"
            style={{ 
              maxHeight: `${field.image_max_height || 300}px`,
              objectFit: field.image_fit || 'cover'
            }}
          />
        ) : (
          <div className="flex items-center justify-center p-8 bg-slate-100 border border-slate-200 rounded-lg text-slate-400 text-sm">
            No image configured
          </div>
        )}
      </div>
    );
  }

  if (field.type === 'instructions') {
    // Conditional logic "set value" rules can override the displayed content by
    // writing rich-text HTML into this field's live value. When an active rule
    // targets this instructions field, render its content; otherwise fall back
    // to the originally authored field.content.
    const overrideContent = typeof value === 'string' && value.trim() !== '' ? value : null;
    const rawContent = overrideContent ?? field.content ?? '<p>No instructions provided.</p>';
    const sanitizedContent = DOMPurify.sanitize(rawContent);
    return (
      <div 
        className="prose prose-sm max-w-none p-4 bg-blue-50 border border-blue-200 rounded-lg"
        data-testid={`instructions-${field.id}`}
      >
        {field.label && (
          <h4 className="text-sm font-semibold text-blue-900 mb-2">{field.label}</h4>
        )}
        <div 
          className="text-blue-800 [&>p]:mb-2 [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4"
          dangerouslySetInnerHTML={{ __html: sanitizedContent }}
        />
      </div>
    );
  }

  if (hideLabel) {
    return renderFieldWithNotListedText();
  }

  return (
    <div className="space-y-2">
      <div>
        <Label htmlFor={field.id}>
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
        </Label>
        {field.description && (
          <p className="text-sm text-slate-500 mt-1">{field.description}</p>
        )}
      </div>
      {renderFieldWithNotListedText()}
    </div>
  );
}