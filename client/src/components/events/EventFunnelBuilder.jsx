import React, { useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType } from '@xyflow/react';
import { GitBranch, Plus, Save, Upload, Trash2, Play, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { evaluateFunnelRoute } from '../../../../shared/eventFunnelGraph.mjs';
import { createFunnelDraft, draftFingerprint, eventKey, eventReference, findEvent, graphConnections, graphIssues, isPurchase, nodeTitle, earlierPurchaseNodes, purchaseVisibilityPatch, purchaseVisibilityIssues } from './eventFunnelBuilderModel.mjs';
import '@xyflow/react/dist/style.css';
import './EventFunnelBuilder.css';

const clone = value => JSON.parse(JSON.stringify(value));
const typeNames = { source: 'Source event', event: 'Further event', addon: 'Event add-on', condition: 'Condition', checkout: 'Checkout' };

function Field({ label, children }) {
  return <label className="efb-field"><span>{label}</span>{children}</label>;
}

function EventChoice({ value, catalog, tenantId, onChange, label = 'Event' }) {
  const known = findEvent(catalog, value);
  return <Field label={label}><select aria-label={label} data-testid="funnel-event-choice" value={eventKey(value)} onChange={event => {
    const choice = catalog.find(item => eventKey(item) === event.target.value);
    onChange(eventReference(choice, tenantId));
  }}>
    <option value="">Choose an event</option>
    {value && !known && <option value={eventKey(value)}>Missing {value.kind} event: {value.id}</option>}
    {catalog.map(item => <option key={eventKey(item)} value={eventKey(item)}>{item.title} · {item.kind}{item.status ? ` · ${item.status}` : ''}</option>)}
  </select></Field>;
}

function Destination({ label, value, nodes, catalog, onChange }) {
  return <Field label={label}><select aria-label={label} value={value || ''} onChange={event => onChange(event.target.value)}>
    <option value="">Choose a destination</option>
    {value && !nodes.some(node => node.id === value) && <option value={value}>Missing node: {value}</option>}
    {nodes.map(node => <option key={node.id} value={node.id}>{nodeTitle(node, catalog)} · {node.id.slice(0, 8)}</option>)}
  </select></Field>;
}

function FunnelNode({ data, selected }) {
  const { node, title, detail, ports, inRoute } = data;
  return <div className={`efb-node ${node.type} ${selected ? 'is-selected' : ''} ${inRoute ? 'is-route' : ''}`} data-testid={`funnel-node-${node.id}`}>
    {node.type !== 'source' && <Handle type="target" position={Position.Top} aria-label="Incoming route" />}
    <span className="efb-node-kind">{typeNames[node.type] || node.type}</span>
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

function PurchaseInspector({ node, nodes, catalog, tenantId, update }) {
  const event = findEvent(catalog, node.event);
  const tickets = event?.tickets || [];
  const ticketIds = node.ticketIds || [];
  const unknownTickets = ticketIds.filter(id => !tickets.some(ticket => ticket.id === id));
  const toggleTicket = id => update({ ticketIds: ticketIds.includes(id) ? ticketIds.filter(value => value !== id) : [...ticketIds, id] });
  const prerequisites = node.requires || [];
  const earlierPurchases = earlierPurchaseNodes(nodes, node.id);
  const unavailablePrerequisites = prerequisites.filter(id => !earlierPurchases.some(other => other.id === id));
  const visibilityIssues = purchaseVisibilityIssues(node, nodes);
  return <>
    <EventChoice value={node.event} catalog={catalog} tenantId={tenantId} onChange={value => update({ event: value, ticketIds: [] })} label="Offered event" />
    <div className="efb-field"><span>Offered ticket classes</span>
      <p className="efb-muted">Only these tickets are offered here. Event identity and settings stay unchanged.</p>
      {!tickets.length && <p className="efb-notice">Choose an event with ticket classes.</p>}
      {tickets.map(ticket => <label className="efb-check" key={ticket.id}><input type="checkbox" checked={ticketIds.includes(ticket.id)} onChange={() => toggleTicket(ticket.id)} />{ticket.name}</label>)}
      {unknownTickets.map(id => <label className="efb-check" key={id}><input type="checkbox" checked onChange={() => toggleTicket(id)} />Missing ticket: {id} (uncheck to remove)</label>)}
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
      <p className="efb-muted">Select the explicit prerequisite purchases below. Checkout-only offers need at least one earlier selected node; a previous booking in a different checkout does not qualify.</p>
      <p className="efb-muted">Visibility does not grant purchase permission. Event audience, ticket eligibility, availability and same-checkout prerequisites are checked by the server.</p>
      {visibilityIssues.map(issue => <p key={issue} role="alert" className="efb-notice efb-error">{issue}</p>)}
    </div>}
    {node.type !== 'source' && <div className="efb-field"><span>Required earlier purchases</span>
      <p className="efb-muted">{node.type === 'addon' ? 'An add-on must require an earlier source or further event with the same event identity and different tickets.' : 'If a required purchase is not retained, this offer follows its skip connection.'}</p>
      {earlierPurchases.map(other => <label className="efb-check" key={other.id}><input type="checkbox" checked={prerequisites.includes(other.id)} onChange={() => update({ requires: prerequisites.includes(other.id) ? prerequisites.filter(id => id !== other.id) : [...prerequisites, other.id] })} />{nodeTitle(other, catalog)} · {other.id.slice(0, 8)}</label>)}
      {!earlierPurchases.length && <p className="efb-muted">Connect an earlier purchase to this offer to select a prerequisite.</p>}
      {unavailablePrerequisites.map(id => <label className="efb-check" key={id}><input type="checkbox" checked onChange={() => update({ requires: prerequisites.filter(value => value !== id) })} />
        {nodes.some(other => other.id === id) ? 'Not a connected earlier purchase' : 'Missing prerequisite'}: {id} (uncheck to remove)</label>)}
    </div>}
    <Destination label={node.type === 'source' ? 'Continue to' : 'Accept → destination / rejoin'} value={node.accept} nodes={nodes} catalog={catalog} onChange={accept => update({ accept })} />
    {node.type !== 'source' && <Destination label="Skip → destination / rejoin" value={node.skip} nodes={nodes} catalog={catalog} onChange={skip => update({ skip })} />}
  </>;
}

function ConditionInspector({ node, nodes, catalog, tenantId, update }) {
  const rules = node.rules || [];
  const updateRule = (index, patch) => update({ rules: rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  const newTest = () => ({ event: eventReference(catalog[0], tenantId), selected: true });
  return <>
    <p className="efb-muted">The lowest matching priority wins. Test only earlier offered events or tickets; a required fallback handles every other answer.</p>
    {rules.map((rule, index) => <div className="efb-rule" key={index} data-testid={`funnel-rule-${index}`}>
      <div className="efb-row" style={{ justifyContent: 'space-between' }}><strong className="efb-muted">Rule {index + 1}</strong>
        <Button type="button" size="sm" variant="ghost" aria-label={`Remove rule ${index + 1}`} onClick={() => update({ rules: rules.filter((_, i) => i !== index) })}><Trash2 /></Button>
      </div>
      <Field label={`Rule ${index + 1} priority`}><input type="number" min="0" step="1" value={rule.priority ?? ''} onChange={event => updateRule(index, { priority: event.target.value === '' ? null : Number(event.target.value) })} /></Field>
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
            {test.ticketId && !tickets.some(ticket => ticket.id === test.ticketId) && <option value={test.ticketId}>Missing ticket: {test.ticketId}</option>}
            {tickets.map(ticket => <option key={ticket.id} value={ticket.id}>{ticket.name}</option>)}
          </select></Field>
          <Field label={`Rule ${index + 1}, test ${testIndex + 1} selection`}><select value={String(test.selected)} onChange={event => patchTest({ selected: event.target.value === 'true' })}><option value="true">Is selected</option><option value="false">Is not selected</option></select></Field>
          <Button type="button" variant="ghost" size="sm" onClick={() => updateRule(index, { tests: rule.tests.filter((_, i) => i !== testIndex) })}>Remove test {testIndex + 1}</Button>
        </div>;
      })}
      <Button type="button" size="sm" variant="outline" onClick={() => updateRule(index, { tests: [...(rule.tests || []), newTest()] })}><Plus />Add test</Button>
      <div style={{ marginTop: 12 }}><Destination label={`Rule ${index + 1} destination`} value={rule.to} nodes={nodes} catalog={catalog} onChange={to => updateRule(index, { to })} /></div>
    </div>)}
    <Button type="button" size="sm" variant="outline" onClick={() => update({ rules: [...rules, { priority: Math.max(-1, ...rules.map(rule => Number(rule.priority) || 0)) + 1, match: 'all', tests: [newTest()], to: nodes.find(item => item.type === 'checkout')?.id || '' }] })}><Plus />Add rule</Button>
    <div style={{ marginTop: 14 }}><Destination label="Required fallback destination" value={node.fallback} nodes={nodes} catalog={catalog} onChange={fallback => update({ fallback })} /></div>
  </>;
}

