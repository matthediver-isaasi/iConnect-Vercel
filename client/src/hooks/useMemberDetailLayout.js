import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import {
  ensureMemberMandateLayoutFields,
  MEMBER_MANDATE_LAYOUT_FIELDS,
} from "@/lib/memberMandateLayout";

const LAYOUT_SETTING_KEY = 'member_detail_layout_config';
export const DEFAULT_RELATIONSHIP_DISPLAY_MODE = 'columns';

export function normalizeRelationshipDisplayMode(value) {
  return value === 'cards' ? 'cards' : DEFAULT_RELATIONSHIP_DISPLAY_MODE;
}

const DEFAULT_LAYOUT = {
  cards: [
    {
      id: 'card-contact',
      title: 'Contact Information',
      columns: 2,
      fields: [
        { id: 'core:first_name', type: 'core', fieldKey: 'first_name', columnIndex: 0 },
        { id: 'core:last_name', type: 'core', fieldKey: 'last_name', columnIndex: 1 },
        { id: 'core:email', type: 'core', fieldKey: 'email', columnIndex: 0 },
        { id: 'core:mobile', type: 'core', fieldKey: 'mobile', columnIndex: 1 },
        { id: 'core:landline', type: 'core', fieldKey: 'landline', columnIndex: 0 },
        { id: 'core:job_title', type: 'core', fieldKey: 'job_title', columnIndex: 1 }
      ]
    },
    {
      id: 'card-biography',
      title: 'Biography',
      columns: 1,
      fields: [
        { id: 'core:biography', type: 'core', fieldKey: 'biography', columnIndex: 0 }
      ]
    },
    {
      id: 'card-direct-debit',
      title: 'Direct Debit',
      columns: 2,
      fields: MEMBER_MANDATE_LAYOUT_FIELDS.map((field, index) => ({
        ...field,
        columnIndex: index
      }))
    },
    {
      id: 'card-custom',
      title: 'Custom Fields',
      columns: 2,
      fields: []
    }
  ]
};

function migrateLayoutWithColumnIndex(layout) {
  if (!layout || !layout.cards) return DEFAULT_LAYOUT;
  
  return ensureMemberMandateLayoutFields({
    ...layout,
    cards: layout.cards.map(card => ({
      ...card,
      fields: card.fields.map((field, idx) => ({
        ...field,
        columnIndex: field.columnIndex !== undefined ? field.columnIndex : (idx % card.columns),
        ...(field.type === 'relationship'
          ? { displayMode: normalizeRelationshipDisplayMode(field.displayMode ?? field.display_mode) }
          : {})
      }))
    }))
  });
}

export const MEMBER_CORE_FIELDS = [
  { id: 'core:first_name', fieldKey: 'first_name', label: 'First Name', type: 'text' },
  { id: 'core:last_name', fieldKey: 'last_name', label: 'Last Name', type: 'text' },
  { id: 'core:email', fieldKey: 'email', label: 'Email', type: 'email' },
  { id: 'core:mobile', fieldKey: 'mobile', label: 'Mobile', type: 'text' },
  { id: 'core:landline', fieldKey: 'landline', label: 'Landline', type: 'text' },
  { id: 'core:job_title', fieldKey: 'job_title', label: 'Job Title', type: 'text' },
  { id: 'core:biography', fieldKey: 'biography', label: 'Biography', type: 'textarea' },
  { id: 'core:gocardless_mandate_id', fieldKey: 'gocardless_mandate_id', label: 'GoCardless Mandate ID', type: 'text', readOnly: true, derived: true },
  { id: 'core:gocardless_mandate_status', fieldKey: 'gocardless_mandate_status', label: 'GoCardless Mandate Status', type: 'text', readOnly: true, derived: true }
];

export function memberRelationshipLayoutId(definitionId, side) {
  return `relationship:${definitionId}:${side}`;
}

export function memberRelationshipLayoutElements(panels = []) {
  return panels.map(({ definition, side }) => ({
    id: memberRelationshipLayoutId(definition.id, side),
    type: 'relationship',
    definitionId: definition.id,
    side,
    displayMode: DEFAULT_RELATIONSHIP_DISPLAY_MODE,
  }));
}

