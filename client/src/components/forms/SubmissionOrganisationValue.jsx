import React from 'react';
import { resolveRepeatableOrganisationLabel } from '../../../../shared/repeatableFormRowsFormat.js';

// Historical answers must not depend on the form's current selectable options.
export default function SubmissionOrganisationValue({ value, namesById, loading, error }) {
  const values = Array.isArray(value) ? value : [value];
  const labels = values.map(id => namesById?.[id] || (
    loading ? 'Loading organisation…' : error
      ? 'Unable to load organisation name. Please try again.'
      : resolveRepeatableOrganisationLabel(id, namesById)
  ));
  return <p className="text-slate-900 dark:text-slate-100" data-testid="submission-organisation-value">{labels.join(', ')}</p>;
}