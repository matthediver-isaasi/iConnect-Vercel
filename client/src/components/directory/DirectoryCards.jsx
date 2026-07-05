import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import RoleBadge from "@/components/RoleBadge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Building2, User, Users, FileText, Calendar, Trophy, Linkedin, Pencil, Trash2 } from "lucide-react";
import { safeLogoSrc } from "@/lib/safeLogoSrc";
import { isVisibleOnFront, isCustomFieldVisibleOnFront, getOrderedCustomFields } from "@/utils/directorySettings";

/**
 * Shared directory card "atoms".
 *
 * Extracted verbatim from DynamicDirectoryView.jsx so the portal directory page
 * and the CanvasBuilder directory embeds render identical cards. All portal-only
 * signals (member stats, admin logo affordances, click-to-open) are behind props
 * that default off, so a public/guest render (canvas embed) shows the same card
 * face without exposing extra data or interactions.
 */

export function DirectoryMemberCard({
  member,
  stats = {},
  role,
  organization,
  displaySettings,
  directoryCustomFields = [],
  memberValues = {},
  isGuest,
  onView,
}) {
  return (
    <Card
      className={`border-slate-200 hover:shadow-lg transition-shadow${onView ? ' cursor-pointer' : ''}`}
      onClick={onView ? () => onView(member) : undefined}
      data-testid={`card-member-${member.id}`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            {isVisibleOnFront(displaySettings, 'show_profile_photo') && member.profile_photo_url ? (
              <img
                src={member.profile_photo_url}
                alt={`${member.first_name} ${member.last_name}`}
                className="w-16 h-16 rounded-full object-cover border-2 border-slate-200"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-slate-200 flex items-center justify-center">
                <User className="w-8 h-8 text-slate-400" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base mb-1">
              {member.first_name} {member.last_name}
            </CardTitle>
            {role && (
              <div className="flex items-center gap-1 mb-1">
                <RoleBadge role={role} />
              </div>
            )}
            {isVisibleOnFront(displaySettings, 'show_job_title') && member.job_title && (
              <p className="text-xs text-slate-600 line-clamp-1">{member.job_title}</p>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isVisibleOnFront(displaySettings, 'show_organization') && organization && (
          <div className="flex items-start gap-2">
            <Building2 className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
            <span className="text-sm text-slate-700">{organization.name}</span>
          </div>
        )}
        {isVisibleOnFront(displaySettings, 'show_linkedin') && member.linkedin_url && (
          <div className="flex items-center gap-2">
            <a
              href={member.linkedin_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 hover:underline"
            >
              <Linkedin className="w-4 h-4" />
              <span>LinkedIn Profile</span>
            </a>
          </div>
        )}
        {!isGuest && isVisibleOnFront(displaySettings, 'show_events') && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-green-600" />
              <span className="text-sm text-slate-600">Events</span>
            </div>
            <Badge variant="secondary">{stats.eventsAttended || 0}</Badge>
          </div>
        )}
        {!isGuest && isVisibleOnFront(displaySettings, 'show_articles') && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-purple-600" />
              <span className="text-sm text-slate-600">Articles</span>
            </div>
            <Badge variant="secondary">{stats.publishedArticles || 0}</Badge>
          </div>
        )}
        {!isGuest && isVisibleOnFront(displaySettings, 'show_awards') && stats.totalAwards > 0 && (
          <div className="pt-3 border-t border-slate-200">
            <div className="flex items-center gap-2 mb-2">
              <Trophy className="w-4 h-4 text-warning" />
              <span className="text-xs font-semibold text-slate-700">
                Awards ({stats.totalAwards})
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {stats.onlineAwards?.slice(0, 2).map(award => (
                <Tooltip key={award.id}>
                  <TooltipTrigger asChild>
                    <div className="px-2 py-1 bg-gradient-to-br from-amber-50 to-amber-100 rounded border border-warning/30 cursor-help">
                      {award.image_url ? (
                        <img src={award.image_url} alt={award.name} className="w-4 h-4 object-contain" />
                      ) : (
                        <span className="text-xs font-medium text-slate-900">{award.name}</span>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-semibold">{award.name}</p>
                    {award.description && <p className="text-xs text-slate-400 mt-1">{award.description}</p>}
                  </TooltipContent>
                </Tooltip>
              ))}
              {stats.offlineAwards?.slice(0, 2).map(award => (
                <Tooltip key={award.id}>
                  <TooltipTrigger asChild>
                    <div className="px-2 py-1 bg-gradient-to-br from-purple-50 to-purple-100 rounded border border-purple-200 cursor-help">
                      {award.image_url ? (
                        <img src={award.image_url} alt={award.name} className="w-4 h-4 object-contain" />
                      ) : (
                        <span className="text-xs font-medium text-slate-900">{award.name}</span>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-semibold">{award.name}</p>
                    {award.period_text && <p className="text-xs text-slate-400 mt-1">{award.period_text}</p>}
                    {award.description && <p className="text-xs text-slate-400 mt-1">{award.description}</p>}
                  </TooltipContent>
                </Tooltip>
              ))}
              {stats.totalAwards > 2 && (
                <div className="px-2 py-1 bg-slate-100 rounded border border-slate-200">
                  <span className="text-xs font-medium text-slate-600">+{stats.totalAwards - 2}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {(() => {
          const orderedFields = getOrderedCustomFields(directoryCustomFields, displaySettings);
          const enabledFields = orderedFields.filter(f =>
            isCustomFieldVisibleOnFront(displaySettings, f.id)
          );
          if (enabledFields.length === 0) return null;
          const values = memberValues || {};
          const fieldsWithValues = enabledFields.filter(f => {
            const val = values[f.id];
            return val !== undefined && val !== null && val !== '';
          });
          if (fieldsWithValues.length === 0) return null;
          const displayFields = fieldsWithValues.slice(0, 3);
          const remaining = fieldsWithValues.length - 3;
          return (
            <div className="pt-3 border-t border-slate-200 space-y-1.5">
              {displayFields.map(field => {
                let displayValue = values[field.id];
                if (field.field_type === 'picklist' && displayValue) {
                  const arr = Array.isArray(displayValue) ? displayValue : (() => {
                    try { return JSON.parse(displayValue); } catch { return [displayValue]; }
                  })();
                  if (Array.isArray(arr) && field.options) {
                    displayValue = arr.map(v => field.options.find(o => o.value === v)?.label || v).join(', ');
                  }
                } else if (field.field_type === 'dropdown' && displayValue && field.options) {
                  const option = field.options.find(o => o.value === displayValue);
                  if (option) displayValue = option.label;
                } else if (field.field_type === 'boolean') {
                  displayValue = displayValue === true || displayValue === 'true' ? 'Yes' : 'No';
                } else if (field.field_type === 'date' && displayValue) {
                  try { displayValue = new Date(displayValue).toLocaleDateString(); } catch {}
                }
                return (
                  <div key={field.id} className="flex items-center justify-between gap-2" data-testid={`card-custom-field-${field.id}`}>
                    <span className="text-xs text-slate-500 truncate">{field._displayLabel || field.label}</span>
                    <span className="text-xs font-medium text-slate-700 text-right truncate max-w-[50%]">{String(displayValue)}</span>
                  </div>
                );
              })}
              {remaining > 0 && (
                <span className="text-xs text-slate-400">+{remaining} more</span>
              )}
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}

export function DirectoryOrganizationCard({
  org,
  displaySettings,
  memberCount = 0,
  isGuest,
  canEditLogos,
  onEditLogo,
  onRequestDeleteLogo,
  onSelect,
}) {
  return (
    <Card
      className={`border-slate-200 hover:shadow-lg transition-shadow${onSelect ? ' cursor-pointer' : ''}`}
      onClick={onSelect ? () => onSelect(org) : undefined}
      data-testid={`card-organisation-${org.id}`}
    >
      <CardHeader className="flex flex-col items-center text-center pb-2">
        {displaySettings?.showLogo && (
          <div className="relative w-[90%] aspect-square rounded-lg overflow-hidden bg-slate-100 flex items-center justify-center mb-3 group">
            {(() => {
              const safeSrc = safeLogoSrc(org.logo_url);
              return safeSrc ? (
                <img
                  src={safeSrc}
                  alt={org.name}
                  className={`w-full h-full object-contain transition-all duration-300 ${displaySettings?.showNameTooltip ? 'group-hover:opacity-20' : ''}`}
                />
              ) : (
                <Building2 className={`w-16 h-16 text-slate-400 transition-all duration-300 ${displaySettings?.showNameTooltip ? 'group-hover:opacity-20' : ''}`} />
              );
            })()}
            {displaySettings?.showNameTooltip && (
              <div className="absolute inset-0 flex items-center justify-center p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <span className="text-lg font-bold text-slate-800 text-center leading-tight line-clamp-4">
                  {org.name}
                </span>
              </div>
            )}
            {canEditLogos && (
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                <Button
                  size="icon"
                  variant="secondary"
                  className="h-8 w-8 bg-white/90 hover:bg-white shadow-sm"
                  onClick={(e) => onEditLogo(e, org)}
                  data-testid={`button-edit-logo-${org.id}`}
                >
                  <Pencil className="w-4 h-4 text-slate-600" />
                </Button>
                {org.logo_url && (
                  <Button
                    size="icon"
                    variant="secondary"
                    className="h-8 w-8 bg-white/90 hover:bg-red-50 shadow-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestDeleteLogo(org);
                    }}
                    data-testid={`button-delete-logo-${org.id}`}
                  >
                    <Trash2 className="w-4 h-4 text-red-500" />
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {displaySettings?.showTitle !== false && (
          <CardTitle className="text-base line-clamp-2 w-full">{org.name}</CardTitle>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!isGuest && displaySettings?.showMemberCount && (
          <div className="flex items-center justify-center gap-2 pt-2 border-t border-slate-200">
            <Users className="w-4 h-4 text-slate-400" />
            <span className="text-sm text-slate-600">Members:</span>
            <span className="text-sm font-semibold text-slate-900">{memberCount}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
