import React from "react";
import { COUNTRIES } from "@/data/countries";
import CustomFieldFileUpload from "@/components/CustomFieldFileUpload";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { arrayValue, optionValues } from "./recordHelpers";

const normalizedFileValue = (value) => {
  const file = Array.isArray(value) ? value[0] : value;
  if (!file || typeof file !== "object" || file.file_url) return file;
  return { ...file, file_url: file.url || file.path, file_name: file.name };
};

function MultiValueControl({ field, value, onChange, countries = false }) {
  const selected = arrayValue(value);
  const options = countries
    ? (field.all_countries !== false ? COUNTRIES : COUNTRIES.filter((item) => arrayValue(field.selected_countries).includes(item.code))).map((item) => ({ value: item.code, label: item.name }))
    : optionValues(field);
  if (field.field_type === "list")
    return <Textarea value={selected.join("\n")} onChange={(event) => onChange(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} placeholder="One value per line" />;
  return <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">{options.map((option) => <label key={option.value} className="flex items-center gap-2 text-sm"><Checkbox checked={selected.includes(option.value)} onCheckedChange={(checked) => onChange(checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />{option.label}</label>)}</div>;
}

export function RecordFieldControl({ field, value, onChange, disabled = false }) {
  const type = field.field_type;
  if (type === "file") return <CustomFieldFileUpload fieldId={field.id} formId={field.custom_object_id} value={normalizedFileValue(value)} onChange={onChange} allowedTypes={field.allowed_file_types} publicAccess={field.public_access} disabled={disabled} />;
  if (type === "textarea") return <Textarea disabled={disabled} minLength={field.min_length ?? undefined} maxLength={field.max_length ?? undefined} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />;
  if (["picklist", "countries", "list"].includes(type)) return <MultiValueControl field={field} value={value} onChange={onChange} countries={type === "countries"} />;
  if (type === "boolean") return <div className="flex items-center gap-2"><Switch disabled={disabled} checked={value === true || value === "true"} onCheckedChange={onChange} /><span className="text-sm">{value === true || value === "true" ? "Yes" : "No"}</span></div>;
  if (["dropdown", "country"].includes(type)) {
    const options = type === "country" ? (field.all_countries !== false ? COUNTRIES : COUNTRIES.filter((item) => arrayValue(field.selected_countries).includes(item.code))).map((item) => ({ value: item.code, label: item.name })) : optionValues(field);
    return <Select disabled={disabled} value={value || undefined} onValueChange={onChange}><SelectTrigger><SelectValue placeholder="Choose an option" /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
  }
  return <Input disabled={disabled} type={type === "email" ? "email" : type === "url" ? "url" : type === "date" ? "date" : ["number", "decimal"].includes(type) ? "number" : "text"} step={type === "decimal" ? "any" : type === "number" ? "1" : undefined} minLength={field.min_length ?? undefined} maxLength={field.max_length ?? undefined} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />;
}