import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import {
  ArrowLeft, Save, Loader2, Plus, Trash2, ChevronDown, ChevronUp,
  Calendar, MapPin, Monitor, Ticket, Users, Globe, PoundSterling,
  Bird, Check, X, Mic, Eye, Tag, Clock
} from "lucide-react";
import { useEventTypes } from "@/hooks/useEventTypes";
import { createFilterTagKey, parseFilterTagKey, normalizeFilterTags } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import EventImageUpload from "@/components/events/EventImageUpload";
import { FocalPointPicker } from "@/components/FocalPointPicker";
import SEOSettings from "@/components/blog/SEOSettings";
import { SpeakerSelectionModal } from "@/components/SpeakerSelectionModal";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";

const TIMEZONE_OPTIONS = [
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Dublin", label: "Dublin (GMT/IST)" },
  { value: "Europe/Paris", label: "Paris (CET/CEST)" },
  { value: "Europe/Berlin", label: "Berlin (CET/CEST)" },
  { value: "America/New_York", label: "New York (EST/EDT)" },
  { value: "America/Chicago", label: "Chicago (CST/CDT)" },
  { value: "America/Los_Angeles", label: "Los Angeles (PST/PDT)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Singapore", label: "Singapore (SGT)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
  { value: "Pacific/Auckland", label: "Auckland (NZST/NZDT)" },
  { value: "UTC", label: "UTC" },
];

const QUILL_MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ color: [] }, { background: [] }],
    [{ list: "ordered" }, { list: "bullet" }],
    [{ align: [] }],
    ["link"],
    ["clean"],
  ],
};

const QUILL_FORMATS = [
  "header", "bold", "italic", "underline", "strike",
  "color", "background", "list", "bullet", "align", "link",
];

const TRACK_COLOURS = [
  "#3B82F6", "#EF4444", "#10B981", "#F59E0B", "#8B5CF6",
  "#EC4899", "#06B6D4", "#F97316", "#6366F1", "#14B8A6",
];

