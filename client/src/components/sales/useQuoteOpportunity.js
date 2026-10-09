import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

export const opportunitySearchParams = (search, page) => new URLSearchParams({
  active: "true", search, page: String(page), pageSize: "25",
});

export function opportunityDetail(payload) {
  return payload?.opportunity || payload?.data?.opportunity || payload?.data || payload;
}

export function opportunityContacts(payload) {
  const detail = opportunityDetail(payload);
  const roles = detail?.["contact-roles"] || payload?.contactRoles || payload?.contact_roles || detail?.contactRoles || detail?.contact_roles || detail?.contacts || [];
  return roles.map((role) => {
    const person = role.contact || role.member || role;
    return {
      ...role,
      id: role.contact?.id || role.member?.id || role.member_id || role.memberId || role.id,
      name: person.name || [person.first_name, person.last_name].filter(Boolean).join(" ") || person.email || "Contact",
    };
  }).filter((contact) => contact.id);
}

export function clearOpportunityContacts(form, opportunityId) {
  return { ...form, opportunityId, organizationId: "", customerContactId: "", billingContactId: "" };
}

export function applyQuoteOpportunity(form, detail) {
  // The detail DTO is rooted at the opportunity, with enriched primaryContact
  // and a hyphenated contact-roles collection. Never use the role row ID.
  const contacts = opportunityContacts(detail);
  const primary = detail.primaryContact?.id || detail.primary_contact_id
    || contacts.find((contact) => contact.is_primary || contact.isPrimary || String(contact.role || "").toLowerCase().includes("primary"))?.id || "";
  return {
    ...form,
    organizationId: detail.organization_id || detail.organizationId || detail.organization?.id || "",
    currency: detail.currency || "GBP",
    customerContactId: primary,
    billingContactId: primary,
  };
}

export function useQuoteOpportunity({ opportunityId, isNew, setForm, request }) {
  const [appliedId, setAppliedId] = useState("");
  const initializedId = useRef("");
  const query = useQuery({
    queryKey: ["quote-opportunity", opportunityId],
    queryFn: async ({ signal }) => {
      const detail = opportunityDetail(await request(`/api/opportunities/${encodeURIComponent(opportunityId)}`, { signal }));
      if (!detail?.id || String(detail.id) !== String(opportunityId)) throw new Error("Could not load the selected opportunity.");
      return detail;
    },
    enabled: Boolean(opportunityId),
    retry: false,
  });
  useEffect(() => {
    initializedId.current = "";
    setAppliedId("");
    if (isNew) setForm((old) => old.opportunityId === opportunityId ? clearOpportunityContacts(old, opportunityId) : old);
  }, [opportunityId, isNew, setForm]);
  useEffect(() => {
    if (!isNew || !query.isSuccess || !query.data || initializedId.current === opportunityId) return;
    const selected = opportunityId;
    setForm((old) => old.opportunityId === selected ? applyQuoteOpportunity(old, query.data) : old);
    initializedId.current = selected;
    setAppliedId(selected);
  }, [opportunityId, isNew, query.data, query.isSuccess, setForm]);
  return {
    ...query,
    ready: Boolean(opportunityId && query.isSuccess && (!isNew || appliedId === opportunityId)),
    contacts: query.isSuccess ? opportunityContacts(query.data) : [],
  };
}
