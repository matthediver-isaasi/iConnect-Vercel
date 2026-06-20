import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Clock, ChevronLeft, Users, MessageCircle } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useSearchParams } from "react-router-dom";
import ForumThreadList, { formatForumDate } from "@/components/forum/ForumThreadList";

const parseFocalPoint = (fp) => {
  if (!fp) return null;
  if (typeof fp === "string") {
    try { return JSON.parse(fp); } catch { return null; }
  }
  return fp;
};

export default function ForumPage() {
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const categoryId = searchParams.get("categoryId");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("forum")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ["forum-categories-browse"],
    queryFn: () => base44.entities.ForumCategory.list({ sort: { display_order: "asc" } }),
    staleTime: 30000,
  });

  const { data: threads = [] } = useQuery({
    queryKey: ["forum-threads-browse"],
    queryFn: () => base44.entities.ForumThread.list(),
    staleTime: 30000,
  });

  const { data: groupAssignments = [], isLoading: assignmentsLoading } = useQuery({
    queryKey: ["forum-group-assignments", memberInfo?.id],
    queryFn: () => base44.entities.MemberGroupAssignment.list(),
    enabled: !!memberInfo?.id,
  });

  const { data: memberGroups = [], isLoading: groupsLoading } = useQuery({
    queryKey: ["forum-member-groups"],
    queryFn: () => base44.entities.MemberGroup.list(),
  });

  const groupMap = useMemo(() => {
    const map = {};
    memberGroups.forEach((g) => {
      map[g.id] = g.name;
    });
    return map;
  }, [memberGroups]);

  // Map of group_id -> Set of group roles the current member holds in that group.
  const myGroupRoles = useMemo(() => {
    const map = new Map();
    if (!memberInfo?.id) return map;
    const nowIso = new Date().toISOString();
    groupAssignments
      // Exclude expired assignments (null expires_at = never expires), matching
      // the server-side group access logic.
      .filter((ga) =>
        ga.member_id === memberInfo.id &&
        ga.group_id &&
        (!ga.expires_at || new Date(ga.expires_at).toISOString() > nowIso)
      )
      .forEach((ga) => {
        if (!map.has(ga.group_id)) map.set(ga.group_id, new Set());
        if (ga.group_role) map.get(ga.group_id).add(ga.group_role);
      });
    return map;
  }, [groupAssignments, memberInfo?.id]);

  const myGroupIds = useMemo(() => new Set(myGroupRoles.keys()), [myGroupRoles]);

  // Map of group_id -> forum_enabled_roles array, for optional role restriction.
  const groupForumRoles = useMemo(() => {
    const map = new Map();
    memberGroups.forEach((g) => {
      map.set(g.id, Array.isArray(g.forum_enabled_roles) ? g.forum_enabled_roles : []);
    });
    return map;
  }, [memberGroups]);

  const threadCountByCategory = useMemo(() => {
    const counts = {};
    threads.forEach((t) => {
      if (t.category_id) {
        counts[t.category_id] = (counts[t.category_id] || 0) + 1;
      }
    });
    return counts;
  }, [threads]);

  const latestActivityByCategory = useMemo(() => {
    const latest = {};
    threads.forEach((t) => {
      if (t.category_id) {
        const activity = t.last_post_at || t.created_at;
        if (activity && (!latest[t.category_id] || activity > latest[t.category_id])) {
          latest[t.category_id] = activity;
        }
      }
    });
    return latest;
  }, [threads]);

  const accessibleCategories = useMemo(() => {
    return categories.filter((cat) => {
      if (!cat.is_active) return false;
      if (cat.group_id) {
        if (!myGroupIds.has(cat.group_id)) return false;
        // Optional per-group role restriction: when forum_enabled_roles is set,
        // the member must hold one of those roles in the group. Empty list means
        // all active group members get access.
        const allowedRoles = groupForumRoles.get(cat.group_id) || [];
        if (allowedRoles.length === 0) return true;
        const myRoles = myGroupRoles.get(cat.group_id) || new Set();
        return allowedRoles.some((r) => myRoles.has(r));
      }
      return true;
    });
  }, [categories, myGroupIds, myGroupRoles, groupForumRoles]);

  // Resolve the selected category from the ACCESS-FILTERED list so that a manually
  // supplied ?categoryId= for a group category the member cannot access never
  // resolves (and therefore never renders threads).
  const selectedCategory = useMemo(() => {
    if (!categoryId) return null;
    return accessibleCategories.find((c) => c.id === categoryId) || null;
  }, [categoryId, accessibleCategories]);

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[400px]" data-testid="forum-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (categoryId) {
    const accessDataLoading = categoriesLoading || groupsLoading || assignmentsLoading;

    if (accessDataLoading) {
      return (
        <div className="flex items-center justify-center min-h-[400px]" data-testid="forum-category-loading">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      );
    }

    if (!selectedCategory) {
      return (
        <div className="max-w-5xl mx-auto p-4 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              onClick={() => setSearchParams({})}
              data-testid="button-back-to-categories"
            >
              <ChevronLeft className="w-4 h-4" />
              Back to Categories
            </Button>
          </div>
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground" data-testid="text-category-unavailable">
              <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
              <p>This forum is not available.</p>
            </CardContent>
          </Card>
        </div>
      );
    }

    return (
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="ghost"
            onClick={() => setSearchParams({})}
            data-testid="button-back-to-categories"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to Categories
          </Button>
        </div>

        {selectedCategory && (
          <div className="space-y-1">
            {selectedCategory.header_image_url && (
              <div className="relative w-full h-56 rounded-md overflow-hidden mb-3" data-testid="img-category-detail-banner">
                <img
                  src={selectedCategory.header_image_url}
                  alt={selectedCategory.name}
                  className="w-full h-full object-cover"
                  style={{
                    objectPosition: (() => {
                      const fp = parseFocalPoint(selectedCategory.header_image_focal_point);
                      return fp ? `${fp.x}% ${fp.y}%` : '50% 50%';
                    })()
                  }}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                <div className="absolute bottom-3 left-4">
                  <h1 className="text-2xl font-semibold text-white drop-shadow-sm" data-testid="text-category-name">
                    {selectedCategory.icon && <span className="mr-2">{selectedCategory.icon}</span>}
                    {selectedCategory.name}
                  </h1>
                  {selectedCategory.description && (
                    <p className="text-white/80 text-sm mt-0.5" data-testid="text-category-description">
                      {selectedCategory.description}
                    </p>
                  )}
                </div>
              </div>
            )}
            {!selectedCategory.header_image_url && (
              <>
                <h1 className="text-2xl font-semibold" data-testid="text-category-name">
                  {selectedCategory.icon && <span className="mr-2">{selectedCategory.icon}</span>}
                  {selectedCategory.name}
                </h1>
                {selectedCategory.description && (
                  <p className="text-muted-foreground" data-testid="text-category-description">
                    {selectedCategory.description}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <ForumThreadList category={selectedCategory} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold" data-testid="text-forum-title">
          <MessageSquare className="w-6 h-6 inline-block mr-2 align-text-bottom text-indigo-500 dark:text-indigo-400" />
          Forum
        </h1>
      </div>

      {categoriesLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : accessibleCategories.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
            <p>No forum categories available.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {accessibleCategories.map((cat) => (
            <Card
              key={cat.id}
              className="cursor-pointer hover-elevate flex flex-col"
              onClick={() => setSearchParams({ categoryId: cat.id })}
              data-testid={`card-category-${cat.id}`}
            >
              {cat.header_image_url ? (
                <div className="relative w-full h-56 overflow-hidden rounded-t-md" data-testid={`img-category-banner-${cat.id}`}>
                  <img
                    src={cat.header_image_url}
                    alt={cat.name}
                    className="w-full h-full object-cover"
                    style={{
                      objectPosition: (() => {
                        const fp = parseFocalPoint(cat.header_image_focal_point);
                        return fp ? `${fp.x}% ${fp.y}%` : '50% 50%';
                      })()
                    }}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
                  <div className="absolute bottom-3 left-4 right-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-white text-lg drop-shadow-sm" data-testid={`text-category-name-${cat.id}`}>
                        {cat.icon && <span className="mr-1">{cat.icon}</span>}
                        {cat.name}
                      </h3>
                      {cat.group_id && groupMap[cat.group_id] && (
                        <Badge variant="secondary" className="text-xs" data-testid={`badge-group-${cat.id}`}>
                          <Users className="w-3 h-3 mr-0.5" />
                          {groupMap[cat.group_id]}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="relative w-full h-56 overflow-hidden rounded-t-md bg-muted flex items-center justify-center">
                  {cat.icon ? (
                    <span className="text-4xl">{cat.icon}</span>
                  ) : (
                    <MessageSquare className="w-12 h-12 text-muted-foreground/30" />
                  )}
                  <div className="absolute bottom-3 left-4 right-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-lg" data-testid={`text-category-name-${cat.id}`}>
                        {cat.name}
                      </h3>
                      {cat.group_id && groupMap[cat.group_id] && (
                        <Badge variant="secondary" className="text-xs" data-testid={`badge-group-${cat.id}`}>
                          <Users className="w-3 h-3 mr-0.5" />
                          {groupMap[cat.group_id]}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <CardContent className="flex items-center gap-3 p-4 mt-auto">
                <div className="flex-1 min-w-0">
                  {cat.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2" data-testid={`text-category-desc-${cat.id}`}>
                      {cat.description}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1" data-testid={`text-thread-count-${cat.id}`}>
                    <MessageCircle className="w-4 h-4 text-indigo-400 dark:text-indigo-500" />
                    {threadCountByCategory[cat.id] || 0}
                  </div>
                  <div className="items-center gap-1 hidden sm:flex" data-testid={`text-latest-activity-${cat.id}`}>
                    <Clock className="w-4 h-4 text-warning dark:text-warning" />
                    {formatForumDate(latestActivityByCategory[cat.id])}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
