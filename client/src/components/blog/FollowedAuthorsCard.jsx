import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { User, UserMinus, BellRing, Users } from "lucide-react";
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
      <Card className="mt-6" data-testid="card-followed-authors-loading">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Users className="w-4 h-4" />
            Following
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-4">
            <div className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          </div>
        </CardContent>
      </Card>
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
    <Card className="mt-6" data-testid="card-followed-authors">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="w-4 h-4" />
          Authors You Follow
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {followedAuthors.map((follow) => (
          <div
            key={follow.id}
            className="flex items-center justify-between gap-2 p-2 rounded-lg hover:bg-slate-50 transition-colors"
            data-testid={`followed-author-${follow.id}`}
          >
            <Link
              to={follow.author_handle ? `/articles/${follow.author_handle}` : '/articles'}
              className="flex items-center gap-2 flex-1 min-w-0"
              onClick={() => handleAuthorClick(follow)}
            >
              <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
                <User className="w-4 h-4 text-slate-500" />
              </div>
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="text-sm font-medium text-slate-700 truncate" data-testid={`text-author-${follow.id}`}>
                  {follow.author_name}
                </span>
                {follow.unread_count > 0 && (
                  <Badge 
                    variant="default" 
                    className="bg-blue-600 text-white flex items-center gap-1 flex-shrink-0"
                    data-testid={`badge-unread-${follow.id}`}
                  >
                    <BellRing className="w-3 h-3" />
                    {follow.unread_count}
                  </Badge>
                )}
              </div>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => unfollowMutation.mutate(follow.id)}
              disabled={unfollowMutation.isPending}
              className="flex-shrink-0 text-slate-400 hover:text-red-500 hover:bg-red-50"
              title="Unfollow"
              data-testid={`button-unfollow-${follow.id}`}
            >
              {unfollowMutation.isPending ? (
                <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <UserMinus className="w-4 h-4" />
              )}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
