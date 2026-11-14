import { useState, useMemo, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, X, Mic, Check, ChevronRight, ArrowUp, ArrowDown, GripVertical } from "lucide-react";
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, sortableKeyboardCoordinates, arrayMove, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function SortableSpeaker({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  return children({ setNodeRef, style: { transform: CSS.Transform.toString(transform), transition }, handleProps: { ...attributes, ...listeners } });
}

export function SpeakerSelectionModal({ 
  open, 
  onOpenChange, 
  speakers = [], 
  selectedSpeakerIds = [], 
  onConfirm 
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [tempSelected, setTempSelected] = useState(() => [...selectedSpeakerIds]);
  const wasOpen = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const moveSpeaker = (id, target) => setTempSelected(prev => {
    const from = prev.indexOf(id);
    return from < 0 || target < 0 || target >= prev.length ? prev : arrayMove(prev, from, target);
  });

  useEffect(() => {
    // Parents open this controlled dialog directly, without onOpenChange firing.
    // Snapshot only on opening: new arrays/catalogue refreshes must not reset a draft.
    if (open && !wasOpen.current) {
      setTempSelected([...selectedSpeakerIds]);
      setSearchTerm('');
    }
    wasOpen.current = open;
  }, [open, selectedSpeakerIds]);

  const filteredSpeakers = useMemo(() => {
    if (!searchTerm.trim()) return speakers;
    const term = searchTerm.toLowerCase();
    return speakers.filter(s => 
      s.full_name?.toLowerCase().includes(term) ||
      s.title?.toLowerCase().includes(term) ||
      s.bio?.toLowerCase().includes(term)
    );
  }, [speakers, searchTerm]);

  const selectedSpeakers = useMemo(() => {
    const byId = new Map(speakers.map(s => [s.id, s]));
    return tempSelected.map(id => byId.get(id) || { id, full_name: 'Unavailable speaker', title: 'Selection retained until you remove it' });
  }, [speakers, tempSelected]);

  const availableSpeakers = useMemo(() => {
    return filteredSpeakers.filter(s => !tempSelected.includes(s.id));
  }, [filteredSpeakers, tempSelected]);

  const handleSelect = (speakerId) => {
    setTempSelected(prev => prev.includes(speakerId) ? prev : [...prev, speakerId]);
  };

  const handleRemove = (speakerId) => {
    setTempSelected(prev => prev.filter(id => id !== speakerId));
  };

  const handleConfirm = () => {
    onConfirm(tempSelected);
    onOpenChange(false);
  };

  const handleOpenChange = (isOpen) => {
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mic className="h-5 w-5 text-purple-600" />
            Select Speakers
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 flex gap-4 min-h-0">
          {/* Left Column - Available Speakers */}
          <div className="flex-1 flex flex-col border rounded-lg">
            <div className="p-3 border-b bg-slate-50">
              <h3 className="font-medium text-sm text-slate-700 mb-2">Available Speakers</h3>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  placeholder="Search speakers..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-8 text-sm"
                  data-testid="input-search-speakers"
                />
              </div>
            </div>
            <ScrollArea className="flex-1 p-2">
              {availableSpeakers.length === 0 ? (
                <div className="text-center py-8 text-sm text-slate-500">
                  {searchTerm ? 'No speakers match your search' : 'All speakers have been selected'}
                </div>
              ) : (
                <div className="space-y-1">
                  {availableSpeakers.map(speaker => (
                    <div
                      key={speaker.id}
                      onClick={() => handleSelect(speaker.id)}
                      className="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors group"
                      data-testid={`speaker-available-${speaker.id}`}
                    >
                      {speaker.profile_photo_url ? (
                        <img 
                          src={speaker.profile_photo_url} 
                          alt={speaker.full_name}
                          className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                          <Mic className="h-5 w-5 text-purple-600" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-slate-900 truncate">{speaker.full_name}</div>
                        {speaker.title && (
                          <div className="text-xs text-slate-500 truncate">{speaker.title}</div>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* Right Column - Selected Speakers */}
          <div className="flex-1 flex flex-col border rounded-lg border-purple-200 bg-purple-50/30">
            <div className="p-3 border-b border-purple-200 bg-purple-50">
              <h3 className="font-medium text-sm text-purple-700">
                Selected Speakers ({selectedSpeakers.length})
              </h3>
              <p className="text-xs text-purple-700 mt-1">Display order: drag a handle or use Move up / Move down.</p>
            </div>
            <ScrollArea className="flex-1 p-2">
              {selectedSpeakers.length === 0 ? (
                <div className="text-center py-8 text-sm text-slate-500">
                  Click on speakers to add them
                </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
                  if (over && active.id !== over.id) moveSpeaker(active.id, tempSelected.indexOf(over.id));
                }}>
                <SortableContext items={tempSelected} strategy={verticalListSortingStrategy}>
                <div className="space-y-1">
                  {selectedSpeakers.map((speaker, index) => (
                    <SortableSpeaker key={speaker.id} id={speaker.id}>
                    {({ setNodeRef, style, handleProps }) => (
                    <div
                      ref={setNodeRef} style={style}
                      className="flex items-center gap-3 p-2 rounded-lg bg-white border border-purple-200 group"
                      data-testid={`speaker-selected-${speaker.id}`}
                    >
                      <button type="button" {...handleProps} aria-label={`Drag to reorder ${speaker.full_name}`} className="touch-none cursor-grab">
                        <GripVertical className="h-4 w-4" />
                      </button>
                      {speaker.profile_photo_url ? (
                        <img 
                          src={speaker.profile_photo_url} 
                          alt={speaker.full_name}
                          className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                          <Mic className="h-5 w-5 text-purple-600" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm text-slate-900 truncate">{speaker.full_name}</div>
                        {speaker.title && (
                          <div className="text-xs text-slate-500 truncate">{speaker.title}</div>
                        )}
                      </div>
                      <Button
                        type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                        disabled={index === 0} aria-label={`Move ${speaker.full_name} up`}
                        data-testid={`button-speaker-up-${speaker.id}`} onClick={() => moveSpeaker(speaker.id, index - 1)}>
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                        disabled={index === selectedSpeakers.length - 1} aria-label={`Move ${speaker.full_name} down`}
                        data-testid={`button-speaker-down-${speaker.id}`} onClick={() => moveSpeaker(speaker.id, index + 1)}>
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        aria-label={`Remove ${speaker.full_name}`}
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-slate-400 hover:text-red-500 hover:bg-red-50"
                        onClick={() => handleRemove(speaker.id)}
                        data-testid={`button-remove-speaker-${speaker.id}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    )}
                    </SortableSpeaker>
                  ))}
                </div>
                </SortableContext>
                </DndContext>
              )}
            </ScrollArea>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-speakers">
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} className="bg-purple-600 hover:bg-purple-700" data-testid="button-confirm-speakers">
            <Check className="h-4 w-4 mr-2" />
            Confirm Selection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
