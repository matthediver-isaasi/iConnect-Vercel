import React, { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { uniqueGroupPersonCount } from '@/lib/memberGroupAutomaticSync';

// Mounted only for an open group and keyed by its ID to reset each search session.
export default function AllMembersDialog({ group, assignments, hasHiddenExpiredAssignments = false, getAssigneeName, renderAssignmentRow, onClose }) {
  const [search, setSearch] = useState('');
  const inputRef = useRef(null);
  const query = search.trim().toLowerCase();
  const matches = assignments.filter((assignment) =>
    getAssigneeName(assignment).toLowerCase().includes(query));
  const total = uniqueGroupPersonCount(assignments);
  const count = uniqueGroupPersonCount(matches);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] flex flex-col overflow-hidden p-4 sm:p-6">
        <DialogHeader className="shrink-0 text-left pr-6">
          <DialogTitle className="break-words leading-snug">Members — {group.name}</DialogTitle>
          <DialogDescription>Search members and guests in this group.</DialogDescription>
        </DialogHeader>
        <div className="shrink-0 space-y-2">
          <Label htmlFor="all-members-search">Search by name</Label>
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              id="all-members-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Member or guest name"
              aria-controls="all-members-results"
              className="min-w-0"
            />
            {search && (
              <Button variant="outline" onClick={() => { setSearch(''); inputRef.current?.focus(); }}>
                Clear
              </Button>
            )}
          </div>
          <p role="status" className="text-sm text-slate-500">
            {query ? `${count} of ${total} people match` : `${total} ${total === 1 ? 'person' : 'people'}`}
          </p>
        </div>
        <div id="all-members-results" aria-label="Group members" tabIndex={0}
          className="space-y-1 min-h-0 overflow-y-auto overscroll-contain flex-1"
          data-testid="list-all-members">
          {matches.length > 0
            ? matches.map((assignment) => renderAssignmentRow(assignment, { compact: true }))
            : <p className="py-4 text-sm text-slate-500">
              {assignments.length === 0
                ? (hasHiddenExpiredAssignments
                  ? 'All assignments are expired. Turn on Show expired members on the group card to view them.'
                  : 'No members in this group.')
                : 'No members or guests match your search.'}
            </p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}