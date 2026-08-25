import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Building2, Pencil, Trash2, ChevronLeft, ExternalLink, Loader2,
  Save, X, LayoutGrid, Settings2, Lock, ClipboardList, ChevronDown, ChevronUp,
  Calendar, ExternalLink as ExternalLinkIcon
} from "lucide-react";
import { toast } from "sonner";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { useGroupDetailLayout, mergeGroupLayoutWithCustomFields, GROUP_CORE_FIELDS } from "@/hooks/useGroupDetailLayout";
import { useGroupFieldVisibilityRules, evaluateVisibilityRules } from "@/hooks/useGroupFieldVisibilityRules";
import { useDateFormat } from "@/hooks/useDateFormat";
import { COUNTRIES } from "@/data/countries";
import OrgDetailLayoutEditor from "@/components/OrgDetailLayoutEditor";
import OrgFieldVisibilityRulesEditor from "@/components/OrgFieldVisibilityRulesEditor";
import { ListFieldEditorOrg, OrgCountryMultiSelect } from "@/components/OrganisationDetailView";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RelatedRecordsPanel, useRelatedRecordDefinitions } from "@/pages/customObjects/RelatedRecordsPanel";
import { labelForSide, relationshipTabValue } from "@/pages/customObjects/relationshipHelpers";

const EMPTY_ARR = [];

const MULTI_VALUE_TYPES = new Set(['picklist', 'list', 'countries']);

