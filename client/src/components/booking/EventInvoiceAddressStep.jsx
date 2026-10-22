import React, { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { INVOICING_ADDRESS_FIELDS } from "../../../../shared/invoicingAddress.js";
import { discoverEventInvoiceAddress, invoiceAddressDraft, personalInvoiceAddressSelection } from "../../lib/eventInvoiceAddress.mjs";

const cancelled = () => Object.assign(new Error("Invoice address collection cancelled."), { name: "AbortError" });
const requiredFields = new Set(["invoicing_address_line1", "invoicing_city", "invoicing_postal_code", "invoicing_country"]);

// The promise belongs to one checkout attempt, not to a member or organisation
// record. Cancellation and scope changes invalidate every outstanding continuation.
export function useEventInvoiceAddress({ scopeKey, eventId, source, request }) {
  const [state, setState] = useState(null);
  const pending = useRef(null);
  const liveScope = useRef(scopeKey);
  liveScope.current = scopeKey;
  const cancel = () => {
    const work = pending.current;
    pending.current = null;
    work?.controller?.abort();
    work?.reject(cancelled());
    setState(null);
  };
  useEffect(() => {
    return () => {
      const work = pending.current;
      pending.current = null;
      work?.controller?.abort();
      work?.reject(cancelled());
    };
  }, [scopeKey]);
  // Do not retain an old address on screen after changing member/event.
  useEffect(() => { setState(null); }, [scopeKey]);

  const load = async work => {
    if (pending.current !== work || liveScope.current !== work.scopeKey || work.loading) return;
    work.loading = true;
    setState({ loading: true });
    try {
      const data = await discoverEventInvoiceAddress(request, {
        eventId, source, signal: work.controller.signal,
      });
      if (pending.current !== work || liveScope.current !== work.scopeKey) return;
      if (!data.required) {
        if (work.forceRequired) throw new Error("Invoice requirements changed. Cancel and retry checkout to check again.");
        pending.current = null;
        setState(null);
        work.resolve(undefined);
      } else {
        setState({ data });
      }
    } catch (error) {
      if (pending.current === work && liveScope.current === work.scopeKey) {
        setState({ error: error.message || "Unable to check invoice addresses. Please retry." });
      }
    } finally {
      work.loading = false;
    }
  };
  const collect = ({ forceRequired = false } = {}) => {
    if (pending.current) return Promise.reject(new Error("Invoice address check is already in progress."));
    return new Promise((resolve, reject) => {
      const work = { resolve, reject, forceRequired, scopeKey, controller: new AbortController() };
      pending.current = work;
      void load(work);
    });
  };
  const choose = selection => {
    const work = pending.current;
    if (!work || work.scopeKey !== liveScope.current) return;
    pending.current = null;
    setState(null);
    work.resolve(selection);
  };
  return {
    collect,
    step: state ? <Dialog open onOpenChange={open => { if (!open) cancel(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose invoice address</DialogTitle>
          <DialogDescription>This address is for your invoice, not card verification. It will not update your member or organisation record.</DialogDescription>
        </DialogHeader>
        <EventInvoiceAddressForm state={state} onChoose={choose} onCancel={cancel}
          onRetry={() => { if (pending.current) void load(pending.current); }} />
      </DialogContent>
    </Dialog> : null,
  };
}

export function EventInvoiceAddressForm({ state, onChoose, onCancel, onRetry }) {
  const [mode, setMode] = useState("personal");
  const [draft, setDraft] = useState(() => invoiceAddressDraft(state.data?.personalAddress));
  const [error, setError] = useState("");
  const submitted = useRef(false);
  useEffect(() => {
    setDraft(invoiceAddressDraft(state.data?.personalAddress));
    setMode("personal");
    setError("");
    submitted.current = false;
  }, [state.data]);
  const submit = event => {
    event.preventDefault();
    if (submitted.current) return;
    try {
      const selection = mode === "organization" && state.data.organizationAddress
        ? { mode: "organization" } : personalInvoiceAddressSelection(draft);
      submitted.current = true;
      onChoose(selection);
    } catch (err) { setError(err.message); }
  };
  return <form onSubmit={submit} className="space-y-4">
    {state.loading ? <p role="status">Checking invoice requirements…</p> : state.error ? <>
      <p role="alert">{state.error}</p>
      <button type="button" onClick={onRetry} className="underline">Retry address check</button>
    </> : state.data ? <>
      <fieldset className="space-y-3">
        <legend className="font-medium">Address to use for this invoice</legend>
        <label className="block"><input type="radio" name="invoice-address-mode" value="personal"
          checked={mode === "personal"} onChange={() => setMode("personal")} /> Personal address (editable)</label>
        {state.data.organizationAddress && <label className="block"><input type="radio" name="invoice-address-mode" value="organization"
          checked={mode === "organization"} onChange={() => setMode("organization")} /> {state.data.organizationLabel || "Linked organisation"} address (read-only)</label>}
      </fieldset>
      {mode === "personal" ? INVOICING_ADDRESS_FIELDS.map(({ key, label, maxLength }) =>
        <label key={key} className="block text-sm">{label}{requiredFields.has(key) ? " *" : ""}
          <input className="mt-1 block w-full rounded-md border p-2" name={key} value={draft[key]}
            maxLength={maxLength} required={requiredFields.has(key)}
            onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
        </label>) : <div className="whitespace-pre-line rounded-md border p-3" aria-label="Organisation invoice address">
        {state.data.organizationAddress.source === "legacy" ? state.data.organizationAddress.address :
          INVOICING_ADDRESS_FIELDS.map(({ key }) => state.data.organizationAddress.address[key]).filter(Boolean).join("\n")}
      </div>}
      {error && <p role="alert">{error}</p>}
      <button type="submit" className="rounded-md bg-primary px-4 py-2 text-primary-foreground">Continue to card payment</button>
    </> : null}
    <button type="button" className="ml-3 underline" onClick={onCancel}>Cancel</button>
  </form>;
}
