import React from "react";
import { MapPin } from "lucide-react";

const NAME_ALIASES = new Map([
  ["address", "address"],
  ["postal_address", "address"],
  ["postaladdress", "address"],
  ["registered_address", "address"],
  ["registeredaddress", "address"],
  ["address_line_1", "line1"],
  ["address_line1", "line1"],
  ["address_1", "line1"],
  ["address1", "line1"],
  ["street_address", "line1"],
  ["streetaddress", "line1"],
  ["address_line_2", "line2"],
  ["address_line2", "line2"],
  ["address_2", "line2"],
  ["address2", "line2"],
  ["address_line_3", "line3"],
  ["address_line3", "line3"],
  ["address_3", "line3"],
  ["address3", "line3"],
  ["post_town", "city"],
  ["posttown", "city"],
  ["town_city", "city"],
  ["address_town_city", "city"],
  ["address_city", "city"],
  ["town", "city"],
  ["city", "city"],
  ["county", "region"],
  ["address_county", "region"],
  ["region", "region"],
  ["state", "region"],
  ["postcode", "postcode"],
  ["post_code", "postcode"],
  ["address_post_code", "postcode"],
  ["address_postcode", "postcode"],
  ["postal_code", "postcode"],
  ["postalcode", "postcode"],
  ["zip", "postcode"],
  ["zip_code", "postcode"],
  ["zipcode", "postcode"],
  ["country", "country"],
  ["address_country", "country"],
]);

const COMPONENT_ORDER = ["line1", "line2", "line3", "city", "region", "postcode", "country"];
const ADDRESS_ANCHORS = new Set(["address", "line1", "postcode"]);

function metadataName(field) {
  return String(field?.name || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function scalar(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function structuredAddressComponents(value) {
  const parsed = parseObject(value);
  if (!parsed) {
    const lines = scalar(value).split(/\r?\n/).map(part => part.trim()).filter(Boolean);
    const postcodeIndex = lines.findIndex(line => (
      /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(line)
    ));
    const postcode = postcodeIndex >= 0 ? lines[postcodeIndex] : "";
    const addressLines = lines.filter((_, index) => index !== postcodeIndex);
    return Object.fromEntries(
      [
        ...addressLines.slice(0, 3).map((line, index) => [`line${index + 1}`, line]),
        ...(postcode ? [["postcode", postcode]] : []),
      ],
    );
  }
  const valueFor = (aliases) => {
    for (const alias of aliases) {
      const candidate = scalar(parsed[alias]);
      if (candidate) return candidate;
    }
    return "";
  };
  return {
    line1: valueFor(["line_1", "line1", "address_line_1", "addressLine1", "address1", "street"]),
    line2: valueFor(["line_2", "line2", "address_line_2", "addressLine2", "address2"]),
    line3: valueFor(["line_3", "line3", "address_line_3", "addressLine3", "address3"]),
    city: valueFor(["post_town", "town_city", "town", "city"]),
    region: valueFor(["county", "region", "state"]),
    postcode: valueFor(["postcode", "post_code", "postal_code", "postalCode", "zip"]),
    country: valueFor(["country"]),
  };
}

/**
 * Build a postal block from the directory response's explicit authorised core
 * address plus organisation custom fields already authorised for this
 * directory. Stable field names, rather than editable labels, provide custom
 * field semantics. A custom region/country alone is not treated as an address.
 */
export function buildOrganisationPostalSummary(fields, values, coreAddress) {
  const valueByFieldId = new Map(
    (values || []).map(item => [String(item.field_id), item.value]),
  );
  const candidates = (fields || [])
    .filter(field => field?._visBack !== false)
    .map(field => ({
      field,
      component: NAME_ALIASES.get(metadataName(field)),
      value: valueByFieldId.get(String(field.id)),
    }))
    .filter(item => item.component && (
      scalar(item.value) !== "" || parseObject(item.value)
    ));

  const components = new Map(COMPONENT_ORDER.map(component => [component, []]));
  const coreComponents = structuredAddressComponents(coreAddress);
  for (const component of COMPONENT_ORDER) {
    const value = scalar(coreComponents[component]);
    if (value) components.get(component).push(value);
  }
  const hasCoreAddress = COMPONENT_ORDER.some(component => (
    scalar(coreComponents[component]) !== ""
  ));
  if (!hasCoreAddress && !candidates.some(item => ADDRESS_ANCHORS.has(item.component))) {
    return null;
  }
  for (const item of candidates) {
    if (item.component === "address") {
      const structured = structuredAddressComponents(item.value);
      for (const component of COMPONENT_ORDER) {
        const value = scalar(structured[component]);
        if (value) components.get(component).push(value);
      }
    } else {
      const value = scalar(item.value);
      if (value) components.get(item.component).push(value);
    }
  }
  const seen = new Set();
  const lines = COMPONENT_ORDER.flatMap(component => components.get(component))
    .filter(value => {
      const canonical = value.toLocaleLowerCase();
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });
  if (!lines.length) return null;
  return {
    fieldIds: candidates.map(item => String(item.field.id)),
    lines,
  };
}

export const ORGANISATION_POSTAL_ORDER_KEY = "__organisation_postal_address__";

/**
 * Replace the contributing custom fields with one postal block immediately
 * before related record details. Every unrelated key retains its
 * relative order. Without related sources, the block stays at its first field's
 * configured position.
 */
export function placeOrganisationPostalSummary(order, sources, summary) {
  if (!summary?.lines?.length) return order || [];
  const postalKeys = new Set(summary.fieldIds.map(id => `custom:${id}`));
  const original = order || [];
  const firstPostalIndex = original.findIndex(key => postalKeys.has(key));
  const remaining = original.filter(key => !postalKeys.has(key));
  const sourceKeys = new Set((sources || []).map(source => source.key));
  let insertAt = remaining.findIndex(key => sourceKeys.has(key));
  if (insertAt < 0) {
    const keysBeforePostal = original
      .slice(0, firstPostalIndex < 0 ? original.length : firstPostalIndex)
      .filter(key => !postalKeys.has(key));
    insertAt = keysBeforePostal.length;
  }
  return [
    ...remaining.slice(0, insertAt),
    ORGANISATION_POSTAL_ORDER_KEY,
    ...remaining.slice(insertAt),
  ];
}

export default function OrganisationPostalSummary({ summary }) {
  if (!summary?.lines?.length) return null;
  return (
    <section
      className="space-y-2 pt-2 border-t"
      data-testid="organisation-postal-address"
    >
      <div className="flex items-center gap-2">
        <MapPin className="w-4 h-4 text-blue-600" />
        <h4 className="font-medium text-slate-900">Postal address</h4>
      </div>
      <address className="min-w-0 text-left text-sm not-italic leading-6 text-slate-700 [overflow-wrap:anywhere]">
        {summary.lines.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}
      </address>
    </section>
  );
}