import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { MessageSquare, Pin, Lock, Plus, Search, Eye, MessageCircle } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { useNavigate } from "react-router-dom";

export const THREADS_PER_PAGE = 15;

const AVATAR_COLOURS = [
  { bg: "bg-blue-100 dark:bg-blue-900/60", text: "text-blue-700 dark:text-blue-300" },
  { bg: "bg-emerald-100 dark:bg-emerald-900/60", text: "text-emerald-700 dark:text-emerald-300" },
  { bg: "bg-violet-100 dark:bg-violet-900/60", text: "text-violet-700 dark:text-violet-300" },
  { bg: "bg-warning/10 dark:bg-warning/60", text: "text-warning dark:text-warning" },
  { bg: "bg-rose-100 dark:bg-rose-900/60", text: "text-rose-700 dark:text-rose-300" },
  { bg: "bg-cyan-100 dark:bg-cyan-900/60", text: "text-cyan-700 dark:text-cyan-300" },
  { bg: "bg-fuchsia-100 dark:bg-fuchsia-900/60", text: "text-fuchsia-700 dark:text-fuchsia-300" },
  { bg: "bg-teal-100 dark:bg-teal-900/60", text: "text-teal-700 dark:text-teal-300" },
  { bg: "bg-indigo-100 dark:bg-indigo-900/60", text: "text-indigo-700 dark:text-indigo-300" },
  { bg: "bg-warning/10 dark:bg-warning/60", text: "text-warning dark:text-warning" },
];

export function getAvatarColour(name) {
  if (!name) return AVATAR_COLOURS[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLOURS[Math.abs(hash) % AVATAR_COLOURS.length];
}

export function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0][0] || "?").toUpperCase();
}

export function formatForumDate(dateStr) {
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
}

/**
 * Renders the thread list for a single forum category: search, sort, New Thread
 * button, the threads table (pinned/locked badges, replies/views/last-activity),
 * empty/loading states, and pagination. Self-sufficient for data — it fetches the
 * threads and member name map using the same query keys as the Forum page so the
 * cache is shared. Used both on the standalone Forum page and embedded inside the
 * group forum card on MemberGroupDetail.
 */
export default function ForumThreadList({ category }) {
  const navigate = useNavigate();
  const { isFeatureExcluded } = useMemberAccess();
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState("latest_activity");
  const [currentPage, setCurrentPage] = useState(1);

  const categoryId = category?.id || null;

  useEffect(() => {
    setCurrentPage(1);
    setSearchQuery("");
  }, [categoryId]);

  const { data: threads = [], isLoading: threadsLoading } = useQuery({
    queryKey: ["forum-threads-browse"],
    queryFn: () => base44.entities.ForumThread.list(),
    staleTime: 30000,
    enabled: !!categoryId,
  });

  useRealtimeSubscription(
    'forum_thread',
    [["forum-threads-browse"]],
    {
      enabled: !!categoryId,
    }
  );

  const { data: members = [] } = useQuery({
    queryKey: ["forum-members-browse"],
    queryFn: () => base44.entities.Member.list(),
    staleTime: 60000,
    enabled: !!categoryId,
  });

  const memberMap = useMemo(() => {
    const map = {};
    members.forEach((m) => {
      map[m.id] = `${m.first_name || ""} ${m.last_name || ""}`.trim() || "Unknown";
    });
    return map;
  }, [members]);

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

  if (!categoryId) return null;

  return (
    <div className="space-y-4">
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
                        {(() => {
                          const authorName = memberMap[thread.created_by] || "Unknown";
                          const colour = getAvatarColour(authorName);
                          return (
                            <Avatar className={`h-8 w-8 shrink-0 ${colour.bg}`}>
                              <AvatarFallback className={`text-xs ${colour.bg} ${colour.text}`}>{getInitials(authorName)}</AvatarFallback>
                            </Avatar>
                          );
                        })()}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {thread.is_pinned && (
                              <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/30 dark:bg-warning/40 dark:text-warning dark:border-warning/50 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-pinned-${thread.id}`}>
                                <Pin className="w-3 h-3 mr-0.5" />
                                Pinned
                              </Badge>
                            )}
                            {thread.is_locked && (
                              <Badge variant="outline" className="text-xs bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/50 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-locked-${thread.id}`}>
                                <Lock className="w-3 h-3 mr-0.5" />
                                Locked
                              </Badge>
                            )}
                            <span className="font-medium truncate" data-testid={`text-thread-title-${thread.id}`}>
                              {thread.title}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            by {memberMap[thread.created_by] || "Unknown"} · {formatForumDate(thread.created_at)}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-center hidden sm:table-cell">
                      <div className="flex items-center justify-center gap-1 text-muted-foreground text-sm">
                        <MessageCircle className="w-3.5 h-3.5 text-indigo-400 dark:text-indigo-500" />
                        {thread.post_count || 0}
                      </div>
                    </TableCell>
                    <TableCell className="text-center hidden sm:table-cell">
                      <div className="flex items-center justify-center gap-1 text-muted-foreground text-sm">
                        <Eye className="w-3.5 h-3.5 text-blue-400 dark:text-blue-500" />
                        {thread.view_count || 0}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="text-sm text-muted-foreground">
                        {formatForumDate(thread.last_post_at || thread.created_at)}
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
