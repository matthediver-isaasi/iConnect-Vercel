import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ColorField } from './ColorField';
import {
  LinkField, TypographyStyleField, useTenantTypographyStylesState,
  resolveTenantStyle, isAwaitingTypographyStyle, buildTypographyInlineStyle,
  buildTenantTypographyResponsiveCss,
} from './registry';
import { useReportReflowHeight } from '../AccordionReflowContext';
import { useCanvasMembershipSummary } from '@/hooks/useCanvasMembershipSummary';
import {
  normalizeCanvasMembershipContent, normalizeCanvasMembershipSummary,
  MEMBERSHIP_DATA_STATES, MEMBERSHIP_PAYMENT_STATES, MEMBERSHIP_PAYMENT_METHODS, MEMBERSHIP_TEXT_ROLES,
  formatMembershipAmount, formatMembershipDate, safeMembershipLink,
} from '@/lib/canvasMembershipData';
import {
  BREAKPOINT_MAX_PX, hasResponsiveOverride, resolveResponsiveValue, writeResponsiveValue,
} from '@/lib/canvasDesign';

const roleNames = {
  eyebrow: 'Eyebrow', heading: 'Heading', supporting: 'Supporting text',
  fieldLabel: 'Field labels', value: 'Values', status: 'Status text', link: 'Link',
};
const roleDefaults = {
  eyebrow: { fontSize: 14, fontWeight: 700, color: 'var(--cb-color-primary, #365787)', letterSpacing: '.025em', marginBottom: 20 },
  heading: { fontSize: 30, lineHeight: 1.2, fontWeight: 700, color: '#1f2937' },
  supporting: { fontSize: 16, lineHeight: 1.6, color: '#667085' },
  fieldLabel: { fontSize: 13, lineHeight: 1.5, color: '#667085', marginBottom: 8 },
  value: { fontSize: 16, lineHeight: 1.5, fontWeight: 700, color: '#1f2937' },
  status: { fontSize: 16, lineHeight: 1.5, fontWeight: 700 },
  link: { fontSize: 17, lineHeight: 1.5, fontWeight: 700, color: 'var(--cb-color-primary, #9a4d16)' },
};
const stateColors = {
  current_direct_debit: '#237249',
  active: '#237249', paid: '#237249', pending: '#865d10', paused: '#865d10', expired: '#667085',
  failed: '#b42318', unavailable: '#667085', none: '#667085',
};

