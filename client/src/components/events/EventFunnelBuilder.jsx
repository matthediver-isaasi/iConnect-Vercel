import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType } from '@xyflow/react';
import EventFunnelConnector from './EventFunnelConnector';
import { funnelConnectorKey, isFunnelLayoutPoint, pruneFunnelEditorLayout } from '../../../../shared/eventFunnelEditorLayout.mjs';
import { GitBranch, Plus, Save, Upload, Trash2, Play, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { evaluateFunnelRoute } from '../../../../shared/eventFunnelGraph.mjs';
import { createFunnelDraft, draftFingerprint, eventKey, eventReference, findEvent, graphConnections, graphIssues, isPurchase, nodeTitle, nodeLabel, earlierPurchaseNodes, reofferNotes, purchaseVisibilityPatch, purchaseVisibilityIssues, selectableEvents, describeFunnelIssue, findMembershipTier, membershipStagePatch } from './eventFunnelBuilderModel.mjs';
import '@xyflow/react/dist/style.css';
import './EventFunnelBuilder.css';
import { autoLayoutFunnel } from './eventFunnelLayout.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const typeNames = { source: 'Source event', event: 'Further event', addon: 'Event add-on', membership: 'Membership', condition: 'Condition', checkout: 'Checkout' };
// Tenant membership tiers, supplied by the admin endpoint (names only for labels).
const TiersContext = createContext([]);

function Field({ label, children }) {
  return <label className="efb-field"><span>{label}</span>{children}</label>;
}

function EventChoice({ value, catalog, tenantId, onChange, label = 'Event' }) {
  const [search, setSearch] = useState('');
  const known = findEvent(catalog, value);
  const choices = selectableEvents(catalog);
  const query = search.trim().toLocaleLowerCase();
  const filteredChoices = query
    ? choices.filter(item => String(item.title || '').toLocaleLowerCase().startsWith(query))
    : choices;
  const unavailable = value && (!known || known.selectable === false);
  const currentOutsideFilter = known && known.selectable !== false
    && !filteredChoices.some(item => eventKey(item) === eventKey(known));
  const noMatches = query && filteredChoices.length === 0;
  return <div className="efb-field">
    <span>{label}</span>
    <input type="search" className="efb-event-search" aria-label={`Search ${label.toLowerCase()}`}
      data-testid="funnel-event-search" placeholder="Filter by event name…" autoComplete="off"
      value={search} onChange={event => setSearch(event.target.value)} />
    <select aria-label={label} data-testid="funnel-event-choice" value={eventKey(value)} onChange={event => {
      const selectedKey = event.target.value;
      if (!selectedKey) {
        if (eventKey(value)) onChange(null);
        return;
      }
      const choice = catalog.find(item => eventKey(item) === selectedKey);
      if (choice && choice.selectable !== false) onChange(eventReference(choice, tenantId));
    }}>
      <option value="" disabled={!!noMatches}>{noMatches ? `No events match “${search.trim()}”` : 'Choose an event'}</option>
      {unavailable && <option value={eventKey(value)} disabled>{known?.title || 'Previously selected event'} — unavailable for new offers</option>}
      {currentOutsideFilter && <option value={eventKey(known)} disabled>{known.title} — current selection</option>}
      {filteredChoices.map(item => <option key={eventKey(item)} value={eventKey(item)}>{item.title}</option>)}
    </select>
    {noMatches && <p className="efb-search-hint" role="status">No selectable future events match “{search.trim()}”. Try another name.</p>}
  </div>;
}

function Destination({ label, value, nodes, catalog, onChange }) {
  const tiers = useContext(TiersContext);
  return <Field label={label}><select aria-label={label} value={value || ''} onChange={event => onChange(event.target.value)}>
    <option value="">Choose a destination</option>
    {value && !nodes.some(node => node.id === value) && <option value={value}>Previously connected destination unavailable</option>}
    {nodes.map(node => <option key={node.id} value={node.id}>{nodeLabel(node, nodes, catalog, tiers)}{isPurchase(node) ? ` — ${typeNames[node.type]}` : ''}</option>)}
  </select></Field>;
}

function FunnelNode({ data, selected }) {
  const { node, title, detail, ports, inRoute } = data;
  return <div className={`efb-node ${node.type} ${selected ? 'is-selected' : ''} ${inRoute ? 'is-route' : ''}`} data-testid={`funnel-node-${node.id}`}>
    {node.type !== 'source' && <Handle type="target" position={Position.Top} aria-label="Incoming route" />}
     <span className="efb-node-kind">{typeNames[node.type] || 'Unsupported funnel step'}</span>
    <strong>{title}</strong>
    <div className="efb-muted">{detail}</div>
    {ports.map((port, index) => {
      const left = `${((index + 1) / (ports.length + 1)) * 100}%`;
      return <React.Fragment key={port.id}>
        <span className="efb-port" style={{ left }}>{port.short}</span>
        <Handle id={port.id} type="source" position={Position.Bottom} style={{ left }} aria-label={`${title}: ${port.label}`} />
      </React.Fragment>;
    })}
  </div>;
}
const nodeTypes = { funnel: FunnelNode };
const edgeTypes = { funnelConnector: EventFunnelConnector };

function PurchaseInspector({ node, nodes, graph, catalog, tenantId, update }) {
  const tiers = useContext(TiersContext);
  const event = findEvent(catalog, node.event);
  const tickets = event?.tickets || [];
  const ticketIds = node.ticketIds || [];
  const unknownTickets = ticketIds.filter(id => !tickets.some(ticket => ticket.id === id));
  const toggleTicket = id => update({ ticketIds: ticketIds.includes(id) ? ticketIds.filter(value => value !== id) : [...ticketIds, id] });
  const prerequisites = node.requires || [];
  const earlierPurchases = earlierPurchaseNodes(nodes, node.id);
  const unavailablePrerequisites = prerequisites.filter(id => !earlierPurchases.some(other => other.id === id));
  const visibilityIssues = purchaseVisibilityIssues(node, nodes);
  const guardNotes = node.type === 'addon' && graph ? reofferNotes(graph, node.id, catalog) : [];
  return <>
    <EventChoice value={node.event} catalog={catalog} tenantId={tenantId} onChange={value => update({ event: value, ticketIds: [] })} label="Offered event" />
    {node.type === 'source' && graph.entryMode === 'ticket_single' && <p className="efb-notice">
      Source-ticket mappings: each checked class starts this funnel after normal registration.
      A class can belong to only one published funnel for this event.
    </p>}
    <Field label="Ticket choice at this step"><select aria-label="Ticket choice at this step"
      value={node.selectionMode || 'multiple'} disabled={node.type === 'source' && graph.entryMode === 'ticket_single'}
      onChange={event => update({ selectionMode: event.target.value })}>
      <option value="multiple">Multiple classes (legacy compatible)</option>
      <option value="single">One class; quantities and group tickets allowed</option>
    </select></Field>
    <div className="efb-field"><span>Offered ticket classes</span>
      <p className="efb-muted">Only these tickets are offered here. Event details remain unchanged.</p>
      {!tickets.length && <p className="efb-notice">Choose an event with ticket classes.</p>}
      {tickets.map(ticket => <label className="efb-check" key={ticket.id}><input type="checkbox" checked={ticketIds.includes(ticket.id)} onChange={() => toggleTicket(ticket.id)} />{ticket.name}</label>)}
      {unknownTickets.map(id => <label className="efb-check" key={id}><input type="checkbox" checked onChange={() => toggleTicket(id)} />Previously selected ticket unavailable (uncheck to remove)</label>)}
      {guardNotes.map(note => <p key={note} className="efb-notice" data-testid="funnel-reoffer-note">{note}</p>)}
    </div>
    {['event', 'addon'].includes(node.type) && <div className="efb-field">
      <span>Visibility and checkout restrictions</span>
      {node.type === 'event' && <label className="efb-check"><input type="checkbox"
        data-testid="funnel-node-unlisted" checked={node.unlisted === true}
        onChange={change => update(purchaseVisibilityPatch(node, 'unlisted', change.target.checked))} />
        Unlisted optional event</label>}
      {node.type === 'event' && <p className="efb-muted">Hide this optional event from event listings. An authorized direct link can still show it.</p>}
      <label className="efb-check"><input type="checkbox" data-testid="funnel-node-funnel-only"
        checked={node.funnelOnly === true}
        onChange={change => update(purchaseVisibilityPatch(node, 'funnelOnly', change.target.checked))} />
        Require an earlier selection in this same checkout</label>
      <p className="efb-muted">Choose which earlier offers must be selected first. A previous booking outside this checkout does not count.</p>
      <p className="efb-muted">Visibility does not grant purchase permission. The event’s audience rules, ticket eligibility and availability still apply.</p>
      {visibilityIssues.map(issue => <p key={issue} role="alert" className="efb-notice efb-error">{issue}</p>)}
    </div>}
    {node.type !== 'source' && <div className="efb-field"><span>Required earlier purchases</span>
      <p className="efb-muted">{node.type === 'addon' ? 'An add-on must follow an earlier offer for the same event. It can offer a ticket from an earlier step again only if a condition before it continues when that ticket is not selected.' : 'If an earlier required offer is not included, this offer follows its skip choice.'}</p>
      {earlierPurchases.map(other => <label className="efb-check" key={other.id}><input type="checkbox" checked={prerequisites.includes(other.id)} onChange={() => update({ requires: prerequisites.includes(other.id) ? prerequisites.filter(id => id !== other.id) : [...prerequisites, other.id] })} />{nodeLabel(other, nodes, catalog, tiers)}</label>)}
      {!earlierPurchases.length && <p className="efb-muted">Connect an earlier purchase to this offer to select a prerequisite.</p>}
      {unavailablePrerequisites.map(id => <label className="efb-check" key={id}><input type="checkbox" checked onChange={() => update({ requires: prerequisites.filter(value => value !== id) })} />
         {nodes.some(other => other.id === id) ? 'Not a connected earlier purchase' : 'Previously selected prerequisite unavailable'} (uncheck to remove)</label>)}
    </div>}
     <Destination label={node.type === 'source' ? 'Continue to' : 'If accepted, continue to'} value={node.accept} nodes={nodes} catalog={catalog} onChange={accept => update({ accept })} />
    {node.type !== 'source' && <Destination label="If skipped, continue to" value={node.skip} nodes={nodes} catalog={catalog} onChange={skip => update({ skip })} />}
  </>;
}

function MembershipInspector({ node, nodes, catalog, update }) {
  const tiers = useContext(TiersContext);
  const membership = node.membership || {};
  const tier = findMembershipTier(tiers, node);
  const active = tiers.filter(item => item.active);
  const groups = [['organization', 'Organisation memberships'], ['member', 'Individual memberships']];
  const prerequisites = node.requires || [];
  const earlierPurchases = earlierPurchaseNodes(nodes, node.id);
  const unavailablePrerequisites = prerequisites.filter(id => !earlierPurchases.some(other => other.id === id));
  const unavailableTier = membership.scheduleId && (!tier || !tier.active);
  return <>
    <p className="efb-muted">Offers one complimentary period of this membership tier. Accepting adds no charge. The base fee is waived once, when that membership period is next created; add-ons and later periods use normal pricing.</p>
    <Field label="Membership tier"><select aria-label="Membership tier" data-testid="funnel-membership-tier" value={membership.scheduleId || ''} onChange={event => {
      const choice = active.find(item => item.id === event.target.value);
      if (choice) update(membershipStagePatch(node, choice));
    }}>
      <option value="" disabled>Choose a membership tier</option>
      {unavailableTier && <option value={membership.scheduleId} disabled>{tier?.name || 'Previously selected tier'} — unavailable</option>}
      {groups.map(([scope, label]) => {
        const options = active.filter(item => item.scope === scope);
        return options.length ? <optgroup key={scope} label={label}>{options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup> : null;
      })}
    </select></Field>
    {!active.length && <p className="efb-notice">No active membership tiers are available. Create or activate a tier first.</p>}
    {unavailableTier && <p role="alert" className="efb-notice efb-error">The saved membership tier is no longer available. It is kept until you choose another tier.</p>}
    {membership.scope === 'organization' && <p className="efb-muted">Organisation tiers go to the purchaser’s organisation. Purchasers without an organisation cannot accept this offer.</p>}
    {membership.scope === 'member' && <Field label="Who receives the membership"><select aria-label="Who receives the membership" data-testid="funnel-membership-recipient" value={membership.recipientMode || 'purchaser'} onChange={event => update({ membership: { ...membership, recipientMode: event.target.value } })}>
      <option value="purchaser">The purchaser only</option>
      <option value="attendees">Each named attendee</option>
    </select></Field>}
    {membership.scope === 'member' && membership.recipientMode === 'attendees' && <p className="efb-muted">Every named attendee on the qualifying bookings must already have a member record.</p>}
    <Field label="Description shown to purchasers (optional)"><textarea data-testid="funnel-membership-description" maxLength={1000} rows={3} value={membership.description || ''} onChange={event => {
      const next = { ...membership };
      if (event.target.value) next.description = event.target.value; else delete next.description;
      update({ membership: next });
    }} /></Field>
    <div className="efb-field"><span>Only if they bought…</span>
      <p className="efb-muted">Optional. If a chosen earlier offer is not included, this membership offer is skipped. Without a choice, the source event qualifies.</p>
      {earlierPurchases.map(other => <label className="efb-check" key={other.id}><input type="checkbox" checked={prerequisites.includes(other.id)} onChange={() => update({ requires: prerequisites.includes(other.id) ? prerequisites.filter(id => id !== other.id) : [...prerequisites, other.id] })} />{nodeLabel(other, nodes, catalog, tiers)}</label>)}
      {unavailablePrerequisites.map(id => <label className="efb-check" key={id}><input type="checkbox" checked onChange={() => update({ requires: prerequisites.filter(value => value !== id) })} />
        {nodes.some(other => other.id === id) ? 'Not a connected earlier purchase' : 'Previously selected prerequisite unavailable'} (uncheck to remove)</label>)}
    </div>
    <Destination label="If accepted, continue to" value={node.accept} nodes={nodes} catalog={catalog} onChange={accept => update({ accept })} />
    <Destination label="If declined, continue to" value={node.skip} nodes={nodes} catalog={catalog} onChange={skip => update({ skip })} />
  </>;
}

function ConditionInspector({ node, nodes, catalog, tenantId, update }) {
  const rules = node.rules || [];
  const updateRule = (index, patch) => update({ rules: rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  const newTest = () => ({ event: eventReference(selectableEvents(catalog)[0], tenantId), selected: true });
  return <>
    <Field label="Condition name"><input aria-label="Condition name" data-testid="funnel-condition-name"
      maxLength={120} placeholder="Selection condition" value={node.name || ''}
      onChange={event => update({ name: event.target.value })} /></Field>
    <p className="efb-muted">The first matching rule wins. Check answers for earlier offers; a fallback handles every other answer.</p>
    <p className="efb-muted">To offer a ticket again as a later add-on (for example another day), use a rule that requires that ticket to be not selected.</p>
    {rules.map((rule, index) => <div className="efb-rule" key={index} data-testid={`funnel-rule-${index}`}>
      <div className="efb-row" style={{ justifyContent: 'space-between' }}><strong className="efb-muted">Rule {index + 1}</strong>
        <Button type="button" size="sm" variant="ghost" aria-label={`Remove rule ${index + 1}`} onClick={() => update({ rules: rules.filter((_, i) => i !== index) })}><Trash2 /></Button>
      </div>
      <Field label={`Rule ${index + 1} order`}><input type="number" min="0" step="1" value={rule.priority ?? ''} onChange={event => updateRule(index, { priority: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
      <Field label={`Rule ${index + 1} match`}><select value={rule.match || ''} onChange={event => updateRule(index, { match: event.target.value })}><option value="all">All tests must match</option><option value="any">Any test may match</option></select></Field>
      {(rule.tests || []).map((test, testIndex) => {
        const patchTest = patch => updateRule(index, { tests: rule.tests.map((item, i) => i === testIndex ? { ...item, ...patch } : item) });
        const tickets = findEvent(catalog, test.event)?.tickets || [];
        return <div className="efb-test" key={testIndex}>
          <EventChoice label={`Rule ${index + 1}, test ${testIndex + 1} event`} value={test.event} catalog={catalog} tenantId={tenantId} onChange={event => {
            const { ticketId: ignored, ...rest } = test;
            void ignored;
            updateRule(index, { tests: rule.tests.map((item, i) => i === testIndex ? { ...rest, event } : item) });
          }} />
          <Field label={`Rule ${index + 1}, test ${testIndex + 1} ticket`}><select value={test.ticketId ?? ''} onChange={event => {
            if (event.target.value) patchTest({ ticketId: event.target.value });
            else {
              const next = { ...test }; delete next.ticketId;
              updateRule(index, { tests: rule.tests.map((item, i) => i === testIndex ? next : item) });
            }
          }}><option value="">Any ticket in this event</option>
            {test.ticketId && !tickets.some(ticket => ticket.id === test.ticketId) && <option value={test.ticketId}>Previously selected ticket unavailable</option>}
            {tickets.map(ticket => <option key={ticket.id} value={ticket.id}>{ticket.name}</option>)}
          </select></Field>
          <Field label={`Rule ${index + 1}, test ${testIndex + 1} selection`}><select value={String(test.selected)} onChange={event => patchTest({ selected: event.target.value === 'true' })}><option value="true">Is selected</option><option value="false">Is not selected</option></select></Field>
          <Button type="button" variant="ghost" size="sm" onClick={() => updateRule(index, { tests: rule.tests.filter((_, i) => i !== testIndex) })}>Remove test {testIndex + 1}</Button>
        </div>;
      })}
      <Button type="button" size="sm" variant="outline" onClick={() => updateRule(index, { tests: [...(rule.tests || []), newTest()] })}><Plus />Add test</Button>
      <div style={{ marginTop: 12 }}><Destination label={`When rule ${index + 1} matches, continue to`} value={rule.to} nodes={nodes} catalog={catalog} onChange={to => updateRule(index, { to })} /></div>
    </div>)}
    <Button type="button" size="sm" variant="outline" onClick={() => update({ rules: [...rules, { priority: Math.max(-1, ...rules.map(rule => Number(rule.priority) || 0)) + 1, match: 'all', tests: [newTest()], to: nodes.find(item => item.type === 'checkout')?.id || '' }] })}><Plus />Add rule</Button>
     <div style={{ marginTop: 14 }}><Destination label="If no rule matches, continue to" value={node.fallback} nodes={nodes} catalog={catalog} onChange={fallback => update({ fallback })} /></div>
  </>;
}

function Builder({ tenantId, catalog = [], membershipTiers, definitions = [], busy = false, unavailable = null, onSave, onPreview, onPublish }) {
  const tiers = useMemo(() => membershipTiers || [], [membershipTiers]);
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [localDefinitions, setLocalDefinitions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedConnector, setSelectedConnector] = useState(null);
  const [editingLocked, setEditingLocked] = useState(false);
  const editGuard = useRef(false);
  // React Flow's mini-map reads dimensions from the controlled user nodes.
  // Keep measurements in view state, never in the saved purchase graph/layout.
  const [nodeMeasurements, setNodeMeasurements] = useState({});
  const [operation, setOperation] = useState(null);
  const [message, setMessage] = useState(null);
  const [samples, setSamples] = useState({});
  const [checkoutNow, setCheckoutNow] = useState(false);
  const [serverPreview, setServerPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const requestGeneration = useRef(0);
  const operationLock = useRef(false);
  const flowRef = useRef(null);
  const fitAfterLayout = useRef(false);
  useEffect(() => {
    if (!fitAfterLayout.current) return;
    fitAfterLayout.current = false;
    const frame = requestAnimationFrame(() => flowRef.current?.fitView({ padding: .25, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [draft?.layout]);
  const operationBusy = busy || !!operation;
  const locked = operationBusy || editingLocked;
  editGuard.current = locked;
  const blocked = operationBusy || !!unavailable;
  const availableDefinitions = [...localDefinitions, ...definitions.filter(item => !localDefinitions.some(local => local.id === item.id))];
  const graph = draft?.graph;
  const graphNodes = graph?.nodes || [];
  const selected = graphNodes.find(node => node.id === selectedId);
  const dirty = !!draft && draftFingerprint(draft) !== baseline;
  const issues = useMemo(() => graph ? graphIssues(graph, catalog, tenantId, tiers) : [], [graph, catalog, tenantId, tiers]);
  const readableIssues = useMemo(() => issues.map(issue => describeFunnelIssue(issue, graph, catalog, tiers)), [issues, graph, catalog, tiers]);
  const problems = draft && !draft.name?.trim() ? ['Give this funnel a name.', ...readableIssues] : readableIssues;
  const invalidSampleQuantity = graphNodes.filter(isPurchase).some(node => !samples[node.id]?.skip &&
    (node.ticketIds || []).some(id => {
      const quantity = Number(samples[node.id]?.quantities?.[id] || 0);
      return !Number.isSafeInteger(quantity) || quantity < 0;
    }));

  const previewInput = useMemo(() => ({
    selections: graphNodes.filter(isPurchase).flatMap(node => {
      const sample = samples[node.id];
      if (sample?.skip) return [];
      const tickets = (node.ticketIds || []).filter(id => Number(sample?.quantities?.[id]) > 0).map(id => ({ id, quantity: Number(sample.quantities[id]) }));
      return tickets.length ? [{ nodeId: node.id, tickets }] : [];
    }),
    decisions: Object.fromEntries([
      ...graphNodes.filter(node => ['event', 'addon'].includes(node.type) && samples[node.id]?.skip).map(node => [node.id, 'skip']),
      ...graphNodes.filter(node => node.type === 'membership' && ['accept', 'skip'].includes(samples[node.id]?.decision)).map(node => [node.id, samples[node.id].decision]),
    ]),
    checkoutNow,
  }), [graphNodes, samples, checkoutNow]);
  const localPreview = useMemo(() => {
    if (!graph) return null;
    if (invalidSampleQuantity) return { error: 'Sample quantities must be whole numbers of zero or greater.' };
    try { return { result: evaluateFunnelRoute(graph, previewInput) }; }
    catch (error) { return { error: error.message }; }
  }, [graph, previewInput, invalidSampleQuantity]);
  const routeResult = serverPreview || localPreview?.result;

  function invalidatePreview() {
    requestGeneration.current += 1;
    setServerPreview(null); setPreviewError(null);
  }
  function changeDraft(fn) {
    if (editGuard.current) return;
    invalidatePreview(); setMessage(null); setDraft(current => {
      const next = fn(current);
      return { ...next, layout: pruneFunnelEditorLayout(next.layout, next.graph) };
    });
  }
  function updateConnector(key, value) {
    if (editGuard.current || (value.bends && (value.bends.length > 24 || !value.bends.every(isFunnelLayoutPoint)))
      || (value.labelOffset && !isFunnelLayoutPoint(value.labelOffset))) return;
    setDraft(current => ({ ...current, layout: { ...current.layout,
      connectors: { ...current.layout?.connectors, [key]: value } } }));
  }
  function updateNode(patch) {
    changeDraft(current => ({ ...current, graph: { ...current.graph, nodes: current.graph.nodes.map(node => node.id === selectedId ? { ...node, ...patch } : node) } }));
  }
  function loadDefinition(definition, isNew = false) {
    if (dirty && !window.confirm('Discard unsaved changes to this funnel?')) return;
    const next = clone(definition);
    next.layout = next.layout || { positions: {} };
    if (next.id !== draft?.id) setNodeMeasurements({});
    setDraft(next); setBaseline(isNew ? '' : draftFingerprint(next)); setSelectedId(next.graph?.entry || null);
    setSamples({}); setCheckoutNow(false); setConfirmDelete(false); setSelectedConnector(null); setMessage(null); invalidatePreview();
    requestAnimationFrame(() => flowRef.current?.fitView({ padding: .25 }));
  }
  function setDestination(nodeId, handle, target) {
    changeDraft(current => ({ ...current, graph: { ...current.graph, nodes: current.graph.nodes.map(node => {
      if (node.id !== nodeId) return node;
      if (handle?.startsWith('rule-')) return { ...node, rules: node.rules.map((rule, index) => index === Number(handle.slice(5)) ? { ...rule, to: target } : rule) };
      if (['accept', 'skip', 'fallback'].includes(handle)) return { ...node, [handle]: target };
      return node;
    }) } }));
  }
  function addNode(type) {
    const id = crypto.randomUUID(), checkoutId = graphNodes.find(node => node.type === 'checkout')?.id || '';
    const anchor = selected && selected.type !== 'checkout' ? selected : graphNodes.find(node => node.accept === checkoutId);
    const related = selected && isPurchase(selected) ? selected : graphNodes.find(node => node.type === 'source');
    const choices = selectableEvents(catalog);
    const relatedEvent = findEvent(catalog, related?.event);
    const choice = type === 'addon' && relatedEvent?.selectable !== false ? relatedEvent
      : choices.find(event => !graphNodes.some(node => isPurchase(node) && eventKey(node.event) === eventKey(event))) || choices[0];
    const usedTickets = graphNodes.filter(node => eventKey(node.event) === eventKey(choice)).flatMap(node => node.ticketIds || []);
    const firstTicket = choice?.tickets?.find(ticket => !usedTickets.includes(ticket.id));
    const owner = graphNodes.find(item => ['source', 'event'].includes(item.type) && eventKey(item.event) === eventKey(choice));
    const destination = anchor?.type === 'condition' ? anchor.fallback : anchor?.accept;
    const next = destination || checkoutId;
    const conditionEvent = relatedEvent && relatedEvent.selectable !== false ? related.event : eventReference(choices[0], tenantId);
    const firstTier = tiers.find(tier => tier.active);
    const node = type === 'membership'
      ? { id, type, ...membershipStagePatch({}, firstTier), requires: [], accept: next, skip: next }
      : type === 'condition'
      ? { id, type, rules: [{ priority: 0, match: 'all', tests: [{ event: conditionEvent, selected: true }], to: next }], fallback: next }
      : { id, type, selectionMode: graph.entryMode === 'ticket_single' ? 'single' : 'multiple', event: eventReference(choice, tenantId), ticketIds: firstTicket ? [firstTicket.id] : [], requires: type === 'addon' && owner ? [owner.id] : [], accept: next, skip: next };
    changeDraft(current => ({
      ...current,
      graph: { ...current.graph, nodes: [...current.graph.nodes.map(item => item.id !== anchor?.id ? item : item.type === 'condition' ? { ...item, fallback: id } : { ...item, accept: id }), node] },
      layout: { ...current.layout, positions: { ...(current.layout?.positions || {}), [id]: { x: 370 + (graphNodes.length % 2) * 50, y: 80 + (graphNodes.length - 2) * 150 } } },
    }));
    setSelectedId(id); setConfirmDelete(false);
  }
  async function save() {
    if (locked || blocked || !draft || problems.length || operationLock.current || !onSave) return;
    operationLock.current = true; setOperation('save'); setMessage(null);
    const submitted = clone(draft), fingerprint = draftFingerprint(draft);
    try {
      const saved = await onSave({ id: submitted.id, name: submitted.name.trim(), expectedRevision: submitted.revision, graph: submitted.graph, layout: submitted.layout });
      if (!saved || saved.id !== submitted.id || !Number.isInteger(saved.revision)) throw new Error('The save response did not include the saved definition and revision.');
      const acknowledged = { ...submitted, ...saved };
      setLocalDefinitions(current => [acknowledged, ...current.filter(item => item.id !== saved.id)]);
      // Do not rehydrate in-progress inputs from query refreshes or a late response.
      setDraft(current => current?.id === submitted.id ? { ...current, revision: saved.revision, published_version_id: saved.published_version_id ?? current.published_version_id } : current);
      setBaseline(fingerprint);
      setMessage({ kind: 'success', text: `Draft saved at revision ${saved.revision}.` });
    } catch (error) { setMessage({ kind: 'error', text: `Could not save. ${describeFunnelIssue(error?.message || 'Please retry.', graph, catalog, tiers)} Your edits are still here.` }); }
    finally { setOperation(null); operationLock.current = false; }
  }
  async function publish() {
    if (locked || blocked || !draft || dirty || !draft.revision || problems.length || operationLock.current || !onPublish) return;
    operationLock.current = true; setOperation('publish'); setMessage(null);
    try {
      const result = await onPublish({ id: draft.id, expectedRevision: draft.revision });
      // Publishing need not return a definition; only adopt explicit definition metadata.
      const metadata = {
        ...(Number.isInteger(result?.revision) ? { revision: result.revision } : {}),
        ...(result?.published_version_id ? { published_version_id: result.published_version_id } : {}),
      };
      setDraft(current => ({ ...current, ...metadata }));
      setLocalDefinitions(current => current.map(item => item.id === draft.id ? { ...item, ...metadata } : item));
      setMessage({ kind: 'success', text: 'Saved funnel published successfully.' });
    } catch (error) { setMessage({ kind: 'error', text: `Could not publish. ${describeFunnelIssue(error?.message || 'Please retry.', graph, catalog, tiers)} Your draft has not been discarded.` }); }
    finally { setOperation(null); operationLock.current = false; }
  }
  async function preview() {
    if (blocked || !graph || problems.length || invalidSampleQuantity || operationLock.current || !onPreview) return;
    const generation = ++requestGeneration.current;
    operationLock.current = true; setOperation('preview'); setPreviewError(null); setServerPreview(null);
    try {
      const result = await onPreview({ graph: clone(graph), ...clone(previewInput) });
      if (!result || !Array.isArray(result.route)) throw new Error('The preview response did not include a route.');
      if (generation === requestGeneration.current) setServerPreview(result);
    } catch { if (generation === requestGeneration.current) setPreviewError('Try again with the same sample answers.'); }
    finally { setOperation(null); operationLock.current = false; }
  }

  function arrange() {
    if (locked || !draft || !graphNodes.length) return;
    try {
      const positions = autoLayoutFunnel(graph, flowRef.current?.getNodes() || []);
      fitAfterLayout.current = true;
      setDraft(current => ({ ...current, layout: { ...current.layout, positions, connectors: {} } }));
      setMessage({ kind: 'success', text: 'Layout arranged; custom connector bends and label positions were reset. You can still drag steps and connectors. Save the draft to keep this layout.' });
    } catch {
      setMessage({ kind: 'error', text: 'Could not arrange this funnel. Your existing layout and edits are unchanged.' });
    }
  }

  const connections = graphConnections(graph);
  const flowNodes = graphNodes.map((node, index) => ({
    id: node.id, type: 'funnel', selected: selectedId === node.id,
    ...(nodeMeasurements[node.id] ? { measured: nodeMeasurements[node.id] } : {}),
    position: draft?.layout?.positions?.[node.id] || { x: 80 + (index % 2) * 300, y: 60 + Math.floor(index / 2) * 180 },
    data: { node, title: nodeLabel(node, graphNodes, catalog, tiers),
       detail: isPurchase(node) ? `${(node.ticketIds || []).length} ticket classes`
         : node.type === 'membership' ? (node.membership?.scope === 'member' ? (node.membership.recipientMode === 'attendees' ? 'Individual · each named attendee' : 'Individual · purchaser') : 'Organisation · purchaser’s organisation')
         : node.type === 'condition' ? `${(node.rules || []).length} rules · first match wins` : 'All selected offers finish here',
       ports: connections.filter(edge => edge.source === node.id).map(edge => ({ id: edge.sourceHandle, label: edge.label, short: edge.sourceHandle.startsWith('rule-') ? `Rule ${Number(edge.sourceHandle.slice(5)) + 1}` : edge.label })),
      inRoute: routeResult?.route?.includes(node.id),
    },
  }));
  const flowEdges = connections.filter(edge => graphNodes.some(node => node.id === edge.target)).map(edge => ({
    ...edge, id: funnelConnectorKey(edge), type: 'funnelConnector', deletable: false, reconnectable: false,
    selected: selectedConnector === funnelConnectorKey(edge),
    data: { locked, layout: draft?.layout?.connectors?.[funnelConnectorKey(edge)],
      onSelect: key => { setSelectedConnector(key); setSelectedId(null); },
      onChange: value => updateConnector(funnelConnectorKey(edge), value) },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#72879a' },
    style: { stroke: routeResult?.route?.some((id, i, route) => id === edge.source && route[i + 1] === edge.target) ? '#43846a' : '#8a9cab', strokeWidth: 1.5 },
    labelStyle: { fontSize: 11, fill: '#42586b' }, labelBgStyle: { fill: '#f7f9fb' },
  }));

  return <TiersContext.Provider value={tiers}><section className="event-funnel-builder" aria-label="Event funnel builder" data-testid="event-funnel-builder">
    <div className="efb-header">
      <div><h3 className="efb-row"><GitBranch size={19} />Event funnels</h3><p className="efb-muted">Offer parking, lunch and further events without changing each event’s identity.</p></div>
      <div className="efb-actions">
        <Button type="button" variant="outline" size="sm" data-testid="funnel-new" disabled={locked} onClick={() => loadDefinition(createFunnelDraft(tenantId), true)}><Plus />New funnel</Button>
        <Button type="button" size="sm" variant="outline" data-testid="funnel-save" disabled={locked || blocked || !draft || !!problems.length || !dirty || !onSave} onClick={save}><Save />{operation === 'save' ? 'Saving…' : 'Save draft'}</Button>
        <Button type="button" size="sm" data-testid="funnel-publish" disabled={locked || blocked || !draft?.revision || dirty || !!problems.length || !onPublish} onClick={publish}><Upload />{operation === 'publish' ? 'Publishing…' : 'Publish saved draft'}</Button>
      </div>
    </div>
    {unavailable && <div role="alert" className="efb-notice efb-error" data-testid="funnel-unavailable">{describeFunnelIssue(unavailable, graph, catalog, tiers)} Saving, publishing and preview are unavailable. In-progress edits are preserved.</div>}
    {message && <div role={message.kind === 'error' ? 'alert' : 'status'} className={`efb-notice efb-${message.kind}`} data-testid="funnel-operation-message">{message.text}</div>}
    <Field label="Saved funnel"><select data-testid="funnel-definition-choice" disabled={operationBusy} value={draft && availableDefinitions.some(item => item.id === draft.id) ? draft.id : ''} onChange={event => {
      const definition = availableDefinitions.find(item => item.id === event.target.value);
      if (definition) loadDefinition(definition);
    }}><option value="">{draft ? 'New unsaved funnel' : 'Select a saved funnel or create one'}</option>
      {availableDefinitions.map(item => {
        const source = item.graph?.nodes?.find(node => node.id === item.graph.entry);
        const event = findEvent(catalog, source?.event);
        const labels = source?.ticketIds?.map(id => event?.tickets?.find(ticket => ticket.id === id)?.name || 'Unavailable ticket').join(', ');
        return <option key={item.id} value={item.id}>{item.name} · {event?.title || 'Choose source event'} · {labels} · revision {item.revision}{item.published_version_id ? ' · published' : ' · draft'}</option>;
      })}
    </select></Field>
    {!draft ? busy ? <div className="efb-skeleton" role="status" aria-label="Loading event funnels" /> : <div className="efb-empty"><GitBranch size={28} style={{ margin: '0 auto 10px' }} /><h3>No funnel selected</h3><p className="efb-muted">Start with a source event and one checkout, then connect additional offers and conditions.</p><Button type="button" variant="outline" size="sm" style={{ marginTop: 12 }} onClick={() => loadDefinition(createFunnelDraft(tenantId), true)}>Create a funnel</Button></div> : <>
      <fieldset disabled={locked}>
        <div className="efb-settings">
          <Field label="Entry routing"><select aria-label="Entry routing" value={graph.entryMode || 'legacy'}
            onChange={event => changeDraft(current => {
              const next = { ...current.graph };
              if (event.target.value === 'ticket_single') {
                next.entryMode = 'ticket_single';
                next.nodes = next.nodes.map(node => node.type === 'source' ? { ...node, selectionMode: 'single' } : node);
              } else delete next.entryMode;
              return { ...current, graph: next };
            })}>
            <option value="legacy">Legacy event-wide entry</option>
            <option value="ticket_single">Route by one initial ticket class</option>
          </select><p className="efb-muted">Changing this affects only a newly published version. Active reservations keep their original choices and expiry. Convert legacy entry explicitly before publishing other funnels for the same event.</p></Field>
          <Field label="Funnel name"><input data-testid="funnel-name" maxLength={120} value={draft.name || ''} onChange={event => changeDraft(current => ({ ...current, name: event.target.value }))} /></Field>
          <Field label="Reservation duration (seconds)"><input data-testid="funnel-reservation" type="number" min="60" max="3600" step="1" value={graph.reservationSeconds ?? ''} onChange={event => changeDraft(current => ({ ...current, graph: { ...current.graph, reservationSeconds: event.target.value === '' ? null : Number(event.target.value) } }))} /></Field>
          <Field label="Invoice mode"><select data-testid="funnel-invoice-mode" value={graph.invoiceMode || ''} onChange={event => changeDraft(current => ({ ...current, graph: { ...current.graph, invoiceMode: event.target.value } }))}>
             {!['per_event', 'consolidated'].includes(graph.invoiceMode) && <option value={graph.invoiceMode || ''}>Previously saved billing choice</option>}
            <option value="per_event">Separate invoice per event</option><option value="consolidated">Consolidated invoice</option>
          </select></Field>
        </div>
      </fieldset>
      <div className="efb-row efb-muted"><span>{dirty ? 'Unsaved changes' : `Saved revision ${draft.revision}`}</span><span>·</span><span>{graphNodes.length} / 100 steps</span><span>·</span><span>Reservation: 60–3600 seconds</span></div>
       {problems.length > 0 ? <div className="efb-notice" data-testid="funnel-validation" role="status"><strong>Finish these details before saving or publishing</strong><ul style={{ paddingLeft: 18, marginTop: 5 }}>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div> : <div className="efb-notice efb-success" data-testid="funnel-validation"><span className="efb-row"><CheckCircle2 size={15} />Funnel steps and event selections look good. We’ll check them again when you save or publish.</span></div>}
       <div className="efb-toolbar"><span className="efb-muted">Add after selected step</span>
        <Button type="button" variant="outline" size="sm" data-testid="funnel-lock-editing" disabled={operationBusy}
          aria-pressed={editingLocked} onClick={() => { setEditingLocked(value => !value); setConfirmDelete(false); }}>
          {editingLocked ? 'Unlock editing' : 'Lock editing'}
        </Button>
        {['event', 'addon', 'membership', 'condition'].map(type => <Button type="button" variant="outline" size="sm" key={type} disabled={locked || graphNodes.length >= 100} data-testid={`funnel-add-${type}`} onClick={() => addNode(type)}><Plus />{typeNames[type]}</Button>)}
        <Button type="button" variant="outline" size="sm" data-testid="funnel-auto-layout" disabled={locked || !graphNodes.length} onClick={arrange} title="Arrange steps from top to bottom; reset custom connector bends and label positions without changing routing">Auto layout</Button>
         <span className="efb-muted" role="status">{editingLocked ? 'Editing locked. Select any step to inspect it; panning, zooming and route simulation remain available.' : 'Drag steps to arrange. Select a connector to move its bends or segments; drag its label independently. Arrow keys also adjust focused controls.'}</span>
      </div>
      <div className="efb-grid">
        <div className="efb-canvas" data-testid="funnel-canvas">
          <ReactFlow key={draft.id} nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={instance => { flowRef.current = instance; }} fitView fitViewOptions={{ padding: .25 }} minZoom={.15} maxZoom={2} nodesDraggable={!locked} nodesConnectable={!locked} elementsSelectable
           onEdgeClick={(_, edge) => { setSelectedConnector(edge.id); setSelectedId(null); }}
           onNodeClick={(_, node) => { setSelectedId(node.id); setSelectedConnector(null); setConfirmDelete(false); }} onPaneClick={() => { setSelectedId(null); setSelectedConnector(null); setConfirmDelete(false); }} onNodesChange={changes => {
            const dimensions = changes.filter(change => change.type === 'dimensions'
              && Number.isFinite(change.dimensions?.width) && change.dimensions.width > 0
              && Number.isFinite(change.dimensions?.height) && change.dimensions.height > 0);
            if (dimensions.length) setNodeMeasurements(current => {
              let next = current;
              for (const change of dimensions) {
                if (current[change.id]?.width === change.dimensions.width && current[change.id]?.height === change.dimensions.height) continue;
                if (next === current) next = { ...current };
                next[change.id] = { width: change.dimensions.width, height: change.dimensions.height };
              }
              return next;
            });
            if (locked) return;
            const positions = changes.filter(change => change.type === 'position' && change.position);
            const selection = changes.find(change => change.type === 'select' && change.selected);
            if (selection) setSelectedId(selection.id);
            if (positions.length) setDraft(current => ({ ...current, layout: { ...current.layout, positions: { ...(current.layout?.positions || {}), ...Object.fromEntries(positions.map(change => [change.id, change.position])) } } }));
          }} onConnect={connection => {
            if (!locked && connection.source && connection.target && connection.sourceHandle) setDestination(connection.source, connection.sourceHandle, connection.target);
           }} isValidConnection={connection => connection.source !== connection.target && graphNodes.find(node => node.id === connection.target)?.type !== 'source'} deleteKeyCode={null} proOptions={{ hideAttribution: true }} aria-label="Event funnel graph">
           <Background gap={20} size={1} color="#cbd7e0" /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={node => node.data.inRoute ? '#83b49a' : node.data.node.type === 'condition' ? '#d8bb83' : '#a9c4d5'} />
          </ReactFlow>
        </div>
        <aside className="efb-inspector" aria-label="Selected node settings" data-testid="funnel-inspector">
          {!selected ? <div className="efb-empty"><h4>Select a node</h4><p className="efb-muted">Choose an offer, condition or checkout to inspect its configuration.</p></div> : <fieldset disabled={locked}>
             <h4>{nodeLabel(selected, graphNodes, catalog, tiers)}</h4>
            {isPurchase(selected) && <PurchaseInspector node={selected} nodes={graphNodes} graph={graph} catalog={catalog} tenantId={tenantId} update={updateNode} />}
            {selected.type === 'membership' && <MembershipInspector node={selected} nodes={graphNodes} catalog={catalog} update={updateNode} />}
            {selected.type === 'condition' && <ConditionInspector node={selected} nodes={graphNodes} catalog={catalog} tenantId={tenantId} update={updateNode} />}
            {selected.type === 'checkout' && <p className="efb-muted">All routes must end at this checkout. Only eligible retained purchases are included. The reservation and invoice settings above apply to this funnel.</p>}
            {!typeNames[selected.type] && <div className="efb-notice efb-error">This saved node type is not supported. Its data has been preserved.</div>}
            {!['source', 'checkout'].includes(selected.type) && <div style={{ marginTop: 20 }}>
              {!confirmDelete ? <Button type="button" variant="outline" size="sm" data-testid="funnel-delete-node" onClick={() => setConfirmDelete(true)}><Trash2 />Remove step</Button> : <div className="efb-notice efb-error" role="alert"><p>Remove this step? Other steps may still lead to an unavailable destination until you reconnect them.</p><div className="efb-actions" style={{ marginTop: 8 }}><Button type="button" variant="destructive" size="sm" onClick={() => {
                changeDraft(current => {
                  const positions = { ...(current.layout?.positions || {}) }; delete positions[selectedId];
                  return { ...current, graph: { ...current.graph, nodes: current.graph.nodes.filter(node => node.id !== selectedId) }, layout: { ...current.layout, positions } };
                });
                setSelectedId(null); setConfirmDelete(false);
              }}>Remove</Button><Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button></div></div>}
            </div>}
          </fieldset>}
        </aside>
      </div>
      <section className="efb-preview" aria-label="Selection-driven route preview" data-testid="funnel-preview">
        <div className="efb-header"><div><h4>Test a route</h4><p className="efb-muted">Administrator simulation only. Enter sample ticket quantities or skip answers. Zero leaves an offer unanswered. No tickets are reserved or purchased.</p></div><Button type="button" variant="outline" size="sm" data-testid="funnel-run-preview" disabled={blocked || !!problems.length || invalidSampleQuantity || !onPreview} onClick={preview}><Play />{operation === 'preview' ? 'Checking…' : 'Check preview'}</Button></div>
        <fieldset disabled={operationBusy}>
          <label className="efb-check"><input data-testid="funnel-preview-checkout-now" type="checkbox" checked={checkoutNow} onChange={event => { invalidatePreview(); setCheckoutNow(event.target.checked); }} />Simulate checkout after source only (source selection is still required)</label>
          <div className="efb-samples">{graphNodes.filter(isPurchase).map(node => {
            const event = findEvent(catalog, node.event);
            const sample = samples[node.id] || {};
            return <div className="efb-sample" key={node.id} data-testid={`funnel-sample-${node.id}`}>
              <strong>{nodeLabel(node, graphNodes, catalog, tiers)}</strong><p className="efb-muted">{typeNames[node.type]}</p>
              {(node.ticketIds || []).map(id => <label className="efb-quantity" key={id}><span>{event?.tickets?.find(ticket => ticket.id === id)?.name || 'Previously selected ticket unavailable'}</span><input aria-label={`Sample quantity for ${nodeTitle(node, catalog, tiers)} — ${event?.tickets?.find(ticket => ticket.id === id)?.name || 'unavailable ticket'}`} data-testid={`funnel-quantity-${node.id}-${id}`} type="number" min="0" step="1" disabled={sample.skip} value={sample.quantities?.[id] ?? 0} onChange={change => {
                const quantity = change.target.value;
                invalidatePreview(); setSamples(current => ({ ...current, [node.id]: { ...current[node.id],
                  quantities: { ...(node.selectionMode === 'single' && Number(quantity) > 0 ? {} : current[node.id]?.quantities), [id]: quantity } } }));
              }} /></label>)}
              {node.type !== 'source' && <label className="efb-check"><input data-testid={`funnel-skip-${node.id}`} type="checkbox" checked={!!sample.skip} onChange={change => {
                const skip = change.target.checked;
                invalidatePreview(); setSamples(current => ({ ...current, [node.id]: { ...current[node.id], skip } }));
              }} />Sample answer: skip this offer</label>}
            </div>;
          })}
          {graphNodes.filter(node => node.type === 'membership').map(node => <div className="efb-sample" key={node.id} data-testid={`funnel-sample-${node.id}`}>
            <strong>{nodeLabel(node, graphNodes, catalog, tiers)}</strong><p className="efb-muted">{typeNames.membership}</p>
            <label className="efb-quantity"><span>Sample answer</span><select aria-label={`Sample answer for ${nodeTitle(node, catalog, tiers)}`} data-testid={`funnel-membership-sample-${node.id}`} value={samples[node.id]?.decision || ''} onChange={change => {
              const decision = change.target.value;
              invalidatePreview(); setSamples(current => ({ ...current, [node.id]: { decision } }));
            }}><option value="">Unanswered</option><option value="accept">Accept</option><option value="skip">Decline</option></select></label>
          </div>)}</div>
          <Button type="button" size="sm" variant="ghost" onClick={() => { invalidatePreview(); setSamples({}); setCheckoutNow(false); }}>Reset sample answers</Button>
        </fieldset>
        {previewError && <div className="efb-notice efb-error" role="alert" data-testid="funnel-preview-error">Server preview could not be completed. Sample answers are preserved; try again.</div>}
        {localPreview?.error && <div className="efb-notice" role="status">Preview unavailable: {describeFunnelIssue(localPreview.error, graph, catalog, tiers)}</div>}
        {routeResult && <div aria-live="polite" data-testid="funnel-preview-result">
          <p className="efb-muted">{serverPreview ? 'Confirmed preview' : 'Draft simulation'} · {routeResult.atCheckout ? 'Checkout reached' : 'Paused at an unanswered offer'}</p>
           <ol className="efb-route" aria-label="Preview route">{routeResult.route.map((id, index) => <li key={`${id}-${index}`}>{nodeLabel(graphNodes.find(node => node.id === id), graphNodes, catalog, tiers)}</li>)}</ol>
           <p className="efb-muted">Included at checkout: {[...(routeResult.retainedNodeIds || []), ...(routeResult.acceptedMembershipNodeIds || [])].map(id => nodeLabel(graphNodes.find(node => node.id === id), graphNodes, catalog, tiers)).join(', ') || 'None'}<br />Still awaiting an answer: {(routeResult.pendingNodeIds || []).map(id => nodeLabel(graphNodes.find(node => node.id === id), graphNodes, catalog, tiers)).join(', ') || 'None'}</p>
           {(routeResult.matchedRules || []).map(match => <p className="efb-muted" key={match.nodeId}>{nodeLabel(graphNodes.find(node => node.id === match.nodeId), graphNodes, catalog, tiers)}: {match.priority == null ? 'used the required fallback' : `matched priority ${match.priority}`}</p>)}
           {(routeResult.removed || []).map(item => <p className="efb-notice" key={item.nodeId}>{nodeLabel(graphNodes.find(node => node.id === item.nodeId), graphNodes, catalog, tiers)}: {describeFunnelIssue(item.reason, graph, catalog, tiers)}</p>)}
        </div>}
      </section>
    </>}
  </section></TiersContext.Provider>;
}

export default function EventFunnelBuilder(props) {
  return <Builder key={props.tenantId} {...props} />;
}
