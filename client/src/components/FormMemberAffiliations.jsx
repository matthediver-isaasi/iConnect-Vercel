import React from "react";
import { Link } from "react-router-dom";
import { Building2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function FormMemberAffiliations({ affiliation }) {
  const { summary, form, latest } = affiliation;
  const available = typeof form?.slug === "string" && form.slug.length > 0;
  return <Card className="border-slate-200 shadow-sm">
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5 text-blue-600" aria-hidden="true" />My affiliations</CardTitle>
      {affiliation.helpText && <CardDescription className="whitespace-pre-line">{affiliation.helpText}</CardDescription>}
    </CardHeader>
    <CardContent className="space-y-5">
      <dl data-testid="saved-affiliations" className="grid gap-4 text-sm sm:grid-cols-2 [overflow-wrap:anywhere]">
        <div><dt className="font-medium">Primary organisation</dt><dd className="mt-1 text-muted-foreground">{summary?.primary || "No primary organisation"}</dd></div>
        <div><dt className="font-medium">Group</dt><dd className="mt-1 text-muted-foreground">{summary?.group || "No group linked"}</dd></div>
        <div><dt className="font-medium">Secondary organisations</dt><dd className="mt-1 text-muted-foreground">{summary?.secondary?.length ? <ul className="space-y-1">{summary.secondary.map((name, index) => <li key={index}>{name}</li>)}</ul> : "No secondary organisations"}</dd></div>
        <div><dt className="font-medium">Departments</dt><dd className="mt-1 text-muted-foreground">{summary?.departments?.length ? <ul className="space-y-1">{summary.departments.map((name, index) => <li key={index}>{name}</li>)}</ul> : "No departments linked"}</dd></div>
      </dl>
      {latest?.status && <p className="text-sm text-muted-foreground">Latest submission status: <span className="font-medium">{latest.status.replace(/_/g, " ")}</span></p>}
      <div className="border-t pt-4">
        {available ? <Button asChild><Link to={`/forms/${encodeURIComponent(form.slug)}?affiliation_profile=1`}>{affiliation.title || "Update my affiliations"}<ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /></Link></Button> : <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">{affiliation.unavailableMessage || "Affiliation updates are not currently available for your profile."}</p>}
      </div>
    </CardContent>
  </Card>;
}
