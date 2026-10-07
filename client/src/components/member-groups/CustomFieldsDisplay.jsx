import React from 'react';
import { populatedCustomFieldDisplay, formatCustomFieldValue } from '@/lib/memberGroupCustomFields.mjs';

export default function CustomFieldsDisplay({ fields }) {
  return populatedCustomFieldDisplay(fields).map((field) => (
    <React.Fragment key={field.id}>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-1">{field.name}</h2>
      <div className="text-slate-700 mb-4 prose prose-sm max-w-none whitespace-pre-wrap break-words" data-testid={`text-group-custom-field-${field.id}`}>
        {formatCustomFieldValue(field.value)}
      </div>
    </React.Fragment>
  ));
}