export function useMemberDetailLayout({ enabled = true } = {}) {
  const queryClient = useQueryClient();

  const { data: layoutData, isLoading } = useQuery({
    queryKey: ['member-detail-layout'],
    enabled,
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === LAYOUT_SETTING_KEY);
      
      let parsedConfig = DEFAULT_LAYOUT;
      if (setting?.setting_value) {
        try {
          parsedConfig = migrateLayoutWithColumnIndex(JSON.parse(setting.setting_value));
        } catch {
          parsedConfig = DEFAULT_LAYOUT;
        }
      }
      
      return {
        config: parsedConfig,
        record: setting || null
      };
    }
  });

  const saveLayoutMutation = useMutation({
    mutationFn: async (newLayout) => {
      const layoutJson = JSON.stringify(newLayout);
      const settingRecord = layoutData?.record;
      
      if (settingRecord?.id) {
        return await base44.entities.SystemSettings.update(settingRecord.id, {
          setting_value: layoutJson
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: LAYOUT_SETTING_KEY,
          setting_value: layoutJson,
          description: 'Member detail view layout configuration'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-detail-layout'] });
    }
  });

  return {
    layoutConfig: layoutData?.config || DEFAULT_LAYOUT,
    isLoading,
    saveLayout: saveLayoutMutation.mutateAsync,
    isSaving: saveLayoutMutation.isPending,
    DEFAULT_LAYOUT
  };
}

const RIGHT_COLUMN_FIELD_KEYS = new Set([
  'organization_id', 'role_id', 'login_enabled', 'show_in_directory', 'created_on'
]);

export function mergeLayoutWithCustomFields(layout, customFields, relationshipPanels = null) {
  if (!layout || !layout.cards) return DEFAULT_LAYOUT;
  const availableRelationshipIds = relationshipPanels === null
    ? null
    : new Set(memberRelationshipLayoutElements(relationshipPanels).map(element => element.id));

  const filteredLayout = {
    ...layout,
    cards: layout.cards
      .map(card => ({
        ...card,
        fields: card.fields.filter(f =>
          !(f.type === 'core' && RIGHT_COLUMN_FIELD_KEYS.has(f.fieldKey))
          && (
            f.type !== 'relationship'
            || availableRelationshipIds === null
            || availableRelationshipIds.has(f.id)
          )
        ).map(f => f.type === 'relationship'
          ? { ...f, displayMode: normalizeRelationshipDisplayMode(f.displayMode ?? f.display_mode) }
          : f)
      }))
      .filter(card => card.fields.length > 0 || card.id === 'card-custom')
  };
  
  const existingCustomFieldIds = new Set();
  filteredLayout.cards.forEach(card => {
    card.fields.forEach(f => {
      if (f.type === 'custom') {
        existingCustomFieldIds.add(f.fieldId);
      }
    });
  });

  const unassignedCustomFields = customFields.filter(cf => !existingCustomFieldIds.has(cf.id));
  
  if (unassignedCustomFields.length === 0) return filteredLayout;

  const updatedCards = [...filteredLayout.cards];
  let customCard = updatedCards.find(c => c.id === 'card-custom');
  
  if (!customCard) {
    customCard = {
      id: 'card-custom',
      title: 'Custom Fields',
      columns: 2,
      fields: []
    };
    updatedCards.push(customCard);
  }

  const cardIndex = updatedCards.findIndex(c => c.id === customCard.id);
  const existingFieldCount = customCard.fields.length;
  updatedCards[cardIndex] = {
    ...customCard,
    fields: [
      ...customCard.fields,
      ...unassignedCustomFields.map((cf, idx) => ({
        id: `custom:${cf.id}`,
        type: 'custom',
        fieldId: cf.id,
        columnIndex: (existingFieldCount + idx) % customCard.columns
      }))
    ]
  };

  return { ...filteredLayout, cards: updatedCards };
}
