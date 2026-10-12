import { Eye, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function uniqueQuoteVersions(versions = []) {
  const unique = new Map();
  for (const item of versions) {
    const number = Number(item.versionNumber ?? item.version_number ?? item.version);
    if (Number.isInteger(number) && number > 0 && !unique.has(number)) unique.set(number, { ...item, number });
  }
  return [...unique.values()].sort((a, b) => b.number - a.number);
}

export default function QuoteVersionDocuments({ versions, currentVersion, onPdf, pending, dirty }) {
  return <Card><CardHeader><CardTitle className="text-base">Version PDFs</CardTitle></CardHeader><CardContent className="space-y-3">
    {!versions.length && <p className="text-sm text-slate-500">No versions available.</p>}
    {versions.map(item => <div key={item.number} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <p className="text-sm font-medium">Version {item.number}{String(item.number) === String(currentVersion) ? " · Current" : ""}<span className="ml-2 font-normal capitalize text-slate-500">{item.status}</span></p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={pending || (dirty && String(item.number) === String(currentVersion))}
          aria-label={`Preview PDF version ${item.number}`} onClick={() => onPdf({ preview: true, version: item.number })}><Eye className="mr-2 h-4 w-4" />Preview PDF</Button>
        <Button variant="outline" size="sm" disabled={pending || (dirty && String(item.number) === String(currentVersion))}
          aria-label={`Download PDF version ${item.number}`} onClick={() => onPdf({ preview: false, version: item.number })}><Download className="mr-2 h-4 w-4" />Download PDF</Button>
      </div>
    </div>)}
    {pending && <p role="status" className="text-sm text-slate-500">Preparing PDF…</p>}
    {dirty && <p className="text-xs text-slate-500">Save changes before generating the current version’s PDF. Previous versions remain available.</p>}
  </CardContent></Card>;
}
