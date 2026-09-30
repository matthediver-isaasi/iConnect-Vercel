import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

// Task #3601: organisation-group record layout, mirroring useOrgDetailLayout
// under its own SystemSettings key.
const LAYOUT_SETTING_KEY = 'org_group_detail_layout_config';

const DEFAULT_LAYOUT = {
  cards: [
    {
      id: 'card-details',
      title: 'Group Details',
      columns: 1,
      fields: [
        { id: 'core:name', type: 'core', fieldKey: 'name', columnIndex: 0 },
        { id: 'core:description', type: 'core', fieldKey: 'description', columnIndex: 0 },
        { id: 'core:created_at', type: 'core', fieldKey: 'created_at', columnIndex: 0 }
      ]
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

  return {
    ...layout,
    cards: layout.cards.map(card => ({
      ...card,
      fields: card.fields.map((field, idx) => ({
        ...field,
        columnIndex: field.columnIndex !== undefined ? field.columnIndex : (idx % card.columns)
      }))
    }))
  };
}

export const GROUP_CORE_FIELDS = [
  { id: 'core:name', fieldKey: 'name', label: 'Group Name', type: 'text' },
  { id: 'core:description', fieldKey: 'description', label: 'Description', type: 'textarea' },
  { id: 'core:created_at', fieldKey: 'created_at', label: 'Created Date', type: 'date' }
];

export function useGroupDetailLayout({ enabled = true } = {}) {
  const queryClient = useQueryClient();

  const { data: layoutData, isLoading } = useQuery({
    queryKey: ['org-group-detail-layout'],
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
          description: 'Organisation group detail view layout configuration'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-group-detail-layout'] });
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

export function mergeGroupLayoutWithCustomFields(layout, customFields) {
  if (!layout || !layout.cards) return DEFAULT_LAYOUT;

  const existingCustomFieldIds = new Set();
  layout.cards.forEach(card => {
    card.fields.forEach(f => {
      if (f.type === 'custom') {
        existingCustomFieldIds.add(f.fieldId);
      }
    });
  });

  const unassignedCustomFields = customFields.filter(cf => !existingCustomFieldIds.has(cf.id));

  if (unassignedCustomFields.length === 0) return layout;

  const updatedCards = [...layout.cards];
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

  return { ...layout, cards: updatedCards };
}
