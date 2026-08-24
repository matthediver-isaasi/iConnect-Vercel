import React from 'react';
import { AlertTriangle, Users } from 'lucide-react';
import MemberGroupCard from '@/components/member-groups/MemberGroupCard';
import { BREAKPOINT_MAX_PX } from '@/lib/canvasDesign';
import { resolveMemberGroupCardColumns } from '@/lib/memberGroupCards';

const MEMBER_GROUP_CARD_GAP = 24;

function isEditorBreakpoint(breakpoint) {
  return breakpoint === 'desktop' || breakpoint === 'tablet' || breakpoint === 'mobile';
}

export function buildMemberGroupCardsResponsiveCss(blockId, value) {
  const rawId = String(blockId || '');
  if (!rawId) return '';
  const escapedId = rawId
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\3c ')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ');
  const columns = resolveMemberGroupCardColumns(value);
  const selector = `[data-cb="${escapedId}"] [data-member-group-cards-grid]`;
  return [
    `${selector}{display:grid;gap:${MEMBER_GROUP_CARD_GAP}px;grid-template-columns:repeat(${columns.desktop},minmax(0,1fr));}`,
    `@media (max-width:${BREAKPOINT_MAX_PX.tablet}px){${selector}{grid-template-columns:repeat(${columns.tablet},minmax(0,1fr));}}`,
    `@media (max-width:${BREAKPOINT_MAX_PX.mobile}px){${selector}{grid-template-columns:repeat(${columns.mobile},minmax(0,1fr));}}`,
  ].join('');
}

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
  breakpoint,
  manualMode = false,
  selectedGroupCount = 0,
  roleHolderByGroup = {},
}) {
  const cards = Array.isArray(groups) ? groups : [];
  const columns = resolveMemberGroupCardColumns(block?.content?.columns);
  const editorPreview = isEditorBreakpoint(breakpoint);
  const activeColumns = columns[editorPreview ? breakpoint : 'desktop'];
  const gridStyle = editorPreview
    ? {
      display: 'grid',
      gridTemplateColumns: `repeat(${activeColumns}, minmax(0, 1fr))`,
      gap: MEMBER_GROUP_CARD_GAP,
    }
    : undefined;
  const responsiveCss = editorPreview
    ? ''
    : buildMemberGroupCardsResponsiveCss(block?.id, columns);
  const gridProps = {
    className: 'grid gap-6',
    style: gridStyle,
    'data-member-group-cards-grid': '',
  };

  return (
    <div
      className="w-full h-full overflow-auto"
      aria-label={block?.a11y?.ariaLabel || 'Member groups'}
      data-testid="member-group-cards-block"
    >
      {responsiveCss ? <style dangerouslySetInnerHTML={{ __html: responsiveCss }} /> : null}
      {accessRestricted ? (
        <MemberGroupCardsEmptyState
          icon={AlertTriangle}
          text="Member group access is not available for your account."
          testId="member-group-cards-restricted"
        />
      ) : isLoading ? (
        <div
          {...gridProps}
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
        <MemberGroupCardsEmptyState
          text={manualMode
            ? (selectedGroupCount > 0
              ? 'None of the selected member groups are currently available.'
              : 'Choose active member groups in the inspector.')
            : 'There are no member groups open for self-join right now.'}
        />
      ) : (
        <div {...gridProps} data-testid="member-group-cards-grid">
          {cards.map((group) => (
            <MemberGroupCard
              key={group.id}
              group={group}
              isAuthenticated={isAuthenticated}
              assignment={assignmentByGroup?.[group.id]}
              isGroupAdmin={groupAdminIds?.has(group.id)}
              openVacancyCount={openVacancyCountByGroup?.[group.id] || 0}
              asEditor={asEditor}
              featuredRole={roleHolderByGroup?.[group.id]?.role}
              roleHolders={roleHolderByGroup?.[group.id]?.holders}
            />
          ))}
        </div>
      )}
    </div>
  );
}