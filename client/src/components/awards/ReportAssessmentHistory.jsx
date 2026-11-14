import { useState } from 'react';
import { Label } from '@/components/ui/label';
import AssessmentHistory from './AssessmentHistory';

export default function ReportAssessmentHistory({ roundId, tenant, applications }) {
  const [applicationId, setApplicationId] = useState('');
  const [accessDenied, setAccessDenied] = useState(false);
  const selected = applications.find(application => application.id === applicationId);
  const references = new Map();
  for (const application of applications) references.set(application.reference, (references.get(application.reference) || 0) + 1);
  return <section className="rounded-lg border p-4 space-y-4" aria-label="Report-authorised submitted assessment history">
    <div><h3 className="font-semibold">Review past submitted assessments</h3><p className="awards-help mt-2">Read-only access through your reporting permission. No application-management, moderation or approval role is required. Choose an application discovered in this complete server report snapshot; this list is independent of local report filters.</p></div>
    <div className="awards-field"><Label htmlFor="report-history-application">Application for submitted history</Label><select id="report-history-application" className="awards-select" value={applicationId} disabled={accessDenied || !applications.length} onChange={event => {
      const id = event.target.value;
      setApplicationId(applications.some(application => application.id === id) ? id : '');
    }}><option value="">Choose a reported application</option>{applications.map(application => <option key={application.id} value={application.id}>{application.reference}{references.get(application.reference) > 1 ? ` · ${application.id}` : ''}</option>)}</select>
      <p className="awards-help">{applications.length} applications in the complete report snapshot. Reloading the report clears this history selection and revalidates access; report filters and export choices are kept. No application is automatically selected.</p>
    </div>
    {accessDenied ? <p role="alert" className="text-sm text-red-800">Submitted history access could not be verified. All previously loaded history has been cleared. Use “Reload complete report” to reconcile current reporting authority, then explicitly select an application again. No additional role or guessed application ID is substituted.</p>
      : selected ? <><p className="text-sm font-medium whitespace-pre-wrap break-words">Selected application: {selected.reference}</p><AssessmentHistory key={`${tenant.scopeKey}:${roundId}:${selected.id}`} tenant={tenant} roundId={roundId} applicationId={selected.id} enabled onAccessDenied={() => setAccessDenied(true)} /></>
        : <div className="rounded-lg border p-5"><h4 className="text-sm font-semibold">{applications.length ? 'Select an application to read its submitted history' : 'No applications in this snapshot'}</h4><p className="awards-help mt-2">{applications.length ? 'Original submitted revisions, versioned rubrics and immutable evidence references will appear here. Drafts and raw judge identities are never requested.' : 'The complete server report returned no applications. Reload explicitly if new applications are expected; no IDs are invented.'}</p></div>}
  </section>;
}
