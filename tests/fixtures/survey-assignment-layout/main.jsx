import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import Panel from "@/components/surveys/SurveyEventAssignmentsPanel";

const mode = new URLSearchParams(location.search).get("mode");
const first = {
  id: "active", form_id: "survey", event_id: "event", event_type: "event",
  event_title: "Annual multidisciplinary conference on clinical practice, research and professional development for the international membership community",
  event_start_date: "2026-10-10T12:00:00Z", token: "fixture-active",
  survey_version_id: "v1", response_count: 12,
  first_response_at: "2026-10-10T12:00:00Z", last_response_at: "2026-10-11T12:00:00Z",
  opens_at: "2020-01-01T00:00:00Z", closes_at: "2099-12-31T00:00:00Z",
  access_mode: "authenticated",
};
window.fixtureRead = async name => {
  if (name === "EventSurveyAssignment") {
    if (mode === "loading") return new Promise(() => {});
    if (mode === "error") throw Error("Fixture list failure");
    if (mode === "empty") return [];
    return [
      first,
      { ...first, id: "removed", status: "removed", response_count: 0, event_id: null, complex_event_id: "complex", event_type: "complex_event", event_title: "Removed assignment with retained history", token: "fixture-removed" },
      { ...first, id: "deleted", event_id: null, event_title: "Deleted event " + "UnbrokenTitle".repeat(25), survey_version_id: null, access_mode: "public", response_count: 0 },
    ];
  }
  if (mode === "version-error") throw Error("Fixture version failure");
  if (name === "Form") return [{ id: "survey", survey_settings: { status: "published", current_version: 2, has_unpublished_changes: true } }];
  if (name === "SurveyVersion") return [1, 2].map(n => ({ id: `v${n}`, form_id: "survey", version_number: n }));
  throw Error(`Unexpected entity: ${name}`);
};
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={client}><BrowserRouter>
    <main className="mx-auto max-w-5xl p-4 sm:p-6"><Panel formId="survey" /></main>
    <Toaster />
  </BrowserRouter></QueryClientProvider>
);