// Separate view makes the state contract testable without authentication/network.
export function MembershipDataView({
  block, type = 'membership-summary', breakpoint, asEditor = false,
  result, tenantStyles = [], stylesResolved = true, viewportBreakpoint,
}) {
  const content = normalizeCanvasMembershipContent(block.content, type);
  const paymentCard = type === 'payment-details';
  const id = `membership-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const selector = `[data-membership-card="${id}"]`;
  const summary = normalizeCanvasMembershipSummary(result?.data);
  const ready = result?.status === 'ready';
  const state = ready ? (paymentCard ? summary.payment.state : summary.membership.state) : 'unavailable';
  // A confirmed absence of payment data has no useful published presentation.
  // Keep every unresolved/error lifecycle visible, and keep the editor sample
  // selectable, but remove the complete public block (including its authored
  // wrapper background/border and its V2 flow slot) once the normalized API
  // state explicitly says `none`.
  const hidePublishedPaymentDetails = paymentCard && ready && state === 'none' && !asEditor;
  const copy = content.states[state];
  const styles = Object.fromEntries(MEMBERSHIP_TEXT_ROLES.map(role => [
    role, resolveTenantStyle(content.typography[role], tenantStyles),
  ]));
  const awaitingStyles = MEMBERSHIP_TEXT_ROLES.some(role => (
    isAwaitingTypographyStyle(content.typography[role], styles[role], stylesResolved)
  ));
  const css = !breakpoint ? MEMBERSHIP_TEXT_ROLES.map(role => (
    buildTenantTypographyResponsiveCss(`${selector} [data-membership-role="${role}"]`, styles[role]) || ''
  )).join('') : '';
  const role = (name, extra = {}) => ({
    'data-membership-role': name,
    style: {
      margin: 0, overflowWrap: 'anywhere', ...roleDefaults[name], ...extra,
      ...buildTypographyInlineStyle(styles[name], { breakpoint: breakpoint || 'desktop' }),
    },
  });
  const style = block.style || {};
  const extraHeight = (Number(style.paddingTop) || 0) + (Number(style.paddingBottom) || 0)
    + (style.borderStyle === 'none' ? 0 : 2 * (Number(style.borderWidth) || 0));
  // minHeight is authored for the complete Canvas block (border + padding +
  // content), while this component is mounted inside that wrapper. Subtract
  // the wrapper chrome so the visible outer card reaches exactly the requested
  // floor. The measured section still reports the floor to both V1 reflow and
  // V2 flow layout, so long/async content remains free to grow beyond it.
  const contentMinHeight = bp => Math.max(0, (resolveResponsiveValue(content.minHeight, bp) || 0) - extraHeight);
  const activeBreakpoint = breakpoint || viewportBreakpoint || 'desktop';
  const minHeight = contentMinHeight(activeBreakpoint);
  const responsiveMinHeightCss = !breakpoint && typeof content.minHeight === 'object' ? `
    @media (max-width:${BREAKPOINT_MAX_PX.tablet}px){${selector}{min-height:${contentMinHeight('tablet')}px !important}}
    @media (max-width:${BREAKPOINT_MAX_PX.mobile}px){${selector}{min-height:${contentMinHeight('mobile')}px !important}}
  ` : '';
  const ref = useReportReflowHeight(block.id, extraHeight, {
    includeExtraHeightPublic: true,
    // V1 positioned pages use signed auto-height reflow for these cards. A
    // hidden card must report zero so content below closes the authored gap.
    allowZero: hidePublishedPaymentDetails,
  });
  const href = safeMembershipLink(content.manageLink);
  const plannedPayment = summary.payment.plannedPayment;
  const confirmedPayment = summary.payment.confirmedPayment;
  const nextCollection = summary.payment.nextCollection
    || (plannedPayment ? { ...plannedPayment, status: 'planned' } : null);
  // A nextCollection is independently future-scoped backend evidence. A
  // confirmedPayment is historical context only and can never become next.
  const paymentDate = nextCollection?.date
    || (summary.payment.collectionStatus === 'planned' ? summary.payment.nextPayment : null);
  const paymentDateLabel = nextCollection?.status === 'confirmed'
    ? content.fields.confirmedPaymentDate
    : nextCollection?.status === 'planned' ? content.fields.plannedPaymentDate : content.fields.nextPayment;
  const displayMethod = summary.payment.method === 'flat_rate' || content.methods[summary.payment.method] === 'Flat Rate'
    ? null : content.methods[summary.payment.method];
  const nextPaymentAmount = formatMembershipAmount(summary.payment.amount, summary.payment.currency)
    || content.messages.amountUnknown;
  const amountLabel = summary.payment.collectionBasis === 'projected' ? content.fields.projectedAmount
    : summary.payment.collectionBasis === 'held' ? content.fields.configuredAmount : content.fields.amount;
  const confirmedAmount = formatMembershipAmount(confirmedPayment?.amount, confirmedPayment?.currency)
    || content.messages.amountUnknown;
  // Retire only these stock explanations in the portal, not actionable notices
  // or the shared report/API wording.
  const collectionNotice = summary.payment.collectionNotice === 'Projected collection amount — not yet bank scheduled'
    ? '' : summary.payment.collectionNotice;
  const structureNotice = summary.payment.structureNotice === 'Structure effective on planned collection date'
    ? '' : summary.payment.structureNotice;
  const collectionStructure = summary.payment.collectionStructure || structureNotice;
  const values = {
    memberSince: formatMembershipDate(summary.membership.memberSince, true) || content.messages.joinDateNotRecorded,
    amount: nextPaymentAmount,
    membershipType: summary.membership.membershipType === 'Flat Rate' ? null : summary.membership.membershipType,
    method: displayMethod || content.messages.missing,
    nextPayment: formatMembershipDate(paymentDate)
      || (summary.payment.collectionStatus === 'unscheduled' ? content.messages.noPaymentScheduled : content.messages.missing),
    paymentHistoryFrom: summary.membership.paymentHistoryFrom
      ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' })
        .format(new Date(summary.membership.paymentHistoryFrom)) : content.messages.missing,
  };
  const paymentFactsAvailable = !['unavailable', 'none', 'paid'].includes(summary.payment.state);
  const fieldKeys = ['memberSince',
    ...(content.fields.membershipType && values.membershipType ? ['membershipType'] : []),
    ...(paymentFactsAvailable ? ['amount', 'method', 'nextPayment'] : []),
    ...(summary.membership.paymentHistoryFrom ? ['paymentHistoryFrom'] : [])];
  return (
    <section ref={ref} data-membership-card={id} data-testid={`canvas-${type}`}
      data-payment-details-visibility={hidePublishedPaymentDetails ? 'hidden' : undefined}
      hidden={hidePublishedPaymentDetails}
      data-membership-state={state} aria-labelledby={`${id}-heading`}
      aria-busy={result?.status === 'loading'}
      style={{ width: '100%', minWidth: 0, minHeight, containerType: 'inline-size', visibility: awaitingStyles ? 'hidden' : undefined }}>
      <style dangerouslySetInnerHTML={{ __html: `${css}
        ${responsiveMinHeightCss}
        [data-block-type="payment-details"]:has(> [data-payment-details-visibility="hidden"]){display:none !important}
        ${selector} .membership-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;margin:40px 0 0;padding:0}
        ${selector} .membership-title{display:flex;align-items:center;gap:24px 60px;flex-wrap:wrap}
        @container (max-width:650px){${selector} .membership-fields{grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}}
        @container (max-width:380px){${selector} .membership-fields{grid-template-columns:minmax(0,1fr)}}
        ${selector} a:focus-visible{outline:2px solid currentColor;outline-offset:4px}
      ` }} />
      {asEditor && result?.isSample && (
        <p data-testid="membership-editor-sample" style={{ margin: '0 0 12px', fontSize: 12, color: '#667085' }}>
          Editor preview — sample data, not a member record
        </p>
      )}
      <p {...role('eyebrow')}>{content.eyebrow}</p>
      <div className="membership-title">
        <h2 id={`${id}-heading`} {...role('heading')}>{copy.heading}</h2>
        {ready && !paymentCard && <span {...role('status', { color: stateColors[state], display: 'inline-flex', alignItems: 'center', gap: 8 })}>
          <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
          {copy.status}
        </span>}
      </div>
      {!ready ? (
        <p {...role('supporting', { marginTop: 16 })} role={result?.status === 'error' || result?.status === 'denied' ? 'alert' : 'status'}>
          {content.messages[result?.status] || content.messages.error}
        </p>
      ) : paymentCard ? (
        <div data-testid="membership-payment-panel" style={{
          marginTop: 30, padding: '18px 22px', background: content.panel.background,
          border: `${content.panel.borderWidth}px solid ${content.panel.borderColor || 'transparent'}`,
          borderRadius: content.panel.borderRadius, minWidth: 0,
        }}>
          <dl className="membership-fields" style={{ margin: 0 }}>
            {paymentFactsAvailable && <div style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>{amountLabel}</dt>
              <dd {...role('value', { fontSize: 24 })}>{nextPaymentAmount}</dd>
            </div>}
            {paymentFactsAvailable && paymentDate && <div style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>{paymentDateLabel}</dt>
              <dd {...role('value')}>{formatMembershipDate(paymentDate)}</dd>
            </div>}
            {paymentFactsAvailable && confirmedPayment && <div style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>
                {confirmedPayment.historical ? content.fields.historicalPayment : content.fields.confirmedPayment}
              </dt>
              <dd {...role('value')}>{formatMembershipDate(confirmedPayment.date)} · {confirmedAmount}</dd>
            </div>}
            {paymentFactsAvailable && displayMethod && <div style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>{content.fields.method}</dt>
              <dd {...role('value')}>{displayMethod}</dd>
            </div>}
            {paymentFactsAvailable && summary.payment.mandateStatus && <div style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>{content.fields.mandateStatus}</dt>
              <dd {...role('value', { color: stateColors[state] })}>{summary.payment.mandateStatus}</dd>
            </div>}
          </dl>
          {summary.payment.collectionBasis && (collectionNotice?.trim() || collectionStructure?.trim()) && <div style={{ marginTop: 16 }}>
            {collectionNotice?.trim() && <p {...role('supporting')}>{collectionNotice}</p>}
            {collectionStructure?.trim() && <dl style={{ margin: collectionNotice?.trim() ? '16px 0 0' : 0 }}>
              <dt {...role('fieldLabel')}>{content.fields.collectionStructure}</dt>
              <dd {...role('value')}>{collectionStructure}</dd>
            </dl>}
            {summary.payment.collectionStructure && structureNotice?.trim() && <p {...role('supporting', { marginTop: 8 })}>{structureNotice}</p>}
          </div>}
          {summary.membership.expiryDate && <dl style={{ marginTop: 16 }}>
            <dt {...role('fieldLabel')}>{content.fields.expiryDate}</dt>
            <dd {...role('value')}>{formatMembershipDate(summary.membership.expiryDate)}</dd>
          </dl>}
          {summary.payment.state === 'paid' && summary.payment.method === 'upfront' && <dl style={{ marginTop: 16 }}>
            <dt {...role('fieldLabel')}>{content.fields.method}</dt>
            <dd {...role('value')}>{displayMethod}</dd>
          </dl>}
          {copy.supporting.trim() && <p {...role('supporting', { marginTop: 16 })}>{copy.supporting}</p>}
        </div>
      ) : (
        <>
          <p {...role('supporting', { marginTop: 12 })}>{copy.supporting}</p>
          <dl className="membership-fields">
            {summary.membership.expiryDate && <div style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>{content.fields.expiryDate}</dt>
              <dd {...role('value')}>{formatMembershipDate(summary.membership.expiryDate)}</dd>
            </div>}
            {fieldKeys.map(key => <div key={key} style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>{key === 'nextPayment' ? paymentDateLabel : key === 'amount' ? amountLabel : content.fields[key]}</dt>
              <dd {...role('value')}>{values[key]}</dd>
            </div>)}
          </dl>
        </>
      )}
      {paymentCard && href && ready && <a href={href}
        target={content.manageLinkNewTab ? '_blank' : undefined}
        rel={content.manageLinkNewTab ? 'noopener noreferrer' : undefined}
        onClick={asEditor ? event => event.preventDefault() : undefined}
        {...role('link', { display: 'inline-flex', alignItems: 'center', gap: 10, marginTop: 24, textDecoration: 'none' })}>
        {content.manageLinkText}<ArrowRight size={18} aria-hidden="true" style={{ flexShrink: 0 }} />
      </a>}
    </section>
  );
}

function MembershipDataRender(props) {
  const result = useCanvasMembershipSummary({ asEditor: props.asEditor });
  const { styles, resolved } = useTenantTypographyStylesState();
  return <MembershipDataView {...props} result={result} tenantStyles={styles} stylesResolved={resolved} />;
}

export function MembershipSummaryRender(props) {
  return <MembershipDataRender {...props} type="membership-summary" />;
}

export function PaymentDetailsRender(props) {
  return <MembershipDataRender {...props} type="payment-details" />;
}

export function MembershipDataInspector({ block, update, breakpoint = 'desktop' }) {
  const c = normalizeCanvasMembershipContent(block.content, block.type);
  const [state, setState] = useState('active');
  const editableStates = block.type === 'payment-details' ? MEMBERSHIP_PAYMENT_STATES : MEMBERSHIP_DATA_STATES;
  const set = patch => update(b => ({
    ...b, content: normalizeCanvasMembershipContent({ ...normalizeCanvasMembershipContent(b.content, b.type), ...patch }, b.type),
  }));
  const minHeight = resolveResponsiveValue(c.minHeight, breakpoint) || 0;
  const minHeightMode = minHeight > 0 ? 'custom' : 'auto';
  const setMinHeight = value => set({
    minHeight: writeResponsiveValue(c.minHeight, breakpoint, value),
  });
  const field = (label, value, onChange, key) => (
    <div className="space-y-1" key={key || label}>
      <Label className="text-xs">{label}
        <Input className="mt-1" value={value} onChange={event => onChange(event.target.value)}
          data-testid={`membership-input-${key || label.replace(/\s+/g, '-').toLowerCase()}`} />
      </Label>
    </div>
  );
  return <div className="space-y-4" data-testid="membership-data-inspector">
    <p className="text-xs text-slate-500">Published cards use the signed-in member’s data. Editor samples are not saved. Wording does not change membership or payment state.</p>
    <div className="space-y-2">
      <Label className="text-xs">Outer minimum height ({breakpoint})
        <select className="mt-1 w-full rounded border p-2 text-sm" value={minHeightMode}
          onChange={event => setMinHeight(event.target.value === 'auto'
            ? 0
            : (minHeight > 0 ? minHeight : (block.type === 'payment-details' ? 330 : 280)))}
          data-testid="membership-min-height-mode">
          <option value="auto">Auto</option>
          <option value="custom">Custom</option>
        </select>
      </Label>
      <p className="text-xs text-slate-500" data-testid="membership-min-height-help">
        Includes the card’s outer padding and border. Longer content can still grow, so it will not be clipped.
      </p>
      {minHeightMode === 'custom' && <Label className="text-xs">Minimum height (px)
        <Input className="mt-1" type="number" min="1" max="4000" value={minHeight}
          onChange={event => {
            const raw = event.target.value;
            setMinHeight(raw === '' ? 0 : Math.max(1, Math.min(4000, Number(raw) || 1)));
          }}
          data-testid="membership-min-height" />
      </Label>}
      {breakpoint !== 'desktop' && !hasResponsiveOverride(c.minHeight, breakpoint) && (
        <p className="text-xs text-slate-500">Inherited from the larger breakpoint.</p>
      )}
    </div>
    {field('Eyebrow', c.eyebrow, eyebrow => set({ eyebrow }))}
    <div className="space-y-2">
      <Label className="text-xs">State-specific wording
        <select className="mt-1 w-full rounded border p-2 text-sm" value={state} onChange={event => setState(event.target.value)} data-testid="membership-state-wording">
          {editableStates.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </Label>
      {['heading', 'supporting', 'status'].map(key => field(
        `${state} ${key}`, c.states[state][key],
        value => set({ states: { ...c.states, [state]: { ...c.states[state], [key]: value } } }), `${state}-${key}`,
      ))}
    </div>
    <details><summary className="cursor-pointer text-sm font-medium">Field and payment-method labels</summary>
      <div className="space-y-2 pt-2">
        {Object.entries(c.fields).map(([key, value]) => field(key, value, next => set({ fields: { ...c.fields, [key]: next } }), `field-${key}`))}
        {MEMBERSHIP_PAYMENT_METHODS.map(key => field(key.replace(/_/g, ' '), c.methods[key], value => set({ methods: { ...c.methods, [key]: value } }), `method-${key}`))}
      </div>
    </details>
    <details><summary className="cursor-pointer text-sm font-medium">Loading and empty-state wording</summary>
      <div className="space-y-2 pt-2">{Object.entries(c.messages).map(([key, value]) => field(key, value, next => set({ messages: { ...c.messages, [key]: next } }), `message-${key}`))}</div>
    </details>
    <div className="space-y-3">
      <p className="text-sm font-medium">Typography</p>
      {MEMBERSHIP_TEXT_ROLES.map(role => <TypographyStyleField key={role} label={roleNames[role]}
        value={c.typography[role]} onChange={value => set({ typography: { ...c.typography, [role]: value } })}
        testId={`membership-typography-${role}`} />)}
    </div>
    {block.type === 'payment-details' && <>
      <LinkField label="Manage payments destination" value={c.manageLink} onChange={manageLink => set({ manageLink })}
        newTab={c.manageLinkNewTab} onNewTabChange={manageLinkNewTab => set({ manageLinkNewTab })}
        testId="membership-manage-link" />
      {c.manageLink && !safeMembershipLink(c.manageLink) && <p className="text-xs text-amber-700" role="status">
        Enter a site path beginning with / or an http(s) URL. The link is hidden until the destination is valid.
      </p>}
      {field('Manage payments link text', c.manageLinkText, manageLinkText => set({ manageLinkText }))}
      <ColorField label="Payment panel background" value={c.panel.background}
        onChange={background => set({ panel: { ...c.panel, background } })} testId="membership-panel-background" />
      <ColorField label="Payment panel border colour" value={c.panel.borderColor}
        onChange={borderColor => set({ panel: { ...c.panel, borderColor } })} testId="membership-panel-border" />
      {field('Payment panel border width', c.panel.borderWidth, borderWidth => set({ panel: { ...c.panel, borderWidth } }))}
      {field('Payment panel corner radius', c.panel.borderRadius, borderRadius => set({ panel: { ...c.panel, borderRadius } }))}
    </>}
  </div>;
}