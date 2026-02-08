import { useState, useEffect, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  MessageSquare, Pin, Lock, Heart, Flag, Pencil, Trash2,
  ChevronLeft, Send, MoreVertical, Reply, Eye, Clock,
  Loader2, X, EyeOff, ArrowRightLeft
} from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useSearchParams, useNavigate } from "react-router-dom";

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatDate(dateStr) {
  if (!dateStr) return "";
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
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0][0] || "?").toUpperCase();
}

export default function ForumThreadPage() {
  const { isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const replyRef = useRef(null);

  const threadId = searchParams.get("threadId");
  const isNewThread = searchParams.get("newThread") === "true";
  const categoryId = searchParams.get("categoryId");

  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [replyContent, setReplyContent] = useState("");
  const [replyingToPost, setReplyingToPost] = useState(null);
  const [editingPostId, setEditingPostId] = useState(null);
  const [editContent, setEditContent] = useState("");
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [reportPostId, setReportPostId] = useState(null);
  const [reportReason, setReportReason] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePostId, setDeletePostId] = useState(null);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [moveCategoryId, setMoveCategoryId] = useState("");
  const [showMoreActions, setShowMoreActions] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("forum")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: thread, isLoading: threadLoading } = useQuery({
    queryKey: ["forum-thread", threadId],
    queryFn: () => base44.entities.ForumThread.get(threadId),
    enabled: !!threadId && !isNewThread,
  });

  const { data: posts = [], isLoading: postsLoading } = useQuery({
    queryKey: ["forum-posts", threadId],
    queryFn: () =>
      base44.entities.ForumPost.list({
        filter: { thread_id: threadId },
        sort: { created_date: "asc" },
      }),
    enabled: !!threadId && !isNewThread,
  });

  const { data: reactions = [] } = useQuery({
    queryKey: ["forum-reactions", threadId],
    queryFn: async () => {
      const allReactions = await base44.entities.ForumReaction.list();
      const postIds = new Set(posts.map((p) => p.id));
      return allReactions.filter((r) => postIds.has(r.post_id));
    },
    enabled: !!threadId && !isNewThread && posts.length > 0,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ["forum-categories-thread"],
    queryFn: () => base44.entities.ForumCategory.list({ sort: { display_order: "asc" } }),
    staleTime: 30000,
  });

  const { data: members = [] } = useQuery({
    queryKey: ["forum-members-thread"],
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

  const categoryMap = useMemo(() => {
    const map = {};
    categories.forEach((c) => {
      map[c.id] = c;
    });
    return map;
  }, [categories]);

  const reactionsByPost = useMemo(() => {
    const map = {};
    reactions.forEach((r) => {
      if (!map[r.post_id]) map[r.post_id] = [];
      map[r.post_id].push(r);
    });
    return map;
  }, [reactions]);

  const threadCategory = thread ? categoryMap[thread.category_id] : categoryMap[categoryId];

  const canReply = !isFeatureExcluded("forum.threads.reply");
  const canEditOwn = !isFeatureExcluded("forum.threads.edit-own");
  const canDeleteOwn = !isFeatureExcluded("forum.threads.delete-own");
  const canEditAny = !isFeatureExcluded("forum.threads.edit-any");
  const canDeleteAny = !isFeatureExcluded("forum.threads.delete-any");
  const canReport = !isFeatureExcluded("forum.threads.report");
  const canPin = !isFeatureExcluded("forum.moderation.pin-threads");
  const canLock = !isFeatureExcluded("forum.moderation.lock-threads");
  const canMove = !isFeatureExcluded("forum.moderation.move-threads");
  const canHidePosts = !isFeatureExcluded("forum.moderation.hide-posts");
  const canCreateThread = !isFeatureExcluded("forum.threads.create");

  useEffect(() => {
    if (threadId && thread && !isNewThread) {
      base44.entities.ForumThread.update(threadId, {
        view_count: (thread.view_count || 0) + 1,
      }).catch(() => {});
    }
  }, [threadId, thread?.id]);

  const createThreadMutation = useMutation({
    mutationFn: async () => {
      const newThread = await base44.entities.ForumThread.create({
        category_id: categoryId,
        title: newTitle.trim(),
        slug: generateSlug(newTitle.trim()),
        created_by: memberInfo.id,
        created_by_type: "member",
        post_count: 1,
        last_post_at: new Date().toISOString(),
        last_post_by: memberInfo.id,
      });
      await base44.entities.ForumPost.create({
        thread_id: newThread.id,
        content: newContent.trim(),
        created_by: memberInfo.id,
        created_by_type: "member",
      });
      return newThread;
    },
    onSuccess: (newThread) => {
      queryClient.invalidateQueries({ queryKey: ["forum-threads-browse"] });
      toast.success("Thread created");
      navigate(createPageUrl("ForumThread") + "?threadId=" + newThread.id);
    },
    onError: (err) => toast.error("Failed to create thread: " + err.message),
  });

  const replyMutation = useMutation({
    mutationFn: async () => {
      await base44.entities.ForumPost.create({
        thread_id: threadId,
        content: replyContent.trim(),
        created_by: memberInfo.id,
        created_by_type: "member",
        parent_post_id: replyingToPost || null,
      });
      await base44.entities.ForumThread.update(threadId, {
        post_count: (thread.post_count || 0) + 1,
        last_post_at: new Date().toISOString(),
        last_post_by: memberInfo.id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-posts", threadId] });
      queryClient.invalidateQueries({ queryKey: ["forum-thread", threadId] });
      setReplyContent("");
      setReplyingToPost(null);
      toast.success("Reply posted");
    },
    onError: (err) => toast.error("Failed to post reply: " + err.message),
  });

  const editPostMutation = useMutation({
    mutationFn: ({ postId, content }) =>
      base44.entities.ForumPost.update(postId, {
        content,
        is_edited: true,
        edited_at: new Date().toISOString(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-posts", threadId] });
      setEditingPostId(null);
      setEditContent("");
      toast.success("Post updated");
    },
    onError: (err) => toast.error("Failed to update post: " + err.message),
  });

  const deletePostMutation = useMutation({
    mutationFn: (postId) => base44.entities.ForumPost.delete(postId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-posts", threadId] });
      queryClient.invalidateQueries({ queryKey: ["forum-thread", threadId] });
      setShowDeleteConfirm(false);
      setDeletePostId(null);
      toast.success("Post deleted");
    },
    onError: (err) => toast.error("Failed to delete post: " + err.message),
  });

  const toggleReactionMutation = useMutation({
    mutationFn: async (postId) => {
      const existing = reactions.find(
        (r) => r.post_id === postId && r.member_id === memberInfo.id
      );
      if (existing) {
        await base44.entities.ForumReaction.delete(existing.id);
      } else {
        await base44.entities.ForumReaction.create({
          post_id: postId,
          member_id: memberInfo.id,
          reaction_type: "like",
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-reactions", threadId] });
    },
    onError: (err) => toast.error("Failed to toggle reaction: " + err.message),
  });

  const reportMutation = useMutation({
    mutationFn: () =>
      base44.entities.ForumReport.create({
        thread_id: threadId,
        post_id: reportPostId,
        reported_by: memberInfo.id,
        reason: reportReason,
        details: reportDetails,
      }),
    onSuccess: () => {
      setShowReportDialog(false);
      setReportPostId(null);
      setReportReason("");
      setReportDetails("");
      toast.success("Report submitted");
    },
    onError: (err) => toast.error("Failed to submit report: " + err.message),
  });

  const logModeration = async (action, target_type, target_id, details) => {
    try {
      await fetch('/api/forum/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, target_type, target_id, details })
      });
    } catch (e) {
      console.error('[Forum] Failed to log moderation action:', e);
    }
  };

  const pinMutation = useMutation({
    mutationFn: async (pinned) => {
      await base44.entities.ForumThread.update(threadId, { is_pinned: pinned });
      await logModeration(pinned ? 'pin' : 'unpin', 'thread', threadId, { title: thread?.title });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-thread", threadId] });
      toast.success(thread?.is_pinned ? "Thread unpinned" : "Thread pinned");
    },
    onError: (err) => toast.error("Failed: " + err.message),
  });

  const lockMutation = useMutation({
    mutationFn: async (locked) => {
      await base44.entities.ForumThread.update(threadId, { is_locked: locked });
      await logModeration(locked ? 'lock' : 'unlock', 'thread', threadId, { title: thread?.title });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-thread", threadId] });
      toast.success(thread?.is_locked ? "Thread unlocked" : "Thread locked");
    },
    onError: (err) => toast.error("Failed: " + err.message),
  });

  const moveMutation = useMutation({
    mutationFn: async (newCatId) => {
      await base44.entities.ForumThread.update(threadId, { category_id: newCatId });
      const targetCat = categories.find(c => c.id === newCatId);
      await logModeration('move', 'thread', threadId, { title: thread?.title, from_category: thread?.category_id, to_category: newCatId, to_category_name: targetCat?.name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-thread", threadId] });
      queryClient.invalidateQueries({ queryKey: ["forum-threads-browse"] });
      setShowMoveDialog(false);
      setMoveCategoryId("");
      toast.success("Thread moved");
    },
    onError: (err) => toast.error("Failed to move thread: " + err.message),
  });

  const hidePostMutation = useMutation({
    mutationFn: async ({ postId, hidden }) => {
      await base44.entities.ForumPost.update(postId, { is_hidden: hidden });
      await logModeration(hidden ? 'hide' : 'unhide', 'post', postId, { thread_id: threadId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forum-posts", threadId] });
      toast.success("Post visibility updated");
    },
    onError: (err) => toast.error("Failed: " + err.message),
  });

  const handleReplyTo = (post) => {
    setReplyingToPost(post.id);
    const authorName = memberMap[post.created_by] || "Unknown";
    const quote = post.content?.substring(0, 100) || "";
    setReplyContent(`> ${authorName} wrote:\n> ${quote}${post.content?.length > 100 ? "..." : ""}\n\n`);
    setTimeout(() => replyRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[400px]" data-testid="forum-thread-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (isNewThread) {
    return (
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="ghost"
            onClick={() => navigate(createPageUrl("Forum") + (categoryId ? "?categoryId=" + categoryId : ""))}
            data-testid="button-back-to-forum"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </Button>
          {threadCategory && (
            <span className="text-muted-foreground text-sm" data-testid="text-new-thread-category">
              {threadCategory.name}
            </span>
          )}
        </div>

        <h1 className="text-2xl font-semibold" data-testid="text-new-thread-heading">New Thread</h1>

        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input
                placeholder="Thread title..."
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                data-testid="input-thread-title"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Content</label>
              <Textarea
                placeholder="Write your post content..."
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={8}
                data-testid="input-thread-content"
              />
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => createThreadMutation.mutate()}
                disabled={!newTitle.trim() || !newContent.trim() || createThreadMutation.isPending || !canCreateThread}
                data-testid="button-submit-thread"
              >
                {createThreadMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                ) : (
                  <Send className="w-4 h-4 mr-1" />
                )}
                Create Thread
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (threadLoading || postsLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]" data-testid="forum-thread-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <Button
          variant="ghost"
          onClick={() => navigate(createPageUrl("Forum"))}
          data-testid="button-back-to-forum"
        >
          <ChevronLeft className="w-4 h-4" />
          Back to Forum
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <MessageSquare className="w-10 h-10 mb-3 opacity-40" />
            <p>Thread not found.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const parentPosts = posts.filter((p) => !p.parent_post_id);
  const childPostsMap = {};
  posts.forEach((p) => {
    if (p.parent_post_id) {
      if (!childPostsMap[p.parent_post_id]) childPostsMap[p.parent_post_id] = [];
      childPostsMap[p.parent_post_id].push(p);
    }
  });

  const canEditPost = (post) => {
    if (canEditAny) return true;
    if (canEditOwn && post.created_by === memberInfo?.id) return true;
    return false;
  };

  const canDeletePost = (post) => {
    if (canDeleteAny) return true;
    if (canDeleteOwn && post.created_by === memberInfo?.id) return true;
    return false;
  };

  const renderPost = (post, isChild = false) => {
    const authorName = memberMap[post.created_by] || "Unknown";
    const postReactions = reactionsByPost[post.id] || [];
    const likeCount = postReactions.length;
    const hasLiked = postReactions.some((r) => r.member_id === memberInfo?.id);
    const isEditing = editingPostId === post.id;
    const children = childPostsMap[post.id] || [];

    return (
      <div key={post.id} className={isChild ? "ml-6 sm:ml-10" : ""} data-testid={`post-${post.id}`}>
        <Card className={post.is_hidden ? "opacity-60" : ""}>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <Avatar className="h-9 w-9 shrink-0">
                <AvatarFallback className="text-xs">{getInitials(authorName)}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm" data-testid={`text-post-author-${post.id}`}>
                    {authorName}
                  </span>
                  <span className="text-xs text-muted-foreground" data-testid={`text-post-date-${post.id}`}>
                    {formatDate(post.created_date)}
                  </span>
                  {post.is_edited && (
                    <span className="text-xs text-muted-foreground italic" data-testid={`text-post-edited-${post.id}`}>
                      (edited)
                    </span>
                  )}
                  {post.is_hidden && (
                    <Badge variant="outline" className="text-xs">
                      <EyeOff className="w-3 h-3 mr-0.5" />
                      Hidden
                    </Badge>
                  )}
                </div>

                {isEditing ? (
                  <div className="mt-2 space-y-2">
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={4}
                      data-testid={`input-edit-post-${post.id}`}
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm"
                        onClick={() => editPostMutation.mutate({ postId: post.id, content: editContent })}
                        disabled={!editContent.trim() || editPostMutation.isPending}
                        data-testid={`button-save-edit-${post.id}`}
                      >
                        {editPostMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditingPostId(null); setEditContent(""); }}
                        data-testid={`button-cancel-edit-${post.id}`}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="mt-2 text-sm whitespace-pre-wrap break-words"
                    data-testid={`text-post-content-${post.id}`}
                  >
                    {post.content}
                  </div>
                )}

                {!isEditing && (
                  <div className="flex items-center gap-1 mt-3 flex-wrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`toggle-elevate ${hasLiked ? "toggle-elevated text-red-500" : ""}`}
                      onClick={() => toggleReactionMutation.mutate(post.id)}
                      data-testid={`button-like-${post.id}`}
                    >
                      <Heart className={`w-3.5 h-3.5 mr-1 ${hasLiked ? "fill-current" : ""}`} />
                      {likeCount > 0 && <span className="text-xs">{likeCount}</span>}
                    </Button>

                    {canReply && !thread.is_locked && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleReplyTo(post)}
                        data-testid={`button-reply-${post.id}`}
                      >
                        <Reply className="w-3.5 h-3.5 mr-1" />
                        Reply
                      </Button>
                    )}

                    {canEditPost(post) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setEditingPostId(post.id); setEditContent(post.content || ""); }}
                        data-testid={`button-edit-${post.id}`}
                      >
                        <Pencil className="w-3.5 h-3.5 mr-1" />
                        Edit
                      </Button>
                    )}

                    {canDeletePost(post) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setDeletePostId(post.id); setShowDeleteConfirm(true); }}
                        data-testid={`button-delete-${post.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Delete
                      </Button>
                    )}

                    {canReport && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { setReportPostId(post.id); setShowReportDialog(true); }}
                        data-testid={`button-report-${post.id}`}
                      >
                        <Flag className="w-3.5 h-3.5 mr-1" />
                        Report
                      </Button>
                    )}

                    {canHidePosts && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => hidePostMutation.mutate({ postId: post.id, hidden: !post.is_hidden })}
                        data-testid={`button-hide-${post.id}`}
                      >
                        {post.is_hidden ? <Eye className="w-3.5 h-3.5 mr-1" /> : <EyeOff className="w-3.5 h-3.5 mr-1" />}
                        {post.is_hidden ? "Show" : "Hide"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {children.length > 0 && (
          <div className="space-y-3 mt-3">
            {children.map((child) => renderPost(child, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="ghost"
          onClick={() =>
            navigate(
              createPageUrl("Forum") +
                (thread.category_id ? "?categoryId=" + thread.category_id : "")
            )
          }
          data-testid="button-back-to-category"
        >
          <ChevronLeft className="w-4 h-4" />
          {threadCategory?.name || "Back"}
        </Button>
      </div>

      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold" data-testid="text-thread-title">
                {thread.title}
              </h1>
              {thread.is_pinned && (
                <Badge variant="secondary" className="text-xs" data-testid="badge-thread-pinned">
                  <Pin className="w-3 h-3 mr-0.5" />
                  Pinned
                </Badge>
              )}
              {thread.is_locked && (
                <Badge variant="outline" className="text-xs" data-testid="badge-thread-locked">
                  <Lock className="w-3 h-3 mr-0.5" />
                  Locked
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1 flex-wrap">
              <span data-testid="text-thread-author">
                by {memberMap[thread.created_by] || "Unknown"}
              </span>
              <span className="flex items-center gap-1" data-testid="text-thread-date">
                <Clock className="w-3.5 h-3.5" />
                {formatDate(thread.created_date)}
              </span>
              <span className="flex items-center gap-1" data-testid="text-thread-views">
                <Eye className="w-3.5 h-3.5" />
                {thread.view_count || 0} views
              </span>
            </div>
          </div>
        </div>

        {(canPin || canLock || canMove) && (
          <div className="flex items-center gap-2 flex-wrap">
            {canPin && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => pinMutation.mutate(!thread.is_pinned)}
                disabled={pinMutation.isPending}
                data-testid="button-pin-thread"
              >
                <Pin className="w-3.5 h-3.5 mr-1" />
                {thread.is_pinned ? "Unpin" : "Pin"}
              </Button>
            )}
            {canLock && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => lockMutation.mutate(!thread.is_locked)}
                disabled={lockMutation.isPending}
                data-testid="button-lock-thread"
              >
                <Lock className="w-3.5 h-3.5 mr-1" />
                {thread.is_locked ? "Unlock" : "Lock"}
              </Button>
            )}
            {canMove && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowMoveDialog(true)}
                data-testid="button-move-thread"
              >
                <ArrowRightLeft className="w-3.5 h-3.5 mr-1" />
                Move
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        {parentPosts.map((post) => renderPost(post))}
      </div>

      {posts.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No posts yet.</p>
          </CardContent>
        </Card>
      )}

      {canReply && !thread.is_locked && (
        <div ref={replyRef} className="space-y-2" data-testid="reply-section">
          {replyingToPost && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Reply className="w-3.5 h-3.5" />
              <span>Replying to {memberMap[posts.find((p) => p.id === replyingToPost)?.created_by] || "a post"}</span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => { setReplyingToPost(null); setReplyContent(""); }}
                data-testid="button-cancel-reply-to"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
          <Card>
            <CardContent className="p-4 space-y-3">
              <Textarea
                placeholder="Write a reply..."
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                rows={4}
                data-testid="input-reply-content"
              />
              <div className="flex justify-end">
                <Button
                  onClick={() => replyMutation.mutate()}
                  disabled={!replyContent.trim() || replyMutation.isPending}
                  data-testid="button-submit-reply"
                >
                  {replyMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : (
                    <Send className="w-4 h-4 mr-1" />
                  )}
                  Reply
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {thread.is_locked && (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
            <Lock className="w-4 h-4" />
            <span className="text-sm">This thread is locked. No new replies can be posted.</span>
          </CardContent>
        </Card>
      )}

      <Dialog open={showReportDialog} onOpenChange={setShowReportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report Post</DialogTitle>
            <DialogDescription>
              Please provide a reason for reporting this post.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Reason</label>
              <Select value={reportReason} onValueChange={setReportReason}>
                <SelectTrigger data-testid="select-report-reason">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="spam">Spam</SelectItem>
                  <SelectItem value="harassment">Harassment</SelectItem>
                  <SelectItem value="inappropriate">Inappropriate Content</SelectItem>
                  <SelectItem value="off-topic">Off Topic</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Additional Details</label>
              <Textarea
                placeholder="Provide more details (optional)..."
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                rows={3}
                data-testid="input-report-details"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setShowReportDialog(false); setReportReason(""); setReportDetails(""); }}
              data-testid="button-cancel-report"
            >
              Cancel
            </Button>
            <Button
              onClick={() => reportMutation.mutate()}
              disabled={!reportReason || reportMutation.isPending}
              data-testid="button-submit-report"
            >
              {reportMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Submit Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Post</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this post? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setShowDeleteConfirm(false); setDeletePostId(null); }}
              data-testid="button-cancel-delete"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletePostMutation.mutate(deletePostId)}
              disabled={deletePostMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deletePostMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move Thread</DialogTitle>
            <DialogDescription>
              Select the category to move this thread to.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Select value={moveCategoryId} onValueChange={setMoveCategoryId}>
              <SelectTrigger data-testid="select-move-category">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories
                  .filter((c) => c.id !== thread.category_id && c.is_active)
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setShowMoveDialog(false); setMoveCategoryId(""); }}
              data-testid="button-cancel-move"
            >
              Cancel
            </Button>
            <Button
              onClick={() => moveMutation.mutate(moveCategoryId)}
              disabled={!moveCategoryId || moveMutation.isPending}
              data-testid="button-confirm-move"
            >
              {moveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
