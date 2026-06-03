import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { UserPlus, UserMinus } from "lucide-react";
import { toast } from "sonner";

// Task #1225: self-contained follow/unfollow control for a single author
// (member or guest writer). Used for co-author cards where the page-level
// follow hooks can't be reused (hooks can't be called inside a map).
export default function AuthorFollowButton({ memberId = null, guestWriterId = null, enabled = true }) {
  const queryClient = useQueryClient();

  const { data: followStatus = { following: false, followId: null } } = useQuery({
    queryKey: ['follow-status', memberId, guestWriterId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (memberId) params.set('author_id', memberId);
      if (guestWriterId) params.set('guest_writer_id', guestWriterId);
      const response = await fetch(`/api/article-follows/check?${params.toString()}`, {
        credentials: 'include'
      });
      if (!response.ok) return { following: false, followId: null };
      return response.json();
    },
    enabled: enabled && (!!memberId || !!guestWriterId),
  });

  const followMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/article-follows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          followed_member_id: memberId || null,
          followed_guest_writer_id: guestWriterId || null
        })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to follow author');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-status', memberId, guestWriterId] });
      queryClient.invalidateQueries({ queryKey: ['article-follows'] });
      toast.success('Now following this author');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to follow author');
    }
  });

  const unfollowMutation = useMutation({
    mutationFn: async (followId) => {
      const response = await fetch(`/api/article-follows/${followId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to unfollow author');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-status', memberId, guestWriterId] });
      queryClient.invalidateQueries({ queryKey: ['article-follows'] });
      toast.success('Unfollowed author');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to unfollow author');
    }
  });

  const handleToggle = () => {
    if (followStatus.following && followStatus.followId) {
      unfollowMutation.mutate(followStatus.followId);
    } else {
      followMutation.mutate();
    }
  };

  const isPending = followMutation.isPending || unfollowMutation.isPending;

  return (
    <Button
      variant={followStatus.following ? "outline" : "default"}
      size="sm"
      onClick={handleToggle}
      disabled={isPending}
      className="gap-2 flex-shrink-0"
      data-testid={`button-follow-coauthor-${memberId || guestWriterId}`}
    >
      {isPending ? (
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : followStatus.following ? (
        <>
          <UserMinus className="w-4 h-4" />
          Unfollow
        </>
      ) : (
        <>
          <UserPlus className="w-4 h-4" />
          Follow
        </>
      )}
    </Button>
  );
}
