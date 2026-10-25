import { useMemo, useState } from 'react';
import { useEventWaitingList } from '@/hooks/useEventWaitingList';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const PAGE_SIZE = 25;
export default function EventWaitingListModal({ event, memberInfo, open, onOpenChange }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, refetch } = useEventWaitingList(memberInfo, {
    admin: true, eventId: event.id, eventKind: event.is_complex ? 'complex' : 'simple', enabled: open,
  });
  const entries = useMemo(() => (data?.entries || []).filter(row => row.status === 'active'), [data]);
  const filtered = useMemo(() => entries.filter(row =>
    [row.first_name, row.last_name, row.email, row.job_title, row.ticket_name].join(' ').toLowerCase().includes(search.trim().toLowerCase())
  ).sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`)), [entries, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const exportCsv = () => {
    const cell = value => `"${String(value || '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""')}"`;
    const csv = [['Name', 'Job Title', 'Email', 'Ticket'], ...filtered.map(row => [
      `${row.first_name || ''} ${row.last_name || ''}`.trim(), row.job_title, row.email, row.ticket_name,
    ])].map(row => row.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `waiting-list-${event.title.replace(/[^a-z0-9]/gi, '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Waiting List - {event.title}</DialogTitle>
        <DialogDescription>Active waiting-list entries for this event. These are expressions of interest, not confirmed bookings.</DialogDescription>
      </DialogHeader>
      {isError ? <div role="alert">Unable to load waiting list. <Button onClick={() => refetch()}>Retry</Button></div>
        : isLoading ? <p role="status">Loading waiting list…</p>
        : <>
          <p>Total waiting-list entries: {entries.length}</p>
          <div className="flex gap-3">
            <Input aria-label="Search waiting list" placeholder="Search waiting list by name, email, job title or ticket…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
            <Button variant="outline" onClick={exportCsv} disabled={!filtered.length}>Export CSV</Button>
          </div>
          {!filtered.length ? <p>{search ? 'No waiting-list entries match your search.' : 'No active waiting-list entries yet.'}</p>
            : <Table><TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Job Title</TableHead><TableHead>Email</TableHead><TableHead>Ticket</TableHead></TableRow></TableHeader>
              <TableBody>{filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(row => <TableRow key={row.id}>
                <TableCell>{`${row.first_name || ''} ${row.last_name || ''}`.trim()}</TableCell>
                <TableCell>{row.job_title || '—'}</TableCell><TableCell>{row.email}</TableCell><TableCell>{row.ticket_name || '—'}</TableCell>
              </TableRow>)}</TableBody></Table>}
          <div className="flex items-center justify-between">
            <span>{filtered.length} entries · Page {currentPage} of {pages}</span>
            <div className="flex gap-2"><Button variant="outline" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</Button>
              <Button variant="outline" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>Next</Button></div>
          </div>
        </>}
    </DialogContent>
  </Dialog>;
}
