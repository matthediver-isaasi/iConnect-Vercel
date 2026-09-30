import { getMembershipPricingPresentation } from './membershipPricingPresentation';

export default function MembershipPricingDisplay({ record, className = '' }) {
  const pricing = getMembershipPricingPresentation(record);
  if (!pricing.monthly && !pricing.signupMonthly) return null;

  return (
    <div className={className} data-testid={`membership-monthly-price-${record?.id || 'unknown'}`}>
      {pricing.monthly && <>
        <div className="font-medium">{pricing.monthly.label}</div>
        {pricing.monthly.amount && <div>{pricing.monthly.amount} {pricing.monthly.state === 'calculated' ? 'per month' : '(monthly collection)'}</div>}
      </>}
      {pricing.signupMonthly && <div className="mt-1">
        <div>{pricing.signupMonthly.label}: {pricing.signupMonthly.amount}</div>
        <div className="text-xs text-muted-foreground">{pricing.signupMonthly.disclaimer}</div>
      </div>}
    </div>
  );
}
