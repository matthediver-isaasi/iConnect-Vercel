import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Heart, Loader2, CheckCircle2, Users, Target, Gift,
  Clock, ChevronDown, ChevronUp, ArrowRight, MessageSquare
} from "lucide-react";

function formatCurrency(amount, currency) {
  const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac' };
  const symbol = symbols[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

function formatTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function ProgressBar({ percent, height = 'h-2.5' }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className={`relative w-full rounded-full ${height} overflow-hidden`}
         style={{ background: 'linear-gradient(90deg, #ef4444 0%, #f59e0b 40%, #22c55e 100%)' }}>
      <div
        className="absolute top-0 right-0 h-full bg-muted/80 rounded-r-full transition-all duration-700"
        style={{ width: `${100 - clamped}%` }}
      />
      {clamped > 0 && clamped < 100 && (
        <div
          className="absolute top-1/2 -translate-y-1/2 w-1 rounded-full bg-foreground shadow-sm transition-all duration-700"
          style={{ left: `calc(${clamped}% - 2px)`, height: 'calc(100% + 4px)' }}
        />
      )}
    </div>
  );
}

const PRESET_AMOUNTS = [10, 25, 50, 100, 250];

export default function DonatePage() {
  const { token } = useParams();
  const [pageData, setPageData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [step, setStep] = useState('amount');
  const [selectedAmount, setSelectedAmount] = useState(null);
  const [customAmount, setCustomAmount] = useState('');
  const [donorName, setDonorName] = useState('');
  const [donorEmail, setDonorEmail] = useState('');
  const [donorMessage, setDonorMessage] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [giftAid, setGiftAid] = useState(false);
  const [giftAidAddress1, setGiftAidAddress1] = useState('');
  const [giftAidAddress2, setGiftAidAddress2] = useState('');
  const [giftAidCity, setGiftAidCity] = useState('');
  const [giftAidPostcode, setGiftAidPostcode] = useState('');
  const [processing, setProcessing] = useState(false);
  const [donationComplete, setDonationComplete] = useState(false);
  const [showAllDonations, setShowAllDonations] = useState(false);
  const [paymentError, setPaymentError] = useState(null);
  const [updates, setUpdates] = useState([]);
  const [fullSizeImage, setFullSizeImage] = useState(null);

  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/public/fundraising/${token}`)
      .then(res => {
        if (!res.ok) throw new Error('Page not found');
        return res.json();
      })
      .then(data => {
        setPageData(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/public/fundraising/updates?token=${encodeURIComponent(token)}`)
      .then(res => res.ok ? res.json() : [])
      .then(data => setUpdates(data || []))
      .catch(() => {});
  }, [token]);

  const notifyParentResize = () => {
    try {
      window.parent.postMessage({
        type: 'fundraising-resize',
        height: document.body.scrollHeight
      }, '*');
    } catch (e) {}
  };

  useEffect(() => {
    notifyParentResize();
    const observer = new ResizeObserver(notifyParentResize);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [step, showAllDonations, giftAid, donationComplete]);

  const donationAmount = selectedAmount || parseFloat(customAmount) || 0;
  const giftAidBonus = giftAid ? donationAmount * 0.25 : 0;

  const initializeStripe = async (publishableKey) => {
    if (stripeRef.current) return;
    if (!window.Stripe) {
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    stripeRef.current = window.Stripe(publishableKey);
    elementsRef.current = stripeRef.current.elements();
    cardRef.current = elementsRef.current.create('card', {
      style: {
        base: {
          fontSize: '16px',
          color: '#1a1a1a',
          '::placeholder': { color: '#9ca3af' },
          fontFamily: 'system-ui, -apple-system, sans-serif'
        },
        invalid: { color: '#ef4444' }
      }
    });
  };

  useEffect(() => {
    if (step === 'payment' && cardRef.current) {
      const container = document.getElementById('card-element');
      if (container && !container.hasChildNodes()) {
        cardRef.current.mount('#card-element');
      }
    }
  }, [step]);

  const handleContinueToDetails = () => {
    if (donationAmount < 1) return;
    setStep('details');
  };

  const handleContinueToPayment = async () => {
    if (!donorName.trim()) return;
    if (giftAid && (!giftAidAddress1.trim() || !giftAidCity.trim() || !giftAidPostcode.trim())) return;

    setProcessing(true);
    setPaymentError(null);

    try {
      const res = await fetch('/api/public/fundraising/donate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          donor_name: donorName.trim(),
          donor_email: donorEmail.trim() || null,
          donor_message: donorMessage.trim() || null,
          is_anonymous: isAnonymous,
          amount: donationAmount,
          gift_aid: giftAid,
          gift_aid_address_line_1: giftAid ? giftAidAddress1.trim() : null,
          gift_aid_address_line_2: giftAid ? giftAidAddress2.trim() : null,
          gift_aid_city: giftAid ? giftAidCity.trim() : null,
          gift_aid_postcode: giftAid ? giftAidPostcode.trim() : null
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to process donation');
      }

      const { client_secret, publishable_key, donation_id } = await res.json();

      await initializeStripe(publishable_key);
      setStep('payment');
      setProcessing(false);

      window._pendingDonation = { client_secret, donation_id };

      setTimeout(() => {
        if (cardRef.current) {
          const container = document.getElementById('card-element');
          if (container && !container.hasChildNodes()) {
            cardRef.current.mount('#card-element');
          }
        }
      }, 100);

    } catch (err) {
      setPaymentError(err.message);
      setProcessing(false);
    }
  };

  const handlePayment = async () => {
    if (!window._pendingDonation) return;

    setProcessing(true);
    setPaymentError(null);

    try {
      const { client_secret, donation_id } = window._pendingDonation;

      const { error: stripeError, paymentIntent } = await stripeRef.current.confirmCardPayment(
        client_secret,
        {
          payment_method: {
            card: cardRef.current,
            billing_details: {
              name: donorName,
              email: donorEmail || undefined
            }
          }
        }
      );

      if (stripeError) {
        throw new Error(stripeError.message);
      }

      if (paymentIntent.status === 'succeeded') {
        await fetch('/api/public/fundraising/confirm-donation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            donation_id,
            payment_intent_id: paymentIntent.id
          })
        });

        setDonationComplete(true);
        setStep('complete');
      }
    } catch (err) {
      setPaymentError(err.message);
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !pageData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-8 pb-8">
            <Heart className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2">Page Not Found</h2>
            <p className="text-muted-foreground text-sm">
              This donation page may have been removed or the link is incorrect.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { campaign, team_member, progress, recent_donations, other_team_members, tenant } = pageData;

  if (donationComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-green-50 to-background dark:from-green-950/20 dark:to-background p-4">
        <Card className="max-w-md w-full text-center">
          <CardContent className="pt-10 pb-10 space-y-4">
            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-2xl font-bold" data-testid="text-thank-you">Thank You!</h2>
            <p className="text-muted-foreground">
              Your donation of <strong>{formatCurrency(donationAmount, campaign.currency)}</strong> to{' '}
              <strong>{team_member.first_name}</strong>'s fundraiser has been received.
            </p>
            {giftAid && (
              <div className="bg-blue-50 dark:bg-blue-950/20 rounded-md p-3 text-sm text-blue-800 dark:text-blue-300">
                <Gift className="w-4 h-4 inline mr-1" />
                With Gift Aid, your donation is worth{' '}
                <strong>{formatCurrency(donationAmount + giftAidBonus, campaign.currency)}</strong>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {campaign.name}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      {campaign.cover_image_url && (
        <div className="relative h-48 md:h-64 overflow-hidden">
          <img
            src={campaign.cover_image_url}
            alt={campaign.name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
          <div className="absolute bottom-4 left-4 right-4 text-white">
            <h1 className="text-2xl md:text-3xl font-bold drop-shadow-lg" data-testid="text-campaign-name">
              {campaign.name}
            </h1>
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {!campaign.cover_image_url && (
          <div className="text-center pt-4">
            <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-campaign-name-no-img">
              {campaign.name}
            </h1>
          </div>
        )}

        <div className="flex items-center gap-4 p-4 rounded-lg bg-muted/50">
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold text-primary shrink-0">
            {team_member.first_name?.[0]}{team_member.last_name?.[0]}
          </div>
          <div>
            <p className="font-semibold text-lg" data-testid="text-team-member-name">
              {team_member.first_name} {team_member.last_name}
            </p>
            <p className="text-sm text-muted-foreground">is fundraising for this campaign</p>
          </div>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-3xl font-bold text-primary" data-testid="text-total-raised">
                  {formatCurrency(progress.team_total, campaign.currency)}
                </p>
                <p className="text-sm text-muted-foreground">
                  raised of {formatCurrency(progress.goal_amount, campaign.currency)} goal
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold">{progress.percentage}%</p>
                <p className="text-xs text-muted-foreground">
                  {progress.team_donor_count} donation{progress.team_donor_count !== 1 ? 's' : ''}
                </p>
              </div>
            </div>

            <ProgressBar percent={progress.percentage} height="h-4" />

            {team_member.individual_goal && (
              <div className="pt-2 border-t">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Target className="w-3 h-3" />
                    {team_member.first_name}'s personal goal
                  </span>
                  <span className="font-medium">
                    {formatCurrency(progress.member_total, campaign.currency)} of{' '}
                    {formatCurrency(team_member.individual_goal, campaign.currency)}
                  </span>
                </div>
                <div className="mt-2">
                  <ProgressBar percent={Math.min(100, Math.round((progress.member_total / parseFloat(team_member.individual_goal)) * 100))} height="h-2" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {campaign.description && (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{campaign.description}</p>
            </CardContent>
          </Card>
        )}

        <Card className="border-primary/20">
          <CardContent className="pt-6 space-y-6">
            {step === 'amount' && (
              <>
                <h2 className="text-lg font-semibold text-center">Choose your donation amount</h2>
                <div className="grid grid-cols-3 gap-3">
                  {PRESET_AMOUNTS.map(amt => (
                    <Button
                      key={amt}
                      variant={selectedAmount === amt ? 'default' : 'outline'}
                      className={`text-lg py-6 ${selectedAmount === amt ? '' : ''}`}
                      onClick={() => { setSelectedAmount(amt); setCustomAmount(''); }}
                      data-testid={`button-amount-${amt}`}
                    >
                      {formatCurrency(amt, campaign.currency)}
                    </Button>
                  ))}
                  <div className="relative">
                    <Input
                      type="number"
                      min="1"
                      step="0.01"
                      placeholder="Other"
                      value={customAmount}
                      onChange={(e) => { setCustomAmount(e.target.value); setSelectedAmount(null); }}
                      className="h-full text-lg text-center"
                      data-testid="input-custom-amount"
                    />
                  </div>
                </div>
                <Button
                  className="w-full py-6 text-lg"
                  disabled={donationAmount < 1}
                  onClick={handleContinueToDetails}
                  data-testid="button-continue-details"
                >
                  Donate {donationAmount >= 1 ? formatCurrency(donationAmount, campaign.currency) : ''}
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              </>
            )}

            {step === 'details' && (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Your details</h2>
                  <Badge variant="outline" className="text-base">
                    {formatCurrency(donationAmount, campaign.currency)}
                  </Badge>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Your Name *</Label>
                    <Input
                      value={donorName}
                      onChange={(e) => setDonorName(e.target.value)}
                      placeholder="Full name"
                      data-testid="input-donor-name"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Email (for receipt)</Label>
                    <Input
                      type="email"
                      value={donorEmail}
                      onChange={(e) => setDonorEmail(e.target.value)}
                      placeholder="your@email.com"
                      data-testid="input-donor-email"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Leave a message (optional)</Label>
                    <Textarea
                      value={donorMessage}
                      onChange={(e) => setDonorMessage(e.target.value)}
                      placeholder="Add an encouraging message..."
                      rows={2}
                      data-testid="input-donor-message"
                    />
                  </div>

                  {campaign.allow_anonymous_donations && (
                    <div className="flex items-center justify-between p-3 rounded-md bg-muted/50">
                      <Label className="cursor-pointer">Donate anonymously</Label>
                      <Switch
                        checked={isAnonymous}
                        onCheckedChange={setIsAnonymous}
                        data-testid="switch-anonymous"
                      />
                    </div>
                  )}

                  <div className="border rounded-md overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between p-4 hover-elevate"
                      onClick={() => setGiftAid(!giftAid)}
                      data-testid="button-gift-aid-toggle"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${giftAid ? 'bg-blue-100 dark:bg-blue-900/30' : 'bg-muted'}`}>
                          <Gift className={`w-5 h-5 ${giftAid ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="text-left">
                          <p className="font-medium text-sm">
                            Add Gift Aid
                            {giftAid && (
                              <span className="text-blue-600 dark:text-blue-400 ml-1">
                                +{formatCurrency(giftAidBonus, campaign.currency)}
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Worth 25% more at no extra cost to you
                          </p>
                        </div>
                      </div>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${giftAid ? 'border-blue-600 bg-blue-600' : 'border-muted-foreground'}`}>
                        {giftAid && <CheckCircle2 className="w-4 h-4 text-white" />}
                      </div>
                    </button>

                    {giftAid && (
                      <div className="border-t p-4 space-y-4 bg-blue-50/50 dark:bg-blue-950/10">
                        <div className="text-xs text-muted-foreground leading-relaxed p-3 bg-background rounded-md border">
                          I am a UK taxpayer and understand that if I pay less Income Tax and/or Capital Gains Tax
                          in the current tax year than the amount of Gift Aid claimed on all my donations,
                          it is my responsibility to pay any difference. I want to Gift Aid this donation and
                          any donations I make in the future or have made in the past 4 years.
                        </div>

                        <div className="space-y-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Home Address *</Label>
                            <Input
                              value={giftAidAddress1}
                              onChange={(e) => setGiftAidAddress1(e.target.value)}
                              placeholder="Address line 1"
                              data-testid="input-gift-aid-address1"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Address Line 2</Label>
                            <Input
                              value={giftAidAddress2}
                              onChange={(e) => setGiftAidAddress2(e.target.value)}
                              placeholder="Address line 2 (optional)"
                              data-testid="input-gift-aid-address2"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs">City *</Label>
                              <Input
                                value={giftAidCity}
                                onChange={(e) => setGiftAidCity(e.target.value)}
                                placeholder="City"
                                data-testid="input-gift-aid-city"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Postcode *</Label>
                              <Input
                                value={giftAidPostcode}
                                onChange={(e) => setGiftAidPostcode(e.target.value)}
                                placeholder="Postcode"
                                data-testid="input-gift-aid-postcode"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {paymentError && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                    {paymentError}
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={() => setStep('amount')}
                    className="flex-1"
                    data-testid="button-back-amount"
                  >
                    Back
                  </Button>
                  <Button
                    className="flex-[2] py-6 text-lg"
                    disabled={!donorName.trim() || processing || (giftAid && (!giftAidAddress1.trim() || !giftAidCity.trim() || !giftAidPostcode.trim()))}
                    onClick={handleContinueToPayment}
                    data-testid="button-continue-payment"
                  >
                    {processing ? (
                      <Loader2 className="w-5 h-5 animate-spin mr-2" />
                    ) : (
                      <Heart className="w-5 h-5 mr-2" />
                    )}
                    Continue to Payment
                  </Button>
                </div>
              </>
            )}

            {step === 'payment' && (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Payment</h2>
                  <div className="text-right">
                    <Badge variant="outline" className="text-base">
                      {formatCurrency(donationAmount, campaign.currency)}
                    </Badge>
                    {giftAid && (
                      <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                        +{formatCurrency(giftAidBonus, campaign.currency)} Gift Aid
                      </p>
                    )}
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Card Details</Label>
                    <div
                      id="card-element"
                      className="p-3 border rounded-md bg-background min-h-[44px]"
                      data-testid="card-element"
                    />
                  </div>
                </div>

                {paymentError && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                    {paymentError}
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    onClick={() => setStep('details')}
                    className="flex-1"
                    data-testid="button-back-details"
                  >
                    Back
                  </Button>
                  <Button
                    className="flex-[2] py-6 text-lg"
                    disabled={processing}
                    onClick={handlePayment}
                    data-testid="button-pay"
                  >
                    {processing ? (
                      <><Loader2 className="w-5 h-5 animate-spin mr-2" /> Processing...</>
                    ) : (
                      <>
                        <Heart className="w-5 h-5 mr-2" />
                        Donate {formatCurrency(donationAmount, campaign.currency)}
                      </>
                    )}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground text-center">
                  Payments are processed securely via Stripe
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {recent_donations && recent_donations.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold flex items-center gap-2">
                  <Heart className="w-4 h-4 text-primary" />
                  Recent Supporters
                </h3>
                <span className="text-xs text-muted-foreground">
                  {progress.member_donor_count} donation{progress.member_donor_count !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="space-y-3">
                {(showAllDonations ? recent_donations : recent_donations.slice(0, 5)).map((d, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary shrink-0 mt-0.5">
                      {d.is_anonymous ? '?' : d.donor_name?.[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-medium truncate">
                          {d.donor_name}
                        </p>
                        <span className="text-sm font-bold shrink-0">
                          {formatCurrency(d.amount, campaign.currency)}
                        </span>
                      </div>
                      {d.donor_message && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 italic">
                          "{d.donor_message}"
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTimeAgo(d.created_at)}
                        </span>
                        {d.gift_aid && (
                          <Badge variant="secondary" className="text-xs">Gift Aid</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {recent_donations.length > 5 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full mt-3"
                  onClick={() => setShowAllDonations(!showAllDonations)}
                  data-testid="button-toggle-all-donations"
                >
                  {showAllDonations ? (
                    <><ChevronUp className="w-4 h-4 mr-1" /> Show Less</>
                  ) : (
                    <><ChevronDown className="w-4 h-4 mr-1" /> Show All ({recent_donations.length})</>
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {updates.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <h3 className="font-semibold flex items-center gap-2 mb-4" data-testid="text-updates-heading">
                <MessageSquare className="w-4 h-4 text-primary" />
                Updates
              </h3>
              <div className="space-y-4">
                {updates.map((u) => (
                  <div key={u.id} className="space-y-2" data-testid={`update-${u.id}`}>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary shrink-0">
                        {u.author_initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" data-testid={`text-update-author-${u.id}`}>
                          {u.author_name}
                        </p>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTimeAgo(u.created_at)}
                        </span>
                      </div>
                    </div>
                    <p className="text-sm" data-testid={`text-update-content-${u.id}`}>{u.content}</p>
                    {u.image_url && (
                      <img
                        src={u.image_url}
                        alt=""
                        className="rounded-md max-h-64 object-cover cursor-pointer"
                        onClick={() => setFullSizeImage(u.image_url)}
                        data-testid={`img-update-${u.id}`}
                      />
                    )}
                    {u !== updates[updates.length - 1] && <div className="border-t" />}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {fullSizeImage && (
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setFullSizeImage(null)}
            data-testid="modal-full-image"
          >
            <img
              src={fullSizeImage}
              alt=""
              className="max-w-full max-h-full object-contain rounded-md"
              data-testid="img-full-size"
            />
          </div>
        )}

        {other_team_members && other_team_members.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <h3 className="font-semibold flex items-center gap-2 mb-4">
                <Users className="w-4 h-4" />
                Other Team Members
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {other_team_members.map((m, i) => (
                  <a
                    key={i}
                    href={`/donate/${m.token}`}
                    className="flex items-center gap-3 p-3 rounded-md border hover-elevate"
                    data-testid={`link-team-member-${i}`}
                  >
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
                      {m.first_name?.[0]}{m.last_name?.[0]}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {m.first_name} {m.last_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Raised {formatCurrency(m.total_raised, campaign.currency)}
                      </p>
                    </div>
                  </a>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {tenant && (
          <div className="text-center py-4 text-xs text-muted-foreground">
            Fundraising by {tenant.name}
          </div>
        )}
      </div>
    </div>
  );
}
