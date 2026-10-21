import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import BadgeInstructionsSettings from "../components/BadgeInstructionsSettings";
import BadgeInstructionsHelpLink from "../components/BadgeInstructionsHelpLink";
import { setActiveTenantId } from "../api/base44Client";
import "../index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
setActiveTenantId("badge-fixture-a");
createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <main className="max-w-3xl mx-auto p-4 space-y-4">
        <h1 className="text-2xl font-bold">Badge instructions fixture</h1>
        <button onClick={() => setActiveTenantId("badge-fixture-b")}>Switch fixture tenant</button>
        <BadgeInstructionsSettings />
        <BadgeInstructionsHelpLink />
      </main>
    </MemoryRouter>
  </QueryClientProvider>,
);
