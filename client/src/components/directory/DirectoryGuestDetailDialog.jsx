import { useState } from "react";
import { Building2, User, Briefcase, ClipboardList, ChevronUp, ChevronDown } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import RoleBadge from "@/components/RoleBadge";
import { CustomFieldFileDisplay } from "@/components/CustomFieldFileUpload";
import { DirectoryContactValue } from "./DirectoryContactValue";
import OrganisationDirectoryCoreRow, { organisationDirectoryCoreValue } from "./OrganisationDirectoryCoreRow";
import { safeLogoSrc } from "@/lib/safeLogoSrc";
import {
  getDirectoryOrderedFields, resolveBackFieldOrder, ORG_BACK_DEFAULT_ORDER,
  MEMBER_BACK_DEFAULT_ORDER, isVisibleOnBack, isFieldVisibleOnBackFor,
  hasDirectoryFieldValue, resolveCustomFieldsLabel,
} from "@/utils/directorySettings";
import { ORG_PUBLICATION_FIELDS } from "../../../../shared/organisationDirectoryCore.js";

function displayFieldValue(field, value) {
  if (field.field_type === "picklist" && value) {
    let values = value;
    if (!Array.isArray(values)) {
      try { values = JSON.parse(values); } catch { values = [values]; }
    }
    if (Array.isArray(values)) return values.map(v => field.options?.find(o => o.value === v)?.label || v).join(", ");
  }
  if (field.field_type === "dropdown" && value) return field.options?.find(o => o.value === value)?.label || value;
  if (field.field_type === "boolean") return value === true || value === "true" ? "Yes" : "No";
  if (field.field_type === "date" && value) return new Date(value).toLocaleDateString();
  return value;
}

function CustomValue({ field, value, organization }) {
  const content = field.field_type === "file"
    ? <CustomFieldFileDisplay value={value} fieldId={`directory-${organization ? "org" : "popup"}-${field.id}`} />
    : <DirectoryContactValue field={field} value={value}>{String(displayFieldValue(field, value) ?? "") || <span className="text-slate-400 italic">Not set</span>}</DirectoryContactValue>;
  return organization ? (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-4">
      <span className="text-sm text-slate-600 break-words">{field._displayLabel || field.label}</span>
      <div className="min-w-0 text-sm font-medium text-slate-900 text-left break-words">{content}</div>
    </div>
  ) : (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-200" data-testid={`popup-custom-field-${field.id}`}>
      <p className="text-xs font-medium text-slate-500 mb-1">{field._displayLabel || field.label}</p>
      <div className="text-sm text-slate-900 break-words">{content}</div>
    </div>
  );
}

