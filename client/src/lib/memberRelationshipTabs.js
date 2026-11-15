import { labelForSide } from "../pages/customObjects/relationshipHelpers.js";

// These relationships remain available as CRM layout cards, not duplicate tabs.
const cardOnlyLabels = new Set([
  "organisation departments",
  "secondary organisation assignments",
  "historical membership records",
]);

export function memberRelationshipTabs(panels) {
  return panels.filter(({ definition, side }) => {
    const label = String(labelForSide(definition, side) || "")
      .trim().toLowerCase().replace(/organization/g, "organisation").replace(/\s+/g, " ");
    return !cardOnlyLabels.has(label);
  });
}
