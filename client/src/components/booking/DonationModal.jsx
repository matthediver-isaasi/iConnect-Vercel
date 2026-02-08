import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Heart, Gift, MapPin, CheckCircle2 } from "lucide-react";

export default function DonationModal({
  open,
  onOpenChange,
  donationConfig,
  currency = 'GBP',
  onConfirm,
  onSkip
}) {
  const [selectedAmount, setSelectedAmount] = useState(null);
  const [customAmount, setCustomAmount] = useState('');
  const [giftAid, setGiftAid] = useState(false);
  const [giftAidAddress1, setGiftAidAddress1] = useState('');
  const [giftAidAddress2, setGiftAidAddress2] = useState('');
  const [giftAidCity, setGiftAidCity] = useState('');
  const [giftAidPostcode, setGiftAidPostcode] = useState('');

  const currencySymbol = currency === 'GBP' ? '\u00a3' : currency === 'USD' ? '$' : currency === 'EUR' ? '\u20ac' : currency + ' ';
  const presetAmounts = donationConfig?.preset_amounts || [5, 10, 25, 50];
  const allowCustomAmount = donationConfig?.allow_custom_amount !== false;
  const customMessage = donationConfig?.custom_message || '';

  const donationAmount = selectedAmount || parseFloat(customAmount) || 0;
  const giftAidBonus = giftAid ? donationAmount * 0.25 : 0;

  const isGiftAidValid = !giftAid || (giftAidAddress1.trim() && giftAidCity.trim() && giftAidPostcode.trim());
  const canConfirm = donationAmount > 0 && isGiftAidValid;

  const handleConfirm = () => {
    const donationData = {
      amount: donationAmount,
      gift_aid: giftAid,
      gift_aid_address: giftAid ? {
        address_line_1: giftAidAddress1.trim(),
        address_line_2: giftAidAddress2.trim(),
        city: giftAidCity.trim(),
        postcode: giftAidPostcode.trim()
      } : null
    };
    onConfirm(donationData);
  };

  const handleSkip = () => {
    onSkip();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Heart className="w-5 h-5 text-pink-600" />
            Would you like to make a donation?
          </DialogTitle>
          {customMessage && (
            <DialogDescription className="text-sm pt-2">
              {customMessage}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-5 pt-2">
          <div className="space-y-3">
            <Label className="text-sm font-medium">Select an amount</Label>
            <div className="grid grid-cols-3 gap-2">
              {presetAmounts.map((amount) => (
                <Button
                  key={amount}
                  type="button"
                  variant={selectedAmount === amount ? 'default' : 'outline'}
                  className={selectedAmount === amount ? 'ring-2 ring-pink-300' : ''}
                  onClick={() => {
                    setSelectedAmount(amount);
                    setCustomAmount('');
                  }}
                  data-testid={`button-donation-amount-${amount}`}
                >
                  {currencySymbol}{amount}
                </Button>
              ))}
            </div>

            {allowCustomAmount && (
              <div className="space-y-1.5">
                <Label htmlFor="custom-donation-amount" className="text-xs text-muted-foreground">
                  Or enter a custom amount
                </Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    {currencySymbol}
                  </span>
                  <Input
                    id="custom-donation-amount"
                    type="number"
                    min="1"
                    step="0.01"
                    placeholder="0.00"
                    value={customAmount}
                    onChange={(e) => {
                      setCustomAmount(e.target.value);
                      setSelectedAmount(null);
                    }}
                    className="pl-7"
                    data-testid="input-custom-donation-amount"
                  />
                </div>
              </div>
            )}
          </div>

          {donationAmount > 0 && (
            <div className="space-y-4 pt-3 border-t">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="gift-aid-toggle" className="flex items-center gap-1.5">
                    <Gift className="w-4 h-4 text-green-600" />
                    Boost your donation with Gift Aid
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Add 25% to your donation at no cost to you. You must be a UK taxpayer.
                  </p>
                </div>
                <Switch
                  id="gift-aid-toggle"
                  checked={giftAid}
                  onCheckedChange={setGiftAid}
                  data-testid="switch-donation-gift-aid"
                />
              </div>

              {giftAid && (
                <div className="space-y-4 p-4 bg-green-50 dark:bg-green-950/20 rounded-lg border border-green-200 dark:border-green-800">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    <p className="text-xs text-green-800 dark:text-green-300">
                      I confirm I am a UK taxpayer and understand that if I pay less Income Tax and/or Capital Gains Tax
                      in the current tax year than the amount of Gift Aid claimed on all my donations, it is my responsibility
                      to pay any difference.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      Your address is required for HMRC Gift Aid claims
                    </p>
                    <div className="space-y-2">
                      <Input
                        placeholder="Address line 1 *"
                        value={giftAidAddress1}
                        onChange={(e) => setGiftAidAddress1(e.target.value)}
                        data-testid="input-donation-gift-aid-address1"
                      />
                      <Input
                        placeholder="Address line 2"
                        value={giftAidAddress2}
                        onChange={(e) => setGiftAidAddress2(e.target.value)}
                        data-testid="input-donation-gift-aid-address2"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          placeholder="City / Town *"
                          value={giftAidCity}
                          onChange={(e) => setGiftAidCity(e.target.value)}
                          data-testid="input-donation-gift-aid-city"
                        />
                        <Input
                          placeholder="Postcode *"
                          value={giftAidPostcode}
                          onChange={(e) => setGiftAidPostcode(e.target.value)}
                          data-testid="input-donation-gift-aid-postcode"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {donationAmount > 0 && (
            <div className="p-3 bg-pink-50 dark:bg-pink-950/20 border border-pink-200 dark:border-pink-800 rounded-lg">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Your donation</span>
                <span className="font-semibold">{currencySymbol}{donationAmount.toFixed(2)}</span>
              </div>
              {giftAid && (
                <div className="flex items-center justify-between text-sm mt-1">
                  <span className="text-green-600">Gift Aid (25%)</span>
                  <span className="font-semibold text-green-600">+ {currencySymbol}{giftAidBonus.toFixed(2)}</span>
                </div>
              )}
              {giftAid && (
                <div className="flex items-center justify-between text-sm mt-1 pt-1 border-t border-pink-200 dark:border-pink-800">
                  <span className="font-medium">Total impact</span>
                  <span className="font-bold">{currencySymbol}{(donationAmount + giftAidBonus).toFixed(2)}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleSkip}
              className="flex-1"
              data-testid="button-skip-donation"
            >
              No thanks
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="flex-1 bg-gradient-to-r from-pink-500 to-rose-500 hover:from-pink-600 hover:to-rose-600 text-white"
              data-testid="button-confirm-donation"
            >
              <Heart className="w-4 h-4 mr-1.5" />
              Donate {donationAmount > 0 ? `${currencySymbol}${donationAmount.toFixed(2)}` : ''}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
