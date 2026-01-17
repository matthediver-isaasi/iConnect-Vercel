import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { toast } from "sonner";
import { useArticleReactionRealtime } from "@/hooks/useArticleReactionRealtime";

export default function ArticleReactions({ articleId, memberInfo, showThumbsUp = true, showThumbsDown = true }) {
  const [userIdentifier, setUserIdentifier] = useState("");
  const queryClient = useQueryClient();
  const isAuthenticated = !!memberInfo;
  
  // Only use realtime for authenticated users
  useArticleReactionRealtime(isAuthenticated ? articleId : null, userIdentifier);

  // Generate or retrieve user identifier
  useEffect(() => {
    if (!memberInfo) {
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

  // Single query to fetch all reactions for this article - use public API for unauthenticated users
  const { data: allReactions = [] } = useQuery({
    queryKey: ['article-reactions', articleId, isAuthenticated],
    queryFn: async () => {
      if (isAuthenticated) {
        const reactions = await base44.entities.ArticleReaction.list();
        return reactions.filter(r => r.article_id === articleId);
      } else {
        const result = await publicClient.getArticleReactions(articleId);
        return result.reactions || [];
      }
    },
    enabled: !!articleId,
  });

  // Derive user reaction from allReactions (no separate fetch)
  const userReaction = userIdentifier 
    ? allReactions.find(r => r.user_identifier === userIdentifier)
    : null;

  // Calculate counts
  const thumbsUpCount = allReactions.filter(r => r.reaction_type === 'up').length;
  const thumbsDownCount = allReactions.filter(r => r.reaction_type === 'down').length;

  // Reaction mutation with optimistic updates - use public API for unauthenticated users
  const reactionMutation = useMutation({
    mutationFn: async (reactionType) => {
      if (isAuthenticated) {
        // Use base44 API for authenticated users
        const currentUserReaction = userReaction;

        if (currentUserReaction && currentUserReaction.reaction_type === reactionType) {
          await base44.entities.ArticleReaction.delete(currentUserReaction.id);
          return { action: 'removed', reactionType };
        }

        if (currentUserReaction && currentUserReaction.reaction_type !== reactionType) {
          await base44.entities.ArticleReaction.update(currentUserReaction.id, {
            reaction_type: reactionType
          });
          return { action: 'switched', reactionType };
        }

        await base44.entities.ArticleReaction.create({
          article_id: articleId,
          reaction_type: reactionType,
          user_identifier: userIdentifier,
          is_member: true
        });
        return { action: 'added', reactionType };
      } else {
        // Use public API for unauthenticated users
        const result = await publicClient.postArticleReaction(articleId, {
          reaction_type: reactionType,
          user_identifier: userIdentifier,
          is_member: false
        });
        return result;
      }
    },
    onMutate: async (reactionType) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['article-reactions', articleId, isAuthenticated] });
      
      // Snapshot previous value
      const previousReactions = queryClient.getQueryData(['article-reactions', articleId, isAuthenticated]);
      
      // Optimistically update
      queryClient.setQueryData(['article-reactions', articleId, isAuthenticated], (old) => {
        if (!old) return old;
        const existing = old.find(r => r.user_identifier === userIdentifier);
        
        if (existing && existing.reaction_type === reactionType) {
          return old.filter(r => r.id !== existing.id);
        } else if (existing) {
          return old.map(r => r.id === existing.id ? { ...r, reaction_type: reactionType } : r);
        } else {
          return [...old, { 
            id: `temp-${Date.now()}`, 
            article_id: articleId, 
            reaction_type: reactionType, 
            user_identifier: userIdentifier,
            is_member: isAuthenticated
          }];
        }
      });
      
      return { previousReactions };
    },
    onError: (err, reactionType, context) => {
      if (context?.previousReactions) {
        queryClient.setQueryData(['article-reactions', articleId, isAuthenticated], context.previousReactions);
      }
      toast.error('Failed to update reaction');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['article-reactions', articleId, isAuthenticated] });
    },
  });

  const handleReaction = (reactionType) => {
    reactionMutation.mutate(reactionType);
  };

  const hasThumbsUp = userReaction?.reaction_type === 'up';
  const hasThumbsDown = userReaction?.reaction_type === 'down';

  return (
    <div className="flex items-center gap-3">
      {showThumbsUp && (
        <Button
          variant="outline"
          size="lg"
          onClick={() => handleReaction('up')}
          disabled={reactionMutation.isPending}
          className={`gap-2 ${
            hasThumbsUp 
              ? 'bg-blue-50 border-blue-300 text-blue-700 hover:bg-blue-100' 
              : 'hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700'
          } transition-all`}
        >
          <ThumbsUp className={`w-5 h-5 ${hasThumbsUp ? 'fill-blue-700' : ''}`} />
          <span className="text-lg font-semibold">{thumbsUpCount}</span>
        </Button>
      )}

      {showThumbsDown && (
        <Button
          variant="outline"
          size="lg"
          onClick={() => handleReaction('down')}
          disabled={reactionMutation.isPending}
          className={`gap-2 ${
            hasThumbsDown 
              ? 'bg-red-50 border-red-300 text-red-700 hover:bg-red-100' 
              : 'hover:bg-red-50 hover:border-red-300 hover:text-red-700'
          } transition-all`}
        >
          <ThumbsDown className={`w-5 h-5 ${hasThumbsDown ? 'fill-red-700' : ''}`} />
          <span className="text-lg font-semibold">{thumbsDownCount}</span>
        </Button>
      )}
    </div>
  );
}