// The guest branch of the canonical directory dialog is shared with Canvas.
// This component deliberately has no authenticated contacts, statistics, object
// sources, email actions or generic entity fetching. Values must already be
// projected by the selected directory's public/config API.
export function DirectoryGuestDetailBody({
  record, entityType, directory = {}, displaySettings = {}, fields = [], values = {},
  organization, customFieldsLabel,
}) {
  const [bioExpanded, setBioExpanded] = useState(false);
  const isOrganization = entityType === "organization";
  const orderedFields = getDirectoryOrderedFields(fields, isOrganization ? null : displaySettings);
  const fieldById = new Map(orderedFields.map(field => [String(field.id), field]));
  const order = resolveBackFieldOrder({
    directoryOrder: directory?.back_field_order,
    tenantOrder: isOrganization ? displaySettings?.backFieldOrder : displaySettings?.back_field_order,
    defaultOrder: isOrganization ? ORG_BACK_DEFAULT_ORDER : MEMBER_BACK_DEFAULT_ORDER,
    customFields: orderedFields,
  });
  const sections = [];
  let customBatch = [];
  const flushCustom = () => {
    if (!customBatch.length) return;
    sections.push(
      <div key={`customs-${sections.length}`} className={isOrganization ? "space-y-3 pt-2 border-t" : "space-y-3 pt-4 border-t border-slate-200"}>
        {isOrganization ? (
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-blue-600" />
            <h4 className="font-medium text-slate-900">{customFieldsLabel}</h4>
          </div>
        ) : <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">{customFieldsLabel}</h3>}
        <div className={isOrganization ? "space-y-3" : "grid grid-cols-1 sm:grid-cols-2 gap-3"}>{customBatch}</div>
      </div>,
    );
    customBatch = [];
  };
  for (const key of order) {
    if (key.startsWith("custom:")) {
      const field = fieldById.get(key.slice(7));
      if (!field) continue;
      if (isOrganization ? field._visBack === false : !isFieldVisibleOnBackFor(field, displaySettings)) continue;
      if (!isOrganization && !hasDirectoryFieldValue(field, values[field.id])) continue;
      customBatch.push(<CustomValue key={key} field={field} value={values[field.id]} organization={isOrganization} />);
      continue;
    }
    let node = null;
    if (isOrganization && ORG_PUBLICATION_FIELDS.some(field => field.key === key)) {
      if (organisationDirectoryCoreValue(record, key) !== null) {
        node = <OrganisationDirectoryCoreRow key={key} organization={record} fieldKey={key} />;
      }
    } else if (!isOrganization && key === "show_organization" && organization && isVisibleOnBack(displaySettings, key)) {
      node = (
        <div key={key} className="bg-slate-50 rounded-lg p-4 border border-slate-200">
          <div className="flex items-center gap-2 text-slate-700">
            <Building2 className="w-5 h-5 text-blue-600" /><span className="font-semibold">{organization.name}</span>
          </div>
        </div>
      );
    } else if (!isOrganization && key === "show_bio_in_popup" && record.biography && isVisibleOnBack(displaySettings, key)) {
      node = (
        <div key={key} className="bg-slate-50 rounded-lg p-4 border border-slate-200 space-y-2">
          <p className="text-xs font-medium text-slate-500">About</p>
          <p className={`text-sm text-slate-900 leading-relaxed ${bioExpanded ? "" : "line-clamp-4"}`}>{record.biography}</p>
          {record.biography.length > 300 && (
            <Button variant="ghost" size="sm" onClick={() => setBioExpanded(!bioExpanded)} className="text-blue-600 hover:text-blue-700 p-0 h-auto font-medium">
              {bioExpanded ? <><ChevronUp className="w-4 h-4 mr-1" />Show less</> : <><ChevronDown className="w-4 h-4 mr-1" />Read more</>}
            </Button>
          )}
        </div>
      );
    }
    if (node) { flushCustom(); sections.push(node); }
  }
  flushCustom();
  return <>{sections}</>;
}

export default function DirectoryGuestDetailDialog({
  record, onClose, entityType, directory = {}, displaySettings = {}, fields = [],
  values = {}, roles = [], organization, loading = false, error, onRetry,
}) {
  const isOrganization = entityType === "organization";
  const logo = safeLogoSrc(record?.logo_url);
  const role = roles.find(item => item.id === record?.role_id);
  const customFieldsLabel = resolveCustomFieldsLabel(directory?.custom_fields_label,
    isOrganization ? displaySettings?.customFieldsLabel : displaySettings?.custom_fields_label);
  return (
    <Dialog open={!!record} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} className={isOrganization ? "sm:max-w-lg max-h-[90dvh] overflow-y-auto" : "max-w-2xl max-h-[90dvh] overflow-y-auto"}>
        <DialogHeader>
          {isOrganization ? (
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center flex-shrink-0">
                {logo ? <img src={logo} alt={record?.name} className="w-full h-full object-contain" /> : <Building2 className="w-8 h-8 text-slate-400" />}
              </div>
              <DialogTitle className="text-xl">{record?.name}</DialogTitle>
            </div>
          ) : <DialogTitle className="sr-only">Member Information</DialogTitle>}
        </DialogHeader>
        {record && (
          <div className={isOrganization ? "space-y-4 py-4" : "space-y-6"}>
            {!isOrganization && (
              <div className="flex items-start gap-6">
                <div className="flex-shrink-0">
                  {isVisibleOnBack(displaySettings, "show_profile_photo") && record.profile_photo_url ? (
                    <img src={record.profile_photo_url} alt={`${record.first_name} ${record.last_name}`} className="w-24 h-24 rounded-full object-cover border-4 border-slate-200" />
                  ) : <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center border-4 border-slate-200"><User className="w-12 h-12 text-blue-600" /></div>}
                </div>
                <div className="flex-1">
                  <h2 className="text-2xl font-bold text-slate-900 mb-2">{record.first_name} {record.last_name}</h2>
                  {isVisibleOnBack(displaySettings, "show_job_title") && record.job_title && (
                    <div className="flex items-center gap-2 text-slate-600 mb-3"><Briefcase className="w-4 h-4" /><span>{record.job_title}</span></div>
                  )}
                  {role && <RoleBadge role={role} />}
                </div>
              </div>
            )}
            {loading ? <div aria-busy="true" aria-label="Loading directory details" className="space-y-3"><div className="h-6 rounded bg-slate-100 animate-pulse" /><div className="h-16 rounded bg-slate-100 animate-pulse" /></div>
              : error ? <div role="alert" className="space-y-3"><p>Couldn't load directory details.</p><Button variant="outline" onClick={onRetry}>Retry</Button></div>
              : <DirectoryGuestDetailBody key={record.id} {...{ record, entityType, directory, displaySettings, fields, values, organization, customFieldsLabel }} />}
          </div>
        )}
        {isOrganization && <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
