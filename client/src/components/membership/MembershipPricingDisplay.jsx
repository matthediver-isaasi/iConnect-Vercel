import { getMembershipPricingPresentation } from './membershipPricingPresentation';

export default function MembershipPricingDisplay({ record, className = '' }) {
  const pricing = getMembershipPricingPresentation(record);
  if (!pricing.monthly) return null;

  return (
    <div className={className} data-testid={`membership-monthly-price-${record?.id || 'unknown'}`}>
      <div className="font-medium">{pricing.monthly.label}</div>
      {pricing.monthly.amount && <div>{pricing.monthly.amount} {pricing.monthly.state === 'calculated' ? 'per month' : '(monthly collection)'}</div>}
    </div>
  );
}
