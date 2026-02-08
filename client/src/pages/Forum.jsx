import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MessageSquare, Pin, Lock, Clock, ChevronLeft, Plus, Search, Users, Eye, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useNavigate, useSearchParams } from "react-router-dom";

const THREADS_PER_PAGE = 15;

export default function ForumPage() {
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const categoryId = searchParams.get("categoryId");
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("latest_activity");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("forum")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  useEffect(() => {
    setCurrentPage(1);
    setSearchQuery("");
  }, [categoryId]);

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ["forum-categories-browse"],
    queryFn: () => base44.entities.ForumCategory.list({ sort: { display_order: "asc" } }),
    staleTime: 30000,
  });

  const { data: threads = [], isLoading: threadsLoading } = useQuery({
    queryKey: ["forum-threads-browse"],
    queryFn: () => base44.entities.ForumThread.list(),
    staleTime: 30000,
  });

  const { data: groupAssignments = [] } = useQuery({
    queryKey: ["forum-group-assignments", memberInfo?.id],
    queryFn: () => base44.entities.MemberGroupAssignment.list(),
    enabled: !!memberInfo?.id,
  });

  const { data: memberGroups = [] } = useQuery({
    queryKey: ["forum-member-groups"],
    queryFn: () => base44.entities.MemberGroup.list(),
  });

  const { data: members = [] } = useQuery({
    queryKey: ["forum-members-browse"],
    queryFn: () => base44.entities.Member.list(),
    staleTime: 60000,
  });

  const memberMap = useMemo(() => {
    const map = {};
    members.forEach((m) => {
      map[m.id] = `${m.first_name || ""} ${m.last_name || ""}`.trim() || "Unknown";
    });
    return map;
  }, [members]);

  const groupMap = useMemo(() => {
    const map = {};
    memberGroups.forEach((g) => {
      map[g.id] = g.name;
    });
    return map;
  }, [memberGroups]);

  const myGroupIds = useMemo(() => {
    if (!memberInfo?.id) return new Set();
    return new Set(
      groupAssignments
        .filter((ga) => ga.member_id === memberInfo.id)
        .map((ga) => ga.group_id)
    );
  }, [groupAssignments, memberInfo?.id]);

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
        return myGroupIds.has(cat.group_id);
      }
      return true;
    });
  }, [categories, myGroupIds]);

  const selectedCategory = useMemo(() => {
    if (!categoryId) return null;
    return categories.find((c) => c.id === categoryId);
  }, [categoryId, categories]);

  const categoryThreads = useMemo(() => {
    if (!categoryId) return [];
    let filtered = threads.filter((t) => t.category_id === categoryId);

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((t) => t.title?.toLowerCase().includes(q));
    }

    const pinned = filtered.filter((t) => t.is_pinned);
    const unpinned = filtered.filter((t) => !t.is_pinned);

    const sortFn = (a, b) => {
      if (sortBy === "latest_activity") {
        return (b.last_post_at || b.created_at || "").localeCompare(
          a.last_post_at || a.created_at || ""
        );
      }
      if (sortBy === "newest") {
        return (b.created_at || "").localeCompare(a.created_at || "");
      }
      if (sortBy === "most_replies") {
        return (b.post_count || 0) - (a.post_count || 0);
      }
      return 0;
    };

    pinned.sort(sortFn);
    unpinned.sort(sortFn);

    return [...pinned, ...unpinned];
  }, [categoryId, threads, searchQuery, sortBy]);

  const totalPages = Math.ceil(categoryThreads.length / THREADS_PER_PAGE);
  const paginatedThreads = categoryThreads.slice(
    (currentPage - 1) * THREADS_PER_PAGE,
    currentPage * THREADS_PER_PAGE
  );

  const canCreateThread = !isFeatureExcluded("forum.threads.create");

  const formatDate = (dateStr) => {
    if (!dateStr) return "—";
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diffMs = now - d;
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return "Just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays < 7) return `${diffDays}d ago`;
      return d.toLocaleDateString();
    } catch {
      return "—";
    }
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[400px]" data-testid="forum-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (categoryId) {
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
              <div className="relative w-full h-40 rounded-md overflow-hidden mb-3" data-testid="img-category-detail-banner">
                <img
                  src={selectedCategory.header_image_url}
                  alt={selectedCategory.name}
                  className="w-full h-full object-cover"
                  style={{
                    objectPosition: selectedCategory.header_image_focal_point
                      ? `${selectedCategory.header_image_focal_point.x}% ${selectedCategory.header_image_focal_point.y}%`
                      : '50% 50%'
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

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search threads..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9"
              data-testid="input-search-threads"
            />
          </div>
          <Select value={sortBy} onValueChange={(v) => { setSortBy(v); setCurrentPage(1); }}>
            <SelectTrigger className="w-[180px]" data-testid="select-sort-threads">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest_activity">Latest Activity</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="most_replies">Most Replies</SelectItem>
            </SelectContent>
          </Select>
          {canCreateThread && (
            <Button
              onClick={() => navigate(createPageUrl("ForumThread") + "?newThread=true&categoryId=" + categoryId)}
              data-testid="button-new-thread"
            >
              <Plus className="w-4 h-4 mr-1" />
              New Thread
            </Button>
          )}
        </div>

        {threadsLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : paginatedThreads.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
              <p>{searchQuery ? "No threads match your search." : "No threads yet in this category."}</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50%]">Thread</TableHead>
                    <TableHead className="text-center hidden sm:table-cell">Replies</TableHead>
                    <TableHead className="text-center hidden sm:table-cell">Views</TableHead>
                    <TableHead className="text-right">Last Activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedThreads.map((thread) => (
                    <TableRow
                      key={thread.id}
                      className="cursor-pointer hover-elevate"
                      onClick={() => navigate(createPageUrl("ForumThread") + "?threadId=" + thread.id)}
                      data-testid={`row-thread-${thread.id}`}
                    >
                      <TableCell>
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {thread.is_pinned && (
                                <Badge variant="secondary" className="text-xs" data-testid={`badge-pinned-${thread.id}`}>
                                  <Pin className="w-3 h-3 mr-0.5" />
                                  Pinned
                                </Badge>
                              )}
                              {thread.is_locked && (
                                <Badge variant="outline" className="text-xs" data-testid={`badge-locked-${thread.id}`}>
                                  <Lock className="w-3 h-3 mr-0.5" />
                                  Locked
                                </Badge>
                              )}
                              <span className="font-medium truncate" data-testid={`text-thread-title-${thread.id}`}>
                                {thread.title}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              by {memberMap[thread.created_by] || "Unknown"} · {formatDate(thread.created_at)}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center hidden sm:table-cell">
                        <div className="flex items-center justify-center gap-1 text-muted-foreground text-sm">
                          <MessageCircle className="w-3.5 h-3.5" />
                          {thread.post_count || 0}
                        </div>
                      </TableCell>
                      <TableCell className="text-center hidden sm:table-cell">
                        <div className="flex items-center justify-center gap-1 text-muted-foreground text-sm">
                          <Eye className="w-3.5 h-3.5" />
                          {thread.view_count || 0}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="text-sm text-muted-foreground">
                          {formatDate(thread.last_post_at || thread.created_at)}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => p - 1)}
                  data-testid="button-prev-page"
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((p) => p + 1)}
                  data-testid="button-next-page"
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold" data-testid="text-forum-title">
          <MessageSquare className="w-6 h-6 inline-block mr-2 align-text-bottom" />
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
                <div className="relative w-full h-44 overflow-hidden rounded-t-md" data-testid={`img-category-banner-${cat.id}`}>
                  <img
                    src={cat.header_image_url}
                    alt={cat.name}
                    className="w-full h-full object-cover"
                    style={{
                      objectPosition: cat.header_image_focal_point
                        ? `${cat.header_image_focal_point.x}% ${cat.header_image_focal_point.y}%`
                        : '50% 50%'
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
                <div className="relative w-full h-44 overflow-hidden rounded-t-md bg-muted flex items-center justify-center">
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
                    <MessageCircle className="w-4 h-4" />
                    {threadCountByCategory[cat.id] || 0}
                  </div>
                  <div className="items-center gap-1 hidden sm:flex" data-testid={`text-latest-activity-${cat.id}`}>
                    <Clock className="w-4 h-4" />
                    {formatDate(latestActivityByCategory[cat.id])}
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
