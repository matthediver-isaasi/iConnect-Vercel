import { Badge } from '@/components/ui/badge';

const labels = {
  missing: 'No invoice linked', pending: 'Invoice pending', blocked: 'Invoice blocked',
  unavailable: 'Status unavailable', not_required: 'No invoice required',
};
export default function MembershipInvoiceAvailability({ record }) {
  const availability = record.invoice_availability || {
    status: 'unavailable', message: 'Invoice request status could not be loaded.',
  };
  return <div className="text-center space-y-1" data-testid={`invoice-availability-${record.id}`}>
    <Badge variant={availability.status === 'blocked' ? 'destructive' : 'outline'}>
      {labels[availability.status] || 'Status unavailable'}
    </Badge>
    <p className="text-xs text-muted-foreground max-w-56 mx-auto">{availability.message}</p>
  </div>;
}
