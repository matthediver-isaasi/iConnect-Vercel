import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, LayoutGrid, Archive, Loader2, Users, Settings, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { Link } from "react-router-dom";
import { apiRequest } from "@/lib/queryClient";

const BOARD_COLORS = [
  { value: '#6366f1', label: 'Indigo' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#ef4444', label: 'Red' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#22c55e', label: 'Green' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#64748b', label: 'Slate' }
];

export default function ProjectBoardsPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [newBoard, setNewBoard] = useState({ name: '', description: '', color: '#6366f1', visibility: 'private' });

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('projects.boards')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: boardsData = { boards: [] }, isLoading } = useQuery({
    queryKey: ['project-boards', showArchived],
    queryFn: async () => {
      const response = await fetch(`/api/projects/boards?archived=${showArchived}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch boards');
      return response.json();
    },
    enabled: accessChecked
  });

  const createBoardMutation = useMutation({
    mutationFn: async (data) => {
      const response = await apiRequest('POST', '/api/projects/boards', data);
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-boards'] });
      setShowCreateDialog(false);
      setNewBoard({ name: '', description: '', color: '#6366f1', visibility: 'private' });
      toast.success('Board created successfully');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create board');
    }
  });

  const handleCreateBoard = () => {
    if (!newBoard.name.trim()) {
      toast.error('Board name is required');
      return;
    }
    createBoardMutation.mutate(newBoard);
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const canCreateBoards = !isFeatureExcluded('projects.boards.create');

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Project Boards</h1>
          <p className="text-muted-foreground">Manage your projects with Kanban-style boards</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowArchived(!showArchived)}
            data-testid="button-toggle-archived"
          >
            <Archive className="w-4 h-4 mr-2" />
            {showArchived ? 'Hide Archived' : 'Show Archived'}
          </Button>
          {canCreateBoards && (
            <Button onClick={() => setShowCreateDialog(true)} data-testid="button-create-board">
              <Plus className="w-4 h-4 mr-2" />
              Create Board
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : boardsData.boards?.length === 0 ? (
        <Card className="p-12 text-center">
          <LayoutGrid className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold mb-2">No boards yet</h3>
          <p className="text-muted-foreground mb-4">
            {showArchived 
              ? 'No archived boards found.' 
              : 'Create your first project board to get started organizing your work.'}
          </p>
          {canCreateBoards && !showArchived && (
            <Button onClick={() => setShowCreateDialog(true)} data-testid="button-create-first-board">
              <Plus className="w-4 h-4 mr-2" />
              Create Your First Board
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {boardsData.boards.map((board) => (
            <Link
              key={board.id}
              to={`/ProjectBoard/${board.id}`}
              className="block"
              data-testid={`link-board-${board.id}`}
            >
              <Card className="hover-elevate cursor-pointer h-full transition-shadow">
                <div
                  className="h-2 rounded-t-md"
                  style={{ backgroundColor: board.color || '#6366f1' }}
                />
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-lg line-clamp-2">{board.name}</CardTitle>
                    {board.is_archived && (
                      <Badge variant="secondary" className="shrink-0">Archived</Badge>
                    )}
                  </div>
                  {board.description && (
                    <CardDescription className="line-clamp-2">
                      {board.description}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Users className="w-4 h-4" />
                      <span className="capitalize">{board.visibility}</span>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {board.user_role}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Board</DialogTitle>
            <DialogDescription>
              Create a new project board to organize your work.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="board-name">Board Name *</Label>
              <Input
                id="board-name"
                value={newBoard.name}
                onChange={(e) => setNewBoard({ ...newBoard, name: e.target.value })}
                placeholder="e.g., Product Development"
                data-testid="input-board-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="board-description">Description</Label>
              <Textarea
                id="board-description"
                value={newBoard.description}
                onChange={(e) => setNewBoard({ ...newBoard, description: e.target.value })}
                placeholder="What is this board for?"
                rows={3}
                data-testid="input-board-description"
              />
            </div>

            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex flex-wrap gap-2">
                {BOARD_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      newBoard.color === color.value ? 'border-foreground scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: color.value }}
                    onClick={() => setNewBoard({ ...newBoard, color: color.value })}
                    title={color.label}
                    data-testid={`button-color-${color.value}`}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="board-visibility">Visibility</Label>
              <Select
                value={newBoard.visibility}
                onValueChange={(value) => setNewBoard({ ...newBoard, visibility: value })}
              >
                <SelectTrigger id="board-visibility" data-testid="select-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private - Only invited members</SelectItem>
                  <SelectItem value="team">Team - All team members</SelectItem>
                  <SelectItem value="organization">Organization - Everyone in the organization</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)} data-testid="button-cancel-create">
              Cancel
            </Button>
            <Button 
              onClick={handleCreateBoard} 
              disabled={createBoardMutation.isPending}
              data-testid="button-confirm-create"
            >
              {createBoardMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Board
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
