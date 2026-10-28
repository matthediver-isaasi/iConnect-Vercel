import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Shared by JSDOM and browser tests. Mount the actual email-card JSX and actual
// edit handlers, without booting unrelated event forms, auth or entity lookups.
// Creation is intentionally limited to persisting settings after a synthetic ID.
export function eventEmailSurfaceFixtureSource() {
  const helpers = ["addEventEmail", "handleEmailRowEdited", "requeueReminders", "saveEventEmails"];
  const fixtures = ["CreateEvent", "EditEvent", "CreateComplexEvent"].map(name => {
    const source = readFileSync(`client/src/pages/${name}.jsx`, "utf8");
    const heading = source.indexOf("Email Configuration\n");
    assert.ok(heading > 0, `${name} email card exists`);
    const start = source.lastIndexOf("<Card ", heading);
    const end = source.indexOf("</Card>", heading) + "</Card>".length;
    const card = source.slice(start, end);
    assert.match(card, /button-add-follow-up-email/);
    const functions = name === "CreateEvent" ? "" : helpers.map(helper => {
      const from = source.indexOf(`  const ${helper} =`);
      assert.ok(from > 0);
      return source.slice(from, source.indexOf("\n  };", from) + "\n  };".length);
    }).join("\n");
    return `
export function ${name}Fixture({initial = [], editing = ${name === "EditEvent"}, programme = false, templates = []}) {
  const [eventEmails, setEventEmails] = useState(initial);
  const [emailSaveErrors, setEmailSaveErrors] = useState({});
  const [isSavingEmails, setIsSavingEmails] = useState(false);
  const [isRequeueingEmails, setIsRequeueingEmails] = useState(false);
  const eventId = editing ? "fixture-event" : null, editId = "fixture-event", isEditMode = editing;
  const isTraining = programme, agendaLines = programme ? [{}] : [];
  const emailTemplates = templates, eventTimezone = "Europe/London", DEFAULT_TIMEZONE = eventTimezone;
  const formData = {timezone: eventTimezone}, loadingEmails = false, isTimezoneLoading = false;
  const communicationCategories = [], setCommunicationCategories = () => {};
  const queryClient = {invalidateQueries: () => {}};
  ${functions}
  return <div>
    ${card}
    ${name === "CreateEvent" || name === "CreateComplexEvent" ? `<button data-testid="fixture-create" onClick={async () => { const saved = await putEventEmails("fixture-event", eventEmails, ${name === "CreateComplexEvent"}); if (saved.response.ok) setEventEmails(Array.isArray(saved.result) ? saved.result : saved.result.savedEmails); }}>Create fixture event</button>` : ""}
    <output data-testid="fixture-emails">{JSON.stringify(eventEmails)}</output>
  </div>;
}`;
  }).join("\n");
  return `
    import React, {useState} from "react";
    import EventEmailSettingsEditor, {createEmptyEmail, putEventEmails, findInvalidCcAddresses, formatSchedulingFailures, formatSkippedSummary, mapEmailSaveFailureDetails, getEmailRowLabel} from "@/components/events/EventEmailSettingsEditor";
    import {Card, CardHeader, CardTitle, CardDescription, CardContent} from "@/components/ui/card";
    import {Button} from "@/components/ui/button";
    import {Mail, Plus, Save, Loader2} from "lucide-react";
    import {toast} from "sonner";
    const EventRegistrationCommunication = () => null;
    export {createEmptyEmail, putEventEmails, getEmailRowLabel};
    ${fixtures}
  `;
}
