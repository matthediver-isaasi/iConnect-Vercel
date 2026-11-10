// Shared rendered regressions for the personal and organisation ledgers.
export const historyStructureFixtures = [
  { id: 'proposal-only', commitment_snapshot: { source: 'bnms_five_member_reconstruction_v1', structure_name: 'LMIC Membership' }, expected: 'Structure unknownRecorded tier / classification: LMIC Membership' },
  { id: 'legacy-label', tier_label: 'LMIC Membership', expected: 'Structure unknownRecorded tier / classification: LMIC Membership' },
  { id: 'absent', expected: 'Structure unknown' },
  { id: 'blank', tier_label: ' ', commitment_snapshot: { structure_name: ' ' }, expected: 'Structure unknown' },
  { id: 'saved', tier_label: 'Flat Rate', commitment_snapshot: { structure_name: 'Purchased structure' }, expected: 'Purchased structure · Flat Rate' },
  { id: 'retired', tier_label: 'Flat Rate', config_id: 'old-config', commitment_snapshot: { config: { id: 'old-config', name: 'Retired structure' } }, expected: 'Retired structure · Flat Rate' },
  { id: 'id-only', config_id: 'config', expected: 'Structure unknownRecorded structure ID: config (name not recorded)' },
  { id: 'reconstructed-name', reconstructed_structure_name: 'Approved reconstructed structure', expected: 'Approved reconstructed structure' },
];
