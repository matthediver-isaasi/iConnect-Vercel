import React, { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import JudgingReview from './JudgingReview';

export default function JudgingApplication({ application, assignmentId, authority }) {
  const [accessFailure, setAccessFailure] = useState(null);
  const scopeKey = JSON.stringify([assignmentId, authority?.scopeKey]);
  const unavailable = accessFailure?.scopeKey === scopeKey;
  const fields = Array.isArray(application.fields) ? application.fields : [];
  const attachments = Array.isArray(application.attachments) ? application.attachments : [];
  return <Card className="min-w-0 shadow-sm">
    <CardHeader className="border-b"><p className="awards-kicker mb-2">Assigned review version</p><CardTitle className="text-xl break-words">{unavailable ? 'Application evidence unavailable' : `Application ${application.reference}`}</CardTitle>
      <p className="awards-help flex items-start gap-2"><LockKeyhole className="h-4 w-4 shrink-0 mt-0.5" />Only the fields authorised for this assessment are shown.</p>
    </CardHeader>
    <CardContent className="pt-6">
      {unavailable ? <p role="alert" className="text-sm text-destructive">Access to this review evidence could not be verified. Previously loaded application fields and files are no longer shown. Return to your assignment list and reopen this assignment after access is restored. Your assessment draft has not been changed.</p>
        : <JudgingReview review={{ fields, attachments }} assignmentId={assignmentId} authority={authority}
          onAccessLost={() => setAccessFailure({ scopeKey })} />}
    </CardContent>
  </Card>;
}
