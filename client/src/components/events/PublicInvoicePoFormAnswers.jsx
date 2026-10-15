import { extractSubmissionEmail, normalizeSubmissionEmail, submissionAnswer, submissionForm } from "@/lib/publicInvoicePoFormAnswers";

export default function PublicInvoicePoFormAnswers({ group, email, submissions = [], formsById = {}, labels = {} }) {
  const matching = submissions.filter(submission => {
    const form = submissionForm(submission, formsById);
    return email && String(form.related_event_id || submission.event_id) === String(group.eventId)
      && normalizeSubmissionEmail(extractSubmissionEmail(submission, form.fields)) === normalizeSubmissionEmail(email);
  });
  return <div className="space-y-3">
    {matching.length === 0 ? <p className="text-sm text-muted-foreground">No linked form submissions found for this email.</p> :
      matching.map((submission, index) => {
        const form = submissionForm(submission, formsById);
        const data = submission.submission_data || {};
        return <section key={submission.id || index} className="rounded-md border p-3 space-y-2">
          <h4 className="text-sm font-medium">{form.title || form.name || "Registration form"}</h4>
          <p className="text-xs text-muted-foreground">Linked by event and email{submission.created_at ? ` · Submitted ${new Date(submission.created_at).toLocaleString()}` : ""}</p>
          {(form.fields || []).filter(field => field?.id).map(field => <div key={field.id} className="text-sm">
            <p className="text-muted-foreground">{field.label || field.id}</p>
            <p className="whitespace-pre-wrap break-words">{submissionAnswer(field, data, labels) || "Not supplied"}</p>
          </div>)}
        </section>;
      })}
  </div>;
}
