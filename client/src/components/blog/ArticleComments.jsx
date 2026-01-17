import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThumbsUp, ThumbsDown, MessageCircle, Send, User, ShieldAlert } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useArticleCommentRealtime } from "@/hooks/useArticleCommentRealtime";
import { useCommentReactionRealtime } from "@/hooks/useCommentReactionRealtime";

// Safe date formatting helper to handle corrupted/missing dates
function formatCommentDate(dateValue) {
  if (!dateValue) return 'Just now';
  try {
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return 'Just now';
    return format(date, 'MMM d, yyyy h:mm a');
  } catch {
    return 'Just now';
  }
}

export default function ArticleComments({ articleId, memberInfo, showThumbsUp = true, showThumbsDown = true }) {
  const [newComment, setNewComment] = useState("");
  const [publicUserName, setPublicUserName] = useState("");
  const [userIdentifier, setUserIdentifier] = useState("");
  const [isCheckingContent, setIsCheckingContent] = useState(false);
  
  const queryClient = useQueryClient();
  const isAuthenticated = !!memberInfo;
  
  // Only use realtime subscriptions for authenticated users
  useArticleCommentRealtime(isAuthenticated ? articleId : null);
  useCommentReactionRealtime(isAuthenticated ? articleId : null, isAuthenticated ? userIdentifier : null);

  // Generate or retrieve user identifier for public users
  useEffect(() => {
    if (!memberInfo) {
      // For public users, use a session-based identifier
      let identifier = sessionStorage.getItem('public_user_id');
      if (!identifier) {
        identifier = `public_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        sessionStorage.setItem('public_user_id', identifier);
      }
      setUserIdentifier(identifier);
    } else {
      setUserIdentifier(memberInfo.email);
    }
  }, [memberInfo]);

  // Fetch comments for this article - use public API for unauthenticated users
  const { data: comments = [], isLoading } = useQuery({
    queryKey: ['article-comments', articleId, isAuthenticated],
    queryFn: async () => {
      if (isAuthenticated) {
        const allComments = await base44.entities.ArticleComment.list('-created_at');
        return allComments.filter(comment => comment.article_id === articleId);
      } else {
        const result = await publicClient.getArticleComments(articleId);
        // Public API now returns correct column names (content, author_name)
        return result.comments || [];
      }
    },
    enabled: !!articleId,
  });

  // Fetch user's reactions - only for authenticated users (public users don't have reactions)
  const { data: userReactions = [] } = useQuery({
    queryKey: ['user-reactions', userIdentifier],
    queryFn: async () => {
      if (!userIdentifier || !isAuthenticated) return [];
      const allReactions = await base44.entities.CommentReaction.list();
      return allReactions.filter(reaction => reaction.user_identifier === userIdentifier);
    },
    enabled: !!userIdentifier && isAuthenticated,
  });

  // Add comment mutation - use public API for unauthenticated users
  const addCommentMutation = useMutation({
    mutationFn: async (commentData) => {
      if (isAuthenticated) {
        return await base44.entities.ArticleComment.create(commentData);
      } else {
        const result = await publicClient.postArticleComment(articleId, {
          content: commentData.content,
          author_name: commentData.author_name,
          user_identifier: commentData.user_identifier
        });
        return result.comment;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article-comments', articleId] });
      setNewComment("");
      setPublicUserName("");
      toast.success('Comment added successfully');
    },
    onError: () => {
      toast.error('Failed to add comment');
    },
  });

  // Add/remove reaction mutation
  const reactionMutation = useMutation({
    mutationFn: async ({ commentId, reactionType, currentReaction }) => {
      const comment = comments.find(c => c.id === commentId);
      if (!comment) throw new Error('Comment not found');

      // If user already has this reaction, remove it
      if (currentReaction && currentReaction.reaction_type === reactionType) {
        await base44.entities.CommentReaction.delete(currentReaction.id);
        
        // Decrement count
        const updateData = reactionType === 'up' 
          ? { thumbs_up_count: Math.max(0, (comment.thumbs_up_count || 0) - 1) }
          : { thumbs_down_count: Math.max(0, (comment.thumbs_down_count || 0) - 1) };
        await base44.entities.ArticleComment.update(commentId, updateData);
        
        return { action: 'removed', reactionType };
      }

      // If user has opposite reaction, switch it
      if (currentReaction && currentReaction.reaction_type !== reactionType) {
        await base44.entities.CommentReaction.update(currentReaction.id, {
          reaction_type: reactionType
        });
        
        // Update counts (decrement old, increment new)
        const updateData = reactionType === 'up'
          ? {
              thumbs_up_count: (comment.thumbs_up_count || 0) + 1,
              thumbs_down_count: Math.max(0, (comment.thumbs_down_count || 0) - 1)
            }
          : {
              thumbs_down_count: (comment.thumbs_down_count || 0) + 1,
              thumbs_up_count: Math.max(0, (comment.thumbs_up_count || 0) - 1)
            };
        await base44.entities.ArticleComment.update(commentId, updateData);
        
        return { action: 'switched', reactionType };
      }

      // Add new reaction
      await base44.entities.CommentReaction.create({
        comment_id: commentId,
        reaction_type: reactionType,
        user_identifier: userIdentifier,
        is_member: !!memberInfo
      });

      // Increment count
      const updateData = reactionType === 'up'
        ? { thumbs_up_count: (comment.thumbs_up_count || 0) + 1 }
        : { thumbs_down_count: (comment.thumbs_down_count || 0) + 1 };
      await base44.entities.ArticleComment.update(commentId, updateData);

      return { action: 'added', reactionType };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article-comments', articleId] });
      queryClient.invalidateQueries({ queryKey: ['user-reactions', userIdentifier] });
    },
    onError: () => {
      toast.error('Failed to update reaction');
    },
  });

  const handleSubmitComment = async (e) => {
    e.preventDefault();
    
    if (!newComment.trim()) {
      toast.error('Please enter a comment');
      return;
    }

    if (!memberInfo && !publicUserName.trim()) {
      toast.error('Please enter your name');
      return;
    }

    setIsCheckingContent(true);
    
    try {
      // Content moderation only for authenticated users (public users skip this for now)
      if (isAuthenticated) {
        const moderationResult = await base44.integrations.Core.InvokeLLM({
          prompt: `You are a content moderation system. Analyze the following comment for inappropriate content including profanity, hate speech, sexually explicit material, threats, or harassment.

Comment to analyze: "${newComment.trim()}"

Respond with a JSON object containing exactly two fields:
- "is_safe": true if the content is appropriate for posting, false if it contains inappropriate content
- "reason": a brief explanation if flagged, or empty string if safe`,
          response_json_schema: {
            type: "object",
            properties: {
              is_safe: {
                type: "boolean",
                description: "true if content is appropriate, false if it contains inappropriate content"
              },
              reason: {
                type: "string",
                description: "Brief explanation of why content was flagged (empty if safe)"
              }
            }
          }
        });

        const isSafe = typeof moderationResult.is_safe === 'boolean' 
          ? moderationResult.is_safe 
          : moderationResult.analysis?.is_safe ?? true;
        
        if (!isSafe) {
          setIsCheckingContent(false);
          toast.error(
            <>
              <div className="flex items-start gap-2">
                <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Comment blocked</p>
                  <p className="text-sm">Your comment contains inappropriate content and cannot be posted. Please revise and try again.</p>
                </div>
              </div>
            </>,
            { duration: 5000 }
          );
          return;
        }
      }

      // Build comment data based on authentication state
      let commentData;
      if (isAuthenticated) {
        // Authenticated users use base44 schema
        commentData = {
          article_id: articleId,
          content: newComment.trim(),
          author_name: `${memberInfo.first_name} ${memberInfo.last_name}`,
          author_member_id: memberInfo.id,
          is_member: true,
          thumbs_up_count: 0,
          thumbs_down_count: 0
        };
      } else {
        // Public users use public API schema (same field names as DB)
        commentData = {
          content: newComment.trim(),
          author_name: publicUserName.trim(),
          user_identifier: userIdentifier
        };
      }

      addCommentMutation.mutate(commentData);
      
    } catch (error) {
      console.error('Content moderation error:', error);
      toast.error('Failed to verify comment content. Please try again.');
    } finally {
      setIsCheckingContent(false);
    }
  };

  const handleReaction = (commentId, reactionType) => {
    // Guard: reactions are only available for authenticated users
    if (!isAuthenticated) return;
    const currentReaction = userReactions.find(r => r.comment_id === commentId);
    reactionMutation.mutate({ commentId, reactionType, currentReaction });
  };

  const getUserReactionForComment = (commentId) => {
    return userReactions.find(r => r.comment_id === commentId);
  };

  const isSubmitting = addCommentMutation.isPending || isCheckingContent;

  return (
    <div className="space-y-6">
      {/* Comments Header */}
      <div className="flex items-center gap-2">
        <MessageCircle className="w-5 h-5 text-slate-600" />
        <h3 className="text-xl font-semibold text-slate-900">
          Comments ({comments.length})
        </h3>
      </div>

      {/* Add Comment Form */}
      <Card className="border-slate-200 shadow-sm">
        <CardContent className="pt-6">
          <form onSubmit={handleSubmitComment} className="space-y-4">
            {!memberInfo && (
              <div className="space-y-2">
                <Label htmlFor="name">Your Name *</Label>
                <Input
                  id="name"
                  placeholder="Enter your name"
                  value={publicUserName}
                  onChange={(e) => setPublicUserName(e.target.value)}
                  required
                />
              </div>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="comment">
                {memberInfo ? 'Add a comment' : 'Your Comment *'}
              </Label>
              <Textarea
                id="comment"
                placeholder="Share your thoughts..."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                rows={3}
                required
              />
              <p className="text-xs text-slate-500 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" />
                Comments are automatically checked for inappropriate content
              </p>
            </div>

            <div className="flex justify-end">
              <Button 
                type="submit" 
                disabled={isSubmitting}
                className="bg-blue-600 hover:bg-blue-700 gap-2"
              >
                {isCheckingContent ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Checking content...
                  </>
                ) : addCommentMutation.isPending ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Posting...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Post Comment
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Comments List */}
      {isLoading ? (
        <div className="space-y-4">
          {Array(3).fill(0).map((_, i) => (
            <Card key={i} className="border-slate-200 animate-pulse">
              <CardContent className="p-6">
                <div className="h-4 bg-slate-200 rounded w-1/4 mb-3" />
                <div className="h-3 bg-slate-200 rounded w-full mb-2" />
                <div className="h-3 bg-slate-200 rounded w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : comments.length === 0 ? (
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-12 text-center">
            <MessageCircle className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-600">No comments yet. Be the first to share your thoughts!</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {comments.map((comment) => {
            const userReaction = getUserReactionForComment(comment.id);
            const hasThumbsUp = userReaction?.reaction_type === 'up';
            const hasThumbsDown = userReaction?.reaction_type === 'down';

            return (
              <Card key={comment.id} className="border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white font-semibold flex-shrink-0">
                      {comment.is_member ? (
                        <User className="w-5 h-5" />
                      ) : (
                        (comment.author_name || 'A').charAt(0).toUpperCase()
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-slate-900">
                          {comment.author_name}
                        </span>
                        {comment.is_member && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                            Member
                          </span>
                        )}
                        <span className="text-sm text-slate-500">
                          • {formatCommentDate(comment.created_date || comment.created_at)}
                        </span>
                      </div>

                      <p className="text-slate-700 mb-3 whitespace-pre-wrap break-words">
                        {comment.content}
                      </p>

                      {/* Reactions only shown for authenticated users */}
                      {isAuthenticated && (showThumbsUp || showThumbsDown) && (
                        <div className="flex items-center gap-4">
                          {showThumbsUp && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleReaction(comment.id, 'up')}
                              disabled={reactionMutation.isPending}
                              className={`gap-1 ${hasThumbsUp ? 'text-blue-600 bg-blue-50' : 'text-slate-600'} hover:text-blue-600 hover:bg-blue-50`}
                            >
                              <ThumbsUp className={`w-4 h-4 ${hasThumbsUp ? 'fill-blue-600' : ''}`} />
                              <span className="text-sm font-medium">
                                {comment.thumbs_up_count || 0}
                              </span>
                            </Button>
                          )}

                          {showThumbsDown && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleReaction(comment.id, 'down')}
                              disabled={reactionMutation.isPending}
                              className={`gap-1 ${hasThumbsDown ? 'text-red-600 bg-red-50' : 'text-slate-600'} hover:text-red-600 hover:bg-red-50`}
                            >
                              <ThumbsDown className={`w-4 h-4 ${hasThumbsDown ? 'fill-red-600' : ''}`} />
                              <span className="text-sm font-medium">
                                {comment.thumbs_down_count || 0}
                              </span>
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}