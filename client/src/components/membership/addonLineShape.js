// Approved lines are stored snake_case (unit_cost, nominal_code, vat_rate);
// accept camelCase too so either shape opens ready to preview.
export function toEditorLine(line) {
  const unitCost = line.unit_cost ?? line.unitCost;
  return {
    type: line.type || "freeform",
    description: line.description || "",
    nominalCode: line.nominal_code ?? line.nominalCode ?? "",
    vatRate: line.vat_rate ?? line.vatRate ?? null,
    unitCost: unitCost != null ? String(unitCost) : "",
    quantity: line.quantity != null ? String(line.quantity) : "1",
  };
}
