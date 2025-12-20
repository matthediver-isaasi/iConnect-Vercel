import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { User, UserMinus, BellRing } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

export default function FollowedAuthorsCard({ memberInfo, articleDisplayName = "Articles" }) {
  const queryClient = useQueryClient();

  const { data: followedAuthors = [], isLoading } = useQuery({
    queryKey: ['article-follows'],
    queryFn: async () => {
      const response = await fetch('/api/article-follows', {
        credentials: 'include'
      });
      if (!response.ok) {
        if (response.status === 401) return [];
        throw new Error('Failed to fetch followed authors');
      }
      return response.json();
    },
    enabled: !!memberInfo,
    staleTime: 30000,
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
      queryClient.invalidateQueries({ queryKey: ['article-follows'] });
      toast.success('Unfollowed author');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to unfollow author');
    }
  });

  const markReadMutation = useMutation({
    mutationFn: async (followId) => {
      const response = await fetch(`/api/article-follows/${followId}/mark-read`, {
        method: 'PATCH',
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error('Failed to mark as read');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article-follows'] });
    }
  });

  if (!memberInfo) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="mt-6" data-testid="card-followed-authors-loading">
        <h3 className="text-sm font-semibold mb-3">Authors You Follow</h3>
        <div className="flex justify-center py-4">
          <div className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (followedAuthors.length === 0) {
    return null;
  }

  const handleAuthorClick = (follow) => {
    if (follow.unread_count > 0) {
      markReadMutation.mutate(follow.id);
    }
  };

  return (
    <div className="mt-6" data-testid="card-followed-authors">
      <h3 className="text-sm font-semibold mb-3">Authors You Follow</h3>
      <div className="space-y-1">
        {followedAuthors.map((follow) => (
          <div
            key={follow.id}
            className="flex items-start gap-2 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            data-testid={`followed-author-${follow.id}`}
          >
            <Link
              to={follow.author_handle ? `/articles/author/${follow.author_handle}` : '/articles'}
              className="flex items-start gap-2 flex-1 min-w-0"
              onClick={() => handleAuthorClick(follow)}
            >
              {/* Avatar or notification badge */}
              {follow.unread_count > 0 ? (
                <div 
                  className="w-7 h-7 flex-shrink-0 rounded-full bg-blue-600 flex items-center justify-center"
                  data-testid={`badge-unread-${follow.id}`}
                >
                  <BellRing className="w-3.5 h-3.5 text-white" />
                </div>
              ) : (
                <Avatar className="w-7 h-7 flex-shrink-0">
                  {follow.author_profile_photo && (
                    <AvatarImage src={follow.author_profile_photo} alt={follow.author_name} />
                  )}
                  <AvatarFallback className="bg-slate-200 dark:bg-slate-700">
                    <User className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                  </AvatarFallback>
                </Avatar>
              )}
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm font-medium truncate" data-testid={`text-author-${follow.id}`}>
                  {follow.author_name}
                </span>
                {follow.author_organization && (
                  <span className="text-xs text-slate-500 dark:text-slate-400 truncate" data-testid={`text-org-${follow.id}`}>
                    {follow.author_organization}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    unfollowMutation.mutate(follow.id);
                  }}
                  disabled={unfollowMutation.isPending}
                  className="h-6 px-2 mt-1 w-fit text-xs text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                  data-testid={`button-unfollow-${follow.id}`}
                >
                  {unfollowMutation.isPending ? (
                    <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin mr-1" />
                  ) : (
                    <UserMinus className="w-3 h-3 mr-1" />
                  )}
                  Unfollow
                </Button>
              </div>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
