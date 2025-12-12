import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

const LAYOUT_SETTING_KEY = 'org_detail_layout_config';

const DEFAULT_LAYOUT = {
  cards: [
    {
      id: 'card-details',
      title: 'Organisation Details',
      columns: 1,
      fields: [
        { id: 'core:name', type: 'core', fieldKey: 'name' },
        { id: 'core:description', type: 'core', fieldKey: 'description' }
      ]
    },
    {
      id: 'card-contact',
      title: 'Contact Information',
      columns: 2,
      fields: [
        { id: 'core:invoicing_email', type: 'core', fieldKey: 'invoicing_email' },
        { id: 'core:phone', type: 'core', fieldKey: 'phone' },
        { id: 'core:website_url', type: 'core', fieldKey: 'website_url' },
        { id: 'core:invoicing_address', type: 'core', fieldKey: 'invoicing_address' }
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

export const CORE_FIELDS = [
  { id: 'core:name', fieldKey: 'name', label: 'Organisation Name', type: 'text' },
  { id: 'core:description', fieldKey: 'description', label: 'Description', type: 'textarea' },
  { id: 'core:invoicing_email', fieldKey: 'invoicing_email', label: 'Invoicing Email', type: 'email' },
  { id: 'core:phone', fieldKey: 'phone', label: 'Phone', type: 'text' },
  { id: 'core:website_url', fieldKey: 'website_url', label: 'Website', type: 'url' },
  { id: 'core:invoicing_address', fieldKey: 'invoicing_address', label: 'Invoicing Address', type: 'textarea' }
];

export function useOrgDetailLayout() {
  const queryClient = useQueryClient();

  const { data: layoutData, isLoading } = useQuery({
    queryKey: ['org-detail-layout'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === LAYOUT_SETTING_KEY);
      
      let parsedConfig = DEFAULT_LAYOUT;
      if (setting?.setting_value) {
        try {
          parsedConfig = JSON.parse(setting.setting_value);
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
          description: 'Organisation detail view layout configuration'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-detail-layout'] });
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

export function mergeLayoutWithCustomFields(layout, customFields) {
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
  updatedCards[cardIndex] = {
    ...customCard,
    fields: [
      ...customCard.fields,
      ...unassignedCustomFields.map(cf => ({
        id: `custom:${cf.id}`,
        type: 'custom',
        fieldId: cf.id
      }))
    ]
  };

  return { ...layout, cards: updatedCards };
}
