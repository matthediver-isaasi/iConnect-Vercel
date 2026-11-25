import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { formatCost, getCurrencySymbol } from "./membershipCost";

// Shared structure / manual price / discount override controls. Used by the
// year override dialog and the Replace membership year dialog.
export default function MembershipOverrideControls({
  overrideType, setOverrideType,
  selectedConfigId, setSelectedConfigId,
  manualPrice, setManualPrice,
  discountType, setDiscountType,
  discountValue, setDiscountValue,
  availableConfigs, configsLoading,
  currency, overrideTargetData = null,
  idPrefix = "", testIdPrefix = "",
}) {
  return (
    <>
      <div className="space-y-3">
        <Label className="text-sm font-medium">Override Type</Label>
        <RadioGroup
          value={overrideType}
          onValueChange={(val) => {
            setOverrideType(val);
            setSelectedConfigId('');
            setManualPrice('');
            setDiscountType('percentage');
            setDiscountValue('');
          }}
          data-testid={`${testIdPrefix}radio-override-type`}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="structure" id={`${idPrefix}override-structure`} data-testid={`${testIdPrefix}radio-structure`} />
            <Label htmlFor={`${idPrefix}override-structure`} className="text-sm cursor-pointer">
              Use a different tier structure
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="price" id={`${idPrefix}override-price`} data-testid={`${testIdPrefix}radio-price`} />
            <Label htmlFor={`${idPrefix}override-price`} className="text-sm cursor-pointer">
              Set a manual price
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="discount" id={`${idPrefix}override-discount`} data-testid={`${testIdPrefix}radio-discount`} />
            <Label htmlFor={`${idPrefix}override-discount`} className="text-sm cursor-pointer">
              Set a discount override
            </Label>
          </div>
        </RadioGroup>
      </div>

      {overrideType === 'structure' && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Select Tier Structure</Label>
          {configsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading structures...
            </div>
          ) : (
            <Select value={selectedConfigId} onValueChange={setSelectedConfigId}>
              <SelectTrigger data-testid={`${testIdPrefix}select-config`}>
                <SelectValue placeholder="Choose a tier structure..." />
              </SelectTrigger>
              <SelectContent>
                {availableConfigs?.map((cfg) => (
                  <SelectItem key={cfg.id} value={cfg.id} data-testid={`option-config-${cfg.id}`}>
                    {cfg.name || 'Unnamed'} (from {cfg.effective_from})
                    {cfg.effective_to ? ` to ${cfg.effective_to}` : ' - Current'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {selectedConfigId && availableConfigs && (
            <div className="p-2 bg-muted/50 rounded-md">
              <p className="text-xs text-muted-foreground mb-1">Bands in selected structure:</p>
              <div className="space-y-0.5">
                {availableConfigs
                  .find(c => c.id === selectedConfigId)
                  ?.bands?.map((band) => (
                    <div key={band.id} className="flex items-center justify-between text-xs">
                      <span>{band.label} ({band.min_value}{band.max_value !== null ? `-${band.max_value}` : '+'})</span>
                      <span>{formatCost(band.annual_cost, currency)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {overrideType === 'price' && (
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}manual-price`} className="text-sm font-medium">
            Manual Price ({getCurrencySymbol(currency)})
          </Label>
          <Input
            id={`${idPrefix}manual-price`}
            type="number"
            min="0"
            step="0.01"
            value={manualPrice}
            onChange={(e) => setManualPrice(e.target.value)}
            placeholder="Enter price..."
            data-testid={`${testIdPrefix}input-manual-price`}
          />
          {overrideTargetData && (
            <p className="text-xs text-muted-foreground">
              Auto-calculated price: {formatCost(
                overrideTargetData.originalAnnualCost ?? overrideTargetData.finalCost,
                currency
              )}
            </p>
          )}
        </div>
      )}

      {overrideType === 'discount' && (
        <div className="space-y-3">
          <Label className="text-sm font-medium">Discount Type</Label>
          <RadioGroup
            value={discountType}
            onValueChange={(val) => {
              setDiscountType(val);
              setDiscountValue('');
            }}
            data-testid={`${testIdPrefix}radio-discount-type`}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="percentage" id={`${idPrefix}discount-percentage`} data-testid={`${testIdPrefix}radio-discount-percentage`} />
              <Label htmlFor={`${idPrefix}discount-percentage`} className="text-sm cursor-pointer">
                Percentage (%)
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="fixed" id={`${idPrefix}discount-fixed`} data-testid={`${testIdPrefix}radio-discount-fixed`} />
              <Label htmlFor={`${idPrefix}discount-fixed`} className="text-sm cursor-pointer">
                Fixed amount ({getCurrencySymbol(currency)})
              </Label>
            </div>
          </RadioGroup>

          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}discount-value`} className="text-sm font-medium">
              {discountType === 'percentage' ? 'Discount Percentage' : `Discount Amount (${getCurrencySymbol(currency)})`}
            </Label>
            <Input
              id={`${idPrefix}discount-value`}
              type="number"
              min="0"
              max={discountType === 'percentage' ? '100' : undefined}
              step={discountType === 'percentage' ? '0.1' : '0.01'}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              placeholder={discountType === 'percentage' ? 'e.g. 10' : 'e.g. 100.00'}
              data-testid={`${testIdPrefix}input-discount-value`}
            />
          </div>

          {overrideTargetData && discountValue && (
            <div className="p-2 bg-muted/50 rounded-md">
              <p className="text-xs text-muted-foreground">
                {(() => {
                  const gross = overrideTargetData.annualCostBeforeDiscounts ?? overrideTargetData.annualCost;
                  const val = parseFloat(discountValue) || 0;
                  const discountAmt = discountType === 'percentage'
                    ? parseFloat((gross * val / 100).toFixed(2))
                    : Math.min(val, gross);
                  const net = Math.max(0, gross - discountAmt);
                  return `Gross: ${formatCost(gross, currency)} - Discount: ${formatCost(discountAmt, currency)} = Net: ${formatCost(net, currency)}`;
                })()}
              </p>
            </div>
          )}
        </div>
      )}

    </>
  );
}
