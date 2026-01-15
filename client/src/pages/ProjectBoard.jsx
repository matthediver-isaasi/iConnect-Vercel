import React, { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { 
  Plus, MoreHorizontal, Loader2, ArrowLeft, Calendar, Users, 
  MessageSquare, CheckSquare, Tag, Trash2, Archive, Settings, Clock,
  AlertCircle, X, Check, User, Paperclip
} from "lucide-react";
import { CardAttachments } from "@/components/projects/CardAttachments";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useProjectBoardRealtime } from "@/hooks/useProjectBoardRealtime";
import { Link, useParams } from "react-router-dom";
import { apiRequest } from "@/lib/queryClient";
import { format, isPast, isToday, isTomorrow } from "date-fns";

const PRIORITY_COLORS = {
  none: 'bg-muted',
  low: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  high: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  urgent: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
};

export default function ProjectBoardPage() {
  const { id: boardId } = useParams();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [addingListId, setAddingListId] = useState(null);
  const [newListName, setNewListName] = useState('');
  const [showAddList, setShowAddList] = useState(false);
  const [addingCardToList, setAddingCardToList] = useState(null);
  const [newCardTitle, setNewCardTitle] = useState('');
  const [selectedCard, setSelectedCard] = useState(null);
  const [showCardDetail, setShowCardDetail] = useState(false);
  const [editingCardTitle, setEditingCardTitle] = useState(false);
  const [editingListId, setEditingListId] = useState(null);
  const [editingListName, setEditingListName] = useState('');
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('projects.board-view')) {
        window.location.href = createPageUrl('ProjectBoards');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: boardData, isLoading, error } = useQuery({
    queryKey: ['project-board', boardId],
    queryFn: async () => {
      const response = await fetch(`/api/projects/boards/${boardId}`, {
        credentials: 'include'
      });
      if (!response.ok) {
        if (response.status === 403) throw new Error('Not authorized to view this board');
        throw new Error('Failed to load board');
      }
      return response.json();
    },
    enabled: accessChecked && !!boardId
  });

  useProjectBoardRealtime(boardId);

  const createListMutation = useMutation({
    mutationFn: async (name) => {
      const response = await apiRequest('POST', `/api/projects/boards/${boardId}/lists`, { name });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-board', boardId] });
      setNewListName('');
      setShowAddList(false);
      toast.success('List created');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create list');
    }
  });

  const updateListMutation = useMutation({
    mutationFn: async ({ listId, data }) => {
      const response = await apiRequest('PATCH', `/api/projects/lists/${listId}`, data);
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-board', boardId] });
      setEditingListId(null);
    }
  });

  const deleteListMutation = useMutation({
    mutationFn: async (listId) => {
      const response = await apiRequest('DELETE', `/api/projects/lists/${listId}`);
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-board', boardId] });
      toast.success('List deleted');
    }
  });

  const createCardMutation = useMutation({
    mutationFn: async ({ list_id, title }) => {
      const response = await apiRequest('POST', '/api/projects/cards', { list_id, title });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-board', boardId] });
      setNewCardTitle('');
      setAddingCardToList(null);
      toast.success('Card created');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create card');
    }
  });

  const moveCardMutation = useMutation({
    mutationFn: async ({ cardId, list_id, position }) => {
      const response = await apiRequest('POST', `/api/projects/cards/${cardId}/move`, { list_id, position });
      return response;
    },
    onMutate: async ({ cardId, list_id, position }) => {
      // Cancel any outgoing refetches to prevent overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: ['project-board', boardId] });

      // Snapshot the previous value (deep clone to preserve for rollback)
      const previousData = queryClient.getQueryData(['project-board', boardId]);

      // Optimistically update the cache
      queryClient.setQueryData(['project-board', boardId], (old) => {
        if (!old?.cards) return old;

        // Deep clone all cards to avoid mutating cached data
        const cards = old.cards.map(c => ({ ...c }));
        const movedCard = cards.find(c => c.id === cardId);
        if (!movedCard) return old;

        const sourceListId = movedCard.list_id;
        const destListId = list_id;

        // Get source and destination lists (excluding the moved card for now)
        const sourceCards = cards
          .filter(c => c.list_id === sourceListId && c.id !== cardId)
          .sort((a, b) => a.position - b.position);

        const destCards = sourceListId === destListId
          ? sourceCards // Same list - work with the filtered source
          : cards
              .filter(c => c.list_id === destListId)
              .sort((a, b) => a.position - b.position);

        // Update moved card's list_id
        movedCard.list_id = destListId;

        // Insert at new position
        if (sourceListId === destListId) {
          // Same list: insert at new position
          sourceCards.splice(position, 0, movedCard);
          // Update positions
          sourceCards.forEach((c, idx) => { c.position = idx; });
        } else {
          // Different lists: update source positions, insert in dest
          sourceCards.forEach((c, idx) => { c.position = idx; });
          destCards.splice(position, 0, movedCard);
          destCards.forEach((c, idx) => { c.position = idx; });
        }

        // Build the new cards array from all lists
        const otherCards = cards.filter(c => 
          c.list_id !== sourceListId && c.list_id !== destListId
        );
        
        const newCards = sourceListId === destListId
          ? [...otherCards, ...sourceCards]
          : [...otherCards, ...sourceCards, ...destCards];

        return { ...old, cards: newCards };
      });

      // Return context with previous data for rollback
      return { previousData };
    },
    onError: (err, variables, context) => {
      // Rollback to previous data on error
      if (context?.previousData) {
        queryClient.setQueryData(['project-board', boardId], context.previousData);
      }
      toast.error('Failed to move card');
    },
    onSettled: () => {
      // Refetch to ensure server and client are in sync
      queryClient.invalidateQueries({ queryKey: ['project-board', boardId] });
    }
  });

  const updateCardMutation = useMutation({
    mutationFn: async ({ cardId, data }) => {
      const response = await apiRequest('PATCH', `/api/projects/cards/${cardId}`, data);
      return response;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['project-board', boardId] });
      if (selectedCard) {
        setSelectedCard({ ...selectedCard, ...data.card });
      }
    }
  });

  const deleteCardMutation = useMutation({
    mutationFn: async (cardId) => {
      const response = await apiRequest('DELETE', `/api/projects/cards/${cardId}`);
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-board', boardId] });
      setShowCardDetail(false);
      setSelectedCard(null);
      toast.success('Card deleted');
    }
  });

  const handleDragEnd = useCallback((result) => {
    const { destination, source, draggableId, type } = result;

    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;

    if (type === 'card') {
      moveCardMutation.mutate({
        cardId: draggableId,
        list_id: destination.droppableId,
        position: destination.index
      });
    }
  }, [moveCardMutation]);

  const handleCreateList = () => {
    if (!newListName.trim()) return;
    createListMutation.mutate(newListName);
  };

  const handleCreateCard = (listId) => {
    if (!newCardTitle.trim()) return;
    createCardMutation.mutate({ list_id: listId, title: newCardTitle });
  };

  const openCardDetail = async (card) => {
    setSelectedCard(card);
    setShowCardDetail(true);
  };

  const getCardsByList = (listId) => {
    return (boardData?.cards || [])
      .filter(card => card.list_id === listId)
      .sort((a, b) => a.position - b.position);
  };

  const getLabelById = (labelId) => {
    return boardData?.labels?.find(l => l.id === labelId);
  };

  const getMemberById = (identityId) => {
    return boardData?.members?.find(m => m.identity_id === identityId);
  };

  if (!accessChecked || isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <AlertCircle className="w-12 h-12 text-destructive" />
        <p className="text-lg">{error.message}</p>
        <Link to={createPageUrl('ProjectBoards')}>
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Boards
          </Button>
        </Link>
      </div>
    );
  }

  const board = boardData?.board;
  const lists = boardData?.lists || [];
  const canManage = ['owner', 'admin'].includes(board?.user_role);
  const canEdit = board?.user_role !== 'viewer';

  return (
    <div className="flex flex-col h-screen">
      <div
        className="px-4 py-3 border-b flex items-center justify-between gap-4"
        style={{ backgroundColor: `${board?.color}15` }}
      >
        <div className="flex items-center gap-3">
          <Link to={createPageUrl('ProjectBoards')}>
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold" data-testid="text-board-name">{board?.name}</h1>
            {board?.description && (
              <p className="text-sm text-muted-foreground">{board.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex -space-x-2">
            {boardData?.members?.slice(0, 5).map((member) => (
              <Avatar key={member.identity_id} className="w-8 h-8 border-2 border-background">
                <AvatarImage src={member.profile_picture_url} />
                <AvatarFallback className="text-xs">
                  {member.first_name?.[0]}{member.last_name?.[0]}
                </AvatarFallback>
              </Avatar>
            ))}
            {boardData?.members?.length > 5 && (
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs border-2 border-background">
                +{boardData.members.length - 5}
              </div>
            )}
          </div>
          {canManage && (
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowSettingsModal(true)}
              data-testid="button-board-settings"
            >
              <Settings className="w-4 h-4 mr-2" />
              Settings
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4">
          <DragDropContext onDragEnd={handleDragEnd}>
            <div className="flex gap-4 items-start min-w-max">
              {lists.map((list) => (
                <div
                  key={list.id}
                  className="w-72 shrink-0 bg-muted/50 rounded-lg"
                >
                  <div className="p-3 flex items-center justify-between">
                    {editingListId === list.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <Input
                          value={editingListName}
                          onChange={(e) => setEditingListName(e.target.value)}
                          className="h-8"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              updateListMutation.mutate({ listId: list.id, data: { name: editingListName } });
                            } else if (e.key === 'Escape') {
                              setEditingListId(null);
                            }
                          }}
                        />
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => {
                          updateListMutation.mutate({ listId: list.id, data: { name: editingListName } });
                        }}>
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingListId(null)}>
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <h3 
                          className="font-semibold cursor-pointer"
                          onClick={() => {
                            if (canEdit) {
                              setEditingListId(list.id);
                              setEditingListName(list.name);
                            }
                          }}
                          data-testid={`text-list-name-${list.id}`}
                        >
                          {list.name}
                        </h3>
                        {canManage && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => {
                                setEditingListId(list.id);
                                setEditingListName(list.name);
                              }}>
                                Rename List
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem 
                                className="text-destructive"
                                onClick={() => deleteListMutation.mutate(list.id)}
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Delete List
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </>
                    )}
                  </div>

                  <Droppable droppableId={list.id} type="card">
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`px-2 pb-2 min-h-[50px] transition-colors ${
                          snapshot.isDraggingOver ? 'bg-muted/80' : ''
                        }`}
                      >
                        {getCardsByList(list.id).map((card, index) => (
                          <Draggable 
                            key={card.id} 
                            draggableId={card.id} 
                            index={index}
                            isDragDisabled={!canEdit}
                          >
                            {(provided, snapshot) => (
                              <div
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                {...provided.dragHandleProps}
                                className={`mb-2 ${snapshot.isDragging ? 'opacity-75' : ''}`}
                              >
                                <Card 
                                  className="cursor-pointer hover-elevate overflow-hidden"
                                  onClick={() => openCardDetail(card)}
                                  data-testid={`card-${card.id}`}
                                >
                                  {card.cover_image ? (
                                    <div className="relative h-32 w-full">
                                      <img 
                                        src={card.cover_image} 
                                        alt=""
                                        className="absolute inset-0 w-full h-full object-cover"
                                      />
                                    </div>
                                  ) : card.cover_color && (
                                    <div 
                                      className="h-8 rounded-t-md"
                                      style={{ backgroundColor: card.cover_color }}
                                    />
                                  )}
                                  <CardContent className="p-3">
                                    {card.project_card_label?.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mb-2">
                                        {card.project_card_label.map((cl) => {
                                          const label = getLabelById(cl.label_id);
                                          if (!label) return null;
                                          return (
                                            <div
                                              key={cl.label_id}
                                              className="h-2 w-10 rounded-full"
                                              style={{ backgroundColor: label.color }}
                                              title={label.name}
                                            />
                                          );
                                        })}
                                      </div>
                                    )}
                                    <p className="text-sm font-medium">{card.title}</p>
                                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                                      {card.due_date && (
                                        <Badge 
                                          variant="secondary" 
                                          className={`text-xs ${
                                            card.is_complete 
                                              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                              : isPast(new Date(card.due_date)) && !isToday(new Date(card.due_date))
                                                ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                                                : ''
                                          }`}
                                        >
                                          <Clock className="w-3 h-3 mr-1" />
                                          {format(new Date(card.due_date), 'MMM d')}
                                        </Badge>
                                      )}
                                      {card.priority !== 'none' && (
                                        <Badge className={`text-xs ${PRIORITY_COLORS[card.priority]}`}>
                                          {card.priority}
                                        </Badge>
                                      )}
                                    </div>
                                    {card.project_card_assignee?.length > 0 && (
                                      <div className="flex -space-x-1 mt-2">
                                        {card.project_card_assignee.slice(0, 3).map((a) => {
                                          const member = getMemberById(a.identity_id);
                                          return (
                                            <Avatar key={a.identity_id} className="w-6 h-6 border border-background">
                                              <AvatarImage src={member?.profile_picture_url} />
                                              <AvatarFallback className="text-[10px]">
                                                {member?.first_name?.[0]}{member?.last_name?.[0]}
                                              </AvatarFallback>
                                            </Avatar>
                                          );
                                        })}
                                        {card.project_card_assignee.length > 3 && (
                                          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px]">
                                            +{card.project_card_assignee.length - 3}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </CardContent>
                                </Card>
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}

                        {addingCardToList === list.id ? (
                          <div className="space-y-2">
                            <Textarea
                              value={newCardTitle}
                              onChange={(e) => setNewCardTitle(e.target.value)}
                              placeholder="Enter a title for this card..."
                              className="min-h-[60px]"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  handleCreateCard(list.id);
                                } else if (e.key === 'Escape') {
                                  setAddingCardToList(null);
                                  setNewCardTitle('');
                                }
                              }}
                            />
                            <div className="flex items-center gap-2">
                              <Button 
                                size="sm" 
                                onClick={() => handleCreateCard(list.id)}
                                disabled={createCardMutation.isPending}
                              >
                                {createCardMutation.isPending ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  'Add Card'
                                )}
                              </Button>
                              <Button 
                                size="sm" 
                                variant="ghost"
                                onClick={() => {
                                  setAddingCardToList(null);
                                  setNewCardTitle('');
                                }}
                              >
                                <X className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          canEdit && (
                            <Button
                              variant="ghost"
                              className="w-full justify-start text-muted-foreground"
                              onClick={() => setAddingCardToList(list.id)}
                              data-testid={`button-add-card-${list.id}`}
                            >
                              <Plus className="w-4 h-4 mr-2" />
                              Add a card
                            </Button>
                          )
                        )}
                      </div>
                    )}
                  </Droppable>
                </div>
              ))}

              {canEdit && (
                <div className="w-72 shrink-0">
                  {showAddList ? (
                    <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                      <Input
                        value={newListName}
                        onChange={(e) => setNewListName(e.target.value)}
                        placeholder="Enter list title..."
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleCreateList();
                          } else if (e.key === 'Escape') {
                            setShowAddList(false);
                            setNewListName('');
                          }
                        }}
                        data-testid="input-new-list-name"
                      />
                      <div className="flex items-center gap-2">
                        <Button 
                          size="sm" 
                          onClick={handleCreateList}
                          disabled={createListMutation.isPending}
                          data-testid="button-confirm-add-list"
                        >
                          {createListMutation.isPending ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            'Add List'
                          )}
                        </Button>
                        <Button 
                          size="sm" 
                          variant="ghost"
                          onClick={() => {
                            setShowAddList(false);
                            setNewListName('');
                          }}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      className="w-full justify-start"
                      onClick={() => setShowAddList(true)}
                      data-testid="button-add-list"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      Add another list
                    </Button>
                  )}
                </div>
              )}
            </div>
          </DragDropContext>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <CardDetailModal
        card={selectedCard}
        open={showCardDetail}
        onOpenChange={setShowCardDetail}
        labels={boardData?.labels || []}
        members={boardData?.members || []}
        lists={lists}
        canEdit={canEdit}
        canManage={canManage}
        onUpdate={(data) => updateCardMutation.mutate({ cardId: selectedCard.id, data })}
        onDelete={() => deleteCardMutation.mutate(selectedCard.id)}
        getLabelById={getLabelById}
        getMemberById={getMemberById}
      />

      <BoardSettingsModal
        boardId={boardId}
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
        members={boardData?.members || []}
        userRole={board?.user_role}
        onMembersChange={() => queryClient.invalidateQueries({ queryKey: ['project-board', boardId] })}
      />
    </div>
  );
}

