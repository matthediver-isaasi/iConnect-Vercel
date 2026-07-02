import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Handshake, X, Image, Plus } from "lucide-react";
import { base44 } from "@/api/base44Client";

export default function EventSponsorSelector({ eventId, eventType = "simple", selectedSponsorIds, onSelectedSponsorIdsChange, sponsorDetails = {}, onSponsorDetailsChange }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [tempSelected, setTempSelected] = useState([]);

  const { data: sponsors = [], isLoading: loadingSponsors } = useQuery({
    queryKey: ['/api/entities/EventSponsor'],
    queryFn: () => base44.entities.EventSponsor.list({ sort: { name: 'asc' } })
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['/api/entities/EventSponsorCategory'],
    queryFn: () => base44.entities.EventSponsorCategory.list({ sort: { display_order: 'asc' } })
  });

  const sponsorMap = useMemo(() => {
    const map = {};
    sponsors.forEach(s => { map[s.id] = s; });
    return map;
  }, [sponsors]);

  const groupedSponsors = useMemo(() => {
    if (sponsors.length === 0) return [];
    const groups = {};
    const uncategorized = [];
    sponsors.forEach(s => {
      if (s.category_id) {
        if (!groups[s.category_id]) groups[s.category_id] = [];
        groups[s.category_id].push(s);
      } else {
        uncategorized.push(s);
      }
    });
    const result = [];
    categories.forEach(cat => {
      if (groups[cat.id]?.length > 0) {
        result.push({ name: cat.name, sponsors: groups[cat.id] });
      }
    });
    if (uncategorized.length > 0) {
      result.push({ name: result.length > 0 ? "Uncategorized" : null, sponsors: uncategorized });
    }
    return result;
  }, [sponsors, categories]);

  const openModal = () => {
    setTempSelected([...selectedSponsorIds]);
    setModalOpen(true);
  };

  const toggleSponsor = (id) => {
    setTempSelected(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const confirmSelection = () => {
    onSelectedSponsorIdsChange(tempSelected);
    setModalOpen(false);
  };

  const removeSponsor = (id) => {
    onSelectedSponsorIdsChange(selectedSponsorIds.filter(x => x !== id));
  };

  if (loadingSponsors) {
    return (
      <div className="space-y-2">
        <Label className="flex items-center gap-2">
          <Handshake className="h-4 w-4 text-slate-500" />
          Sponsors
        </Label>
        <div className="text-sm text-slate-500">Loading sponsors...</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-2">
        <Handshake className="h-4 w-4 text-slate-500" />
        Sponsors
      </Label>
      <p className="text-xs text-slate-500 mb-2">
        Select sponsors to display on this event's page.
      </p>

      {sponsors.length === 0 ? (
        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600">
          No sponsors available. <a href="/SponsorManagement" className="text-blue-600 hover:underline" data-testid="link-add-sponsor">Add sponsors</a> first.
        </div>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            onClick={openModal}
            className="w-full justify-start text-left h-auto py-2"
            data-testid="button-select-sponsors"
          >
            <Handshake className="h-4 w-4 mr-2 text-blue-600" />
            {selectedSponsorIds.length === 0
              ? "Click to select sponsors..."
              : `${selectedSponsorIds.length} sponsor${selectedSponsorIds.length !== 1 ? 's' : ''} selected`
            }
          </Button>

          {selectedSponsorIds.length > 0 && (
            <div className="flex flex-col gap-2 mt-2">
              {selectedSponsorIds.map(sponsorId => {
                const sponsor = sponsorMap[sponsorId];
                if (!sponsor) return null;
                return (
                  <div
                    key={sponsor.id}
                    className="flex flex-col gap-2 p-2 rounded-md bg-slate-50 border border-slate-200 sm:flex-row sm:items-center"
                  >
                    <div className="flex items-center gap-2 sm:w-44 sm:shrink-0">
                      {sponsor.logo_url ? (
                        <img src={sponsor.logo_url} alt={sponsor.name} className="w-6 h-6 rounded-full object-cover" />
                      ) : (
                        <Handshake className="h-4 w-4 text-slate-500" />
                      )}
                      <span className="text-sm text-slate-900 truncate">{sponsor.name}</span>
                      <button
                        type="button"
                        onClick={() => removeSponsor(sponsor.id)}
                        className="ml-auto text-slate-400 hover:text-slate-600"
                        data-testid={`button-remove-sponsor-chip-${sponsor.id}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {onSponsorDetailsChange && (
                      <Input
                        value={sponsorDetails[sponsor.id] || ''}
                        onChange={(e) => onSponsorDetailsChange(sponsor.id, e.target.value)}
                        placeholder="What are they sponsoring? (optional, e.g. Lunch)"
                        className="h-8 text-sm flex-1"
                        data-testid={`input-sponsor-detail-${sponsor.id}`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Dialog open={modalOpen} onOpenChange={setModalOpen}>
            <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Select Sponsors</DialogTitle>
                <DialogDescription>Choose sponsors to associate with this event.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {groupedSponsors.map((group, gi) => (
                  <div key={gi}>
                    {group.name && (
                      <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">{group.name}</h4>
                    )}
                    <div className="space-y-1">
                      {group.sponsors.map(sponsor => (
                        <label
                          key={sponsor.id}
                          className="flex items-center gap-3 p-2 rounded-md hover:bg-slate-50 cursor-pointer"
                          data-testid={`label-sponsor-option-${sponsor.id}`}
                        >
                          <Checkbox
                            checked={tempSelected.includes(sponsor.id)}
                            onCheckedChange={() => toggleSponsor(sponsor.id)}
                          />
                          {sponsor.logo_url ? (
                            <img src={sponsor.logo_url} alt={sponsor.name} className="w-8 h-8 object-contain rounded border border-slate-200 bg-white" />
                          ) : (
                            <div className="w-8 h-8 rounded border border-slate-200 bg-slate-50 flex items-center justify-center">
                              <Image className="h-4 w-4 text-slate-300" />
                            </div>
                          )}
                          <span className="text-sm text-slate-900">{sponsor.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => setModalOpen(false)} data-testid="button-cancel-sponsor-modal">Cancel</Button>
                <Button onClick={confirmSelection} data-testid="button-confirm-sponsor-modal">
                  Confirm ({tempSelected.length})
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
