export const MEMBER_MANDATE_LAYOUT_FIELDS = [
  {
    id: 'core:gocardless_mandate_id',
    type: 'core',
    fieldKey: 'gocardless_mandate_id',
  },
  {
    id: 'core:gocardless_mandate_status',
    type: 'core',
    fieldKey: 'gocardless_mandate_status',
  },
];

/**
 * Keep the derived mandate fields visible for both new and previously saved
 * member layouts. Existing placements win; only missing fields are appended.
 */
export function ensureMemberMandateLayoutFields(layout) {
  if (!layout?.cards) return layout;

  const assignedIds = new Set(
    layout.cards.flatMap(card => (card.fields || []).map(field => field.id)),
  );
  const missingFields = MEMBER_MANDATE_LAYOUT_FIELDS.filter(field => !assignedIds.has(field.id));
  if (!missingFields.length) return layout;

  const cards = layout.cards.map(card => ({
    ...card,
    fields: [...(card.fields || [])],
  }));
  let cardIndex = cards.findIndex(card => card.id === 'card-direct-debit');
  if (cardIndex === -1) {
    cards.push({
      id: 'card-direct-debit',
      title: 'Direct Debit',
      columns: 2,
      fields: [],
    });
    cardIndex = cards.length - 1;
  }

  const card = cards[cardIndex];
  cards[cardIndex] = {
    ...card,
    fields: [
      ...card.fields,
      ...missingFields.map((field, index) => ({
        ...field,
        columnIndex: (card.fields.length + index) % (card.columns || 2),
      })),
    ],
  };
  return { ...layout, cards };
}