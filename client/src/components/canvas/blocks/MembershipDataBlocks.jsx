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
  formatMembershipDate, safeMembershipLink,
} from '@/lib/canvasMembershipData';

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
  active: '#237249', paid: '#237249', pending: '#865d10', paused: '#865d10', expired: '#667085',
  failed: '#b42318', unavailable: '#667085', none: '#667085',
};

// Separate view makes the state contract testable without authentication/network.
export function MembershipDataView({
  block, type = 'membership-summary', breakpoint, asEditor = false,
  result, tenantStyles = [], stylesResolved = true,
}) {
  const content = normalizeCanvasMembershipContent(block.content, type);
  const paymentCard = type === 'payment-details';
  const id = `membership-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const selector = `[data-membership-card="${id}"]`;
  const summary = normalizeCanvasMembershipSummary(result?.data);
  const ready = result?.status === 'ready';
  const state = ready ? (paymentCard ? summary.payment.state : summary.membership.state) : 'unavailable';
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
  const ref = useReportReflowHeight(block.id, extraHeight, { includeExtraHeightPublic: true });
  const href = safeMembershipLink(content.manageLink);
  const paidWithoutNextPayment = summary.payment.state === 'paid' && !summary.payment.nextPayment;
  const renewalDate = formatMembershipDate(summary.membership.renewalDate);
  const values = {
    memberSince: formatMembershipDate(summary.membership.memberSince, true) || content.messages.missing,
    membershipType: summary.membership.membershipType || content.messages.missing,
    method: content.methods[summary.payment.method],
    nextPayment: formatMembershipDate(summary.payment.nextPayment)
      || (paidWithoutNextPayment ? content.messages.noPaymentScheduled : content.messages.missing),
    renewalDate: renewalDate || content.messages.noPaymentScheduled,
  };
  const fieldKeys = ['memberSince', 'membershipType', 'method',
    paidWithoutNextPayment && renewalDate ? 'renewalDate' : 'nextPayment'];
  return (
    <section ref={ref} data-membership-card={id} data-testid={`canvas-${type}`}
      data-membership-state={state} aria-labelledby={`${id}-heading`}
      aria-busy={result?.status === 'loading'}
      style={{ width: '100%', minWidth: 0, containerType: 'inline-size', visibility: awaitingStyles ? 'hidden' : undefined }}>
      <style dangerouslySetInnerHTML={{ __html: `${css}
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
          <p {...role('value', { fontSize: 24 })}>{content.methods[summary.payment.method]}</p>
          <p {...role('status', { marginTop: 8, color: stateColors[state] })}>{copy.status}</p>
          <p {...role('supporting', { marginTop: 8, color: stateColors[state], fontWeight: 600 })}>{copy.supporting}</p>
          {state === 'paid' && <dl style={{ margin: '16px 0 0' }}>
            <dt {...role('fieldLabel')}>
              {renewalDate ? content.fields.renewalDate : content.fields.nextPayment}
            </dt>
            <dd {...role('value')}>{renewalDate || content.messages.noPaymentScheduled}</dd>
          </dl>}
        </div>
      ) : (
        <>
          <p {...role('supporting', { marginTop: 12 })}>{copy.supporting}</p>
          <dl className="membership-fields">
            {fieldKeys.map(key => <div key={key} style={{ minWidth: 0 }}>
              <dt {...role('fieldLabel')}>{content.fields[key]}</dt>
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

export function MembershipDataInspector({ block, update }) {
  const c = normalizeCanvasMembershipContent(block.content, block.type);
  const [state, setState] = useState('active');
  const editableStates = block.type === 'payment-details' ? MEMBERSHIP_PAYMENT_STATES : MEMBERSHIP_DATA_STATES;
  const set = patch => update(b => ({
    ...b, content: normalizeCanvasMembershipContent({ ...normalizeCanvasMembershipContent(b.content, b.type), ...patch }, b.type),
  }));
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