import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import {
  Ticket,
  Plus,
  Trash2,
  Users,
  PoundSterling,
  ChevronDown,
  ChevronUp,
  Check,
  Globe,
  Eye,
  X,
  Layers
} from "lucide-react";

const createEmptyTicketClass = (defaultVatRate = null) => ({
  id: `ticket-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
  name: "",
  price: "",
  is_free: false,
  role_ids: [],
  visibility_mode: 'members_only',
  role_match_only: false,
  offer_type: "none",
  bogo_logic_type: "buy_x_get_y_free",
  bogo_buy_quantity: "",
  bogo_get_free_quantity: "",
  bulk_discount_threshold: "",
  bulk_discount_percentage: "",
  available_count: "",
  is_unlimited_tickets: true,
  vat_rate_key: defaultVatRate?.taxType || null,
  vat_rate_label: defaultVatRate?.name || null,
  vat_rate_percentage: defaultVatRate?.effectiveRate || null,
  is_group_ticket: false,
  group_size: "",
  group_cutoff_date: "",
  early_bird_enabled: false,
  early_bird_price: "",
  early_bird_deadline: "",
  linked_track_ids: [],
  all_tracks: true,
  display_order: 0
});

export default function ComplexEventTicketManager({
  ticketClasses,
  setTicketClasses,
  tracks = [],
  roles = [],
  loadingRoles = false,
  availableVatRates = [],
  defaultVatRate = null,
  allowGuestsToViewAllTickets = false,
  setAllowGuestsToViewAllTickets = () => {}
}) {
  const [expandedTickets, setExpandedTickets] = useState({});

  const addTicketClass = () => {
    const newTicket = createEmptyTicketClass(defaultVatRate);
    newTicket.display_order = ticketClasses.length;
    setTicketClasses([...ticketClasses, newTicket]);
    setExpandedTickets(prev => ({ ...prev, [newTicket.id]: true }));
  };

  const removeTicketClass = (ticketId) => {
    if (ticketClasses.length === 1) {
      toast.error('You must have at least one ticket class');
      return;
    }
    setTicketClasses(ticketClasses.filter(t => t.id !== ticketId));
  };

  const updateTicketClass = (ticketId, field, value) => {
    setTicketClasses(prev => prev.map(t =>
      t.id === ticketId ? { ...t, [field]: value } : t
    ));
  };

  const setTicketFree = (ticketId, isFree) => {
    setTicketClasses(prev => prev.map(t =>
      t.id === ticketId ? {
        ...t,
        is_free: isFree,
        price: isFree ? '0' : t.price,
        early_bird_enabled: isFree ? false : t.early_bird_enabled,
        early_bird_price: isFree ? '' : t.early_bird_price,
        early_bird_deadline: isFree ? '' : t.early_bird_deadline,
      } : t
    ));
  };

  const toggleRoleForTicket = (ticketId, roleId) => {
    setTicketClasses(prev => prev.map(t => {
      if (t.id !== ticketId) return t;
      const currentRoles = t.role_ids || [];
      const newRoles = currentRoles.includes(roleId)
        ? currentRoles.filter(id => id !== roleId)
        : [...currentRoles, roleId];
      return { ...t, role_ids: newRoles };
    }));
  };

  const toggleTrackForTicket = (ticketId, trackId) => {
    setTicketClasses(prev => prev.map(t => {
      if (t.id !== ticketId) return t;
      const currentTracks = t.linked_track_ids || [];
      const newTracks = currentTracks.includes(trackId)
        ? currentTracks.filter(id => id !== trackId)
        : [...currentTracks, trackId];
      return { ...t, linked_track_ids: newTracks };
    }));
  };

  const toggleExpandTicket = (ticketId) => {
    setExpandedTickets(prev => ({
      ...prev,
      [ticketId]: !prev[ticketId]
    }));
  };

  const getRoleNames = (roleIds) => {
    if (!roleIds || roleIds.length === 0) return "All Roles";
    return roleIds
      .map(id => roles.find(r => r.id === id)?.name || 'Unknown')
      .join(', ');
  };

  const getTrackNames = (ticket) => {
    if (ticket.all_tracks) return "All Tracks";
    if (!ticket.linked_track_ids || ticket.linked_track_ids.length === 0) return "No tracks selected";
    return ticket.linked_track_ids
      .map(id => tracks.find(t => t.id === id)?.name || 'Unknown')
      .join(', ');
  };

  return (
    <Card className="border-slate-200 shadow-sm mb-6">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Ticket className="h-5 w-5 text-blue-600" />
              Ticket Classes
            </CardTitle>
            <CardDescription>Create ticket types with track-based access control</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTicketClass}
            data-testid="button-add-complex-ticket-class"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Ticket
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {ticketClasses.map((ticket, index) => (
          <div
            key={ticket.id}
            className="border border-slate-200 rounded-lg overflow-hidden"
          >
            {/* Ticket Header */}
            <div
              className="flex items-center justify-between p-4 bg-slate-50 cursor-pointer"
              onClick={() => toggleExpandTicket(ticket.id)}
              data-testid={`ticket-header-${ticket.id}`}
            >
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-600 font-medium text-sm">
                  {index + 1}
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-900">
                      {ticket.name || "Unnamed Ticket"}
                    </span>
                    {ticket.all_tracks && (
                      <Badge variant="outline" className="text-xs bg-indigo-50 text-indigo-700 border-indigo-200">
                        <Layers className="h-3 w-3 mr-1" />
                        All Tracks
                      </Badge>
                    )}
                    {!ticket.all_tracks && (ticket.linked_track_ids || []).length > 0 && (
                      <Badge variant="outline" className="text-xs bg-indigo-50 text-indigo-700 border-indigo-200">
                        <Layers className="h-3 w-3 mr-1" />
                        {(ticket.linked_track_ids || []).length} track{(ticket.linked_track_ids || []).length !== 1 ? 's' : ''}
                      </Badge>
                    )}
                    {ticket.visibility_mode === 'members_and_public' && (
                      <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                        <Globe className="h-3 w-3 mr-1" />
                        Members & Public
                      </Badge>
                    )}
                    {ticket.visibility_mode === 'public_only' && (
                      <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">
                        <Globe className="h-3 w-3 mr-1" />
                        Public Only
                      </Badge>
                    )}
                    {ticket.is_group_ticket && (
                      <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                        <Users className="h-3 w-3 mr-1" />
                        Group ({ticket.group_size || '?'})
                      </Badge>
                    )}
                    {ticket.early_bird_enabled && !ticket.is_free && (
                      <Badge variant="outline" className="text-xs bg-warning/10 text-warning border-warning/30">
                        Early Bird
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span>{ticket.is_free ? 'Free' : `£${ticket.price || "0.00"}`}</span>
                    <span className="text-slate-300">|</span>
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {getRoleNames(ticket.role_ids)}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {ticketClasses.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(e) => { e.stopPropagation(); removeTicketClass(ticket.id); }}
                    className="text-slate-400 hover:text-red-500"
                    data-testid={`button-remove-complex-ticket-${ticket.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
                {expandedTickets[ticket.id] ? (
                  <ChevronUp className="h-5 w-5 text-slate-400" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-slate-400" />
                )}
              </div>
            </div>

            {/* Ticket Details - Collapsible */}
            {expandedTickets[ticket.id] && (
              <div className="p-4 space-y-4 border-t border-slate-200">
                {/* Name and Price */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor={`ct-name-${ticket.id}`}>Ticket Name *</Label>
                    <Input
                      id={`ct-name-${ticket.id}`}
                      value={ticket.name}
                      onChange={(e) => updateTicketClass(ticket.id, 'name', e.target.value)}
                      placeholder="e.g. Full Access Pass"
                      data-testid={`input-complex-ticket-name-${ticket.id}`}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`ct-price-${ticket.id}`}>Price (£) *</Label>
                    <div className="flex items-center gap-3">
                      <div className="relative w-28">
                        <PoundSterling className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                        <Input
                          id={`ct-price-${ticket.id}`}
                          type="number"
                          step="0.01"
                          min="0"
                          value={ticket.is_free ? "0" : ticket.price}
                          onChange={(e) => updateTicketClass(ticket.id, 'price', e.target.value)}
                          placeholder="0.00"
                          className="pl-9"
                          disabled={ticket.is_free}
                          data-testid={`input-complex-ticket-price-${ticket.id}`}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`ct-free-${ticket.id}`}
                          checked={ticket.is_free || false}
                          onCheckedChange={(checked) => setTicketFree(ticket.id, checked)}
                          data-testid={`switch-complex-free-${ticket.id}`}
                        />
                        <Label htmlFor={`ct-free-${ticket.id}`} className="text-sm font-medium">
                          Free
                        </Label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Track Access */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Layers className="h-5 w-5 text-indigo-600" />
                    <Label className="text-base font-medium">Track Access</Label>
                  </div>
                  <p className="text-xs text-slate-500">
                    Choose which tracks this ticket grants access to, or allow access to all tracks.
                  </p>
                  <div className="flex items-center gap-4 mb-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`ct-all-tracks-${ticket.id}`}
                        checked={ticket.all_tracks}
                        onCheckedChange={(checked) => {
                          updateTicketClass(ticket.id, 'all_tracks', checked);
                          if (checked) {
                            updateTicketClass(ticket.id, 'linked_track_ids', []);
                          }
                        }}
                        data-testid={`switch-all-tracks-${ticket.id}`}
                      />
                      <Label htmlFor={`ct-all-tracks-${ticket.id}`} className="text-sm font-medium">
                        All Tracks
                      </Label>
                    </div>
                  </div>

                  {!ticket.all_tracks && (
                    <>
                      {tracks.length === 0 ? (
                        <div className="p-3 bg-warning/10 border border-warning/30 rounded-lg text-sm text-warning">
                          No tracks defined yet. Add tracks to this event first, then link them to ticket classes.
                        </div>
                      ) : (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              type="button"
                              variant="outline"
                              className="w-full justify-between gap-2"
                              data-testid={`track-selector-trigger-${ticket.id}`}
                            >
                              <div className="flex items-center gap-2">
                                <Layers className="w-4 h-4" />
                                {(ticket.linked_track_ids || []).length === 0 ? (
                                  <span className="text-slate-500">Select tracks...</span>
                                ) : (ticket.linked_track_ids || []).length === 1 ? (
                                  <span className="truncate max-w-[200px]">
                                    {tracks.find(t => t.id === ticket.linked_track_ids[0])?.name || 'Unknown'}
                                  </span>
                                ) : (
                                  <span>{(ticket.linked_track_ids || []).length} tracks selected</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1">
                                {(ticket.linked_track_ids || []).length > 0 && (
                                  <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                                    {(ticket.linked_track_ids || []).length}
                                  </Badge>
                                )}
                                <ChevronDown className="w-4 h-4 opacity-50" />
                              </div>
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-64 p-0" align="start">
                            <div className="p-2 border-b border-slate-100">
                              <div className="flex items-center justify-between flex-wrap gap-1">
                                <span className="text-sm font-medium text-slate-700">Select tracks</span>
                                {(ticket.linked_track_ids || []).length > 0 && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs text-slate-500 hover:text-slate-700"
                                    onClick={() => updateTicketClass(ticket.id, 'linked_track_ids', [])}
                                    data-testid={`track-clear-${ticket.id}`}
                                  >
                                    Clear all
                                  </Button>
                                )}
                              </div>
                            </div>
                            <div className="max-h-[280px] overflow-y-auto p-1">
                              {tracks.map(track => {
                                const isSelected = (ticket.linked_track_ids || []).includes(track.id);
                                return (
                                  <button
                                    type="button"
                                    key={track.id}
                                    className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                                      isSelected
                                        ? "bg-slate-100 text-slate-900 font-medium"
                                        : "text-slate-600 hover:bg-slate-50"
                                    }`}
                                    onClick={() => toggleTrackForTicket(ticket.id, track.id)}
                                    data-testid={`track-toggle-${ticket.id}-${track.id}`}
                                  >
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                      isSelected ? "bg-primary border-primary" : "border-slate-300"
                                    }`}>
                                      {isSelected && <Check className="w-3 h-3 text-white" />}
                                    </div>
                                    <span className="truncate">{track.name}</span>
                                    {track.color && (
                                      <span
                                        className="w-3 h-3 rounded-full flex-shrink-0"
                                        style={{ backgroundColor: track.color }}
                                      />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}

                      {(ticket.linked_track_ids || []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {(ticket.linked_track_ids || []).map(trackId => {
                            const track = tracks.find(t => t.id === trackId);
                            return track ? (
                              <Badge key={trackId} variant="secondary" className="text-xs">
                                {track.color && (
                                  <span
                                    className="w-2 h-2 rounded-full mr-1 inline-block"
                                    style={{ backgroundColor: track.color }}
                                  />
                                )}
                                {track.name}
                                <button
                                  type="button"
                                  className="ml-1 hover:text-slate-900"
                                  onClick={() => toggleTrackForTicket(ticket.id, trackId)}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </Badge>
                            ) : null;
                          })}
                        </div>
                      )}

                      {(ticket.linked_track_ids || []).length === 0 && tracks.length > 0 && (
                        <div className="mt-2 p-2 bg-warning/10 border border-warning/30 rounded text-sm text-warning">
                          No tracks selected. Attendees with this ticket won't have access to any sessions.
                        </div>
                      )}
                    </>
                  )}

                  {ticket.all_tracks && (
                    <div className="p-2 bg-green-50 border border-green-200 rounded text-sm text-green-700">
                      This ticket grants access to all tracks and sessions.
                    </div>
                  )}
                </div>

                <Separator />

                {/* Early Bird Pricing */}
                {!ticket.is_free && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`ct-early-bird-${ticket.id}`}
                      checked={ticket.early_bird_enabled || false}
                      onCheckedChange={(checked) => updateTicketClass(ticket.id, 'early_bird_enabled', checked)}
                      data-testid={`switch-early-bird-${ticket.id}`}
                    />
                    <Label htmlFor={`ct-early-bird-${ticket.id}`} className="text-sm font-medium">
                      Early Bird Pricing
                    </Label>
                  </div>
                  {ticket.early_bird_enabled && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-2 border-l-2 border-warning/30 ml-1">
                      <div className="space-y-1.5">
                        <Label htmlFor={`ct-eb-price-${ticket.id}`} className="text-sm">Early Bird Price (£) *</Label>
                        <div className="relative w-28">
                          <PoundSterling className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
                          <Input
                            id={`ct-eb-price-${ticket.id}`}
                            type="number"
                            step="0.01"
                            min="0"
                            value={ticket.early_bird_price || ""}
                            onChange={(e) => updateTicketClass(ticket.id, 'early_bird_price', e.target.value)}
                            placeholder="0.00"
                            className="pl-9"
                            data-testid={`input-early-bird-price-${ticket.id}`}
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`ct-eb-deadline-${ticket.id}`} className="text-sm">Deadline *</Label>
                        <Input
                          id={`ct-eb-deadline-${ticket.id}`}
                          type="datetime-local"
                          value={ticket.early_bird_deadline || ""}
                          onChange={(e) => updateTicketClass(ticket.id, 'early_bird_deadline', e.target.value)}
                          data-testid={`input-early-bird-deadline-${ticket.id}`}
                        />
                      </div>
                    </div>
                  )}
                </div>
                )}

                <Separator />

                {/* Ticket Availability */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Ticket className="h-4 w-4 text-slate-500" />
                    Ticket Availability
                  </Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Set how many of this ticket type are available.
                  </p>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`ct-unlimited-${ticket.id}`}
                        checked={ticket.is_unlimited_tickets !== false}
                        onCheckedChange={(checked) => updateTicketClass(ticket.id, 'is_unlimited_tickets', checked)}
                        data-testid={`switch-complex-unlimited-tickets-${ticket.id}`}
                      />
                      <Label htmlFor={`ct-unlimited-${ticket.id}`} className="text-sm font-medium">
                        Unlimited
                      </Label>
                    </div>
                    {ticket.is_unlimited_tickets === false && (
                      <div className="flex items-center gap-2">
                        <Input
                          id={`ct-available-count-${ticket.id}`}
                          type="number"
                          min="0"
                          value={ticket.available_count || ""}
                          onChange={(e) => updateTicketClass(ticket.id, 'available_count', e.target.value)}
                          placeholder="e.g. 50"
                          className="w-24"
                          data-testid={`input-complex-ticket-available-count-${ticket.id}`}
                        />
                        <span className="text-sm text-slate-500">tickets</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Group Ticket */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`ct-group-${ticket.id}`}
                      checked={ticket.is_group_ticket || false}
                      onCheckedChange={(checked) => updateTicketClass(ticket.id, 'is_group_ticket', checked)}
                      data-testid={`switch-complex-group-ticket-${ticket.id}`}
                    />
                    <Label htmlFor={`ct-group-${ticket.id}`} className="text-sm font-medium flex items-center gap-1.5">
                      <Users className="h-4 w-4 text-slate-500" />
                      Group Ticket
                    </Label>
                  </div>
                  <p className="text-xs text-slate-500">
                    A group ticket covers multiple participants.
                  </p>
                  {ticket.is_group_ticket && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-2 border-l-2 border-blue-200 ml-1">
                      <div className="space-y-1.5">
                        <Label htmlFor={`ct-group-size-${ticket.id}`} className="text-sm">
                          Group Size (max participants) *
                        </Label>
                        <Input
                          id={`ct-group-size-${ticket.id}`}
                          type="number"
                          min="2"
                          value={ticket.group_size || ""}
                          onChange={(e) => updateTicketClass(ticket.id, 'group_size', e.target.value)}
                          placeholder="e.g. 10"
                          className="w-28"
                          data-testid={`input-complex-group-size-${ticket.id}`}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`ct-group-cutoff-${ticket.id}`} className="text-sm">
                          Cut-off Date/Time
                        </Label>
                        <Input
                          id={`ct-group-cutoff-${ticket.id}`}
                          type="datetime-local"
                          value={ticket.group_cutoff_date || ""}
                          onChange={(e) => updateTicketClass(ticket.id, 'group_cutoff_date', e.target.value)}
                          data-testid={`input-complex-group-cutoff-${ticket.id}`}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Role Assignment */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-slate-500" />
                    Available to Roles
                  </Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Select which roles can purchase this ticket. Leave empty for all roles.
                  </p>

                  {loadingRoles ? (
                    <div className="text-sm text-slate-500">Loading roles...</div>
                  ) : (
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full justify-between gap-2"
                          data-testid={`complex-role-selector-trigger-${ticket.id}`}
                        >
                          <div className="flex items-center gap-2">
                            <Users className="w-4 h-4" />
                            {(ticket.role_ids || []).length === 0 ? (
                              <span className="text-green-600 font-medium">All Roles</span>
                            ) : (ticket.role_ids || []).length === 1 ? (
                              <span className="truncate max-w-[200px]">
                                {roles.find(r => r.id === ticket.role_ids[0])?.name || 'Unknown'}
                              </span>
                            ) : (
                              <span>{(ticket.role_ids || []).length} roles selected</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {(ticket.role_ids || []).length > 0 && (
                              <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                                {(ticket.role_ids || []).length}
                              </Badge>
                            )}
                            <ChevronDown className="w-4 h-4 opacity-50" />
                          </div>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-0" align="start">
                        <div className="p-2 border-b border-slate-100">
                          <div className="flex items-center justify-between flex-wrap gap-1">
                            <span className="text-sm font-medium text-slate-700">Select roles</span>
                            {(ticket.role_ids || []).length > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-slate-500 hover:text-slate-700"
                                onClick={() => updateTicketClass(ticket.id, 'role_ids', [])}
                                data-testid={`complex-role-clear-${ticket.id}`}
                              >
                                Clear all
                              </Button>
                            )}
                          </div>
                        </div>
                        <div className="max-h-[280px] overflow-y-auto p-1">
                          {roles.map(role => {
                            const isSelected = (ticket.role_ids || []).includes(role.id);
                            return (
                              <button
                                type="button"
                                key={role.id}
                                className={`w-full flex items-center gap-2 px-2 py-2 text-sm rounded-md transition-colors ${
                                  isSelected
                                    ? "bg-slate-100 text-slate-900 font-medium"
                                    : "text-slate-600 hover:bg-slate-50"
                                }`}
                                onClick={() => toggleRoleForTicket(ticket.id, role.id)}
                                data-testid={`complex-role-toggle-${ticket.id}-${role.id}`}
                              >
                                <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                  isSelected ? "bg-primary border-primary" : "border-slate-300"
                                }`}>
                                  {isSelected && <Check className="w-3 h-3 text-white" />}
                                </div>
                                <span className="truncate">{role.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}

                  {(ticket.role_ids || []).length === 0 && (
                    <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-sm text-green-700">
                      This ticket is available to all roles
                    </div>
                  )}

                  {(ticket.role_ids || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(ticket.role_ids || []).map(roleId => {
                        const role = roles.find(r => r.id === roleId);
                        return role ? (
                          <Badge key={roleId} variant="secondary" className="text-xs">
                            {role.name}
                            <button
                              type="button"
                              className="ml-1 hover:text-slate-900"
                              onClick={() => toggleRoleForTicket(ticket.id, roleId)}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ) : null;
                      })}
                    </div>
                  )}

                  {(ticket.role_ids || []).length > 0 && ticket.visibility_mode !== 'public_only' && (
                    <div className="mt-3 flex items-center justify-between p-3 bg-warning/10 border border-warning/30 rounded-lg">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-warning" />
                        <div>
                          <Label htmlFor={`ct-role-match-only-${ticket.id}`} className="text-sm font-medium text-warning">
                            Match only to user role
                          </Label>
                          <p className="text-xs text-warning">
                            {ticket.role_match_only
                              ? "Ticket is hidden from users whose role doesn't match"
                              : "Ticket is visible to all users (role only affects who can register)"}
                          </p>
                        </div>
                      </div>
                      <Switch
                        id={`ct-role-match-only-${ticket.id}`}
                        checked={ticket.role_match_only || false}
                        onCheckedChange={(checked) => updateTicketClass(ticket.id, 'role_match_only', checked)}
                        data-testid={`switch-complex-role-match-only-${ticket.id}`}
                      />
                    </div>
                  )}
                </div>

                {/* Ticket Visibility Mode */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Globe className="h-5 w-5 text-blue-600" />
                    <Label className="text-base font-medium">Ticket Visibility</Label>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {[
                      { value: 'members_only', label: 'Members Only', desc: 'Logged-in members only' },
                      { value: 'members_and_public', label: 'Members & Public', desc: 'Both members and visitors' },
                      { value: 'public_only', label: 'Public Only', desc: 'Non-logged in visitors only' }
                    ].map(opt => (
                      <div
                        key={opt.value}
                        className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                          (ticket.visibility_mode || 'members_only') === opt.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                        onClick={() => updateTicketClass(ticket.id, 'visibility_mode', opt.value)}
                        data-testid={`complex-visibility-${opt.value}-${ticket.id}`}
                      >
                        <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                          (ticket.visibility_mode || 'members_only') === opt.value
                            ? 'border-blue-500'
                            : 'border-slate-300'
                        }`}>
                          {(ticket.visibility_mode || 'members_only') === opt.value && (
                            <div className="h-2 w-2 rounded-full bg-blue-500" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{opt.label}</p>
                          <p className="text-xs text-slate-500">{opt.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <Separator />

                {/* Offer Configuration */}
                <div className="space-y-4">
                  <Label className="text-sm font-medium text-slate-700">Special Offer</Label>
                  <RadioGroup
                    value={ticket.offer_type}
                    onValueChange={(value) => updateTicketClass(ticket.id, 'offer_type', value)}
                    className="grid grid-cols-1 md:grid-cols-3 gap-2"
                  >
                    {[
                      { value: 'none', label: 'No Offer' },
                      { value: 'bogo', label: 'BOGO' },
                      { value: 'bulk_discount', label: 'Bulk Discount' }
                    ].map(opt => (
                      <Label
                        key={opt.value}
                        htmlFor={`ct-offer-${opt.value}-${ticket.id}`}
                        className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                          ticket.offer_type === opt.value
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                        data-testid={`complex-offer-${opt.value}-${ticket.id}`}
                      >
                        <RadioGroupItem value={opt.value} id={`ct-offer-${opt.value}-${ticket.id}`} />
                        <span className="text-sm">{opt.label}</span>
                      </Label>
                    ))}
                  </RadioGroup>

                  {ticket.offer_type === 'bogo' && (
                    <div className="p-4 bg-slate-50 rounded-lg space-y-4">
                      <RadioGroup
                        value={ticket.bogo_logic_type}
                        onValueChange={(value) => updateTicketClass(ticket.id, 'bogo_logic_type', value)}
                      >
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="buy_x_get_y_free" id={`ct-bogo-1-${ticket.id}`} />
                            <Label htmlFor={`ct-bogo-1-${ticket.id}`} className="text-sm cursor-pointer">
                              Buy X, Get Y Free
                            </Label>
                          </div>
                          <div className="flex items-center gap-2">
                            <RadioGroupItem value="enter_total_pay_less" id={`ct-bogo-2-${ticket.id}`} />
                            <Label htmlFor={`ct-bogo-2-${ticket.id}`} className="text-sm cursor-pointer">
                              Enter Total, Pay Less
                            </Label>
                          </div>
                        </div>
                      </RadioGroup>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor={`ct-bogo-buy-${ticket.id}`}>Buy Quantity *</Label>
                          <Input
                            id={`ct-bogo-buy-${ticket.id}`}
                            type="number"
                            min="1"
                            value={ticket.bogo_buy_quantity}
                            onChange={(e) => updateTicketClass(ticket.id, 'bogo_buy_quantity', e.target.value)}
                            placeholder="e.g. 2"
                            data-testid={`input-complex-bogo-buy-${ticket.id}`}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`ct-bogo-free-${ticket.id}`}>Get Free Quantity *</Label>
                          <Input
                            id={`ct-bogo-free-${ticket.id}`}
                            type="number"
                            min="1"
                            value={ticket.bogo_get_free_quantity}
                            onChange={(e) => updateTicketClass(ticket.id, 'bogo_get_free_quantity', e.target.value)}
                            placeholder="e.g. 1"
                            data-testid={`input-complex-bogo-free-${ticket.id}`}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {ticket.offer_type === 'bulk_discount' && (
                    <div className="p-4 bg-slate-50 rounded-lg">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor={`ct-bulk-threshold-${ticket.id}`}>Minimum Tickets *</Label>
                          <Input
                            id={`ct-bulk-threshold-${ticket.id}`}
                            type="number"
                            min="2"
                            value={ticket.bulk_discount_threshold}
                            onChange={(e) => updateTicketClass(ticket.id, 'bulk_discount_threshold', e.target.value)}
                            placeholder="e.g. 5"
                            data-testid={`input-complex-bulk-threshold-${ticket.id}`}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor={`ct-bulk-percentage-${ticket.id}`}>Discount % *</Label>
                          <Input
                            id={`ct-bulk-percentage-${ticket.id}`}
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            value={ticket.bulk_discount_percentage}
                            onChange={(e) => updateTicketClass(ticket.id, 'bulk_discount_percentage', e.target.value)}
                            placeholder="e.g. 10"
                            data-testid={`input-complex-bulk-percentage-${ticket.id}`}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* VAT Rate Selection */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium text-slate-700">VAT Rate</Label>
                  <Select
                    value={ticket.vat_rate_key || "none"}
                    onValueChange={(value) => {
                      if (value === "none") {
                        updateTicketClass(ticket.id, 'vat_rate_key', null);
                        updateTicketClass(ticket.id, 'vat_rate_label', null);
                        updateTicketClass(ticket.id, 'vat_rate_percentage', null);
                      } else {
                        const selectedRate = availableVatRates.find(r => r.taxType === value);
                        if (selectedRate) {
                          updateTicketClass(ticket.id, 'vat_rate_key', selectedRate.taxType);
                          updateTicketClass(ticket.id, 'vat_rate_label', selectedRate.name);
                          updateTicketClass(ticket.id, 'vat_rate_percentage', selectedRate.effectiveRate);
                        }
                      }
                    }}
                  >
                    <SelectTrigger className="w-full" data-testid={`select-complex-vat-rate-${ticket.id}`}>
                      <SelectValue placeholder="Select VAT rate..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No VAT / Tax Exempt</SelectItem>
                      {availableVatRates.map((rate) => (
                        <SelectItem key={rate.taxType} value={rate.taxType}>
                          {rate.name} ({rate.effectiveRate}%)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {availableVatRates.length === 0 && (
                    <p className="text-xs text-warning">
                      No VAT rates available. Sync rates from Xero in Admin Setup.
                    </p>
                  )}
                  {ticket.vat_rate_key && (
                    <p className="text-xs text-green-600">
                      {ticket.vat_rate_label} ({ticket.vat_rate_percentage}%)
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {ticketClasses.length === 0 && (
          <div className="text-center py-8 text-slate-500">
            <Ticket className="h-12 w-12 mx-auto mb-3 text-slate-300" />
            <p>No ticket classes defined</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addTicketClass}
              className="mt-3"
              data-testid="button-add-first-complex-ticket"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Your First Ticket
            </Button>
          </div>
        )}

        {ticketClasses.length > 0 && (
          <div className="mt-6 pt-4 border-t border-slate-200">
            <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
              <div className="flex items-start gap-3">
                <Eye className="h-5 w-5 text-slate-600 mt-0.5" />
                <div>
                  <Label htmlFor="complex-allow-guests-view-all" className="text-sm font-medium text-slate-900 cursor-pointer">
                    Show all ticket types to public visitors
                  </Label>
                  <p className="text-xs text-slate-500 mt-1">
                    When enabled, non-logged-in visitors can see member-only ticket prices (but cannot purchase them)
                  </p>
                </div>
              </div>
              <Switch
                id="complex-allow-guests-view-all"
                checked={allowGuestsToViewAllTickets}
                onCheckedChange={setAllowGuestsToViewAllTickets}
                data-testid="switch-complex-allow-guests-view-all"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export { createEmptyTicketClass };
