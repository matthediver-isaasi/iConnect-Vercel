import React from 'react';
import { ArrowRight, ImageIcon, Lock, Wand2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { sanitizeRichText } from '@/components/canvas/blocks/sanitize';
import { createPageUrl } from '@/utils';
import {
  buildMemberGroupCardDestination,
  isMemberGroupCardActivationKey,
} from '@/lib/memberGroupCards';

export function guardMemberGroupCardEditorInteraction(event) {
  event.preventDefault();
  event.stopPropagation();
}

export default function MemberGroupCard({
  group,
  isAuthenticated,
  assignment,
  isGroupAdmin,
  openVacancyCount = 0,
  asEditor = false,
  onNavigate,
}) {
  const navigate = useNavigate();
  const hasAssignment = !!assignment;
  const hasCurrentAssignment = hasAssignment && (
    !assignment.expires_at || new Date(assignment.expires_at) > new Date()
  );
  const groupId = group?.id;
  // Legacy card callers pre-date the explicit flag and are self-join cards.
  // Only a deliberate false value identifies a managed-membership card.
  const isSelfJoinGroup = group?.allow_self_join !== false;
  const isJoined = isSelfJoinGroup ? hasAssignment : hasCurrentAssignment;
  const canOpenDetail = isSelfJoinGroup || (
    !!isAuthenticated && (hasCurrentAssignment || isGroupAdmin)
  );

  const activate = () => {
    if (!groupId || !canOpenDetail) return;
    const destination = buildMemberGroupCardDestination({
      groupId,
      isAuthenticated,
      detailPath: createPageUrl('MemberGroupDetail'),
    });
    if (onNavigate) {
      onNavigate(destination);
      return;
    }
    if (!isAuthenticated) {
      window.location.href = destination;
      return;
    }
    navigate(destination);
  };

  const handleCardClick = (event) => {
    if (asEditor) {
      guardMemberGroupCardEditorInteraction(event);
      return;
    }
    activate();
  };

  const handleCardKeyDown = (event) => {
    if (!isMemberGroupCardActivationKey(event.key)) return;
    if (asEditor) {
      guardMemberGroupCardEditorInteraction(event);
      return;
    }
    event.preventDefault();
    activate();
  };

  const handleCtaClick = (event) => {
    event.stopPropagation();
    if (asEditor) {
      event.preventDefault();
      return;
    }
    activate();
  };

  if (!groupId) return null;

  return (
    <Card
      className={`overflow-hidden flex flex-col ${canOpenDetail ? 'cursor-pointer hover-elevate' : ''}`}
      onClick={handleCardClick}
      role={canOpenDetail ? 'link' : undefined}
      tabIndex={canOpenDetail ? 0 : undefined}
      onKeyDown={handleCardKeyDown}
      data-testid={`card-group-${groupId}`}
      data-canvas-editor={asEditor ? 'true' : undefined}
    >
      <div className="relative w-full aspect-[5/2] bg-slate-100">
        {isAuthenticated && openVacancyCount > 0 && (
          <div className="absolute top-2 right-2 z-10">
            <Badge
              className="bg-green-100 text-green-700 text-xs"
              data-testid={`badge-open-vacancies-${groupId}`}
            >
              {openVacancyCount > 1 ? `${openVacancyCount} open vacancies` : 'Open vacancies'}
            </Badge>
          </div>
        )}
        {group.header_image_url ? (
          <img
            src={group.header_image_url}
            alt={group.name}
            className="w-full h-full object-cover"
            onError={(event) => {
              event.currentTarget.onerror = null;
              event.currentTarget.style.display = 'none';
            }}
            data-testid={`img-group-header-${groupId}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-300">
            <ImageIcon className="w-12 h-12" />
          </div>
        )}
      </div>
      <CardContent className="p-4 flex flex-col flex-1">
        <h3
          className="text-lg font-semibold text-slate-900 mb-1"
          data-testid={`text-group-name-${groupId}`}
        >
          {group.name}
        </h3>
        {group.description && (
          <div
            className="text-sm text-slate-600 mb-3 line-clamp-3 prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitizeRichText(group.description) }}
          />
        )}
        {isAuthenticated && isGroupAdmin && (
          <div className="mb-3">
            <Wand2
              className="h-4 w-4 text-purple-700"
              data-testid={`badge-group-admin-${groupId}`}
            />
          </div>
        )}
        {isAuthenticated && isJoined ? (
          <div className="mb-3" data-testid={`text-joined-role-${groupId}`}>
            <span className="text-xs text-slate-500">You have joined the group as </span>
            <Badge className="bg-green-100 text-green-700 text-xs">
              {assignment.group_role || group.default_self_join_role}
            </Badge>
          </div>
        ) : (
          isAuthenticated && isSelfJoinGroup && group.default_self_join_role && (
            <div className="mb-3" data-testid={`text-join-as-${groupId}`}>
              <span className="text-xs text-slate-500">You&apos;ll join as: </span>
              <Badge className="bg-blue-100 text-blue-700 text-xs">
                {group.default_self_join_role}
              </Badge>
            </div>
          )
        )}
        <div className="mt-auto pt-3" onClick={(event) => event.stopPropagation()}>
          {!canOpenDetail ? (
            <Button
              variant="outline"
              className="w-full"
              disabled
              data-testid={`button-members-only-${groupId}`}
            >
              Available to group members
            </Button>
          ) : !isAuthenticated ? (
            group.self_join_closed ? (
              <Button
                variant="outline"
                className="w-full"
                disabled
                data-testid={`button-closed-${groupId}`}
              >
                {group.self_join_closed_label?.trim() || 'Registrations closed'}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={handleCtaClick}
                data-testid={`button-login-required-${groupId}`}
              >
                <Lock className="w-4 h-4 mr-2" />
                Member only content - Click to login
              </Button>
            )
          ) : group.self_join_closed ? (
            <Button
              variant="outline"
              className="w-full"
              disabled
              data-testid={`button-closed-${groupId}`}
            >
              {group.self_join_closed_label?.trim() || 'Registrations closed'}
            </Button>
          ) : (
            <Button
              variant="outline"
              className="w-full"
              onClick={handleCtaClick}
              data-testid={`button-find-out-more-${groupId}`}
            >
              Find out more
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}