function CardDetailModal({ 
  card, open, onOpenChange, labels, members, lists, canEdit, canManage,
  onUpdate, onDelete, getLabelById, getMemberById
}) {
  const [editedCard, setEditedCard] = useState({});
  const [newComment, setNewComment] = useState('');
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (card) {
      setEditedCard({
        title: card.title,
        description: card.description || '',
        due_date: card.due_date ? card.due_date.split('T')[0] : '',
        priority: card.priority || 'none',
        is_complete: card.is_complete
      });
    }
  }, [card]);

  const { data: cardDetails } = useQuery({
    queryKey: ['card-detail', card?.id],
    queryFn: async () => {
      const response = await fetch(`/api/projects/cards/${card.id}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch card details');
      return response.json();
    },
    enabled: !!card?.id && open
  });

  const addCommentMutation = useMutation({
    mutationFn: async (content) => {
      const response = await apiRequest('POST', `/api/projects/cards/${card.id}/comments`, { content });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['card-detail', card.id] });
      setNewComment('');
    }
  });

  const toggleLabelMutation = useMutation({
    mutationFn: async ({ labelId, isApplied }) => {
      if (isApplied) {
        return apiRequest('DELETE', `/api/projects/cards/${card.id}/labels`, { label_id: labelId });
      } else {
        return apiRequest('POST', `/api/projects/cards/${card.id}/labels`, { label_id: labelId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-board'] });
      queryClient.invalidateQueries({ queryKey: ['card-detail', card.id] });
    }
  });

  const toggleAssigneeMutation = useMutation({
    mutationFn: async ({ identityId, isAssigned }) => {
      if (isAssigned) {
        return apiRequest('DELETE', `/api/projects/cards/${card.id}/assignees`, { identity_id: identityId });
      } else {
        return apiRequest('POST', `/api/projects/cards/${card.id}/assignees`, { identity_id: identityId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-board'] });
      queryClient.invalidateQueries({ queryKey: ['card-detail', card.id] });
    }
  });

  const handleSave = () => {
    onUpdate({
      title: editedCard.title,
      description: editedCard.description,
      due_date: editedCard.due_date || null,
      priority: editedCard.priority,
      is_complete: editedCard.is_complete
    });
  };

  const isLabelApplied = (labelId) => {
    return card?.project_card_label?.some(l => l.label_id === labelId);
  };

  const isAssigned = (identityId) => {
    return card?.project_card_assignee?.some(a => a.identity_id === identityId);
  };

  if (!card) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {card.cover_image && (
          <div className="relative w-full h-40 bg-muted">
            <img 
              src={card.cover_image} 
              alt=""
              className="w-full h-full object-cover"
            />
          </div>
        )}
        <div className="p-6">
          <DialogHeader>
            <DialogTitle className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={editedCard.is_complete}
                onChange={(e) => setEditedCard({ ...editedCard, is_complete: e.target.checked })}
                className="mt-1 w-5 h-5"
                disabled={!canEdit}
              />
              {canEdit ? (
                <Input
                  value={editedCard.title}
                  onChange={(e) => setEditedCard({ ...editedCard, title: e.target.value })}
                  className="text-lg font-semibold"
                  data-testid="input-card-title"
                />
              ) : (
                <span className={editedCard.is_complete ? 'line-through text-muted-foreground' : ''}>
                  {card.title}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

        <div className="grid grid-cols-3 gap-6 mt-4">
          <div className="col-span-2 space-y-4">
            <div>
              <Label>Description</Label>
              {canEdit ? (
                <Textarea
                  value={editedCard.description}
                  onChange={(e) => setEditedCard({ ...editedCard, description: e.target.value })}
                  placeholder="Add a more detailed description..."
                  rows={4}
                  className="mt-1"
                  data-testid="input-card-description"
                />
              ) : (
                <p className="text-sm text-muted-foreground mt-1">
                  {card.description || 'No description'}
                </p>
              )}
            </div>

            <CardAttachments
              cardId={card.id}
              attachments={cardDetails?.attachments || []}
              coverImage={card.cover_image}
              canEdit={canEdit}
              onCoverChange={(newCover) => {
                onUpdate({ cover_image: newCover });
              }}
            />

            <div>
              <Label className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4" />
                Comments
              </Label>
              <div className="mt-2 space-y-3">
                {cardDetails?.comments?.map((comment) => (
                  <div key={comment.id} className="flex gap-3">
                    <Avatar className="w-8 h-8">
                      <AvatarImage src={comment.author?.profile_picture_url} />
                      <AvatarFallback>
                        {comment.author?.first_name?.[0]}{comment.author?.last_name?.[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">
                          {comment.author?.first_name} {comment.author?.last_name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(comment.created_at), 'MMM d, h:mm a')}
                        </span>
                      </div>
                      <p className="text-sm mt-1">{comment.content}</p>
                    </div>
                  </div>
                ))}

                {canEdit && (
                  <div className="flex gap-2">
                    <Textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Write a comment..."
                      rows={2}
                      className="flex-1"
                      data-testid="input-new-comment"
                    />
                    <Button
                      size="sm"
                      onClick={() => addCommentMutation.mutate(newComment)}
                      disabled={!newComment.trim() || addCommentMutation.isPending}
                      data-testid="button-add-comment"
                    >
                      {addCommentMutation.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        'Send'
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <Label className="flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                Due Date
              </Label>
              {canEdit ? (
                <Input
                  type="date"
                  value={editedCard.due_date}
                  onChange={(e) => setEditedCard({ ...editedCard, due_date: e.target.value })}
                  className="mt-1"
                  data-testid="input-due-date"
                />
              ) : (
                <p className="text-sm mt-1">
                  {card.due_date ? format(new Date(card.due_date), 'MMM d, yyyy') : 'Not set'}
                </p>
              )}
            </div>

            <div>
              <Label>Priority</Label>
              {canEdit ? (
                <Select
                  value={editedCard.priority}
                  onValueChange={(value) => setEditedCard({ ...editedCard, priority: value })}
                >
                  <SelectTrigger className="mt-1" data-testid="select-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Badge className={`mt-1 ${PRIORITY_COLORS[card.priority]}`}>
                  {card.priority}
                </Badge>
              )}
            </div>

            <div>
              <Label className="flex items-center gap-2">
                <Tag className="w-4 h-4" />
                Labels
              </Label>
              <div className="flex flex-wrap gap-1 mt-2">
                {card.project_card_label?.map((cl) => {
                  const label = getLabelById(cl.label_id);
                  if (!label) return null;
                  return (
                    <Badge
                      key={cl.label_id}
                      style={{ backgroundColor: label.color }}
                      className="text-white cursor-pointer"
                      onClick={() => canEdit && toggleLabelMutation.mutate({ labelId: label.id, isApplied: true })}
                    >
                      {label.name}
                      {canEdit && <X className="w-3 h-3 ml-1" />}
                    </Badge>
                  );
                })}
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowLabelPicker(!showLabelPicker)}
                    data-testid="button-add-label"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {showLabelPicker && (
                <div className="mt-2 p-2 border rounded-md space-y-1">
                  {labels.map((label) => (
                    <div
                      key={label.id}
                      className="flex items-center gap-2 p-1 rounded cursor-pointer hover:bg-muted"
                      onClick={() => toggleLabelMutation.mutate({ labelId: label.id, isApplied: isLabelApplied(label.id) })}
                    >
                      <div
                        className="w-4 h-4 rounded"
                        style={{ backgroundColor: label.color }}
                      />
                      <span className="text-sm flex-1">{label.name}</span>
                      {isLabelApplied(label.id) && <Check className="w-4 h-4" />}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <Label className="flex items-center gap-2">
                <Users className="w-4 h-4" />
                Assignees
              </Label>
              <div className="flex flex-wrap gap-1 mt-2">
                {card.project_card_assignee?.map((a) => {
                  const member = getMemberById(a.identity_id);
                  return (
                    <div
                      key={a.identity_id}
                      className="flex items-center gap-1 bg-muted rounded-full pl-1 pr-2 py-1 cursor-pointer"
                      onClick={() => canEdit && toggleAssigneeMutation.mutate({ identityId: a.identity_id, isAssigned: true })}
                    >
                      <Avatar className="w-5 h-5">
                        <AvatarImage src={member?.profile_picture_url} />
                        <AvatarFallback className="text-[10px]">
                          {member?.first_name?.[0]}{member?.last_name?.[0]}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs">{member?.first_name}</span>
                      {canEdit && <X className="w-3 h-3" />}
                    </div>
                  );
                })}
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowMemberPicker(!showMemberPicker)}
                    data-testid="button-add-assignee"
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {showMemberPicker && (
                <div className="mt-2 p-2 border rounded-md space-y-1 max-h-40 overflow-y-auto">
                  {members.map((member) => (
                    <div
                      key={member.identity_id}
                      className="flex items-center gap-2 p-1 rounded cursor-pointer hover:bg-muted"
                      onClick={() => toggleAssigneeMutation.mutate({ identityId: member.identity_id, isAssigned: isAssigned(member.identity_id) })}
                    >
                      <Avatar className="w-6 h-6">
                        <AvatarImage src={member.profile_picture_url} />
                        <AvatarFallback className="text-xs">
                          {member.first_name?.[0]}{member.last_name?.[0]}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm flex-1">{member.first_name} {member.last_name}</span>
                      {isAssigned(member.identity_id) && <Check className="w-4 h-4" />}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {canManage && (
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={onDelete}
                data-testid="button-delete-card"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Card
              </Button>
            )}
          </div>
        </div>

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {canEdit && (
            <Button onClick={handleSave} data-testid="button-save-card">
              Save Changes
            </Button>
          )}
        </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BoardSettingsModal({ boardId, open, onOpenChange, members, userRole, onMembersChange }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState('member');
  const queryClient = useQueryClient();

  const { data: availableUsers = { users: [] }, isLoading: loadingUsers } = useQuery({
    queryKey: ['available-users', boardId, searchQuery],
    queryFn: async () => {
      const response = await fetch(`/api/projects/boards/${boardId}/available-users?search=${encodeURIComponent(searchQuery)}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch users');
      return response.json();
    },
    enabled: open && !!boardId
  });

  const addMemberMutation = useMutation({
    mutationFn: async ({ identity_id, role }) => {
      const response = await apiRequest('POST', `/api/projects/boards/${boardId}/members`, { identity_id, role });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['available-users', boardId] });
      onMembersChange();
      toast.success('Member added');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to add member');
    }
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ identity_id, role }) => {
      const response = await apiRequest('PATCH', `/api/projects/boards/${boardId}/members`, { identity_id, role });
      return response;
    },
    onSuccess: () => {
      onMembersChange();
      toast.success('Role updated');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update role');
    }
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (identity_id) => {
      const response = await apiRequest('DELETE', `/api/projects/boards/${boardId}/members`, { identity_id });
      return response;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['available-users', boardId] });
      onMembersChange();
      toast.success('Member removed');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to remove member');
    }
  });

  const getRoleBadgeColor = (role) => {
    switch (role) {
      case 'owner': return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'admin': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'member': return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'viewer': return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
      default: return '';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Board Members
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          <div>
            <Label className="text-sm font-medium mb-2 block">Invite Members</Label>
            <div className="flex gap-2">
              <Input
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                data-testid="input-search-members"
              />
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  {userRole === 'owner' && <SelectItem value="owner">Owner</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            
            {loadingUsers ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : availableUsers.users.length > 0 ? (
              <div className="mt-2 border rounded-md max-h-40 overflow-y-auto">
                {availableUsers.users.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-2 p-2 hover:bg-muted cursor-pointer"
                    onClick={() => addMemberMutation.mutate({ identity_id: user.id, role: selectedRole })}
                    data-testid={`button-add-member-${user.id}`}
                  >
                    <Avatar className="w-8 h-8">
                      <AvatarImage src={user.profile_picture_url} />
                      <AvatarFallback className="text-xs">
                        {user.first_name?.[0]}{user.last_name?.[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {user.first_name} {user.last_name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                    </div>
                    <Plus className="w-4 h-4 text-muted-foreground" />
                  </div>
                ))}
              </div>
            ) : searchQuery ? (
              <p className="text-sm text-muted-foreground mt-2">No users found matching "{searchQuery}"</p>
            ) : null}
          </div>

          <div>
            <Label className="text-sm font-medium mb-2 block">Current Members ({members.length})</Label>
            <div className="border rounded-md divide-y max-h-60 overflow-y-auto">
              {members.map((member) => (
                <div key={member.identity_id} className="flex items-center gap-2 p-2">
                  <Avatar className="w-8 h-8">
                    <AvatarImage src={member.profile_picture_url} />
                    <AvatarFallback className="text-xs">
                      {member.first_name?.[0]}{member.last_name?.[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {member.first_name} {member.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                  </div>
                  <Select 
                    value={member.role} 
                    onValueChange={(role) => updateRoleMutation.mutate({ identity_id: member.identity_id, role })}
                    disabled={member.role === 'owner' && userRole !== 'owner'}
                  >
                    <SelectTrigger className="w-24 h-8">
                      <Badge className={`text-xs ${getRoleBadgeColor(member.role)}`}>
                        {member.role}
                      </Badge>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      {userRole === 'owner' && <SelectItem value="owner">Owner</SelectItem>}
                    </SelectContent>
                  </Select>
                  {member.role !== 'owner' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => removeMemberMutation.mutate(member.identity_id)}
                      data-testid={`button-remove-member-${member.identity_id}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="text-xs text-muted-foreground space-y-1">
            <p><strong>Owner:</strong> Full control, can delete board</p>
            <p><strong>Admin:</strong> Manage lists, cards, and members</p>
            <p><strong>Member:</strong> Create and edit cards</p>
            <p><strong>Viewer:</strong> Read-only access</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