function generateId() {
  return `tmp-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

const createEmptyTicketClass = (isDefault = false, defaultVatRate = null) => ({
  _localId: generateId(),
  name: isDefault ? "Standard Ticket" : "",
  price: "",
  is_free: false,
  role_ids: [],
  is_default: isDefault,
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
  all_tracks: true,
  linked_track_ids: [],
});

export default function CreateComplexEvent() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const params = new URLSearchParams(location.search);
  const editId = params.get("id");
  const isEditMode = !!editId;

  const [activeSection, setActiveSection] = useState("details");
  const [saving, setSaving] = useState(false);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [slugError, setSlugError] = useState(null);
  const [checkingSlug, setCheckingSlug] = useState(false);

  const [formData, setFormData] = useState({
    title: "",
    slug: "",
    description: "",
    summary: "",
    image_url: "",
    image_focal_point: null,
    start_date: "",
    end_date: "",
    location: "",
    status: "published",
    event_state: "active",
    timezone: "Europe/London",
    available_seats: "",
    internal_reference: "",
    event_type: "",
    registration_closes_at: "",
    program_tag: "",
  });

  const [tracks, setTracks] = useState([]);
  const [expandedTracks, setExpandedTracks] = useState({});
  const [sessions, setSessions] = useState([]);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState(null);
  const [sessionForm, setSessionForm] = useState({
    title: "",
    description: "",
    image_url: "",
    speaker_ids: [],
    start_time: "",
    end_time: "",
    location: "",
    is_online: false,
    track_ids: [],
  });
  const [sessionSpeakerModalOpen, setSessionSpeakerModalOpen] = useState(false);

  const [ticketClasses, setTicketClasses] = useState([]);
  const [expandedTickets, setExpandedTickets] = useState({});
  const [ticketsInitialized, setTicketsInitialized] = useState(false);

  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['/api/entities/Role'],
    queryFn: () => base44.entities.Role.list({ sort: { name: 'asc' } })
  });

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['/api/entities/SystemSettings'],
    queryFn: () => base44.entities.SystemSettings.list()
  });

  const { data: speakers = [] } = useQuery({
    queryKey: ['/api/entities/Speaker'],
    queryFn: () => base44.entities.Speaker.list({ filter: { is_active: true }, sort: { full_name: 'asc' } })
  });

  const { eventTypes } = useEventTypes();

  const { data: resourceCategories = [] } = useQuery({
    queryKey: ['/api/entities/ResourceCategory'],
    queryFn: () => base44.entities.ResourceCategory.list('display_order')
  });

  const eventCategories = useMemo(() => {
    return resourceCategories
      .filter(cat =>
        cat.is_active &&
        Array.isArray(cat.applies_to_content_types) &&
        cat.applies_to_content_types.includes('Events') &&
        Array.isArray(cat.subcategories) &&
        cat.subcategories.length > 0
      )
      .map(cat => ({
        id: cat.id,
        name: cat.name,
        subcategories: cat.subcategories || []
      }));
  }, [resourceCategories]);

  const [selectedFilterTags, setSelectedFilterTags] = useState([]);
  const [filterTagsInitialized, setFilterTagsInitialized] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [isProgramEvent, setIsProgramEvent] = useState(false);

  const { data: programs = [], isLoading: loadingPrograms } = useQuery({
    queryKey: ['/api/entities/Program'],
    queryFn: () => base44.entities.Program.list({ sort: { name: 'asc' } })
  });

  const summaryMaxLength = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_summary_max_length');
    return setting ? parseInt(setting.setting_value) || 150 : 150;
  }, [systemSettings]);

  const handleTimingChange = (newTiming) => {
    setFormData(prev => ({
      ...prev,
      status: newTiming,
      ...(newTiming === 'tbc' ? { start_date: '', end_date: '', registration_closes_at: '' } : {})
    }));
  };

  const speakerModuleName = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'speaker_module_name');
    if (setting?.setting_value) {
      try {
        const names = JSON.parse(setting.setting_value);
        return { singular: names.singular || "Speaker", plural: names.plural || "Speakers" };
      } catch {
        return { singular: setting.setting_value, plural: setting.setting_value + "s" };
      }
    }
    return { singular: "Speaker", plural: "Speakers" };
  }, [systemSettings]);

  const defaultVatRate = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'event_default_vat_rate');
    if (setting?.setting_value) {
      try { return JSON.parse(setting.setting_value); } catch { return null; }
    }
    return null;
  }, [systemSettings]);

  const availableVatRates = useMemo(() => {
    const setting = systemSettings.find(s => s.setting_key === 'xero_vat_rates');
    if (setting?.setting_value) {
      try {
        const parsed = JSON.parse(setting.setting_value);
        return parsed.rates || [];
      } catch { return []; }
    }
    return [];
  }, [systemSettings]);

  const { data: existingEvent, isLoading: loadingEvent } = useQuery({
    queryKey: ["/api/entities/ComplexEvent", editId],
    queryFn: () => base44.entities.ComplexEvent.get(editId),
    enabled: isEditMode,
  });

  const { data: existingTracks = [], isLoading: loadingTracks } = useQuery({
    queryKey: ["/api/entities/ComplexEventTrack", editId],
    queryFn: () =>
      base44.entities.ComplexEventTrack.list({
        filter: { complex_event_id: editId },
        sort: { display_order: "asc" },
      }),
    enabled: isEditMode,
  });

  const { data: existingSessions = [], isLoading: loadingSessions } = useQuery({
    queryKey: ["/api/complex-event-sessions", editId],
    queryFn: async () => {
      const resp = await fetch(`/api/complex-event-sessions?event_id=${editId}`, { credentials: 'include' });
      if (!resp.ok) return [];
      return resp.json();
    },
    enabled: isEditMode,
  });

  const { data: existingTicketClasses = [], isLoading: loadingTicketClasses } = useQuery({
    queryKey: ["/api/entities/ComplexEventTicketClass", editId],
    queryFn: () =>
      base44.entities.ComplexEventTicketClass.list({
        filter: { complex_event_id: editId },
        sort: { display_order: "asc" },
      }),
    enabled: isEditMode,
  });

  useEffect(() => {
    if (isEditMode && existingTicketClasses.length > 0 && !ticketsInitialized) {
      const loaded = existingTicketClasses.map(tc => ({
        _localId: tc.id,
        _dbId: tc.id,
        name: tc.name || "",
        price: tc.price != null ? String(Number(tc.price)) : "",
        is_free: tc.is_free || false,
        role_ids: tc.role_ids || [],
        is_default: false,
        visibility_mode: tc.visibility_mode || 'members_only',
        role_match_only: tc.role_match_only || false,
        offer_type: tc.offer_type || "none",
        bogo_logic_type: tc.bogo_logic_type || "buy_x_get_y_free",
        bogo_buy_quantity: tc.bogo_buy_quantity != null ? String(tc.bogo_buy_quantity) : "",
        bogo_get_free_quantity: tc.bogo_get_free_quantity != null ? String(tc.bogo_get_free_quantity) : "",
        bulk_discount_threshold: tc.bulk_discount_threshold != null ? String(tc.bulk_discount_threshold) : "",
        bulk_discount_percentage: tc.bulk_discount_percentage != null ? String(tc.bulk_discount_percentage) : "",
        available_count: tc.available_count != null ? String(tc.available_count) : "",
        is_unlimited_tickets: tc.is_unlimited_tickets !== false,
        vat_rate_key: tc.vat_rate_key || null,
        vat_rate_label: tc.vat_rate_label || null,
        vat_rate_percentage: tc.vat_rate_percentage || null,
        is_group_ticket: tc.is_group_ticket || false,
        group_size: tc.group_size != null ? String(tc.group_size) : "",
        group_cutoff_date: tc.group_cutoff_date || "",
        early_bird_enabled: tc.early_bird_enabled || false,
        early_bird_price: tc.early_bird_price != null ? String(Number(tc.early_bird_price)) : "",
        early_bird_deadline: tc.early_bird_deadline ? tc.early_bird_deadline.slice(0, 16) : "",
        all_tracks: tc.all_tracks !== false,
        linked_track_ids: tc.linked_track_ids || [],
      }));
      setTicketClasses(loaded);
      setTicketsInitialized(true);
      if (loaded.length > 0) {
        setExpandedTickets({ [loaded[0]._localId]: true });
      }
    }
  }, [existingTicketClasses, isEditMode, ticketsInitialized]);

  useEffect(() => {
    if (existingEvent && isEditMode) {
      let loadedStatus = existingEvent.status || "published";
      let loadedEventState = existingEvent.event_state || "active";
      if (loadedStatus === 'draft') {
        loadedStatus = 'published';
        loadedEventState = 'draft';
      } else if (loadedStatus === 'closed') {
        loadedStatus = 'published';
        loadedEventState = 'closed';
      }
      setFormData({
        title: existingEvent.title || "",
        slug: existingEvent.slug || "",
        description: existingEvent.description || "",
        summary: existingEvent.summary || "",
        image_url: existingEvent.image_url || "",
        image_focal_point: existingEvent.image_focal_point || null,
        start_date: existingEvent.start_date ? existingEvent.start_date.slice(0, 16) : "",
        end_date: existingEvent.end_date ? existingEvent.end_date.slice(0, 16) : "",
        location: existingEvent.location || "",
        status: loadedStatus,
        event_state: loadedEventState,
        timezone: existingEvent.timezone || "Europe/London",
        available_seats: existingEvent.available_seats != null ? String(existingEvent.available_seats) : "",
        internal_reference: existingEvent.internal_reference || "",
        event_type: existingEvent.event_type || "",
        registration_closes_at: existingEvent.registration_closes_at ? existingEvent.registration_closes_at.slice(0, 16) : "",
        program_tag: existingEvent.program_tag || "",
      });
      setSlugManuallyEdited(true);
      setSeoTitle(existingEvent.seo_title || "");
      setSeoDescription(existingEvent.seo_description || "");
      if (existingEvent.program_tag) {
        setIsProgramEvent(true);
      }
    }
  }, [existingEvent, isEditMode]);

  useEffect(() => {
    if (isEditMode && existingEvent && eventCategories.length > 0 && !filterTagsInitialized) {
      if (existingEvent.filter_tags && existingEvent.filter_tags.length > 0) {
        const normalizedTags = normalizeFilterTags(existingEvent.filter_tags, eventCategories);
        setSelectedFilterTags(normalizedTags);
      }
      setFilterTagsInitialized(true);
    }
  }, [existingEvent, eventCategories, isEditMode, filterTagsInitialized]);

  useEffect(() => {
    if (isEditMode && existingTracks.length > 0) {
      const loadedTracks = existingTracks.map((t) => ({
        ...t,
        _localId: t.id,
      }));
      setTracks(loadedTracks);
      const expanded = {};
      loadedTracks.forEach((t) => { expanded[t._localId] = true; });
      setExpandedTracks(expanded);
    }
  }, [existingTracks, isEditMode]);

  useEffect(() => {
    if (isEditMode && existingSessions.length > 0) {
      const loadedSessions = existingSessions.map((s) => ({
        ...s,
        _localId: s.id,
        speaker_ids: s.speaker_ids || [],
        speaker_names: s.speaker_names || [],
        track_ids: s.track_ids || [],
      }));
      setSessions(loadedSessions);
    }
  }, [existingSessions, isEditMode]);

  useEffect(() => {
    if (formData.title && !slugManuallyEdited) {
      const generated = formData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      setFormData((prev) => ({ ...prev, slug: generated }));
    }
  }, [formData.title, slugManuallyEdited]);

  useEffect(() => {
    if (!formData.slug) {
      setSlugError(null);
      return;
    }
    const checkSlugUniqueness = async () => {
      setCheckingSlug(true);
      try {
        const allEvents = await base44.entities.ComplexEvent.list();
        const duplicate = allEvents.find(
          (e) => e.slug === formData.slug && (!isEditMode || e.id !== editId)
        );
        if (duplicate) {
          setSlugError("This URL slug is already in use. Please choose a different one.");
        } else {
          setSlugError(null);
        }
      } catch (error) {
        console.error("Error checking slug uniqueness:", error);
      } finally {
        setCheckingSlug(false);
      }
    };
    const timer = setTimeout(checkSlugUniqueness, 500);
    return () => clearTimeout(timer);
  }, [formData.slug, editId, isEditMode]);

  useEffect(() => {
    if (formData.status === 'tbc') return;
    const allTimes = sessions
      .filter(s => s.start_time || s.end_time)
      .flatMap(s => {
        const times = [];
        if (s.start_time) times.push(new Date(s.start_time));
        if (s.end_time) times.push(new Date(s.end_time));
        return times;
      })
      .filter(d => !isNaN(d.getTime()));

    if (allTimes.length === 0) return;

    const earliest = new Date(Math.min(...allTimes.map(d => d.getTime())));
    const latest = new Date(Math.max(...allTimes.map(d => d.getTime())));

    const toLocal = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    setFormData(prev => ({
      ...prev,
      start_date: toLocal(earliest),
      end_date: toLocal(latest),
    }));
  }, [sessions, formData.status]);

  const updateField = (field, value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const addTrack = () => {
    const colourIdx = tracks.length % TRACK_COLOURS.length;
    const newTrack = {
      _localId: generateId(),
      name: "",
      description: "",
      colour: TRACK_COLOURS[colourIdx],
      display_order: tracks.length,
    };
    setTracks((prev) => [...prev, newTrack]);
    setExpandedTracks((prev) => ({ ...prev, [newTrack._localId]: true }));
  };

  const updateTrack = (localId, field, value) => {
    setTracks((prev) =>
      prev.map((t) => (t._localId === localId ? { ...t, [field]: value } : t))
    );
  };

  const removeTrack = (localId) => {
    const track = tracks.find(t => t._localId === localId);
    const trackRef = track?.id || localId;
    setTracks((prev) => prev.filter((t) => t._localId !== localId));
    setTicketClasses((prev) => prev.map(t => ({
      ...t,
      linked_track_ids: (t.linked_track_ids || []).filter(id => id !== trackRef),
    })));
    setSessions((prev) => prev.map(s => ({
      ...s,
      track_ids: (s.track_ids || []).filter(id => id !== trackRef),
    })));
  };

  const moveTrack = (localId, direction) => {
    setTracks((prev) => {
      const idx = prev.findIndex((t) => t._localId === localId);
      if ((direction === -1 && idx === 0) || (direction === 1 && idx === prev.length - 1)) return prev;
      const next = [...prev];
      [next[idx], next[idx + direction]] = [next[idx + direction], next[idx]];
      return next.map((t, i) => ({ ...t, display_order: i }));
    });
  };

  const openSessionDialog = (session = null) => {
    setSessionDialogOpen(true);
    if (session) {
      setEditingSession(session._localId);
      setSessionForm({
        title: session.title || "",
        description: session.description || "",
        image_url: session.image_url || "",
        speaker_ids: session.speaker_ids || [],
        start_time: session.start_time ? session.start_time.slice(0, 16) : "",
        end_time: session.end_time ? session.end_time.slice(0, 16) : "",
        location: session.location || "",
        is_online: session.is_online || false,
        track_ids: session.track_ids || [],
      });
    } else {
      setEditingSession(null);
      setSessionForm({
        title: "",
        description: "",
        image_url: "",
        speaker_ids: [],
        start_time: "",
        end_time: "",
        location: "",
        is_online: false,
        track_ids: [],
      });
    }
  };

  const closeSessionDialog = () => {
    setSessionDialogOpen(false);
    setEditingSession(null);
  };

  const checkSessionOverlaps = (formData, currentLocalId) => {
    if (!formData.start_time || !formData.end_time || !(formData.track_ids || []).length) return [];
    const newStart = new Date(formData.start_time).getTime();
    const newEnd = new Date(formData.end_time).getTime();
    if (isNaN(newStart) || isNaN(newEnd) || newEnd <= newStart) return [];

    const overlaps = [];
    for (const s of sessions) {
      if (s._localId === currentLocalId) continue;
      if (!s.start_time || !s.end_time) continue;
      const sStart = new Date(s.start_time).getTime();
      const sEnd = new Date(s.end_time).getTime();
      if (isNaN(sStart) || isNaN(sEnd)) continue;
      const sharedTracks = (formData.track_ids || []).filter(tid => (s.track_ids || []).includes(tid));
      if (sharedTracks.length > 0 && newStart < sEnd && newEnd > sStart) {
        const trackLabels = sharedTracks.map(tid => {
          const t = tracks.find(tr => (tr.id || tr._localId) === tid);
          return t?.name || 'Unknown';
        });
        overlaps.push({ session: s.title, tracks: trackLabels });
      }
    }
    return overlaps;
  };

  const saveSession = () => {
    if (!sessionForm.title.trim()) {
      toast.error("Session title is required");
      return;
    }

    const overlaps = checkSessionOverlaps(sessionForm, editingSession);
    if (overlaps.length > 0) {
      const msgs = overlaps.map(o => `"${o.session}" on track(s): ${o.tracks.join(', ')}`);
      toast.warning(`Time overlap detected with: ${msgs.join('; ')}. Session saved, but please review.`);
    }

    if (editingSession) {
      setSessions((prev) =>
        prev.map((s) =>
          s._localId === editingSession ? { ...s, ...sessionForm } : s
        )
      );
    } else {
      setSessions((prev) => [
        ...prev,
        { ...sessionForm, _localId: generateId(), display_order: prev.length },
      ]);
    }
    closeSessionDialog();
  };

  const removeSession = (sessionLocalId) => {
    setSessions((prev) => prev.filter((s) => s._localId !== sessionLocalId));
  };

  const moveSession = (sessionLocalId, direction) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s._localId === sessionLocalId);
      if ((direction === -1 && idx === 0) || (direction === 1 && idx === prev.length - 1))
        return prev;
      const next = [...prev];
      [next[idx], next[idx + direction]] = [next[idx + direction], next[idx]];
      return next.map((s, i) => ({ ...s, display_order: i }));
    });
  };

  const toggleTrackForSession = (trackRef) => {
    setSessionForm((prev) => {
      const current = prev.track_ids || [];
      const updated = current.includes(trackRef)
        ? current.filter(id => id !== trackRef)
        : [...current, trackRef];
      return { ...prev, track_ids: updated };
    });
  };

  const selectedSessionSpeakers = useMemo(() => {
    return speakers.filter(s => (sessionForm.speaker_ids || []).includes(s.id));
  }, [speakers, sessionForm.speaker_ids]);

  const addTicketClass = () => {
    const newTicket = createEmptyTicketClass(ticketClasses.length === 0, defaultVatRate);
    setTicketClasses(prev => [...prev, newTicket]);
    setExpandedTickets(prev => ({ ...prev, [newTicket._localId]: true }));
  };

  const removeTicketClass = (localId) => {
    setTicketClasses(prev => prev.filter(t => t._localId !== localId));
  };

  const updateTicketClass = (localId, field, value) => {
    setTicketClasses(prev => prev.map(t =>
      t._localId === localId ? { ...t, [field]: value } : t
    ));
  };

  const setTicketFree = (localId, isFree) => {
    setTicketClasses(prev => prev.map(t =>
      t._localId === localId ? { ...t, is_free: isFree, price: isFree ? '0' : t.price } : t
    ));
  };

  const toggleRoleForTicket = (localId, roleId) => {
    setTicketClasses(prev => prev.map(t => {
      if (t._localId !== localId) return t;
      const currentRoles = t.role_ids || [];
      const newRoles = currentRoles.includes(roleId)
        ? currentRoles.filter(id => id !== roleId)
        : [...currentRoles, roleId];
      return { ...t, role_ids: newRoles };
    }));
  };

  const toggleExpandTicket = (localId) => {
    setExpandedTickets(prev => ({ ...prev, [localId]: !prev[localId] }));
  };

  const getRoleNames = (roleIds) => {
    if (!roleIds || roleIds.length === 0) return "All Roles";
    return roleIds.map(id => roles.find(r => r.id === id)?.name || 'Unknown').join(', ');
  };

  const moveTicketClass = (localId, direction) => {
    setTicketClasses(prev => {
      const idx = prev.findIndex(t => t._localId === localId);
      if (idx < 0) return prev;
      const newIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    });
  };

  const toggleTrackForTicket = (localId, trackId) => {
    setTicketClasses(prev => prev.map(t => {
      if (t._localId !== localId) return t;
      const current = t.linked_track_ids || [];
      const updated = current.includes(trackId)
        ? current.filter(id => id !== trackId)
        : [...current, trackId];
      return { ...t, linked_track_ids: updated };
    }));
  };

  const handleSave = async () => {
    if (!formData.title.trim()) {
      toast.error("Event title is required");
      return;
    }
    if (!formData.slug.trim()) {
      toast.error("Event slug is required");
      return;
    }
    if (slugError) {
      toast.error("Please fix the URL slug before saving");
      return;
    }

    setSaving(true);
    try {
      const eventPayload = {
        title: formData.title,
        slug: formData.slug,
        description: formData.description || null,
        summary: formData.summary || null,
        image_url: formData.image_url || null,
        image_focal_point: formData.image_focal_point || null,
        start_date: formData.start_date || null,
        end_date: formData.end_date || null,
        location: formData.location || null,
        status: formData.status,
        event_state: formData.event_state,
        timezone: formData.timezone,
        available_seats: formData.available_seats ? parseInt(formData.available_seats, 10) : null,
        internal_reference: formData.internal_reference || null,
        event_type: formData.event_type || null,
        registration_closes_at: formData.registration_closes_at || null,
        filter_tags: selectedFilterTags.length > 0
          ? selectedFilterTags.map(key => parseFilterTagKey(key).label)
          : null,
        seo_title: seoTitle || null,
        seo_description: seoDescription || null,
        program_tag: formData.program_tag || null,
      };

      let eventId;
      if (isEditMode) {
        await base44.entities.ComplexEvent.update(editId, eventPayload);
        eventId = editId;
      } else {
        const created = await base44.entities.ComplexEvent.create(eventPayload);
        eventId = created.id;
      }

      if (isEditMode) {
        const existingTrackIds = existingTracks.map((t) => t.id);
        const currentTrackDbIds = tracks.filter((t) => t.id).map((t) => t.id);
        const deletedTrackIds = existingTrackIds.filter((id) => !currentTrackDbIds.includes(id));
        for (const trackId of deletedTrackIds) {
          await base44.entities.ComplexEventTrack.delete(trackId);
        }
      }

      const trackIdMap = {};
      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        const trackPayload = {
          complex_event_id: eventId,
          name: track.name || "Untitled Track",
          description: track.description || null,
          colour: track.colour || null,
          display_order: ti,
        };

        let trackId;
        if (track.id) {
          await base44.entities.ComplexEventTrack.update(track.id, trackPayload);
          trackId = track.id;
        } else {
          const created = await base44.entities.ComplexEventTrack.create(trackPayload);
          trackId = created.id;
        }
        trackIdMap[track._localId] = trackId;
        if (track.id) trackIdMap[track.id] = trackId;
      }

      if (isEditMode) {
        const existingSessionIds = existingSessions.map((s) => s.id);
        const currentSessionDbIds = sessions.filter((s) => s.id).map((s) => s.id);
        const deletedSessionIds = existingSessionIds.filter(
          (id) => !currentSessionDbIds.includes(id)
        );
        for (const sid of deletedSessionIds) {
          const delResp = await fetch(`/api/complex-event-sessions/${sid}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          if (!delResp.ok) {
            console.error(`Failed to delete session ${sid}:`, delResp.status);
          }
        }
      }

      for (let si = 0; si < sessions.length; si++) {
        const session = sessions[si];
        const resolvedTrackIds = (session.track_ids || []).map(id => trackIdMap[id] || id);
        const sessionPayload = {
          complex_event_id: eventId,
          title: session.title || "Untitled Session",
          description: session.description || null,
          image_url: session.image_url || null,
          speaker_ids: session.speaker_ids || [],
          speaker_names: session.speaker_names || [],
          start_time: session.start_time || null,
          end_time: session.end_time || null,
          location: session.location || null,
          is_online: session.is_online || false,
          display_order: si,
          track_ids: resolvedTrackIds,
          timezone: formData.timezone,
        };

        if (session.id) {
          const resp = await fetch(`/api/complex-event-sessions/${session.id}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionPayload),
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to update session: ${session.title}`);
          }
        } else {
          const resp = await fetch('/api/complex-event-sessions', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sessionPayload),
          });
          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to create session: ${session.title}`);
          }
        }
      }

      if (isEditMode) {
        const existingDbIds = existingTicketClasses.map(tc => tc.id);
        const currentDbIds = ticketClasses.filter(t => t._dbId).map(t => t._dbId);
        const deletedIds = existingDbIds.filter(id => !currentDbIds.includes(id));
        for (const tcId of deletedIds) {
          await base44.entities.ComplexEventTicketClass.delete(tcId);
        }
      }

      for (let ti = 0; ti < ticketClasses.length; ti++) {
        const ticket = ticketClasses[ti];
        const tcPayload = {
          complex_event_id: eventId,
          name: ticket.name || "Standard Ticket",
          price: parseFloat(ticket.price) || 0,
          is_free: ticket.is_free || false,
          early_bird_enabled: ticket.early_bird_enabled || false,
          early_bird_price: ticket.early_bird_enabled && ticket.early_bird_price ? parseFloat(ticket.early_bird_price) : null,
          early_bird_deadline: ticket.early_bird_enabled && ticket.early_bird_deadline ? ticket.early_bird_deadline : null,
          is_group_ticket: ticket.is_group_ticket || false,
          group_size: ticket.is_group_ticket && ticket.group_size ? parseInt(ticket.group_size) : null,
          group_cutoff_date: ticket.is_group_ticket && ticket.group_cutoff_date ? ticket.group_cutoff_date : null,
          vat_rate_key: ticket.vat_rate_key || null,
          vat_rate_label: ticket.vat_rate_label || null,
          vat_rate_percentage: ticket.vat_rate_percentage || null,
          visibility_mode: ticket.visibility_mode || 'members_only',
          role_ids: ticket.role_ids || [],
          role_match_only: ticket.role_match_only || false,
          offer_type: ticket.offer_type || 'none',
          bogo_logic_type: ticket.offer_type === 'bogo' ? (ticket.bogo_logic_type || 'buy_x_get_y_free') : null,
          bogo_buy_quantity: ticket.offer_type === 'bogo' && ticket.bogo_buy_quantity ? parseInt(ticket.bogo_buy_quantity) : null,
          bogo_get_free_quantity: ticket.offer_type === 'bogo' && ticket.bogo_get_free_quantity ? parseInt(ticket.bogo_get_free_quantity) : null,
          bulk_discount_threshold: ticket.offer_type === 'bulk_discount' && ticket.bulk_discount_threshold ? parseInt(ticket.bulk_discount_threshold) : null,
          bulk_discount_percentage: ticket.offer_type === 'bulk_discount' && ticket.bulk_discount_percentage ? parseFloat(ticket.bulk_discount_percentage) : null,
          available_count: ticket.is_unlimited_tickets ? null : (ticket.available_count ? parseInt(ticket.available_count) : null),
          is_unlimited_tickets: ticket.is_unlimited_tickets !== false,
          linked_track_ids: ticket.all_tracks ? [] : (ticket.linked_track_ids || []).map(id => trackIdMap[id] || id),
          all_tracks: ticket.all_tracks !== false,
          display_order: ti,
        };

        if (ticket._dbId) {
          await base44.entities.ComplexEventTicketClass.update(ticket._dbId, tcPayload);
        } else {
          await base44.entities.ComplexEventTicketClass.create(tcPayload);
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEvent"] });
      queryClient.invalidateQueries({ queryKey: ["/api/entities/ComplexEventTicketClass"] });
      toast.success(isEditMode ? "Complex event updated" : "Complex event created");
      window.location.href = createPageUrl("ComplexEvents");
    } catch (err) {
      console.error("Save error:", err);
      toast.error("Failed to save: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  };

  if (isEditMode && (loadingEvent || loadingTracks || loadingSessions || loadingTicketClasses)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const sections = [
    { id: "details", label: "Event Details" },
    { id: "tracks", label: "Tracks & Sessions" },
    { id: "tickets", label: "Tickets" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => (window.location.href = createPageUrl("ComplexEvents"))}
              data-testid="button-back"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">
              {isEditMode ? "Edit Complex Event" : "Create Complex Event"}
            </h1>
          </div>
          <Button onClick={handleSave} disabled={saving} data-testid="button-save">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            {isEditMode ? "Save Changes" : "Create Event"}
          </Button>
        </div>

        <div className="flex gap-2 mb-6">
          {sections.map((s) => (
            <Button
              key={s.id}
              variant={activeSection === s.id ? "default" : "outline"}
              onClick={() => setActiveSection(s.id)}
              data-testid={`button-section-${s.id}`}
            >
              {s.label}
            </Button>
          ))}
        </div>

        {activeSection === "details" && (
          <>
            {/* Event Status Card — matches EditEvent */}
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Eye className="h-5 w-5 text-purple-600" />
                  Event Status
                </CardTitle>
                <CardDescription>Configure when and how members can access this event</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <Label className="text-sm font-medium mb-3 block">Event Timing</Label>
                  <p className="text-xs text-slate-500 mb-3">Determines whether dates are required for this event</p>
                  <RadioGroup
                    value={formData.status}
                    onValueChange={handleTimingChange}
                    className="grid grid-cols-2 gap-4"
                    data-testid="radio-event-timing"
                  >
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.status === 'published' ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="published" id="timing-published" data-testid="radio-timing-published" />
                      <Label htmlFor="timing-published" className="cursor-pointer flex-1">
                        <span className="font-medium">Scheduled</span>
                        <p className="text-xs text-slate-500">Event has confirmed dates</p>
                      </Label>
                    </div>
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.status === 'tbc' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="tbc" id="timing-tbc" data-testid="radio-timing-tbc" />
                      <Label htmlFor="timing-tbc" className="cursor-pointer flex-1">
                        <span className="font-medium">To Be Confirmed</span>
                        <p className="text-xs text-slate-500">Dates not yet set</p>
                      </Label>
                    </div>
                  </RadioGroup>
                  {formData.status === 'tbc' && (
                    <p className="mt-3 text-sm text-blue-600 bg-blue-50 p-2 rounded">
                      Dates will be shown as "To be confirmed" and Zoom webinar/meeting selection is optional.
                    </p>
                  )}
                </div>

                <div>
                  <Label className="text-sm font-medium mb-3 block">Event State</Label>
                  <p className="text-xs text-slate-500 mb-3">Controls visibility and whether members can register</p>
                  <RadioGroup
                    value={formData.event_state}
                    onValueChange={(v) => updateField("event_state", v)}
                    className="grid grid-cols-3 gap-4"
                    data-testid="radio-event-state"
                  >
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.event_state === 'active' ? 'border-green-500 bg-green-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="active" id="state-active" data-testid="radio-state-active" />
                      <Label htmlFor="state-active" className="cursor-pointer flex-1">
                        <span className="font-medium">Active</span>
                        <p className="text-xs text-slate-500">Visible, accepting registrations</p>
                      </Label>
                    </div>
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.event_state === 'draft' ? 'border-amber-500 bg-amber-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="draft" id="state-draft" data-testid="radio-state-draft" />
                      <Label htmlFor="state-draft" className="cursor-pointer flex-1">
                        <span className="font-medium">Draft</span>
                        <p className="text-xs text-slate-500">Hidden from members</p>
                      </Label>
                    </div>
                    <div className={`flex items-center space-x-2 p-3 rounded-lg border-2 cursor-pointer transition-colors ${formData.event_state === 'closed' ? 'border-red-500 bg-red-50' : 'border-slate-200 hover:border-slate-300'}`}>
                      <RadioGroupItem value="closed" id="state-closed" data-testid="radio-state-closed" />
                      <Label htmlFor="state-closed" className="cursor-pointer flex-1">
                        <span className="font-medium">Closed</span>
                        <p className="text-xs text-slate-500">Visible, registration closed</p>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </CardContent>
            </Card>

            {/* Event Details Card — matches EditEvent (minus Session Leaders & CTA Override) */}
            <Card className="border-slate-200 shadow-sm mb-6">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Calendar className="h-5 w-5 text-blue-600" />
                  Event Details
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Program vs One-off Toggle */}
                <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg">
                  <div className="space-y-0.5">
                    <Label htmlFor="program-toggle" className="text-base font-medium">
                      {isProgramEvent ? "Program Event" : "One-off Event"}
                    </Label>
                    <p className="text-sm text-slate-500">
                      {isProgramEvent
                        ? "Event is part of a program - requires program tickets to attend"
                        : "Standalone event - not linked to any program"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-sm ${!isProgramEvent ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                      One-off
                    </span>
                    <Switch
                      id="program-toggle"
                      checked={isProgramEvent}
                      onCheckedChange={(checked) => {
                        setIsProgramEvent(checked);
                        if (!checked) {
                          updateField('program_tag', '');
                        }
                      }}
                      data-testid="switch-program-toggle"
                    />
                    <span className={`text-sm ${isProgramEvent ? 'text-slate-900 font-medium' : 'text-slate-500'}`}>
                      Program
                    </span>
                  </div>
                </div>

                {isProgramEvent && (
                  <div className="space-y-2">
                    <Label htmlFor="program">Program *</Label>
                    <Select
                      value={formData.program_tag}
                      onValueChange={(value) => updateField('program_tag', value)}
                      disabled={loadingPrograms}
                      data-testid="select-program"
                    >
                      <SelectTrigger data-testid="select-program-trigger">
                        <SelectValue placeholder={loadingPrograms ? "Loading programs..." : "Select a program"} />
                      </SelectTrigger>
                      <SelectContent>
                        {programs.map((program) => (
                          <SelectItem
                            key={program.id}
                            value={program.program_tag || program.name}
                            data-testid={`select-program-${program.id}`}
                          >
                            {program.name || program.program_tag}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      The program determines ticket types that can be used for this event
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="title">Event Title *</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => updateField("title", e.target.value)}
                    placeholder="Enter event title"
                    required
                    data-testid="input-title"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="slug">URL Slug</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-500 whitespace-nowrap">/session-events/</span>
                    <Input
                      id="slug"
                      value={formData.slug}
                      onChange={(e) => {
                        setSlugManuallyEdited(true);
                        const value = e.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9-]/g, '');
                        updateField("slug", value);
                      }}
                      placeholder="my-event-name"
                      data-testid="input-slug"
                    />
                  </div>
                  {slugError && (
                    <p className="text-xs text-red-600" data-testid="text-slug-error">{slugError}</p>
                  )}
                  {checkingSlug && (
                    <p className="text-xs text-slate-400">Checking availability...</p>
                  )}
                  <p className="text-xs text-slate-500">
                    Friendly URL for sharing. Leave empty to use the default URL format.
                  </p>
                </div>

                <SEOSettings
                  seoTitle={seoTitle}
                  onSeoTitleChange={setSeoTitle}
                  seoDescription={seoDescription}
                  onSeoDescriptionChange={setSeoDescription}
                  defaultTitle={formData.title}
                  defaultDescription={formData.summary}
                />

                <div className="space-y-2">
                  <Label htmlFor="summary">Summary</Label>
                  <Textarea
                    id="summary"
                    value={formData.summary}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value.length <= summaryMaxLength) {
                        updateField("summary", value);
                      }
                    }}
                    placeholder={`Brief summary for event cards (max ${summaryMaxLength} characters)`}
                    className="resize-none"
                    rows={2}
                    data-testid="input-summary"
                  />
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Displayed on event cards and listings</span>
                    <span className={formData.summary.length >= summaryMaxLength - 10 ? 'text-amber-600' : ''}>
                      {formData.summary.length}/{summaryMaxLength}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Full Description</Label>
                  <div className="border rounded-md overflow-hidden" data-testid="input-description">
                    <ReactQuill
                      theme="snow"
                      value={formData.description || ''}
                      onChange={(val) => updateField("description", val)}
                      modules={QUILL_MODULES}
                      formats={QUILL_FORMATS}
                      placeholder="Describe the event..."
                      style={{ minHeight: '150px' }}
                    />
                  </div>
                </div>

                {/* Filter Tags */}
                {eventCategories.length > 0 && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Tag className="h-4 w-4 text-slate-500" />
                      Filter Tags
                    </Label>
                    <p className="text-xs text-slate-500 mb-2">
                      Select one or more filter values to help categorize this event.
                    </p>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className="w-full justify-between gap-2"
                          data-testid="filter-tags-trigger"
                        >
                          <div className="flex items-center gap-2">
                            <Tag className="w-4 h-4" />
                            {selectedFilterTags.length === 0 ? (
                              <span className="text-slate-500">Select filter tags...</span>
                            ) : selectedFilterTags.length === 1 ? (
                              <span className="truncate max-w-[200px]">{parseFilterTagKey(selectedFilterTags[0]).label}</span>
                            ) : (
                              <span>{selectedFilterTags.length} selected</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            {selectedFilterTags.length > 0 && (
                              <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                                {selectedFilterTags.length}
                              </Badge>
                            )}
                            <ChevronDown className="w-4 h-4 opacity-50" />
                          </div>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-72 p-0" align="start">
                        <div className="p-2 border-b border-slate-100">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-slate-700">Select filter tags</span>
                            {selectedFilterTags.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-slate-500 hover:text-slate-700"
                                onClick={() => setSelectedFilterTags([])}
                                data-testid="filter-tags-clear"
                              >
                                Clear all
                              </Button>
                            )}
                          </div>
                        </div>
                        <div className="max-h-[320px] overflow-y-auto p-1">
                          {eventCategories.map((category) => (
                            <div key={category.id} className="mb-2">
                              <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                                {category.name}
                              </div>
                              {category.subcategories.map((subcategory) => {
                                const tagKey = createFilterTagKey(category.id, subcategory);
                                const isSelected = selectedFilterTags.includes(tagKey);
                                return (
                                  <button
                                    key={tagKey}
                                    type="button"
                                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
                                      isSelected
                                        ? "bg-slate-100 text-slate-900 font-medium"
                                        : "text-slate-600 hover:bg-slate-50"
                                    }`}
                                    onClick={() => {
                                      if (isSelected) {
                                        setSelectedFilterTags(prev => prev.filter(t => t !== tagKey));
                                      } else {
                                        setSelectedFilterTags(prev => [...prev, tagKey]);
                                      }
                                    }}
                                    data-testid={`filter-tag-${subcategory}`}
                                  >
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                      isSelected ? "bg-primary border-primary" : "border-slate-300"
                                    }`}>
                                      {isSelected && <Check className="w-3 h-3 text-white" />}
                                    </div>
                                    <span className="truncate">{subcategory}</span>
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                    {selectedFilterTags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {selectedFilterTags.map((tagKey, idx) => (
                          <Badge
                            key={idx}
                            variant="secondary"
                            className="text-xs"
                          >
                            {parseFilterTagKey(tagKey).label}
                            <button
                              type="button"
                              className="ml-1 hover:text-slate-900"
                              onClick={() => setSelectedFilterTags(prev => prev.filter(t => t !== tagKey))}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="internal_reference">Internal Reference</Label>
                    <Input
                      id="internal_reference"
                      value={formData.internal_reference}
                      onChange={(e) => updateField("internal_reference", e.target.value)}
                      placeholder="e.g. PROJECT-123, Budget Code, etc."
                      data-testid="input-internal-reference"
                    />
                    <p className="text-xs text-slate-500">
                      For internal use only. Not shown to attendees but included on invoices.
                    </p>
                  </div>

                  {eventTypes.length > 0 && (
                    <div className="space-y-2">
                      <Label htmlFor="event_type">Event Type</Label>
                      <Select
                        value={formData.event_type || "_none"}
                        onValueChange={(val) => updateField("event_type", val === "_none" ? "" : val)}
                      >
                        <SelectTrigger id="event_type" data-testid="select-event-type">
                          <SelectValue placeholder="Select event type..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">None</SelectItem>
                          {eventTypes.map((type, idx) => {
                            const typeName = typeof type === 'string' ? type : type.name;
                            return (
                              <SelectItem key={idx} value={typeName}>{typeName}</SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">
                        Categorize this event by type (e.g., Workshop, Training).
                      </p>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="start_date">
                      Start Date & Time
                    </Label>
                    <Input
                      id="start_date"
                      type="datetime-local"
                      value={formData.start_date}
                      disabled
                      className="bg-slate-100 cursor-not-allowed"
                      data-testid="input-start-date"
                    />
                    <p className="text-xs text-slate-500">
                      {formData.status === 'tbc'
                        ? "Date disabled for TBC events"
                        : "Auto-populated from the earliest session across all tracks"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="end_date">End Date & Time</Label>
                    <Input
                      id="end_date"
                      type="datetime-local"
                      value={formData.end_date}
                      disabled
                      className="bg-slate-100 cursor-not-allowed"
                      data-testid="input-end-date"
                    />
                    <p className="text-xs text-slate-500">
                      {formData.status === 'tbc'
                        ? "Date disabled for TBC events"
                        : "Auto-populated from the latest session across all tracks"}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="location">Location</Label>
                    <Input
                      id="location"
                      value={formData.location}
                      onChange={(e) => updateField("location", e.target.value)}
                      placeholder="Venue or address"
                      data-testid="input-location"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="timezone">Event Timezone</Label>
                    <Select value={formData.timezone} onValueChange={(v) => updateField("timezone", v)}>
                      <SelectTrigger id="timezone" data-testid="select-timezone">
                        <SelectValue placeholder="Select timezone" />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONE_OPTIONS.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>
                            {tz.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Times will be displayed and stored in this timezone.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="registration_closes_at">Registration Closes On (Optional)</Label>
                  <Input
                    id="registration_closes_at"
                    type="datetime-local"
                    value={formData.registration_closes_at}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      if (newValue && formData.end_date && new Date(newValue) > new Date(formData.end_date)) {
                        toast.error('Registration close date cannot be after the event end date');
                        return;
                      }
                      updateField("registration_closes_at", newValue);
                    }}
                    max={formData.end_date || undefined}
                    disabled={formData.status === 'tbc'}
                    className={formData.status === 'tbc' ? "bg-slate-100 cursor-not-allowed" : ""}
                    data-testid="input-registration-closes-at"
                  />
                  <p className="text-xs text-slate-500">
                    If set, registration will automatically close at this time. Must be on or before the event end time.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="available_seats">Available Seats</Label>
                  <Input
                    id="available_seats"
                    type="number"
                    value={formData.available_seats}
                    onChange={(e) => updateField("available_seats", e.target.value)}
                    placeholder="Leave empty for unlimited"
                    data-testid="input-available-seats"
                  />
                </div>

                <EventImageUpload
                  value={formData.image_url}
                  onChange={(url) => updateField("image_url", url)}
                />

                {formData.image_url && (
                  <FocalPointPicker
                    imageUrl={formData.image_url}
                    focalPoint={formData.image_focal_point}
                    onChange={(point) => updateField('image_focal_point', point)}
                  />
                )}
              </CardContent>
            </Card>

          </>
        )}

        {activeSection === "tracks" && (
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Tracks</h2>
                  <p className="text-sm text-slate-500">
                    Define tracks to organise sessions by theme, room, or stream.
                  </p>
                </div>
                <Button onClick={addTrack} data-testid="button-add-track">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Track
                </Button>
              </div>

              {tracks.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-12">
                    <p className="text-slate-500 mb-2" data-testid="text-no-tracks">
                      No tracks yet
                    </p>
                    <p className="text-slate-400 text-sm mb-4">
                      Add tracks to organise sessions by theme, room, or stream.
                    </p>
                    <Button variant="outline" onClick={addTrack} data-testid="button-add-first-track">
                      <Plus className="w-4 h-4 mr-2" />
                      Add First Track
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                tracks.map((track, trackIdx) => (
                  <Card key={track._localId} data-testid={`card-track-${track._localId}`}>
                    <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div
                          className="w-4 h-4 rounded-full flex-shrink-0"
                          style={{ backgroundColor: track.colour || "#3B82F6" }}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setExpandedTracks((prev) => ({
                              ...prev,
                              [track._localId]: !prev[track._localId],
                            }))
                          }
                        >
                          {expandedTracks[track._localId] ? (
                            <ChevronUp className="w-4 h-4" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                        </Button>
                        <span className="font-semibold truncate">
                          {track.name || "Untitled Track"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={trackIdx === 0}
                          onClick={() => moveTrack(track._localId, -1)}
                          data-testid={`button-move-track-up-${track._localId}`}
                        >
                          <ChevronUp className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={trackIdx === tracks.length - 1}
                          onClick={() => moveTrack(track._localId, 1)}
                          data-testid={`button-move-track-down-${track._localId}`}
                        >
                          <ChevronDown className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeTrack(track._localId)}
                          data-testid={`button-remove-track-${track._localId}`}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    </CardHeader>

                    {expandedTracks[track._localId] && (
                      <CardContent className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-2">
                            <Label>Track Name *</Label>
                            <Input
                              value={track.name}
                              onChange={(e) => updateTrack(track._localId, "name", e.target.value)}
                              placeholder="e.g. Main Stage, Workshop Room A"
                              data-testid={`input-track-name-${track._localId}`}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Colour</Label>
                            <div className="flex flex-wrap gap-2">
                              {TRACK_COLOURS.map((c) => (
                                <button
                                  key={c}
                                  className={`w-7 h-7 rounded-full border-2 transition-all ${
                                    track.colour === c ? "border-slate-900 scale-110" : "border-transparent"
                                  }`}
                                  style={{ backgroundColor: c }}
                                  onClick={() => updateTrack(track._localId, "colour", c)}
                                  data-testid={`button-colour-${c}-${track._localId}`}
                                />
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>Track Description</Label>
                          <Textarea
                            value={track.description || ""}
                            onChange={(e) => updateTrack(track._localId, "description", e.target.value)}
                            placeholder="Describe this track..."
                            rows={2}
                            data-testid={`input-track-description-${track._localId}`}
                          />
                        </div>

                        {(() => {
                          const trackRef = track.id || track._localId;
                          const linkedSessions = sessions.filter(s => (s.track_ids || []).includes(trackRef));
                          if (linkedSessions.length === 0) return null;
                          return (
                            <div className="space-y-1.5" data-testid={`track-sessions-ref-${track._localId}`}>
                              <Label className="text-xs text-slate-400">Linked Sessions</Label>
                              <div className="space-y-1">
                                {linkedSessions.map(s => (
                                  <div key={s._localId} className="flex items-center gap-2 text-xs text-slate-500 px-2 py-1 rounded bg-slate-50">
                                    <span className="font-medium truncate">{s.title || 'Untitled'}</span>
                                    {s.start_time && (
                                      <span className="text-slate-400 flex-shrink-0">
                                        {new Date(s.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                      </CardContent>
                    )}
                  </Card>
                ))
              )}
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Sessions</h2>
                  <p className="text-sm text-slate-500">
                    Add sessions and assign them to one or more tracks.
                  </p>
                </div>
                <Button onClick={() => openSessionDialog()} data-testid="button-add-session">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Session
                </Button>
              </div>

              {sessions.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-12">
                    <p className="text-slate-500 mb-2" data-testid="text-no-sessions">
                      No sessions yet
                    </p>
                    <p className="text-slate-400 text-sm mb-4">
                      Add sessions and assign them to tracks.
                    </p>
                    <Button variant="outline" onClick={() => openSessionDialog()} data-testid="button-add-first-session">
                      <Plus className="w-4 h-4 mr-2" />
                      Add First Session
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {sessions.map((session, sessionIdx) => {
                    const sessionTrackNames = (session.track_ids || []).map(tid => {
                      const t = tracks.find(tr => (tr.id || tr._localId) === tid);
                      return t ? { name: t.name || "Untitled Track", colour: t.colour } : null;
                    }).filter(Boolean);

                    return (
                      <div
                        key={session._localId}
                        className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100"
                        data-testid={`session-item-${session._localId}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-sm text-slate-800 truncate">
                              {session.title || "Untitled Session"}
                            </span>
                            {session.is_online && (
                              <Badge variant="outline" className="text-xs">
                                <Monitor className="w-3 h-3 mr-1" />
                                Virtual
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mt-1">
                            {session.start_time && (
                              <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {new Date(session.start_time).toLocaleString(undefined, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                            )}
                            {session.location && (
                              <span className="flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {session.location}
                              </span>
                            )}
                            {(() => {
                              const sessionSpeakerNames = (session.speaker_ids || [])
                                .map(id => speakers.find(s => s.id === id)?.full_name)
                                .filter(Boolean);
                              const fallbackNames = sessionSpeakerNames.length > 0
                                ? sessionSpeakerNames
                                : session.speaker_names || [];
                              return fallbackNames.length > 0 ? (
                                <span className="flex items-center gap-1">
                                  <Mic className="w-3 h-3" />
                                  {fallbackNames.join(", ")}
                                </span>
                              ) : null;
                            })()}
                          </div>
                          {sessionTrackNames.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                              {sessionTrackNames.map((t, i) => (
                                <Badge key={i} variant="secondary" className="text-xs gap-1">
                                  <div
                                    className="w-2.5 h-2.5 rounded-full"
                                    style={{ backgroundColor: t.colour || "#94a3b8" }}
                                  />
                                  {t.name}
                                </Badge>
                              ))}
                            </div>
                          )}
                          {sessionTrackNames.length === 0 && (
                            <p className="text-xs text-amber-600 mt-1">No tracks assigned</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={sessionIdx === 0}
                            onClick={() => moveSession(session._localId, -1)}
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={sessionIdx === sessions.length - 1}
                            onClick={() => moveSession(session._localId, 1)}
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openSessionDialog(session)}
                            data-testid={`button-edit-session-${session._localId}`}
                          >
                            <Calendar className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => removeSession(session._localId)}
                            data-testid={`button-remove-session-${session._localId}`}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-500" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className={`space-y-6 ${activeSection !== 'tickets' ? 'hidden' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-semibold text-slate-800">Ticket Classes</h3>
          <Button onClick={addTicketClass} data-testid="button-add-ticket-class">
            <Plus className="w-4 h-4 mr-2" />
            Add Ticket Class
          </Button>
        </div>

        {ticketClasses.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-slate-500">
              <Ticket className="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p className="font-medium">No ticket classes yet</p>
              <p className="text-sm">Add ticket classes to allow registrations for this event</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {ticketClasses.map((ticket, idx) => (
              <Card key={ticket._localId}>
                <CardContent className="p-0">
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 p-4 cursor-pointer hover-elevate"
                    onClick={() => toggleExpandTicket(ticket._localId)}
                    data-testid={`ticket-header-${ticket._localId}`}
                  >
                    <div className="flex items-center gap-3">
                      <Ticket className="w-4 h-4 text-slate-400" />
                      <div>
                        <span className="font-medium text-slate-700">
                          {ticket.name || `Ticket ${idx + 1}`}
                        </span>
                        <span className="ml-2 text-sm text-slate-400">
                          {ticket.is_free ? 'Free' : ticket.price ? `£${ticket.price}` : 'No price set'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={ticket.visibility_mode !== 'members_only' ? 'default' : 'secondary'}>
                        {ticket.visibility_mode === 'members_and_public' ? 'Members & Public' : ticket.visibility_mode === 'public_only' ? 'Public Only' : 'Members Only'}
                      </Badge>
                      {!ticket.all_tracks && (
                        <Badge variant="outline">{ticket.linked_track_ids.length} track(s)</Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={idx === 0}
                        onClick={(e) => { e.stopPropagation(); moveTicketClass(ticket._localId, 'up'); }}
                        data-testid={`button-move-up-ticket-${ticket._localId}`}
                      >
                        <ChevronUp className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={idx === ticketClasses.length - 1}
                        onClick={(e) => { e.stopPropagation(); moveTicketClass(ticket._localId, 'down'); }}
                        data-testid={`button-move-down-ticket-${ticket._localId}`}
                      >
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); removeTicketClass(ticket._localId); }}
                        data-testid={`button-remove-ticket-${ticket._localId}`}
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    </div>
                  </div>

                  {expandedTickets[ticket._localId] && (
                    <div className="border-t p-4 space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label>Ticket Name</Label>
                          <Input
                            value={ticket.name}
                            onChange={(e) => updateTicketClass(ticket._localId, 'name', e.target.value)}
                            placeholder="e.g. Standard, VIP, Student"
                            data-testid={`input-ticket-name-${ticket._localId}`}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label>Visibility</Label>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            <div
                              className={`flex items-center gap-2 p-3 rounded-md border-2 cursor-pointer transition-colors ${
                                (ticket.visibility_mode || 'members_only') === 'members_only'
                                  ? 'border-blue-500 bg-blue-50' : 'border-slate-200'
                              }`}
                              onClick={() => updateTicketClass(ticket._localId, 'visibility_mode', 'members_only')}
                              data-testid={`visibility-members-only-${ticket._localId}`}
                            >
                              <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                                (ticket.visibility_mode || 'members_only') === 'members_only' ? 'border-blue-500' : 'border-slate-300'
                              }`}>
                                {(ticket.visibility_mode || 'members_only') === 'members_only' && (
                                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-medium">Members Only</p>
                                <p className="text-xs text-slate-500">Logged-in members only</p>
                              </div>
                            </div>
                            <div
                              className={`flex items-center gap-2 p-3 rounded-md border-2 cursor-pointer transition-colors ${
                                ticket.visibility_mode === 'members_and_public'
                                  ? 'border-blue-500 bg-blue-50' : 'border-slate-200'
                              }`}
                              onClick={() => updateTicketClass(ticket._localId, 'visibility_mode', 'members_and_public')}
                              data-testid={`visibility-members-and-public-${ticket._localId}`}
                            >
                              <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                                ticket.visibility_mode === 'members_and_public' ? 'border-blue-500' : 'border-slate-300'
                              }`}>
                                {ticket.visibility_mode === 'members_and_public' && (
                                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-medium">Members & Public</p>
                                <p className="text-xs text-slate-500">Both members and visitors</p>
                              </div>
                            </div>
                            <div
                              className={`flex items-center gap-2 p-3 rounded-md border-2 cursor-pointer transition-colors ${
                                ticket.visibility_mode === 'public_only'
                                  ? 'border-blue-500 bg-blue-50' : 'border-slate-200'
                              }`}
                              onClick={() => updateTicketClass(ticket._localId, 'visibility_mode', 'public_only')}
                              data-testid={`visibility-public-only-${ticket._localId}`}
                            >
                              <div className={`h-4 w-4 rounded-full border-2 flex items-center justify-center ${
                                ticket.visibility_mode === 'public_only' ? 'border-blue-500' : 'border-slate-300'
                              }`}>
                                {ticket.visibility_mode === 'public_only' && (
                                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                                )}
                              </div>
                              <div>
                                <p className="text-sm font-medium">Public Only</p>
                                <p className="text-xs text-slate-500">Non-logged in visitors only</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <Label>Price (£)</Label>
                          <div className="flex items-center gap-3">
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              value={ticket.is_free ? '0' : ticket.price}
                              onChange={(e) => updateTicketClass(ticket._localId, 'price', e.target.value)}
                              disabled={ticket.is_free}
                              className="flex-1"
                              data-testid={`input-ticket-price-${ticket._localId}`}
                            />
                            <div className="flex items-center gap-1.5">
                              <Switch
                                checked={ticket.is_free}
                                onCheckedChange={(val) => setTicketFree(ticket._localId, val)}
                                data-testid={`switch-free-${ticket._localId}`}
                              />
                              <Label className="text-sm">Free</Label>
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label>Availability</Label>
                          <div className="flex items-center gap-3">
                            <Input
                              type="number"
                              min="1"
                              value={ticket.is_unlimited_tickets ? '' : ticket.available_count}
                              onChange={(e) => updateTicketClass(ticket._localId, 'available_count', e.target.value)}
                              disabled={ticket.is_unlimited_tickets}
                              placeholder="Ticket limit"
                              className="flex-1"
                              data-testid={`input-ticket-count-${ticket._localId}`}
                            />
                            <div className="flex items-center gap-1.5">
                              <Switch
                                checked={ticket.is_unlimited_tickets}
                                onCheckedChange={(val) => {
                                  updateTicketClass(ticket._localId, 'is_unlimited_tickets', val);
                                  if (val) updateTicketClass(ticket._localId, 'available_count', '');
                                }}
                                data-testid={`switch-unlimited-${ticket._localId}`}
                              />
                              <Label className="text-sm">Unlimited</Label>
                            </div>
                          </div>
                        </div>
                      </div>

                      {availableVatRates.length > 0 && (
                        <div className="space-y-1.5">
                          <Label>VAT Rate</Label>
                          <Select
                            value={ticket.vat_rate_key || '_none'}
                            onValueChange={(val) => {
                              if (val === '_none') {
                                updateTicketClass(ticket._localId, 'vat_rate_key', null);
                                updateTicketClass(ticket._localId, 'vat_rate_label', null);
                                updateTicketClass(ticket._localId, 'vat_rate_percentage', null);
                              } else {
                                const rate = availableVatRates.find(r => r.taxType === val);
                                if (rate) {
                                  updateTicketClass(ticket._localId, 'vat_rate_key', rate.taxType);
                                  updateTicketClass(ticket._localId, 'vat_rate_label', rate.name);
                                  updateTicketClass(ticket._localId, 'vat_rate_percentage', rate.effectiveRate);
                                }
                              }
                            }}
                          >
                            <SelectTrigger data-testid={`select-vat-${ticket._localId}`}>
                              <SelectValue placeholder="No VAT" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="_none">No VAT</SelectItem>
                              {availableVatRates.map((rate) => (
                                <SelectItem key={rate.taxType} value={rate.taxType}>
                                  {rate.name} ({rate.effectiveRate}%)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <Label>Role Restrictions</Label>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="outline" className="w-full justify-start" data-testid={`button-roles-${ticket._localId}`}>
                              <Users className="w-4 h-4 mr-2" />
                              {getRoleNames(ticket.role_ids)}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-64 max-h-60 overflow-y-auto">
                            {roles.map((role) => (
                              <div
                                key={role.id}
                                className="flex items-center gap-2 p-1.5 cursor-pointer hover-elevate rounded"
                                onClick={() => toggleRoleForTicket(ticket._localId, role.id)}
                              >
                                <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                  (ticket.role_ids || []).includes(role.id) ? 'bg-blue-500 border-blue-500' : 'border-slate-300'
                                }`}>
                                  {(ticket.role_ids || []).includes(role.id) && <Check className="w-3 h-3 text-white" />}
                                </div>
                                <span className="text-sm">{role.name}</span>
                              </div>
                            ))}
                          </PopoverContent>
                        </Popover>
                        {(ticket.role_ids || []).length > 0 && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <Switch
                              checked={ticket.role_match_only}
                              onCheckedChange={(val) => updateTicketClass(ticket._localId, 'role_match_only', val)}
                              data-testid={`switch-role-match-${ticket._localId}`}
                            />
                            <Label className="text-sm text-slate-600">Only show to members with matching roles</Label>
                          </div>
                        )}
                      </div>

                      <div className="border rounded-md p-3 space-y-3">
                        <h5 className="font-medium text-sm text-slate-700">Track Access</h5>
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={ticket.all_tracks}
                            onCheckedChange={(val) => {
                              updateTicketClass(ticket._localId, 'all_tracks', val);
                              if (val) updateTicketClass(ticket._localId, 'linked_track_ids', []);
                            }}
                            data-testid={`switch-all-tracks-${ticket._localId}`}
                          />
                          <Label className="text-sm">Access to all tracks</Label>
                        </div>
                        {!ticket.all_tracks && (
                          <div className="space-y-1.5">
                            {tracks.length === 0 ? (
                              <p className="text-sm text-slate-400">No tracks created yet. Add tracks in the Tracks & Sessions tab.</p>
                            ) : (
                              tracks.map((track) => (
                                <div
                                  key={track._localId}
                                  className="flex items-center gap-2 p-1.5 cursor-pointer hover-elevate rounded"
                                  onClick={() => toggleTrackForTicket(ticket._localId, track.id || track._localId)}
                                >
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                                    (ticket.linked_track_ids || []).includes(track.id || track._localId) ? 'bg-blue-500 border-blue-500' : 'border-slate-300'
                                  }`}>
                                    {(ticket.linked_track_ids || []).includes(track.id || track._localId) && (
                                      <Check className="w-3 h-3 text-white" />
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {track.colour && (
                                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: track.colour }} />
                                    )}
                                    <span className="text-sm">{track.name || 'Untitled Track'}</span>
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      <div className="border rounded-md p-3 space-y-3">
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={ticket.early_bird_enabled}
                            onCheckedChange={(val) => updateTicketClass(ticket._localId, 'early_bird_enabled', val)}
                            data-testid={`switch-early-bird-${ticket._localId}`}
                          />
                          <Label className="text-sm font-medium text-slate-700">Early Bird Pricing</Label>
                        </div>
                        {ticket.early_bird_enabled && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-sm">Early Bird Price (£)</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={ticket.early_bird_price}
                                onChange={(e) => updateTicketClass(ticket._localId, 'early_bird_price', e.target.value)}
                                data-testid={`input-early-bird-price-${ticket._localId}`}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-sm">Deadline</Label>
                              <Input
                                type="datetime-local"
                                value={ticket.early_bird_deadline}
                                onChange={(e) => updateTicketClass(ticket._localId, 'early_bird_deadline', e.target.value)}
                                data-testid={`input-early-bird-deadline-${ticket._localId}`}
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="border rounded-md p-3 space-y-3">
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={ticket.is_group_ticket}
                            onCheckedChange={(val) => updateTicketClass(ticket._localId, 'is_group_ticket', val)}
                            data-testid={`switch-group-${ticket._localId}`}
                          />
                          <Label className="text-sm font-medium text-slate-700">Group Ticket</Label>
                        </div>
                        {ticket.is_group_ticket && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-sm">Group Size</Label>
                              <Input
                                type="number"
                                min="2"
                                value={ticket.group_size}
                                onChange={(e) => updateTicketClass(ticket._localId, 'group_size', e.target.value)}
                                data-testid={`input-group-size-${ticket._localId}`}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-sm">Cutoff Date</Label>
                              <Input
                                type="date"
                                value={ticket.group_cutoff_date}
                                onChange={(e) => updateTicketClass(ticket._localId, 'group_cutoff_date', e.target.value)}
                                data-testid={`input-group-cutoff-${ticket._localId}`}
                              />
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <Label>Special Offers</Label>
                        <RadioGroup
                          value={ticket.offer_type}
                          onValueChange={(val) => updateTicketClass(ticket._localId, 'offer_type', val)}
                          className="flex flex-wrap gap-3"
                        >
                          <div className="flex items-center gap-1.5">
                            <RadioGroupItem value="none" id={`offer-none-${ticket._localId}`} />
                            <Label htmlFor={`offer-none-${ticket._localId}`} className="text-sm">None</Label>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <RadioGroupItem value="bogo" id={`offer-bogo-${ticket._localId}`} />
                            <Label htmlFor={`offer-bogo-${ticket._localId}`} className="text-sm">BOGO</Label>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <RadioGroupItem value="bulk_discount" id={`offer-bulk-${ticket._localId}`} />
                            <Label htmlFor={`offer-bulk-${ticket._localId}`} className="text-sm">Bulk Discount</Label>
                          </div>
                        </RadioGroup>

                        {ticket.offer_type === 'bogo' && (
                          <div className="space-y-3 mt-2 p-3 bg-slate-50 rounded-md">
                            <RadioGroup
                              value={ticket.bogo_logic_type}
                              onValueChange={(value) => updateTicketClass(ticket._localId, 'bogo_logic_type', value)}
                            >
                              <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <RadioGroupItem value="buy_x_get_y_free" id={`bogo-logic-1-${ticket._localId}`} />
                                  <Label htmlFor={`bogo-logic-1-${ticket._localId}`} className="text-sm cursor-pointer">
                                    Buy X, Get Y Free
                                  </Label>
                                </div>
                                <div className="flex items-center gap-2">
                                  <RadioGroupItem value="enter_total_pay_less" id={`bogo-logic-2-${ticket._localId}`} />
                                  <Label htmlFor={`bogo-logic-2-${ticket._localId}`} className="text-sm cursor-pointer">
                                    Enter Total, Pay Less
                                  </Label>
                                </div>
                              </div>
                            </RadioGroup>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-sm">Buy Quantity</Label>
                              <Input
                                type="number"
                                min="1"
                                value={ticket.bogo_buy_quantity}
                                onChange={(e) => updateTicketClass(ticket._localId, 'bogo_buy_quantity', e.target.value)}
                                data-testid={`input-bogo-buy-${ticket._localId}`}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-sm">Get Free Quantity</Label>
                              <Input
                                type="number"
                                min="1"
                                value={ticket.bogo_get_free_quantity}
                                onChange={(e) => updateTicketClass(ticket._localId, 'bogo_get_free_quantity', e.target.value)}
                                data-testid={`input-bogo-free-${ticket._localId}`}
                              />
                            </div>
                          </div>
                          </div>
                        )}

                        {ticket.offer_type === 'bulk_discount' && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                            <div className="space-y-1.5">
                              <Label className="text-sm">Minimum Quantity</Label>
                              <Input
                                type="number"
                                min="2"
                                value={ticket.bulk_discount_threshold}
                                onChange={(e) => updateTicketClass(ticket._localId, 'bulk_discount_threshold', e.target.value)}
                                data-testid={`input-bulk-threshold-${ticket._localId}`}
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-sm">Discount %</Label>
                              <Input
                                type="number"
                                min="1"
                                max="100"
                                value={ticket.bulk_discount_percentage}
                                onChange={(e) => updateTicketClass(ticket._localId, 'bulk_discount_percentage', e.target.value)}
                                data-testid={`input-bulk-percentage-${ticket._localId}`}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={sessionDialogOpen} onOpenChange={() => closeSessionDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSession ? "Edit Session" : "Add Session"}</DialogTitle>
            <DialogDescription>
              {editingSession ? "Update the session details below." : "Fill in the session details below."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                value={sessionForm.title}
                onChange={(e) =>
                  setSessionForm((prev) => ({ ...prev, title: e.target.value }))
                }
                placeholder="Session title"
                data-testid="input-session-title"
              />
            </div>

            <div className="space-y-2">
              <Label>Tracks</Label>
              {tracks.length === 0 ? (
                <p className="text-sm text-slate-400">No tracks created yet. Add tracks first.</p>
              ) : (
                <div className="space-y-1.5">
                  {tracks.map((track) => {
                    const trackRef = track.id || track._localId;
                    const isSelected = (sessionForm.track_ids || []).includes(trackRef);
                    return (
                      <div
                        key={track._localId}
                        className="flex items-center gap-2 p-2 cursor-pointer hover-elevate rounded-md"
                        onClick={() => toggleTrackForSession(trackRef)}
                        data-testid={`session-track-toggle-${track._localId}`}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                          isSelected ? 'bg-blue-500 border-blue-500' : 'border-slate-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: track.colour || "#94a3b8" }}
                          />
                          <span className="text-sm">{track.name || "Untitled Track"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <ReactQuill
                theme="snow"
                value={sessionForm.description}
                onChange={(val) =>
                  setSessionForm((prev) => ({ ...prev, description: val }))
                }
                modules={QUILL_MODULES}
                formats={QUILL_FORMATS}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Start Time</Label>
                <Input
                  type="datetime-local"
                  value={sessionForm.start_time}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, start_time: e.target.value }))
                  }
                  data-testid="input-session-start-time"
                />
              </div>
              <div className="space-y-2">
                <Label>End Time</Label>
                <Input
                  type="datetime-local"
                  value={sessionForm.end_time}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, end_time: e.target.value }))
                  }
                  data-testid="input-session-end-time"
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Location</Label>
                <Input
                  value={sessionForm.location}
                  onChange={(e) =>
                    setSessionForm((prev) => ({ ...prev, location: e.target.value }))
                  }
                  placeholder='Physical address or "virtual"'
                  data-testid="input-session-location"
                />
              </div>
              <div className="space-y-2">
                <Label>Delivery Mode</Label>
                <div className="flex items-center gap-3 pt-2">
                  <Switch
                    checked={sessionForm.is_online}
                    onCheckedChange={(checked) =>
                      setSessionForm((prev) => ({ ...prev, is_online: checked }))
                    }
                    data-testid="switch-session-is-online"
                  />
                  <span className="text-sm text-slate-600">
                    {sessionForm.is_online ? "Virtual / Online" : "In-person"}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{speakerModuleName.plural}</Label>
              {selectedSessionSpeakers.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {selectedSessionSpeakers.map((speaker) => (
                    <Badge key={speaker.id} variant="secondary" className="gap-1.5">
                      {speaker.profile_photo_url ? (
                        <img src={speaker.profile_photo_url} alt="" className="w-5 h-5 rounded-full object-cover" />
                      ) : (
                        <Mic className="w-3.5 h-3.5" />
                      )}
                      {speaker.full_name}
                      <button
                        onClick={() =>
                          setSessionForm((prev) => ({
                            ...prev,
                            speaker_ids: prev.speaker_ids.filter((id) => id !== speaker.id),
                          }))
                        }
                        className="ml-0.5"
                        data-testid={`button-remove-session-speaker-${speaker.id}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => setSessionSpeakerModalOpen(true)}
                data-testid="button-select-session-speakers"
              >
                <Mic className="w-4 h-4 mr-2" />
                Select {speakerModuleName.plural}
              </Button>
              <SpeakerSelectionModal
                open={sessionSpeakerModalOpen}
                onOpenChange={setSessionSpeakerModalOpen}
                speakers={speakers}
                selectedSpeakerIds={sessionForm.speaker_ids || []}
                onConfirm={(ids) =>
                  setSessionForm((prev) => ({ ...prev, speaker_ids: ids }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label>Session Image</Label>
              <EventImageUpload
                imageUrl={sessionForm.image_url}
                onImageChange={(url) =>
                  setSessionForm((prev) => ({ ...prev, image_url: url }))
                }
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={closeSessionDialog} data-testid="button-cancel-session">
              Cancel
            </Button>
            <Button onClick={saveSession} data-testid="button-save-session">
              {editingSession ? "Update Session" : "Add Session"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
