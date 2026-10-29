import { useId, useState } from 'react';
import DOMPurify from 'dompurify';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export default function CodeOfConductAcceptance({ policy }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!policy?.required) return null;
  return <>
    <div className="flex items-start gap-2" data-testid="code-of-conduct-acceptance">
      <Checkbox id={id} checked={policy.accepted} onCheckedChange={policy.setAccepted}
        data-testid="checkbox-code-of-conduct" />
      <div className="text-sm text-slate-600 leading-tight">
        <label htmlFor={id} className="cursor-pointer">I agree to the Code of Conduct.</label>{' '}
        <button type="button" onClick={() => setOpen(true)}
          className="text-blue-600 hover:text-blue-800 underline" data-testid="link-code-of-conduct">View Code of Conduct</button>
      </div>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Code of Conduct</DialogTitle></DialogHeader>
        <div className="prose prose-sm max-w-none ql-editor"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(policy.content) }} />
      </DialogContent>
    </Dialog>
  </>;
}
