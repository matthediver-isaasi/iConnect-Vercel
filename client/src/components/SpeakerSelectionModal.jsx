import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, X, Mic, Check, ChevronRight } from "lucide-react";

export function SpeakerSelectionModal({ 
  open, 
  onOpenChange, 
  speakers = [], 
  selectedSpeakerIds = [], 
  onConfirm 
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [tempSelected, setTempSelected] = useState(selectedSpeakerIds);

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
    return speakers.filter(s => tempSelected.includes(s.id));
  }, [speakers, tempSelected]);

  const availableSpeakers = useMemo(() => {
    return filteredSpeakers.filter(s => !tempSelected.includes(s.id));
  }, [filteredSpeakers, tempSelected]);

  const handleSelect = (speakerId) => {
    setTempSelected(prev => [...prev, speakerId]);
  };

  const handleRemove = (speakerId) => {
    setTempSelected(prev => prev.filter(id => id !== speakerId));
  };

  const handleConfirm = () => {
    onConfirm(tempSelected);
    onOpenChange(false);
  };

  const handleOpenChange = (isOpen) => {
    if (isOpen) {
      setTempSelected(selectedSpeakerIds);
      setSearchTerm('');
    }
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
            </div>
            <ScrollArea className="flex-1 p-2">
              {selectedSpeakers.length === 0 ? (
                <div className="text-center py-8 text-sm text-slate-500">
                  Click on speakers to add them
                </div>
              ) : (
                <div className="space-y-1">
                  {selectedSpeakers.map(speaker => (
                    <div
                      key={speaker.id}
                      className="flex items-center gap-3 p-2 rounded-lg bg-white border border-purple-200 group"
                      data-testid={`speaker-selected-${speaker.id}`}
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
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-slate-400 hover:text-red-500 hover:bg-red-50"
                        onClick={() => handleRemove(speaker.id)}
                        data-testid={`button-remove-speaker-${speaker.id}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-speakers">
            Cancel
          </Button>
          <Button onClick={handleConfirm} className="bg-purple-600 hover:bg-purple-700" data-testid="button-confirm-speakers">
            <Check className="h-4 w-4 mr-2" />
            Confirm Selection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
