import { Badge } from "@/components/ui/badge";

// Historical identity comes only from saved evidence, not today's matching config.
export default function HistoricalStructureLabel({ record }) {
  const text = value => typeof value === 'string' ? value.trim() : '';
  const snapshot = record.commitment_snapshot;
  // This offline proposal source copied a classification, not a purchased structure.
  // Its approved persistence paths clear/omit the snapshot; don't elevate it if encountered.
  const classificationOnly = snapshot?.source === 'bnms_five_member_reconstruction_v1';
  const structure = (!classificationOnly && (text(snapshot?.structure_name)
    || text(snapshot?.config?.name)
    || text(record.reconstructed_structure_name))) || '';
  const classification = text(record.tier_label)
    || text(snapshot?.pricing?.tier_label)
    || text(snapshot?.tier_label)
    || (classificationOnly ? text(snapshot?.structure_name) : '');
  return (
    <>
      <Badge variant="secondary">
        {structure
          ? `${structure}${classification && classification !== structure ? ` · ${classification}` : ''}`
          : 'Structure unknown'}
      </Badge>
      {!structure && classification && (
        <div className="text-xs text-muted-foreground mt-1">
          Recorded tier / classification: {classification}
        </div>
      )}
      {!structure && record.config_id && (
        <div className="text-xs text-muted-foreground mt-1">
          Recorded structure ID: {record.config_id} (name not recorded)
        </div>
      )}
    </>
  );
}
