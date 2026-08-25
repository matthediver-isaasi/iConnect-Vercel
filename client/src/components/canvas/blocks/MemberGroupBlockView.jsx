import React from 'react';
import { ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DirectoryMemberCard } from '@/components/directory/DirectoryCards';
import { sanitizeRichText } from './sanitize';
import { useReportReflowHeight } from '../AccordionReflowContext';

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function resolveMemberGroupGrid(content, breakpoint) {
  const columns = content?.columns || {};
  const desktop = clampInteger(columns.desktop, 1, 6, 1);
  const columnCount = clampInteger(columns[breakpoint], 1, 6, desktop);
  const rows = clampInteger(content?.rows, 1, 6, 1);
  return { columns: columnCount, rows, pageSize: columnCount * rows };
}

export function guardEditorCardClick(event) {
  event.preventDefault();
  event.stopPropagation();
}

function LoadingGrid({ count, columns, gap }) {
  return (
    <div
      className="w-full"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap,
      }}
      aria-busy="true"
      data-testid="member-group-loading"
    >
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="rounded-md border border-slate-200 bg-white overflow-hidden">
          <div className="h-20 bg-slate-100 animate-pulse" />
          <div className="p-3 space-y-2">
            <div className="h-3 bg-slate-200 rounded animate-pulse w-2/3" />
            <div className="h-3 bg-slate-100 rounded animate-pulse w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div
      className="w-full min-h-[120px] flex flex-col items-center justify-center text-center px-6 py-8 text-slate-500"
      data-testid="member-group-empty"
    >
      <Users className="w-8 h-8 mb-2 text-slate-400" aria-hidden="true" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

function ErrorState({ message }) {
  return (
    <div
      className="w-full min-h-[120px] flex items-center justify-center text-center px-6 py-8 text-rose-600"
      role="alert"
      data-testid="member-group-error"
    >
      <p className="text-sm">{message}</p>
    </div>
  );
}

export default function MemberGroupBlockView({
  block,
  content,
  group,
  records,
  displaySettings,
  columns,
  pageSize,
  currentPage,
  total,
  isLoading,
  isError,
  errorMessage,
  isFetching,
  asEditor,
  onPrevious,
  onNext,
}) {
  const c = content || {};
  const members = Array.isArray(records) ? records : [];
  const reflowRef = useReportReflowHeight(
    block?.id,
    (block?.style?.paddingTop || 0) + (block?.style?.paddingBottom || 0),
    { includeExtraHeightPublic: true },
  );
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / pageSize));
  const H = `h${Math.max(1, Math.min(6, Number(c.headingLevel) || 2))}`;
  const cardGuard = asEditor ? { onClickCapture: guardEditorCardClick } : {};
  const controlGuard = asEditor
    // Canvas selection starts on pointer-down. Stopping click during capture
    // would also prevent the pagination button's own onClick from firing.
    ? { onPointerDownCapture: (event) => event.stopPropagation() }
    : {};

  return (
    <TooltipProvider>
      <div
        ref={reflowRef}
        className="w-full"
        aria-label={block?.a11y?.ariaLabel || group?.name || 'Member group'}
        data-testid="member-group-block"
      >
        {c.showGroupName !== false && group?.name ? (
          <H className="text-xl font-semibold mb-3 text-slate-900">{group.name}</H>
        ) : null}
        {c.showGroupDescription !== false && group?.description ? (
          <div
            className="text-sm text-slate-600 mb-4 prose prose-sm max-w-none"
            data-testid="member-group-description"
            dangerouslySetInnerHTML={{ __html: sanitizeRichText(group.description) }}
          />
        ) : null}

        {isError ? (
          <ErrorState message={errorMessage || "Couldn't load this member group right now."} />
        ) : c.showMembers === false ? null : isLoading ? (
          <LoadingGrid count={Math.min(pageSize, 6)} columns={columns} gap={c.gap ?? 16} />
        ) : members.length === 0 ? (
          <EmptyState text={c.emptyText || 'No group members to show yet.'} />
        ) : (
          <>
            <ul
              className="list-none m-0 p-0"
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: c.gap ?? 16,
              }}
              data-testid="member-group-list"
            >
              {members.map((member) => (
                <li key={member.id} {...cardGuard}>
                  <DirectoryMemberCard
                    member={member}
                    role={member.group_role ? { name: member.group_role } : undefined}
                    organization={member.organization_name ? { name: member.organization_name } : undefined}
                    displaySettings={displaySettings || {}}
                    isGuest={true}
                  />
                </li>
              ))}
            </ul>

            {totalPages > 1 ? (
              <nav
                className="flex items-center justify-center gap-4 mt-6"
                aria-label={`${group?.name || 'Member group'} member pages`}
                {...controlGuard}
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1 || isFetching}
                  onClick={onPrevious}
                  data-testid="button-member-group-prev"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Previous
                </Button>
                <span
                  className="text-sm text-slate-600"
                  aria-live="polite"
                  aria-atomic="true"
                  data-testid="text-member-group-page"
                >
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages || isFetching}
                  onClick={onNext}
                  data-testid="button-member-group-next"
                >
                  Next <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </Button>
              </nav>
            ) : null}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}