function Builder({ tenantId, catalog = [], definitions = [], busy = false, unavailable = null, onSave, onPreview, onPublish }) {
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [localDefinitions, setLocalDefinitions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
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
  const locked = busy || !!operation;
  const blocked = locked || !!unavailable;
  const availableDefinitions = [...localDefinitions, ...definitions.filter(item => !localDefinitions.some(local => local.id === item.id))];
  const graph = draft?.graph;
  const graphNodes = graph?.nodes || [];
  const selected = graphNodes.find(node => node.id === selectedId);
  const dirty = !!draft && draftFingerprint(draft) !== baseline;
  const issues = useMemo(() => graph ? graphIssues(graph, catalog, tenantId) : [], [graph, catalog, tenantId]);
  const problems = draft && !draft.name?.trim() ? ['Give this funnel a name.', ...issues] : issues;
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
    decisions: Object.fromEntries(graphNodes.filter(node => ['event', 'addon'].includes(node.type) && samples[node.id]?.skip).map(node => [node.id, 'skip'])),
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
    invalidatePreview(); setMessage(null); setDraft(current => fn(current));
  }
  function updateNode(patch) {
    changeDraft(current => ({ ...current, graph: { ...current.graph, nodes: current.graph.nodes.map(node => node.id === selectedId ? { ...node, ...patch } : node) } }));
  }
  function loadDefinition(definition, isNew = false) {
    if (dirty && !window.confirm('Discard unsaved changes to this funnel?')) return;
    const next = clone(definition);
    next.layout = next.layout || { positions: {} };
    setDraft(next); setBaseline(isNew ? '' : draftFingerprint(next)); setSelectedId(next.graph?.entry || null);
    setSamples({}); setCheckoutNow(false); setConfirmDelete(false); setMessage(null); invalidatePreview();
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
    const choice = type === 'addon' ? findEvent(catalog, related?.event)
      : catalog.find(event => !graphNodes.some(node => isPurchase(node) && eventKey(node.event) === eventKey(event))) || catalog[0];
    const usedTickets = graphNodes.filter(node => eventKey(node.event) === eventKey(choice)).flatMap(node => node.ticketIds || []);
    const firstTicket = choice?.tickets?.find(ticket => !usedTickets.includes(ticket.id));
    const owner = graphNodes.find(item => ['source', 'event'].includes(item.type) && eventKey(item.event) === eventKey(choice));
    const destination = anchor?.type === 'condition' ? anchor.fallback : anchor?.accept;
    const next = destination || checkoutId;
    const node = type === 'condition'
      ? { id, type, rules: [{ priority: 0, match: 'all', tests: [{ event: related?.event || eventReference(catalog[0], tenantId), selected: true }], to: next }], fallback: next }
      : { id, type, event: eventReference(choice, tenantId), ticketIds: firstTicket ? [firstTicket.id] : [], requires: type === 'addon' && owner ? [owner.id] : [], accept: next, skip: next };
    changeDraft(current => ({
      ...current,
      graph: { ...current.graph, nodes: [...current.graph.nodes.map(item => item.id !== anchor?.id ? item : item.type === 'condition' ? { ...item, fallback: id } : { ...item, accept: id }), node] },
      layout: { positions: { ...(current.layout?.positions || {}), [id]: { x: 370 + (graphNodes.length % 2) * 50, y: 80 + (graphNodes.length - 2) * 150 } } },
    }));
    setSelectedId(id); setConfirmDelete(false);
  }
  async function save() {
    if (blocked || !draft || problems.length || operationLock.current || !onSave) return;
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
    } catch (error) { setMessage({ kind: 'error', text: `Could not save. ${error?.message || 'Please retry.'} Your edits are still here.` }); }
    finally { setOperation(null); operationLock.current = false; }
  }
  async function publish() {
    if (blocked || !draft || dirty || !draft.revision || problems.length || operationLock.current || !onPublish) return;
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
    } catch (error) { setMessage({ kind: 'error', text: `Could not publish. ${error?.message || 'Please retry.'} Your draft has not been discarded.` }); }
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
    } catch (error) { if (generation === requestGeneration.current) setPreviewError(error?.message || 'Preview failed. Retry with the same sample answers.'); }
    finally { setOperation(null); operationLock.current = false; }
  }

  const connections = graphConnections(graph);
  const flowNodes = graphNodes.map((node, index) => ({
    id: node.id, type: 'funnel', selected: selectedId === node.id,
    position: draft?.layout?.positions?.[node.id] || { x: 80 + (index % 2) * 300, y: 60 + Math.floor(index / 2) * 180 },
    data: { node, title: nodeTitle(node, catalog),
      detail: isPurchase(node) ? `${(node.ticketIds || []).length} ticket classes · ${node.event?.kind || 'No event'}`
        : node.type === 'condition' ? `${(node.rules || []).length} rules · lowest priority first` : 'One checkout · event identity retained',
      ports: connections.filter(edge => edge.source === node.id).map(edge => ({ id: edge.sourceHandle, label: edge.label, short: edge.sourceHandle.startsWith('rule-') ? `P${node.rules[Number(edge.sourceHandle.slice(5))]?.priority}` : edge.label })),
      inRoute: routeResult?.route?.includes(node.id),
    },
  }));
  const flowEdges = connections.filter(edge => graphNodes.some(node => node.id === edge.target)).map((edge, index) => ({
    ...edge, id: `${edge.source}-${edge.sourceHandle}-${index}`, type: 'smoothstep', deletable: false, reconnectable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#72879a' },
    style: { stroke: routeResult?.route?.some((id, i, route) => id === edge.source && route[i + 1] === edge.target) ? '#43846a' : '#8a9cab', strokeWidth: 1.5 },
    labelStyle: { fontSize: 11, fill: '#42586b' }, labelBgStyle: { fill: '#f7f9fb' },
  }));

  return <section className="event-funnel-builder" aria-label="Event funnel builder" data-testid="event-funnel-builder">
    <div className="efb-header">
      <div><h3 className="efb-row"><GitBranch size={19} />Event funnels</h3><p className="efb-muted">Offer parking, lunch and further events without changing each event’s identity.</p></div>
      <div className="efb-actions">
        <Button type="button" variant="outline" size="sm" data-testid="funnel-new" disabled={locked} onClick={() => loadDefinition(createFunnelDraft(tenantId), true)}><Plus />New funnel</Button>
        <Button type="button" size="sm" variant="outline" data-testid="funnel-save" disabled={blocked || !draft || !!problems.length || !dirty || !onSave} onClick={save}><Save />{operation === 'save' ? 'Saving…' : 'Save draft'}</Button>
        <Button type="button" size="sm" data-testid="funnel-publish" disabled={blocked || !draft?.revision || dirty || !!problems.length || !onPublish} onClick={publish}><Upload />{operation === 'publish' ? 'Publishing…' : 'Publish saved draft'}</Button>
      </div>
    </div>
    {unavailable && <div role="alert" className="efb-notice efb-error" data-testid="funnel-unavailable">{unavailable} Saving, publishing and server preview are unavailable. In-progress edits are preserved.</div>}
    {message && <div role={message.kind === 'error' ? 'alert' : 'status'} className={`efb-notice efb-${message.kind}`} data-testid="funnel-operation-message">{message.text}</div>}
    <Field label="Saved funnel"><select data-testid="funnel-definition-choice" disabled={locked} value={draft && availableDefinitions.some(item => item.id === draft.id) ? draft.id : ''} onChange={event => {
      const definition = availableDefinitions.find(item => item.id === event.target.value);
      if (definition) loadDefinition(definition);
    }}><option value="">{draft ? 'New unsaved funnel' : 'Select a saved funnel or create one'}</option>
      {availableDefinitions.map(item => <option key={item.id} value={item.id}>{item.name} · revision {item.revision}{item.published_version_id ? ' · published' : ' · draft'}</option>)}
    </select></Field>
    {!draft ? busy ? <div className="efb-skeleton" role="status" aria-label="Loading event funnels" /> : <div className="efb-empty"><GitBranch size={28} style={{ margin: '0 auto 10px' }} /><h3>No funnel selected</h3><p className="efb-muted">Start with a source event and one checkout, then connect additional offers and conditions.</p><Button type="button" variant="outline" size="sm" style={{ marginTop: 12 }} onClick={() => loadDefinition(createFunnelDraft(tenantId), true)}>Create a funnel</Button></div> : <>
      <fieldset disabled={locked}>
        <div className="efb-settings">
          <Field label="Funnel name"><input data-testid="funnel-name" maxLength={120} value={draft.name || ''} onChange={event => changeDraft(current => ({ ...current, name: event.target.value }))} /></Field>
          <Field label="Reservation duration (seconds)"><input data-testid="funnel-reservation" type="number" min="60" max="3600" step="1" value={graph.reservationSeconds ?? ''} onChange={event => changeDraft(current => ({ ...current, graph: { ...current.graph, reservationSeconds: event.target.value === '' ? null : Number(event.target.value) } }))} /></Field>
          <Field label="Invoice mode"><select data-testid="funnel-invoice-mode" value={graph.invoiceMode || ''} onChange={event => changeDraft(current => ({ ...current, graph: { ...current.graph, invoiceMode: event.target.value } }))}>
            {!['per_event', 'consolidated'].includes(graph.invoiceMode) && <option value={graph.invoiceMode || ''}>Unknown: {graph.invoiceMode || '(missing)'}</option>}
            <option value="per_event">Separate invoice per event</option><option value="consolidated">Consolidated invoice</option>
          </select></Field>
        </div>
      </fieldset>
      <div className="efb-row efb-muted"><span>{dirty ? 'Unsaved changes' : `Saved revision ${draft.revision}`}</span><span>·</span><span>{graphNodes.length} / 100 nodes</span><span>·</span><span>Reservation: 60–3600 seconds</span></div>
      {problems.length > 0 ? <div className="efb-notice" data-testid="funnel-validation" role="status"><strong>Finish these details before saving or publishing</strong><ul style={{ paddingLeft: 18, marginTop: 5 }}>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div> : <div className="efb-notice efb-success" data-testid="funnel-validation"><span className="efb-row"><CheckCircle2 size={15} />Graph structure and catalog references are valid. The server validates again on save and publish.</span></div>}
      <div className="efb-toolbar"><span className="efb-muted">Insert after selected node</span>
        {['event', 'addon', 'condition'].map(type => <Button type="button" variant="outline" size="sm" key={type} disabled={locked || graphNodes.length >= 100} data-testid={`funnel-add-${type}`} onClick={() => addNode(type)}><Plus />{typeNames[type]}</Button>)}
        <span className="efb-muted">Drag nodes to arrange. Drag labelled ports to connect. Routes may rejoin.</span>
      </div>
      <div className="efb-grid">
        <div className="efb-canvas" data-testid="funnel-canvas">
          <ReactFlow key={draft.id} nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} onInit={instance => { flowRef.current = instance; }} fitView fitViewOptions={{ padding: .25 }} minZoom={.15} maxZoom={2} nodesDraggable={!locked} nodesConnectable={!locked} elementsSelectable onNodeClick={(_, node) => { setSelectedId(node.id); setConfirmDelete(false); }} onPaneClick={() => { setSelectedId(null); setConfirmDelete(false); }} onNodesChange={changes => {
            if (locked) return;
            const positions = changes.filter(change => change.type === 'position' && change.position);
            const selection = changes.find(change => change.type === 'select' && change.selected);
            if (selection) setSelectedId(selection.id);
            if (positions.length) setDraft(current => ({ ...current, layout: { positions: { ...(current.layout?.positions || {}), ...Object.fromEntries(positions.map(change => [change.id, change.position])) } } }));
          }} onConnect={connection => {
            if (!locked && connection.source && connection.target && connection.sourceHandle) setDestination(connection.source, connection.sourceHandle, connection.target);
          }} isValidConnection={connection => connection.source !== connection.target && graphNodes.find(node => node.id === connection.target)?.type !== 'source'} deleteKeyCode={null} proOptions={{ hideAttribution: false }} aria-label="Event funnel graph">
            <Background gap={20} size={1} color="#cbd7e0" /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor={node => node.data.inRoute ? '#83b49a' : node.data.node.type === 'condition' ? '#d8bb83' : '#a9c4d5'} />
          </ReactFlow>
        </div>
        <aside className="efb-inspector" aria-label="Selected node settings" data-testid="funnel-inspector">
          {!selected ? <div className="efb-empty"><h4>Select a node</h4><p className="efb-muted">Choose an offer, condition or checkout to inspect its configuration.</p></div> : <fieldset disabled={locked}>
            <h4>{typeNames[selected.type] || 'Unknown node'}</h4><p className="efb-muted" style={{ overflowWrap: 'anywhere', marginBottom: 16 }}>ID: {selected.id}</p>
            {isPurchase(selected) && <PurchaseInspector node={selected} nodes={graphNodes} catalog={catalog} tenantId={tenantId} update={updateNode} />}
            {selected.type === 'condition' && <ConditionInspector node={selected} nodes={graphNodes} catalog={catalog} tenantId={tenantId} update={updateNode} />}
            {selected.type === 'checkout' && <p className="efb-muted">All routes must end at this checkout. Only eligible retained purchases are included. The reservation and invoice settings above apply to this funnel.</p>}
            {!typeNames[selected.type] && <div className="efb-notice efb-error">This saved node type is not supported. Its data has been preserved.</div>}
            {!['source', 'checkout'].includes(selected.type) && <div style={{ marginTop: 20 }}>
              {!confirmDelete ? <Button type="button" variant="outline" size="sm" data-testid="funnel-delete-node" onClick={() => setConfirmDelete(true)}><Trash2 />Remove node</Button> : <div className="efb-notice efb-error" role="alert"><p>Remove this node? Incoming references will remain visible as missing destinations until you reconnect them.</p><div className="efb-actions" style={{ marginTop: 8 }}><Button type="button" variant="destructive" size="sm" onClick={() => {
                changeDraft(current => {
                  const positions = { ...(current.layout?.positions || {}) }; delete positions[selectedId];
                  return { ...current, graph: { ...current.graph, nodes: current.graph.nodes.filter(node => node.id !== selectedId) }, layout: { positions } };
                });
                setSelectedId(null); setConfirmDelete(false);
              }}>Remove</Button><Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button></div></div>}
            </div>}
          </fieldset>}
        </aside>
      </div>
      <section className="efb-preview" aria-label="Selection-driven route preview" data-testid="funnel-preview">
        <div className="efb-header"><div><h4>Test a route</h4><p className="efb-muted">Administrator simulation only. Enter sample ticket quantities or skip answers. Zero leaves an offer unanswered. No tickets are reserved or purchased.</p></div><Button type="button" variant="outline" size="sm" data-testid="funnel-run-preview" disabled={blocked || !!problems.length || invalidSampleQuantity || !onPreview} onClick={preview}><Play />{operation === 'preview' ? 'Checking…' : 'Check server preview'}</Button></div>
        <fieldset disabled={locked}>
          <label className="efb-check"><input data-testid="funnel-preview-checkout-now" type="checkbox" checked={checkoutNow} onChange={event => { invalidatePreview(); setCheckoutNow(event.target.checked); }} />Simulate checkout after source only (source selection is still required)</label>
          <div className="efb-samples">{graphNodes.filter(isPurchase).map(node => {
            const event = findEvent(catalog, node.event);
            const sample = samples[node.id] || {};
            return <div className="efb-sample" key={node.id} data-testid={`funnel-sample-${node.id}`}>
              <strong>{nodeTitle(node, catalog)}</strong><p className="efb-muted">{typeNames[node.type]} · {node.id.slice(0, 8)}</p>
              {(node.ticketIds || []).map(id => <label className="efb-quantity" key={id}><span>{event?.tickets?.find(ticket => ticket.id === id)?.name || `Missing ticket: ${id}`}</span><input aria-label={`Sample quantity for ${node.id} ticket ${id}`} data-testid={`funnel-quantity-${node.id}-${id}`} type="number" min="0" step="1" disabled={sample.skip} value={sample.quantities?.[id] ?? 0} onChange={change => {
                const quantity = change.target.value;
                invalidatePreview(); setSamples(current => ({ ...current, [node.id]: { ...current[node.id], quantities: { ...current[node.id]?.quantities, [id]: quantity } } }));
              }} /></label>)}
              {node.type !== 'source' && <label className="efb-check"><input data-testid={`funnel-skip-${node.id}`} type="checkbox" checked={!!sample.skip} onChange={change => {
                const skip = change.target.checked;
                invalidatePreview(); setSamples(current => ({ ...current, [node.id]: { ...current[node.id], skip } }));
              }} />Sample answer: skip this offer</label>}
            </div>;
          })}</div>
          <Button type="button" size="sm" variant="ghost" onClick={() => { invalidatePreview(); setSamples({}); setCheckoutNow(false); }}>Reset sample answers</Button>
        </fieldset>
        {previewError && <div className="efb-notice efb-error" role="alert" data-testid="funnel-preview-error">Server preview failed: {previewError} Sample answers are preserved; use Check server preview to retry.</div>}
        {localPreview?.error && <div className="efb-notice" role="status">Preview unavailable: {localPreview.error}</div>}
        {routeResult && <div aria-live="polite" data-testid="funnel-preview-result">
          <p className="efb-muted">{serverPreview ? 'Server-confirmed preview' : 'Local simulation · not yet server-confirmed'} · {routeResult.atCheckout ? 'Checkout reached' : 'Paused at an unanswered offer'}</p>
          <ol className="efb-route" aria-label="Preview route">{routeResult.route.map((id, index) => <li key={`${id}-${index}`}>{index + 1}. {nodeTitle(graphNodes.find(node => node.id === id), catalog)} · {id.slice(0, 8)}</li>)}</ol>
          <p className="efb-muted">Retained: {(routeResult.retainedNodeIds || []).map(id => `${nodeTitle(graphNodes.find(node => node.id === id), catalog)} (${id.slice(0, 8)})`).join(', ') || 'None'}<br />Pending downstream answers: {(routeResult.pendingNodeIds || []).map(id => `${nodeTitle(graphNodes.find(node => node.id === id), catalog)} (${id.slice(0, 8)})`).join(', ') || 'None'}</p>
          {(routeResult.matchedRules || []).map(match => <p className="efb-muted" key={match.nodeId}>Condition {match.nodeId.slice(0, 8)}: {match.priority == null ? 'fallback' : `matched priority ${match.priority}`}</p>)}
          {(routeResult.removed || []).map(item => <p className="efb-notice" key={item.nodeId}>{nodeTitle(graphNodes.find(node => node.id === item.nodeId), catalog)}: {item.reason}</p>)}
        </div>}
      </section>
    </>}
  </section>;
}

export default function EventFunnelBuilder(props) {
  return <Builder key={props.tenantId} {...props} />;
}
