// Standalone, in-memory browser fixture only. Not imported by app routing.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import FormPrefillBoundary from '../components/forms/FormPrefillBoundary';
import FormRenderer from '../components/forms/FormRenderer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { useFormFieldPrefill } from './useFormFieldPrefill';
import { combinePrefillStates } from './formPrefillBarrier';
import { publicClient } from '../api/publicClient';

const form = { id: 'browser-fixture', slug: 'browser-fixture',
  prefill_source: 'form_field', prefill_source_field_id: 'organisation',
  fields: [
    { id: 'organisation', type: 'organisation_dropdown' },
    { id: 'name', type: 'text', label: 'Full name', prefill_field: 'org:name' },
    { id: 'email', type: 'email', label: 'Email address', prefill_field: 'org:email' },
    { id: 'job', type: 'text', label: 'Job title' },
  ] };
let resolve, reject;
let attempts = 0, submits = 0;
publicClient.getFormFieldPrefill = () => {
  attempts++;
  return new Promise((yes, no) => { resolve = yes; reject = no; });
};
window.prefillFixture = {
  resolve: () => resolve({ values: { name: 'Maya Reed', email: 'maya@example.invalid' } }),
  reject: () => reject(new Error('Fixture lookup failed')),
  attempts: () => attempts, submits: () => submits,
};
// Deny even unexpected reads in this isolated fixture.
window.fetch = async () => { throw new Error('Network requests are forbidden in this fixture'); };

function Fixture() {
  const [values, setValues] = useState({ organisation: 'fixture-org', job: 'Keep this draft answer' });
  const state = useFormFieldPrefill({ form, formValues: values, setFormValues: setValues, protectedFieldIds: ['job'] });
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="mx-auto max-w-2xl">
        <FormPrefillBoundary state={combinePrefillStates(state)}>
          <Card>
            <CardHeader>
              <CardTitle>Member details</CardTitle>
              <CardDescription>Please check your details before continuing.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-5" onSubmit={event => { event.preventDefault(); if (!state.pending && !state.error) submits++; }}>
                {form.fields.filter(field => field.id !== 'organisation').map(field => (
                  <FormRenderer key={field.id} field={field} value={values[field.id] || ''}
                    onChange={value => setValues(previous => ({ ...previous, [field.id]: value }))} />
                ))}
                <Button type="submit" className="w-full">Submit</Button>
              </form>
            </CardContent>
          </Card>
        </FormPrefillBoundary>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
);
