import { directDebitPolicyText } from "@/lib/directDebitConsentSummary";

function money(amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return 'Not available';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(Number(amount));
}

const STATE_LABELS = {
  provider_scheduled: 'Accepted by provider — not yet collected',
  reserved: 'Reserved locally — not yet confirmed by provider',
  blocked: 'Collection blocked',
  unknown: 'No confirmed collection evidence available',
  agreed: 'Agreed amount — not a confirmed provider charge',
  last_collected: 'Last collected amount — not the next collection',
};

export default function DirectDebitCommitmentDetails({ commitment }) {
  const policy = commitment.collectionPolicy;
  const details = commitment.collectionDetails;
  const known = ['stop', 'continue'].includes(policy?.end_policy)
    && ['fixed', 'dynamic'].includes(policy?.pricing_policy) && !policy.needs_review;
  return (
    <div className="mt-4 space-y-3 border-t pt-4" data-testid={`dd-commitment-policy-${commitment.id}`}>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">At the end of the billing period</dt>
          <dd className="font-medium">{known ? (policy.end_policy === 'continue' ? 'Continue collections' : 'Stop collections') : 'Existing agreement needs review'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Monthly collection amount</dt>
          <dd className="font-medium">{known ? (policy.pricing_policy === 'dynamic' ? 'Use the current active membership structure price' : 'Fixed for the membership term') : 'Policy not recorded'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Current monthly collection amount</dt>
          <dd className="font-medium">{money(details?.amount, details?.currency || commitment.currency)}</dd>
          <dd className="text-xs text-muted-foreground">{STATE_LABELS[details?.state] || STATE_LABELS.unknown}</dd>
        </div>
        {details?.dueDate && <div>
          <dt className="text-muted-foreground">Collection date</dt>
          <dd>{details.dueDate} {details.providerStatus ? `· ${details.providerStatus}` : ''}</dd>
        </div>}
        {details?.pricePreview && <div>
          <dt className="text-muted-foreground">Current price preview — not a confirmed charge</dt>
          <dd>{money(details.pricePreview.amount, details.pricePreview.currency || commitment.currency)}</dd>
        </div>}
        {details?.lastCollection && details.state !== 'last_collected' && <div>
          <dt className="text-muted-foreground">Last collection</dt>
          <dd>{money(details.lastCollection.amount, details.lastCollection.currency || commitment.currency)} · {details.lastCollection.dueDate || 'Date unknown'}</dd>
        </div>}
      </dl>
      {known && policy.evidence === 'legacy_auto_renew' && <p className="text-xs text-muted-foreground">Based on saved legacy consent.</p>}
      <p className="text-xs text-muted-foreground">{directDebitPolicyText(known ? { collectionPolicy: policy } : {})}</p>
      <p className="text-xs text-muted-foreground">The membership term end is not necessarily the Direct Debit collection end.</p>
      {!!details?.blockers?.length && <ul className="list-disc pl-4 text-sm text-warning" aria-label="Collection blockers">
        {details.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
      </ul>}
    </div>
  );
}