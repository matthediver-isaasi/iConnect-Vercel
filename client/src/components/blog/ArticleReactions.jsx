import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { toast } from "sonner";
import { useArticleReactionRealtime } from "@/hooks/useArticleReactionRealtime";

export default function ArticleReactions({ articleId, memberInfo, showThumbsUp = true, showThumbsDown = true }) {
  const [userIdentifier, setUserIdentifier] = useState("");
  const queryClient = useQueryClient();
  
  useArticleReactionRealtime(articleId, userIdentifier);

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

  // Fetch all reactions for this article
  const { data: allReactions = [] } = useQuery({
    queryKey: ['article-reactions', articleId],
    queryFn: async () => {
      const reactions = await base44.entities.ArticleReaction.list();
      return reactions.filter(r => r.article_id === articleId);
    },
    enabled: !!articleId,
  });

  // Fetch user's reaction
  const { data: userReaction } = useQuery({
    queryKey: ['user-article-reaction', articleId, userIdentifier],
    queryFn: async () => {
      if (!userIdentifier) return null;
      const reactions = await base44.entities.ArticleReaction.list();
      return reactions.find(r => r.article_id === articleId && r.user_identifier === userIdentifier);
    },
    enabled: !!articleId && !!userIdentifier,
  });

  // Calculate counts
  const thumbsUpCount = allReactions.filter(r => r.reaction_type === 'up').length;
  const thumbsDownCount = allReactions.filter(r => r.reaction_type === 'down').length;

  // Reaction mutation
  const reactionMutation = useMutation({
    mutationFn: async (reactionType) => {
      // Fetch fresh user reaction to avoid stale closure data
      const allReactions = await base44.entities.ArticleReaction.list();
      const currentUserReaction = allReactions.find(
        r => r.article_id === articleId && r.user_identifier === userIdentifier
      );

      // If user already has this reaction, remove it
      if (currentUserReaction && currentUserReaction.reaction_type === reactionType) {
        await base44.entities.ArticleReaction.delete(currentUserReaction.id);
        return { action: 'removed' };
      }

      // If user has opposite reaction, update it
      if (currentUserReaction && currentUserReaction.reaction_type !== reactionType) {
        await base44.entities.ArticleReaction.update(currentUserReaction.id, {
          reaction_type: reactionType
        });
        return { action: 'switched' };
      }

      // Add new reaction
      await base44.entities.ArticleReaction.create({
        article_id: articleId,
        reaction_type: reactionType,
        user_identifier: userIdentifier,
        is_member: !!memberInfo
      });
      return { action: 'added' };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article-reactions', articleId] });
      queryClient.invalidateQueries({ queryKey: ['user-article-reaction', articleId, userIdentifier] });
    },
    onError: () => {
      toast.error('Failed to update reaction');
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