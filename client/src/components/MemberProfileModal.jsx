import { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  User, Mail, FileText, Trophy, Calendar, Building2, Briefcase,
  ChevronDown, ChevronUp, Linkedin, Copy, Check
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { isVisibleOnBack, isCustomFieldVisibleOnBack, getOrderedCustomFields, hasDirectoryFieldValue } from "@/utils/directorySettings";

export default function MemberProfileModal({ memberId, open, onOpenChange }) {
  const { isFeatureExcluded } = useMemberAccess();
  const canViewMemberBiography = !isFeatureExcluded('view_member_biography');

  const [bioExpanded, setBioExpanded] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);

  const { data: member } = useQuery({
    queryKey: ['member-profile-member', memberId],
    enabled: open && !!memberId,
    queryFn: async () => {
      try {
        return await base44.entities.Member.get(memberId);
      } catch {
        return null;
      }
    },
    staleTime: 60 * 1000,
  });

  const { data: displaySettings } = useQuery({
    queryKey: ['memberDirectoryDisplay'],
    enabled: open,
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'member_directory_display');
      if (setting?.setting_value) {
        try {
          return JSON.parse(setting.setting_value);
        } catch {
          return defaultDisplaySettings();
        }
      }
      return defaultDisplaySettings();
    },
    staleTime: 0,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    enabled: open,
    queryFn: () => base44.entities.Role.list(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    enabled: open,
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: awards = [] } = useQuery({
    queryKey: ['awards'],
    enabled: open,
    queryFn: async () => {
      const all = await base44.entities.Award.list();
      return all.filter(a => a.is_active);
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: offlineAssignments = [] } = useQuery({
    queryKey: ['offline-assignments'],
    enabled: open,
    queryFn: () => base44.entities.OfflineAwardAssignment.list(),
    staleTime: 60 * 1000,
  });

  const { data: offlineAwards = [] } = useQuery({
    queryKey: ['offline-awards'],
    enabled: open,
    queryFn: async () => {
      const all = await base44.entities.OfflineAward.list();
      return all.filter(a => a.is_active);
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: allBookings = [] } = useQuery({
    queryKey: ['all-bookings'],
    enabled: open,
    queryFn: () => base44.entities.Booking.list(),
    staleTime: 60 * 1000,
  });

  const { data: allArticles = [] } = useQuery({
    queryKey: ['all-articles'],
    enabled: open,
    queryFn: () => base44.entities.BlogPost.list(),
    staleTime: 60 * 1000,
  });

  const { data: directoryCustomFields = [] } = useQuery({
    queryKey: ['member-directory-custom-fields'],
    enabled: open,
    queryFn: async () => {
      const parseDirVis = (field) => {
        if (!field.directory_visibility) return null;
        let vis = field.directory_visibility;
        if (typeof vis === 'string') {
          try { vis = JSON.parse(vis); } catch { return null; }
        }
        if (Array.isArray(vis)) return { ids: vis, labels: {} };
        if (vis && typeof vis === 'object') {
          return {
            ids: Array.isArray(vis.ids) ? vis.ids : [],
            labels: (vis.labels && typeof vis.labels === 'object' && !Array.isArray(vis.labels)) ? vis.labels : {}
          };
        }
        return null;
      };
      const isVisibleInMain = (field) => {
        const parsed = parseDirVis(field);
        if (parsed) return parsed.ids.includes('main');
        return field.show_in_member_directory !== false;
      };
      const enrich = (field) => {
        const override = parseDirVis(field)?.labels?.main;
        return {
          ...field,
          _displayLabel: (typeof override === 'string' && override.trim()) ? override.trim() : field.label
        };
      };
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'member' && isVisibleInMain(f)).map(enrich);
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f =>
            (!f.entity_scope || f.entity_scope === 'member') && isVisibleInMain(f)
          ).map(enrich);
        } catch {
          return [];
        }
      }
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: memberPreferenceValues = [] } = useQuery({
    queryKey: ['all-member-preference-values'],
    enabled: open && directoryCustomFields.length > 0,
    queryFn: async () => {
      try {
        return await base44.entities.MemberPreferenceValue.list() || [];
      } catch {
        return [];
      }
    },
    staleTime: 60 * 1000,
  });

  const memberPreferenceMap = useMemo(() => {
    if (!member) return {};
    const map = {};
    memberPreferenceValues.forEach(pv => {
      if (pv.member_id !== member.id) return;
      if (!map[pv.member_id]) map[pv.member_id] = {};
      let normalizedValue = pv.value;
      if (typeof pv.value === 'string') {
        const trimmed = pv.value.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try { normalizedValue = JSON.parse(trimmed); } catch {}
        }
      }
      const fieldId = pv.field_id || pv.preference_field_id;
      if (fieldId) {
        map[pv.member_id][fieldId] = normalizedValue;
      }
    });
    return map;
  }, [member, memberPreferenceValues]);

  const stats = useMemo(() => {
    if (!member) return { publishedArticles: 0, eventsAttended: 0, onlineAwards: [], offlineAwards: [], totalAwards: 0 };

    const publishedArticles = allArticles.filter(
      a => a.author_id === member.id && a.status === 'published'
    ).length;

    const eventsAttended = allBookings.filter(
      b => b.member_id === member.id && b.status === 'confirmed'
    ).length;

    const earnedOnlineAwards = awards.filter(award => {
      const stat = award.award_type === 'events_attended' ? eventsAttended :
                   award.award_type === 'articles_published' ? publishedArticles : 0;
      return stat >= award.threshold;
    });

    const memberOfflineAssignments = offlineAssignments.filter(a => a.member_id === member.id);
    const earnedOfflineAwards = memberOfflineAssignments
      .map(assignment => offlineAwards.find(award => award.id === assignment.offline_award_id))
      .filter(Boolean);

    return {
      publishedArticles,
      eventsAttended,
      onlineAwards: earnedOnlineAwards,
      offlineAwards: earnedOfflineAwards,
      totalAwards: earnedOnlineAwards.length + earnedOfflineAwards.length
    };
  }, [member, allArticles, allBookings, awards, offlineAssignments, offlineAwards]);

  const handleOpenChange = (nextOpen) => {
    if (!nextOpen) {
      setBioExpanded(false);
      setEmailCopied(false);
    }
    onOpenChange(nextOpen);
  };

  const handleEmailMember = (email) => {
    window.location.href = `mailto:${email}`;
  };

  const handleCopyEmail = async (email) => {
    try {
      await navigator.clipboard.writeText(email);
      setEmailCopied(true);
      toast.success("Email address copied to clipboard");
      setTimeout(() => setEmailCopied(false), 2000);
    } catch {
      toast.error("Failed to copy email address");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="sr-only">Member Information</DialogTitle>
        </DialogHeader>

        {member && (
          <div className="space-y-6">
            <div className="flex items-start gap-6">
              <div className="flex-shrink-0">
                {isVisibleOnBack(displaySettings, 'show_profile_photo') && member.profile_photo_url ? (
                  <img
                    src={member.profile_photo_url}
                    alt={`${member.first_name} ${member.last_name}`}
                    className="w-24 h-24 rounded-full object-cover border-4 border-slate-200"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center border-4 border-slate-200">
                    <User className="w-12 h-12 text-blue-600" />
                  </div>
                )}
              </div>

              <div className="flex-1">
                <h2 className="text-2xl font-bold text-slate-900 mb-2">
                  {member.first_name} {member.last_name}
                </h2>
                {isVisibleOnBack(displaySettings, 'show_job_title') && member.job_title && (
                  <div className="flex items-center gap-2 text-slate-600 mb-3">
                    <Briefcase className="w-4 h-4" />
                    <span>{member.job_title}</span>
                  </div>
                )}
                {(() => {
                  const role = roles.find(r => r.id === member.role_id);
                  return role ? (
                    <Badge
                      variant="secondary"
                      className="bg-blue-100 text-blue-700"
                    >
                      {role.name}
                    </Badge>
                  ) : null;
                })()}
              </div>
            </div>

            {isVisibleOnBack(displaySettings, 'show_organization') && (() => {
              const organization = organizations.find(o => o.id === member.organization_id);
              return organization ? (
                <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                  <div className="flex items-center gap-2 text-slate-700">
                    <Building2 className="w-5 h-5 text-blue-600" />
                    <span className="font-semibold">{organization.name}</span>
                  </div>
                </div>
              ) : null;
            })()}

            {isVisibleOnBack(displaySettings, 'show_bio_in_popup') && member.biography && canViewMemberBiography && (
              <div className="bg-slate-50 rounded-lg p-4 border border-slate-200 space-y-2">
                <p className="text-xs font-medium text-slate-500">About</p>
                <p className={`text-sm text-slate-900 leading-relaxed ${!bioExpanded ? 'line-clamp-4' : ''}`}>
                  {member.biography}
                </p>
                {member.biography.length > 300 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setBioExpanded(!bioExpanded)}
                    className="text-blue-600 hover:text-blue-700 p-0 h-auto font-medium"
                  >
                    {bioExpanded ? (
                      <>
                        <ChevronUp className="w-4 h-4 mr-1" />
                        Show less
                      </>
                    ) : (
                      <>
                        <ChevronDown className="w-4 h-4 mr-1" />
                        Read more
                      </>
                    )}
                  </Button>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              {isVisibleOnBack(displaySettings, 'show_events') && (
                <div className="bg-gradient-to-br from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
                  <div className="flex items-center gap-2 mb-1">
                    <Calendar className="w-5 h-5 text-green-600" />
                    <span className="text-sm font-medium text-green-900">Events Attended</span>
                  </div>
                  <p className="text-2xl font-bold text-green-700">
                    {stats.eventsAttended}
                  </p>
                </div>
              )}

              {isVisibleOnBack(displaySettings, 'show_articles') && (
                <div className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-4 border border-purple-200">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="w-5 h-5 text-purple-600" />
                    <span className="text-sm font-medium text-purple-900">Articles Published</span>
                  </div>
                  <p className="text-2xl font-bold text-purple-700">
                    {stats.publishedArticles}
                  </p>
                </div>
              )}
            </div>

            {isVisibleOnBack(displaySettings, 'show_awards') && stats.totalAwards > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-600" />
                  Awards & Recognition ({stats.totalAwards})
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {stats.onlineAwards.map(award => (
                    <div key={award.id} className="bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg p-3 border border-amber-200">
                      <div className="flex items-center gap-2">
                        {award.image_url && (
                          <img src={award.image_url} alt={award.name} className="w-8 h-8 object-contain" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-amber-900 line-clamp-1">{award.name}</p>
                          {award.description && (
                            <p className="text-xs text-amber-700 line-clamp-1">{award.description}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  {stats.offlineAwards.map(award => (
                    <div key={award.id} className="bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg p-3 border border-purple-200">
                      <div className="flex items-center gap-2">
                        {award.image_url && (
                          <img src={award.image_url} alt={award.name} className="w-8 h-8 object-contain" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-purple-900 line-clamp-1">{award.name}</p>
                          {award.period_text && (
                            <p className="text-xs text-purple-700">{award.period_text}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(() => {
              const orderedFields = getOrderedCustomFields(directoryCustomFields, displaySettings);
              const enabledFields = orderedFields.filter(f =>
                isCustomFieldVisibleOnBack(displaySettings, f.id)
              );
              if (enabledFields.length === 0) return null;
              const memberValues = memberPreferenceMap[member.id] || {};
              const fieldsWithValues = enabledFields.filter(f =>
                hasDirectoryFieldValue(f, memberValues[f.id])
              );
              if (fieldsWithValues.length === 0) return null;
              return (
                <div className="space-y-3 pt-4 border-t border-slate-200">
                  <h3 className="text-sm font-semibold text-slate-900 uppercase tracking-wide">Additional Information</h3>
                  <div className="grid grid-cols-2 gap-3">
                    {fieldsWithValues.map(field => {
                      let displayValue = memberValues[field.id];
                      if (field.field_type === 'picklist' && displayValue) {
                        const arr = Array.isArray(displayValue) ? displayValue : (() => {
                          try { return JSON.parse(displayValue); } catch { return [displayValue]; }
                        })();
                        if (Array.isArray(arr) && field.options) {
                          displayValue = arr
                            .map(v => field.options.find(o => o.value === v)?.label || v)
                            .join(', ');
                        }
                      } else if (field.field_type === 'dropdown' && displayValue && field.options) {
                        const option = field.options.find(o => o.value === displayValue);
                        if (option) displayValue = option.label;
                      } else if (field.field_type === 'boolean') {
                        displayValue = displayValue === true || displayValue === 'true' ? 'Yes' : 'No';
                      } else if (field.field_type === 'date' && displayValue) {
                        try {
                          displayValue = new Date(displayValue).toLocaleDateString();
                        } catch {}
                      }
                      return (
                        <div key={field.id} className="bg-slate-50 rounded-lg p-3 border border-slate-200" data-testid={`custom-field-${field.id}`}>
                          <p className="text-xs font-medium text-slate-500 mb-1">{field._displayLabel || field.label}</p>
                          <p className="text-sm text-slate-900 break-words">{String(displayValue)}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            <div className="pt-4 border-t border-slate-200 space-y-3">
              {member.email && (
                <div className="flex items-center justify-between bg-slate-50 rounded-lg p-3 border border-slate-200">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Mail className="w-4 h-4 text-slate-500 flex-shrink-0" />
                    <span className="text-sm text-slate-700 truncate" data-testid="text-member-email">
                      {member.email}
                    </span>
                  </div>
                  <TooltipProvider delayDuration={100}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={() => handleCopyEmail(member.email)}
                          data-testid="button-copy-email"
                        >
                          {emailCopied ? (
                            <Check className="w-4 h-4 text-green-600" />
                          ) : (
                            <Copy className="w-4 h-4 text-slate-500" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{emailCopied ? "Copied!" : "Copy"}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              )}

              <Button
                onClick={() => handleEmailMember(member.email)}
                className="w-full bg-blue-600 hover:bg-blue-700"
                size="lg"
              >
                <Mail className="w-5 h-5 mr-2" />
                Send Email to {member.first_name}
              </Button>

              {isVisibleOnBack(displaySettings, 'show_linkedin') && member.linkedin_url && (
                <Button
                  onClick={() => window.open(member.linkedin_url, '_blank')}
                  variant="outline"
                  className="w-full"
                  size="lg"
                >
                  <Linkedin className="w-5 h-5 mr-2" />
                  View LinkedIn Profile
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function defaultDisplaySettings() {
  return {
    show_profile_photo: true,
    show_events: true,
    show_articles: true,
    show_organization: true,
    show_job_title: true,
    show_linkedin: true,
    show_awards: true,
    show_bio_in_popup: true
  };
}
