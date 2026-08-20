import React from 'react';
import { AlertTriangle, Users } from 'lucide-react';
import MemberGroupCard from '@/components/member-groups/MemberGroupCard';

function MemberGroupCardsEmptyState({ icon: Icon = Users, text, testId = 'member-group-cards-empty' }) {
  return (
    <div
      className="w-full min-h-[160px] flex flex-col items-center justify-center text-center px-6 py-8 text-slate-500"
      data-testid={testId}
    >
      <Icon className="w-8 h-8 mb-2 text-slate-400" aria-hidden="true" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

export default function MemberGroupCardsBlockView({
  block,
  groups,
  isAuthenticated,
  assignmentByGroup,
  openVacancyCountByGroup,
  groupAdminIds,
  isLoading,
  isError,
  errorMessage,
  accessRestricted,
  asEditor,
}) {
  const cards = Array.isArray(groups) ? groups : [];

  return (
    <div
      className="w-full h-full overflow-auto"
      aria-label={block?.a11y?.ariaLabel || 'Member groups'}
      data-testid="member-group-cards-block"
    >
      {accessRestricted ? (
        <MemberGroupCardsEmptyState
          icon={AlertTriangle}
          text="Member group access is not available for your account."
          testId="member-group-cards-restricted"
        />
      ) : isLoading ? (
        <div
          className="grid md:grid-cols-2 lg:grid-cols-3 gap-6"
          aria-busy="true"
          data-testid="member-group-cards-loading"
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="rounded-md border border-slate-200 bg-white overflow-hidden">
              <div className="aspect-[5/2] bg-slate-100 animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-slate-200 rounded animate-pulse w-2/3" />
                <div className="h-3 bg-slate-100 rounded animate-pulse w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div
          className="w-full min-h-[160px] flex items-center justify-center text-center px-6 py-8 text-rose-600"
          role="alert"
          data-testid="member-group-cards-error"
        >
          <p className="text-sm">{errorMessage || "Couldn't load member groups right now."}</p>
        </div>
      ) : cards.length === 0 ? (
        <MemberGroupCardsEmptyState text="There are no member groups open for self-join right now." />
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="member-group-cards-grid">
          {cards.map((group) => (
            <MemberGroupCard
              key={group.id}
              group={group}
              isAuthenticated={isAuthenticated}
              assignment={assignmentByGroup?.[group.id]}
              isGroupAdmin={groupAdminIds?.has(group.id)}
              openVacancyCount={openVacancyCountByGroup?.[group.id] || 0}
              asEditor={asEditor}
            />
          ))}
        </div>
      )}
    </div>
  );
}