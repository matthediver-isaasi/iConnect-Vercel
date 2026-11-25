import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import { formatCost } from "./membershipCost";

export function addonLineTotal(line) {
  const unit = parseFloat(line.unitCost);
  const qty = parseFloat(line.quantity);
  if (!isFinite(unit) || !isFinite(qty)) return 0;
  return Math.round(unit * qty * 100) / 100;
}

export function summarizeAddonLines(lines, membershipSettings) {
  let subtotal = 0;
  let vat = 0;
  for (const line of lines) {
    const total = addonLineTotal(line);
    subtotal += total;
    const rate = line.type === 'training_fund'
      ? (membershipSettings?.training_fund_vat_rate?.effectiveRate ?? 0)
      : (line.vatRate?.effectiveRate ?? 0);
    vat += Math.round(total * (parseFloat(rate) || 0)) / 100;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  vat = Math.round(vat * 100) / 100;
  return { subtotal, vat, total: Math.round((subtotal + vat) * 100) / 100 };
}

export function addonLinesAreValid(lines) {
  return lines.every(line => {
    const unit = parseFloat(line.unitCost);
    const qty = parseFloat(line.quantity);
    if (!isFinite(unit) || unit <= 0 || !isFinite(qty) || qty <= 0) return false;
    return !!String(line.description || '').trim();
  });
}

export function serializeAddonLines(lines, membershipSettings) {
  return lines.map(line => ({
    type: line.type,
    description: String(line.description || '').trim(),
    nominalCode: line.type === 'training_fund' ? (membershipSettings?.training_fund_nominal_code || null) : (line.nominalCode || null),
    vatRate: line.type === 'training_fund' ? (membershipSettings?.training_fund_vat_rate || null) : (line.vatRate || null),
    unitCost: parseFloat(line.unitCost),
    quantity: parseFloat(line.quantity),
  }));
}

// Shared invoice add-on line editor (fee approval and year replacement).
export default function MembershipAddonLinesEditor({
  lines, setLines, membershipSettings, addonVatRates = [], currency,
  allowTrainingFund = true, testIdPrefix = "",
}) {
  const updateAddonLine = (index, patch) => {
    setLines(prev => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };
  return (
    <>
      {lines.length > 0 && (
        <div className="space-y-3">
          {lines.map((line, index) => (
            <div key={index} className="p-3 rounded-md border space-y-3" data-testid={`${testIdPrefix}addon-line-${index}`}>
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline">
                  {line.type === 'training_fund' ? 'Training Fund top-up' : 'Add-on'}
                </Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setLines(prev => prev.filter((_, i) => i !== index))}
                  data-testid={`${testIdPrefix}button-remove-addon-${index}`}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Description</Label>
                <Input
                  value={line.description}
                  onChange={(e) => updateAddonLine(index, { description: e.target.value })}
                  data-testid={`${testIdPrefix}input-addon-description-${index}`}
                />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Unit cost (ex VAT)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.unitCost}
                    onChange={(e) => updateAddonLine(index, { unitCost: e.target.value })}
                    data-testid={`${testIdPrefix}input-addon-unit-cost-${index}`}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Quantity</Label>
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={line.quantity}
                    onChange={(e) => updateAddonLine(index, { quantity: e.target.value })}
                    data-testid={`${testIdPrefix}input-addon-quantity-${index}`}
                  />
                </div>
                {line.type === 'training_fund' ? (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">Nominal code</Label>
                      <Input value={membershipSettings?.training_fund_nominal_code || ''} disabled readOnly />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">VAT rate</Label>
                      <Input value={membershipSettings?.training_fund_vat_rate?.name || 'Provider default'} disabled readOnly />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">Nominal code</Label>
                      <Input
                        value={line.nominalCode || ''}
                        onChange={(e) => updateAddonLine(index, { nominalCode: e.target.value })}
                        placeholder="Default"
                        data-testid={`${testIdPrefix}input-addon-nominal-${index}`}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">VAT rate</Label>
                      <Select
                        value={line.vatRate?.taxType || 'none'}
                        onValueChange={(value) => {
                          if (value === 'none') {
                            updateAddonLine(index, { vatRate: null });
                          } else {
                            const rate = addonVatRates.find(r => r.taxType === value);
                            updateAddonLine(index, { vatRate: rate ? { taxType: rate.taxType, name: rate.name, effectiveRate: rate.effectiveRate } : null });
                          }
                        }}
                      >
                        <SelectTrigger data-testid={`${testIdPrefix}select-addon-vat-${index}`}>
                          <SelectValue placeholder="VAT rate" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Provider default</SelectItem>
                          {addonVatRates.map((rate) => (
                            <SelectItem key={rate.taxType} value={rate.taxType}>
                              {rate.name}{rate.effectiveRate != null ? ` (${rate.effectiveRate}%)` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}
              </div>
              <div className="flex justify-end text-sm">
                <span className="text-muted-foreground mr-2">Line total (ex VAT):</span>
                <span className="font-medium" data-testid={`${testIdPrefix}text-addon-line-total-${index}`}>{formatCost(addonLineTotal(line), currency)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {allowTrainingFund && membershipSettings?.addon_training_fund_enabled && (
          <Button
            size="sm"
            variant="outline"
            disabled={lines.some(l => l.type === 'training_fund')}
            onClick={() => setLines(prev => ([...prev, {
              type: 'training_fund',
              description: 'Training Fund top-up',
              unitCost: '',
              quantity: '1',
            }]))}
            data-testid={`${testIdPrefix}button-add-training-fund-line`}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add Training Fund top-up
          </Button>
        )}
        {membershipSettings?.addon_freeform_enabled && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLines(prev => ([...prev, {
              type: 'freeform',
              description: '',
              nominalCode: '',
              vatRate: null,
              unitCost: '',
              quantity: '1',
            }]))}
            data-testid={`${testIdPrefix}button-add-freeform-line`}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add line item
          </Button>
        )}
      </div>

    </>
  );
}