function parseStoredValue(field, raw) {
  if (MULTI_VALUE_TYPES.has(field?.field_type) && raw) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(v => String(v).trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return raw;
}

/**
 * Task #3601: CRM-style record view for an Organisation Group, mirroring the
 * organisation detail experience — configurable card layout, custom fields
 * with diff-and-upsert save, visibility/lock rules, and linked organisations.
 */
export default function OrganisationGroupDetailView({ group, orgs = EMPTY_ARR, onBack, onEdit, onDelete }) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '' });
  const [customFieldValues, setCustomFieldValues] = useState({});
  const [showLayoutEditor, setShowLayoutEditor] = useState(false);
  const [showRulesEditor, setShowRulesEditor] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({});
  const { formatDate } = useDateFormat();

  const groupId = group?.id;
  const relatedRecords = useRelatedRecordDefinitions({
    context: { kind: "organization_group", recordId: groupId },
    enabled: !!groupId,
  });

  // Custom field definitions scoped to organisation groups.
  const { data: groupCustomFields = EMPTY_ARR } = useQuery({
    queryKey: ['group-custom-fields'],
    queryFn: async () => {
      const fields = await base44.entities.PreferenceField.list({
        filter: { entity_scope: 'organization_group' },
        sort: { display_order: 'asc' }
      });
      return (fields || []).filter(f => f.entity_scope === 'organization_group');
    }
  });

  // Stored values for this group.
  const { data: groupValues = EMPTY_ARR } = useQuery({
    queryKey: ['org-group-detail-preference-values', groupId],
    enabled: !!groupId,
    queryFn: async () => {
      const values = await base44.entities.OrganizationGroupPreferenceValue.list({
        filter: { organization_group_id: groupId }
      });
      return (values || []).filter(v => v.organization_group_id === groupId);
    }
  });

  useRealtimeSubscription('organization_group_preference_value', [
    ['org-group-detail-preference-values', groupId]
  ], { enabled: !!groupId });

  const { layoutConfig, saveLayout, isSaving: isLayoutSaving } = useGroupDetailLayout();
  const { rulesConfig, saveRules, isSaving: isRulesSaving } = useGroupFieldVisibilityRules();

  const mergedLayout = mergeGroupLayoutWithCustomFields(layoutConfig, groupCustomFields);

  // Sync form + values from server state whenever not editing.
  useEffect(() => {
    if (isEditing) return;
    setFormData({
      name: group?.name || '',
      description: group?.description || ''
    });
    const valuesMap = {};
    groupValues.forEach(pv => {
      const field = groupCustomFields.find(f => f.id === pv.field_id);
      valuesMap[pv.field_id] = parseStoredValue(field, pv.value);
    });
    setCustomFieldValues(valuesMap);
  }, [group, groupValues, groupCustomFields, isEditing]);

  const upsertValue = async ({ fieldId, value }) => {
    const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
    const res = await fetch('/api/entities/organization-group-preference-value/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        organization_group_id: groupId,
        field_id: fieldId,
        value: storedValue
      })
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to save custom field');
    }
    return res.json();
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!formData.name?.trim()) {
        throw new Error('Group name is required');
      }
      // Core fields.
      await base44.entities.OrganizationGroup.update(groupId, {
        name: formData.name.trim(),
        description: formData.description?.trim() || null
      });
      // Custom fields: diff against stored values, upsert only changes.
      for (const [fieldId, value] of Object.entries(customFieldValues)) {
        const newStored = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
        const existing = groupValues.find(v => v.field_id === fieldId);
        const existingStored = existing?.value ?? '';
        if (newStored !== existingStored) {
          await upsertValue({ fieldId, value });
        }
      }
    },
    onSuccess: () => {
      toast.success('Group updated');
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ['/api/entities/OrganizationGroup'] });
      queryClient.invalidateQueries({ queryKey: ['org-group-detail-preference-values', groupId] });
      // Invalidate the list-level values cache so the Groups list reflects the
      // newly saved values in its columns and filter results immediately.
      queryClient.invalidateQueries({ queryKey: ['org-groups-all-preference-values'] });
    },
    onError: (e) => toast.error(e.message || 'Failed to save group')
  });

  const handleCancel = () => {
    setIsEditing(false);
    setFormData({ name: group?.name || '', description: group?.description || '' });
    const valuesMap = {};
    groupValues.forEach(pv => {
      const field = groupCustomFields.find(f => f.id === pv.field_id);
      valuesMap[pv.field_id] = parseStoredValue(field, pv.value);
    });
    setCustomFieldValues(valuesMap);
  };

  const toggleSection = (cardId) => {
    setCollapsedSections(prev => ({ ...prev, [cardId]: !prev[cardId] }));
  };

  const { hiddenFields, hiddenCards, lockedFields, lockedCards } = evaluateVisibilityRules(
    rulesConfig,
    { ...formData, custom_field_values: customFieldValues },
    groupCustomFields
  );

  const renderCoreField = (fieldKey, isLocked = false) => {
    const coreFieldDef = GROUP_CORE_FIELDS.find(f => f.fieldKey === fieldKey);
    if (!coreFieldDef) return null;
    const label = coreFieldDef.label;
    const lockBadge = isLocked && isEditing ? (
      <Lock className="w-3 h-3 text-slate-400" data-testid={`lock-icon-${fieldKey}`} />
    ) : null;

    if (fieldKey === 'created_at') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 flex items-center gap-1">
            <Calendar className="w-3 h-3" /> {label}
          </Label>
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {formatDate(group?.created_at)}
          </div>
        </div>
      );
    }

    if (fieldKey === 'description') {
      return (
        <div className="space-y-2">
          <Label className="text-slate-500 min-h-5 flex items-center gap-1">{label}{lockBadge}</Label>
          {isEditing ? (
            <Textarea
              value={formData.description || ''}
              onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
              rows={3}
              disabled={isLocked}
              data-testid="textarea-group-detail-description"
            />
          ) : (
            <div className="min-h-[80px] px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 text-slate-700">
              {formData.description || 'No description provided'}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <Label className="text-slate-500 flex items-center gap-1">{label}{lockBadge}</Label>
        {isEditing ? (
          <Input
            value={formData[fieldKey] || ''}
            onChange={(e) => setFormData(prev => ({ ...prev, [fieldKey]: e.target.value }))}
            disabled={isLocked}
            data-testid={`input-group-detail-${fieldKey}`}
          />
        ) : (
          <div className={`min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center ${fieldKey === 'name' ? 'font-medium' : ''}`}>
            {formData[fieldKey] || '-'}
          </div>
        )}
      </div>
    );
  };

  const renderFieldEditor = (field, isLocked = false) => {
    const value = customFieldValues[field.id];
    const disabledOverride = !isEditing || isLocked;
    const setVal = (v) => setCustomFieldValues(prev => ({ ...prev, [field.id]: v }));

    switch (field.field_type) {
      case 'textarea':
      case 'long_text':
        return (
          <Textarea
            value={value || ''}
            onChange={(e) => setVal(e.target.value)}
            disabled={disabledOverride}
            rows={3}
            data-testid={`textarea-group-custom-${field.id}`}
          />
        );
      case 'number':
      case 'decimal':
        return (
          <Input
            type="number"
            step={field.field_type === 'decimal' ? '0.01' : '1'}
            value={value || ''}
            onChange={(e) => setVal(e.target.value)}
            disabled={disabledOverride}
            data-testid={`input-group-custom-${field.id}`}
          />
        );
      case 'dropdown':
        return (
          <Select
            value={value || ''}
            onValueChange={(v) => setVal(v === '__clear__' ? '' : v)}
            disabled={disabledOverride}
          >
            <SelectTrigger data-testid={`select-group-custom-${field.id}`}>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__clear__" className="text-muted-foreground italic">None (clear selection)</SelectItem>
              {(field.options || []).map((opt, idx) => (
                <SelectItem key={idx} value={opt.value}>{opt.label || opt.value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'picklist': {
        const selectedValues = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-2">
            {(field.options || []).map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Checkbox
                  checked={selectedValues.includes(opt.value)}
                  onCheckedChange={(checked) => {
                    if (disabledOverride) return;
                    const newValues = checked
                      ? [...selectedValues, opt.value]
                      : selectedValues.filter(v => v !== opt.value);
                    setVal(newValues);
                  }}
                  disabled={disabledOverride}
                  data-testid={`checkbox-group-custom-${field.id}-${opt.value}`}
                />
                <span className="text-sm">{opt.label || opt.value}</span>
              </div>
            ))}
          </div>
        );
      }
      case 'country': {
        const availableCountries = field.all_countries !== false
          ? COUNTRIES
          : COUNTRIES.filter(c => {
              const sel = Array.isArray(field.selected_countries) ? field.selected_countries : [];
              return sel.includes(c.code) || sel.includes(c.name);
            });
        const resolvedValue = (() => {
          if (!value) return '';
          const byCode = COUNTRIES.find(c => c.code === value);
          return byCode ? byCode.name : value;
        })();
        return isEditing ? (
          <Select
            value={resolvedValue}
            onValueChange={(v) => setVal(v === '__clear__' ? '' : v)}
            disabled={disabledOverride}
          >
            <SelectTrigger data-testid={`select-group-custom-country-${field.id}`}>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__clear__" className="text-muted-foreground italic">None (clear selection)</SelectItem>
              {availableCountries.map((country) => (
                <SelectItem key={country.code} value={country.name}>{country.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {resolvedValue || '-'}
          </div>
        );
      }
      case 'countries': {
        const selectedCountries = Array.isArray(value) ? value : [];
        const normalizedSelected = selectedCountries.map(v => {
          const byCode = COUNTRIES.find(c => c.code === v);
          return byCode ? byCode.name : v;
        });
        const availableCountriesList = field.all_countries !== false
          ? COUNTRIES
          : COUNTRIES.filter(c => {
              const sel = Array.isArray(field.selected_countries) ? field.selected_countries : [];
              return sel.includes(c.code) || sel.includes(c.name);
            });
        if (!isEditing) {
          return (
            <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
              {normalizedSelected.length > 0 ? normalizedSelected.join(', ') : '-'}
            </div>
          );
        }
        return (
          <OrgCountryMultiSelect
            fieldId={field.id}
            selectedValues={normalizedSelected}
            availableCountries={availableCountriesList}
            onChange={(newValues) => setVal(newValues)}
            label={field.label}
            disabled={isLocked}
          />
        );
      }
      case 'list':
        return (
          <ListFieldEditorOrg
            fieldId={field.id}
            values={Array.isArray(value) ? value : []}
            onChange={(newValues) => setVal(newValues)}
            disabled={disabledOverride}
            placeholder={`Add ${field.label.toLowerCase()}...`}
          />
        );
      case 'boolean':
      case 'checkbox': {
        const isChecked = value === 'true' || value === true;
        return (
          <div className="flex items-center gap-2 min-h-9">
            <Switch
              checked={isChecked}
              onCheckedChange={(checked) => setVal(checked ? 'true' : 'false')}
              disabled={disabledOverride}
              data-testid={`switch-group-custom-${field.id}`}
            />
          </div>
        );
      }
      case 'date':
        return isEditing ? (
          <Input
            type="date"
            value={value || ''}
            onChange={(e) => setVal(e.target.value)}
            disabled={isLocked}
            data-testid={`input-group-custom-date-${field.id}`}
          />
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {formatDate(value) || '-'}
          </div>
        );
      case 'email':
        return isEditing ? (
          <Input
            type="email"
            value={value || ''}
            onChange={(e) => setVal(e.target.value)}
            disabled={isLocked}
            data-testid={`input-group-custom-email-${field.id}`}
          />
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {value ? <a href={`mailto:${value}`} className="text-blue-600 hover:underline">{value}</a> : '-'}
          </div>
        );
      case 'url':
        return isEditing ? (
          <Input
            type="url"
            value={value || ''}
            onChange={(e) => setVal(e.target.value)}
            placeholder="https://"
            disabled={isLocked}
            data-testid={`input-group-custom-url-${field.id}`}
          />
        ) : (
          <div className="min-h-9 px-3 py-2 text-sm border border-slate-200 rounded-md bg-slate-50/50 flex items-center">
            {value ? (
              <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                {value} <ExternalLinkIcon className="w-3 h-3" />
              </a>
            ) : '-'}
          </div>
        );
      default:
        return (
          <Input
            value={value || ''}
            onChange={(e) => setVal(e.target.value)}
            disabled={disabledOverride}
            data-testid={`input-group-custom-${field.id}`}
          />
        );
    }
  };

  const renderLayoutCard = (card) => {
    if (card.fields.length === 0) return null;
    if (hiddenCards.has(card.id)) return null;

    const gridCols = card.columns === 1 ? 'grid-cols-1' : card.columns === 2 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-3';
    const isCardLocked = lockedCards.has(card.id);
    const isCollapsed = collapsedSections[card.id];

    const renderField = (field) => {
      if (hiddenFields.has(field.id)) return null;
      const isFieldLocked = isCardLocked || lockedFields.has(field.id);

      if (field.type === 'core') {
        return <div key={field.id}>{renderCoreField(field.fieldKey, isFieldLocked)}</div>;
      }
      const customField = groupCustomFields.find(cf => cf.id === field.fieldId);
      if (!customField) return null;
      return (
        <div key={field.id} className="space-y-2">
          <Label className="text-slate-500 min-h-5 flex items-center gap-1">
            {customField.label}
            {isFieldLocked && isEditing && (
              <Lock className="w-3 h-3 text-slate-400" data-testid={`lock-icon-group-custom-${customField.id}`} />
            )}
          </Label>
          {renderFieldEditor(customField, isFieldLocked)}
        </div>
      );
    };

    const visibleFields = card.fields.filter(f => !hiddenFields.has(f.id));
    if (visibleFields.length === 0) return null;

    return (
      <Card key={card.id}>
        <CardHeader
          className="cursor-pointer select-none"
          onClick={() => toggleSection(card.id)}
          data-testid={`group-card-header-${card.id}`}
        >
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-blue-600" />
            {card.title}
            <span className="ml-auto">
              {isCollapsed ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronUp className="w-4 h-4 text-slate-400" />}
            </span>
          </CardTitle>
        </CardHeader>
        {!isCollapsed && (
          <CardContent>
            <div className={`grid ${gridCols} gap-4`}>
              {card.fields.map(renderField)}
            </div>
          </CardContent>
        )}
      </Card>
    );
  };

  const memberOrgs = orgs.filter(o => o.organization_group_id === groupId);
  const renderOverview = () => (
    <>
      {mergedLayout.cards.map(renderLayoutCard)}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4 text-blue-600" />
            Organisations in this group ({memberOrgs.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {memberOrgs.length === 0 ? (
            <p className="text-sm text-slate-400">No organisations assigned yet. Assign one from an organisation's detail page.</p>
          ) : (
            <div className="divide-y border rounded-md">
              {memberOrgs.map((o) => (
                <Link
                  key={o.id}
                  to={`/organisations/${o.id}`}
                  className="flex items-center justify-between px-4 py-3 text-sm hover:bg-slate-50"
                  data-testid={`link-group-org-${o.id}`}
                >
                  <span className="font-medium text-slate-700">{o.name}</span>
                  <ExternalLink className="w-4 h-4 text-slate-400" />
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-back-to-groups">
          <ChevronLeft className="w-4 h-4 mr-1" /> All groups
        </Button>
        <div className="flex gap-2">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={handleCancel} data-testid="button-cancel-group-edit">
                <X className="w-4 h-4 mr-1" /> Cancel
              </Button>
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-group-detail">
                {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Save
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowLayoutEditor(true)} data-testid="button-group-layout-editor">
                <LayoutGrid className="w-4 h-4 mr-1" /> Layout
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowRulesEditor(true)} data-testid="button-group-rules-editor">
                <Settings2 className="w-4 h-4 mr-1" /> Rules
              </Button>
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-group">
                <Pencil className="w-4 h-4 mr-1" /> Edit
              </Button>
              {onDelete && (
                <Button variant="outline" size="sm" className="text-red-600" onClick={() => onDelete(group)} data-testid="button-delete-group">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Building2 className="w-6 h-6 text-blue-600" />
        <h1 className="text-2xl font-semibold text-slate-800" data-testid="text-group-detail-name">{group?.name}</h1>
      </div>

      {relatedRecords.panels.length === 0 ? renderOverview() : (
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {relatedRecords.panels.map(({ definition, side, count }) => (
              <TabsTrigger key={`${definition.id}-${side}`} value={relationshipTabValue(definition, side)} data-testid={`tab-relationship-${definition.id}-${side}`}>
                {labelForSide(definition, side)}{count != null ? ` (${count})` : ""}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview" className="space-y-4">{renderOverview()}</TabsContent>
          {relatedRecords.panels.map(({ definition, side }) => (
            <TabsContent key={`${definition.id}-${side}`} value={relationshipTabValue(definition, side)}>
              <RelatedRecordsPanel context={relatedRecords.context} record={group} definition={definition} side={side} showHeading={false} />
            </TabsContent>
          ))}
        </Tabs>
      )}

      {showLayoutEditor && (
        <OrgDetailLayoutEditor
          layout={mergedLayout}
          customFields={groupCustomFields}
          coreFields={GROUP_CORE_FIELDS}
          title="Customize Group Layout"
          onSave={async (newLayout) => {
            await saveLayout(newLayout);
            setShowLayoutEditor(false);
          }}
          onCancel={() => setShowLayoutEditor(false)}
          isSaving={isLayoutSaving}
        />
      )}

      <OrgFieldVisibilityRulesEditor
        open={showRulesEditor}
        onOpenChange={setShowRulesEditor}
        rulesConfig={rulesConfig}
        customFields={groupCustomFields}
        coreFields={GROUP_CORE_FIELDS}
        layoutCards={mergedLayout.cards}
        onSave={saveRules}
        isSaving={isRulesSaving}
      />
    </div>
  );
}
