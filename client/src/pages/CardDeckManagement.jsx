import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Search, X, Image as ImageIcon, GripVertical, ExternalLink, FileText, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function CardDeckManagementPage() {
  const { isAdmin, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingCard, setEditingCard] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showFileSelector, setShowFileSelector] = useState(false);
  const [imageFromRepository, setImageFromRepository] = useState(false);
  const [fileSelectorSearch, setFileSelectorSearch] = useState("");
  const [fileSelectorPage, setFileSelectorPage] = useState(1);
  const [fileSelectorItemsPerPage] = useState(12);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady]);

  const { data: cards = [], isLoading } = useQuery({
    queryKey: ['card-deck'],
    queryFn: () => base44.entities.CardDeck.list('display_order'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: repositoryFiles = [] } = useQuery({
    queryKey: ['file-repository'],
    queryFn: () => base44.entities.FileRepository.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const filteredCards = useMemo(() => {
    if (!searchQuery.trim()) return cards;
    const query = searchQuery.toLowerCase();
    return cards.filter(card =>
      card.title?.toLowerCase().includes(query) ||
      card.description?.toLowerCase().includes(query)
    );
  }, [cards, searchQuery]);

  const filteredRepositoryFiles = useMemo(() => {
    const imageFiles = repositoryFiles.filter(f => f.file_type === 'image');
    if (!fileSelectorSearch.trim()) return imageFiles;
    return imageFiles.filter(f =>
      f.name?.toLowerCase().includes(fileSelectorSearch.toLowerCase()) ||
      f.description?.toLowerCase().includes(fileSelectorSearch.toLowerCase())
    );
  }, [repositoryFiles, fileSelectorSearch]);

  const paginatedFiles = useMemo(() => {
    const start = (fileSelectorPage - 1) * fileSelectorItemsPerPage;
    return filteredRepositoryFiles.slice(start, start + fileSelectorItemsPerPage);
  }, [filteredRepositoryFiles, fileSelectorPage, fileSelectorItemsPerPage]);

  const fileSelectorTotalPages = Math.ceil(filteredRepositoryFiles.length / fileSelectorItemsPerPage);

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.CardDeck.create(data),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['card-deck'] });
      await queryClient.refetchQueries({ queryKey: ['card-deck'], type: 'active' });
      setShowDialog(false);
      setEditingCard(null);
      toast.success('Card created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create card: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.CardDeck.update(id, data),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['card-deck'] });
      await queryClient.refetchQueries({ queryKey: ['card-deck'], type: 'active' });
      setShowDialog(false);
      setEditingCard(null);
      toast.success('Card updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update card: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.CardDeck.delete(id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['card-deck'] });
      await queryClient.refetchQueries({ queryKey: ['card-deck'], type: 'active' });
      toast.success('Card deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete card: ' + error.message);
    }
  });

  const handleCreateNew = () => {
    setEditingCard({
      title: "",
      description: "",
      image_url: "",
      target_url: "",
      button_text: "Learn More",
      status: "active",
      display_order: cards.length
    });
    setShowDialog(true);
  };

  const handleEdit = (card) => {
    setEditingCard({ ...card });
    const isImageFromRepo = card.image_url ? repositoryFiles.some(f => f.file_url === card.image_url) : false;
    setImageFromRepository(isImageFromRepo);
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingCard.title.trim()) {
      toast.error('Title is required');
      return;
    }

    const payload = {
      title: editingCard.title,
      description: editingCard.description || "",
      image_url: editingCard.image_url || null,
      target_url: editingCard.target_url || null,
      button_text: editingCard.button_text || "Learn More",
      status: editingCard.status || "active",
      display_order: editingCard.display_order || 0
    };

    if (editingCard.id) {
      updateMutation.mutate({ id: editingCard.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleDelete = (id) => {
    if (window.confirm('Are you sure you want to delete this card?')) {
      deleteMutation.mutate(id);
    }
  };

  const handleSelectFile = (file) => {
    setEditingCard({ ...editingCard, image_url: file.file_url });
    setImageFromRepository(true);
    setShowFileSelector(false);
    setFileSelectorSearch("");
    setFileSelectorPage(1);
  };

  const handleClearImage = () => {
    setEditingCard({ ...editingCard, image_url: "" });
    setImageFromRepository(false);
  };

  const moveCard = async (cardId, direction) => {
    const currentIndex = cards.findIndex(c => c.id === cardId);
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    
    if (newIndex < 0 || newIndex >= cards.length) return;
    
    const cardToSwap = cards[newIndex];
    const currentCard = cards[currentIndex];
    
    try {
      await base44.entities.CardDeck.update(currentCard.id, { display_order: newIndex });
      await base44.entities.CardDeck.update(cardToSwap.id, { display_order: currentIndex });
      queryClient.invalidateQueries({ queryKey: ['card-deck'] });
    } catch (error) {
      toast.error('Failed to reorder cards');
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-7xl mx-auto p-4 md:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Card Deck Management</h1>
            <p className="text-slate-600 mt-1">Create and manage cards for the page builder Card Deck element</p>
          </div>
          <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700" data-testid="button-create-card">
            <Plus className="w-4 h-4 mr-2" />
            Create Card
          </Button>
        </div>

        <div className="mb-6">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search cards..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-cards"
            />
          </div>
        </div>

        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array(6).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6">
                  <div className="h-32 bg-slate-200 rounded mb-4" />
                  <div className="h-6 bg-slate-200 rounded w-2/3 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredCards.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Cards Found</h3>
              <p className="text-slate-600 mb-4">
                {searchQuery ? 'No cards match your search' : 'Create your first card to get started'}
              </p>
              {!searchQuery && (
                <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-2" />
                  Create Card
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredCards.map((card, index) => (
              <Card key={card.id} className="border-slate-200 hover:shadow-lg transition-shadow" data-testid={`card-deck-item-${card.id}`}>
                <CardContent className="p-0">
                  {card.image_url && (
                    <div className="relative h-48 overflow-hidden rounded-t-lg">
                      <img
                        src={card.image_url}
                        alt={card.title}
                        className="w-full h-full object-cover"
                      />
                      {card.status === 'draft' && (
                        <Badge className="absolute top-2 right-2 bg-amber-500">Draft</Badge>
                      )}
                    </div>
                  )}
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <h3 className="font-semibold text-lg text-slate-900 line-clamp-2">{card.title}</h3>
                      {!card.image_url && card.status === 'draft' && (
                        <Badge className="bg-amber-500 shrink-0">Draft</Badge>
                      )}
                    </div>
                    {card.description && (
                      <p className="text-slate-600 text-sm line-clamp-3 mb-3">{card.description}</p>
                    )}
                    {card.target_url && (
                      <div className="flex items-center gap-1 text-xs text-blue-600 mb-3">
                        <ExternalLink className="w-3 h-3" />
                        <span className="truncate">{card.button_text || 'Learn More'}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => moveCard(card.id, 'up')}
                          disabled={index === 0}
                          className="h-8 w-8"
                          data-testid={`button-move-up-${card.id}`}
                        >
                          <ArrowUp className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => moveCard(card.id, 'down')}
                          disabled={index === filteredCards.length - 1}
                          className="h-8 w-8"
                          data-testid={`button-move-down-${card.id}`}
                        >
                          <ArrowDown className="w-4 h-4" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEdit(card)}
                          className="h-8 w-8 text-slate-600 hover:text-blue-600"
                          data-testid={`button-edit-card-${card.id}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(card.id)}
                          className="h-8 w-8 text-slate-600 hover:text-red-600"
                          data-testid={`button-delete-card-${card.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <Dialog open={showDialog} onOpenChange={(open) => {
          setShowDialog(open);
          if (!open) {
            setImageFromRepository(false);
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingCard?.id ? 'Edit Card' : 'Create New Card'}
              </DialogTitle>
            </DialogHeader>

            {editingCard && (
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    value={editingCard.title}
                    onChange={(e) => setEditingCard({ ...editingCard, title: e.target.value })}
                    placeholder="Card title"
                    data-testid="input-card-title"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={editingCard.description || ''}
                    onChange={(e) => setEditingCard({ ...editingCard, description: e.target.value })}
                    placeholder="Brief description..."
                    rows={3}
                    data-testid="input-card-description"
                  />
                </div>

                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Switch
                    id="status-toggle"
                    checked={editingCard.status === 'active'}
                    onCheckedChange={(checked) => setEditingCard({ ...editingCard, status: checked ? 'active' : 'draft' })}
                    data-testid="switch-card-status"
                  />
                  <div className="flex-1">
                    <Label htmlFor="status-toggle" className="cursor-pointer font-medium">
                      {editingCard.status === 'active' ? 'Active' : 'Draft'}
                    </Label>
                    <p className="text-xs text-slate-500 mt-1">
                      {editingCard.status === 'active' 
                        ? 'This card can be selected in page builder elements' 
                        : 'This card is hidden from selection (draft mode)'}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="image-url">Image</Label>
                  <div className="flex gap-2">
                    <Input
                      id="image-url"
                      value={imageFromRepository ? '' : (editingCard.image_url || '')}
                      onChange={(e) => {
                        setEditingCard({ ...editingCard, image_url: e.target.value });
                        setImageFromRepository(false);
                      }}
                      placeholder={imageFromRepository ? "Image selected from repository" : "https://... or select from repository"}
                      className="flex-1"
                      data-testid="input-card-image-url"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowFileSelector(true)}
                      data-testid="button-select-image"
                    >
                      <ImageIcon className="w-4 h-4 mr-2" />
                      Select from Repository
                    </Button>
                  </div>
                  {editingCard.image_url && (
                    <div className="mt-2 p-2 border border-slate-200 rounded-lg relative">
                      <img
                        src={editingCard.image_url}
                        alt="Preview"
                        className="w-full h-32 object-cover rounded"
                      />
                      <button
                        onClick={handleClearImage}
                        className="absolute bottom-3 right-3 p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-full shadow-lg transition-colors"
                        title="Remove image"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="target-url">Link URL (optional)</Label>
                  <Input
                    id="target-url"
                    value={editingCard.target_url || ''}
                    onChange={(e) => setEditingCard({ ...editingCard, target_url: e.target.value })}
                    placeholder="https://example.com"
                    data-testid="input-card-target-url"
                  />
                  <p className="text-xs text-slate-500">Optional link that the card will navigate to when clicked</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="button-text">Button Text</Label>
                  <Input
                    id="button-text"
                    value={editingCard.button_text || ''}
                    onChange={(e) => setEditingCard({ ...editingCard, button_text: e.target.value })}
                    placeholder="Learn More"
                    data-testid="input-card-button-text"
                  />
                  <p className="text-xs text-slate-500">Text displayed on the card's button (if shown in page builder element)</p>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowDialog(false)}>
                    Cancel
                  </Button>
                  <Button 
                    onClick={handleSave}
                    disabled={createMutation.isPending || updateMutation.isPending}
                    className="bg-blue-600 hover:bg-blue-700"
                    data-testid="button-save-card"
                  >
                    {(createMutation.isPending || updateMutation.isPending) ? 'Saving...' : 'Save Card'}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={showFileSelector} onOpenChange={(open) => {
          setShowFileSelector(open);
          if (!open) {
            setFileSelectorSearch("");
            setFileSelectorPage(1);
          }
        }}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Select Image from Repository</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search images..."
                  value={fileSelectorSearch}
                  onChange={(e) => {
                    setFileSelectorSearch(e.target.value);
                    setFileSelectorPage(1);
                  }}
                  className="pl-10"
                />
              </div>

              {paginatedFiles.length === 0 ? (
                <div className="text-center py-12">
                  <ImageIcon className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-600">No images found</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-3 md:grid-cols-4 gap-4">
                    {paginatedFiles.map((file) => (
                      <button
                        key={file.id}
                        onClick={() => handleSelectFile(file)}
                        className="group relative aspect-square rounded-lg overflow-hidden border border-slate-200 hover:border-blue-500 transition-colors"
                      >
                        <img
                          src={file.file_url}
                          alt={file.name}
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <span className="text-white text-sm font-medium">Select</span>
                        </div>
                      </button>
                    ))}
                  </div>

                  {fileSelectorTotalPages > 1 && (
                    <div className="flex items-center justify-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFileSelectorPage(p => Math.max(1, p - 1))}
                        disabled={fileSelectorPage === 1}
                      >
                        Previous
                      </Button>
                      <span className="text-sm text-slate-600">
                        Page {fileSelectorPage} of {fileSelectorTotalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFileSelectorPage(p => Math.min(fileSelectorTotalPages, p + 1))}
                        disabled={fileSelectorPage === fileSelectorTotalPages}
                      >
                        Next
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowFileSelector(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
