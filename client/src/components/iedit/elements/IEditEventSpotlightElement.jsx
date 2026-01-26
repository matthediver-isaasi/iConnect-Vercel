import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useEventsData } from "@/hooks/useEventsData";
import DOMPurify from 'dompurify';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChevronDown, ChevronUp, Upload, X, Calendar, MapPin, Clock, Users, Ticket, Tag, ExternalLink } from "lucide-react";
import TypographyStyleSelector, { applyTypographyStyle, useTypographyStyles } from "../TypographyStyleSelector";
import AGCASButton from "../../ui/AGCASButton";
import { useIsMobile } from "@/hooks/use-mobile";
import { format, parseISO } from "date-fns";
import { createPageUrl } from "@/utils";
import { useSpeakerModuleName } from "@/hooks/useSpeakerModuleName";

const quillModules = {
  toolbar: [
    [{ 'header': [1, 2, 3, false] }],
    ['bold', 'italic', 'underline'],
    [{ 'list': 'ordered'}, { 'list': 'bullet' }],
    ['link'],
    ['clean']
  ]
};

const fontFamilies = [
  'Poppins',
  'Degular Medium', 
  'Degular Bold',
  'Degular Semibold',
  'Inter',
  'Arial',
  'Georgia',
  'Times New Roman'
];

const fontWeights = [
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' }
];

export default function IEditEventSpotlightElement({ content, variant, settings }) {
  const isMobile = useIsMobile();
  const { singular: speakerSingular, plural: speakerPlural } = useSpeakerModuleName();
  const { getStyleById } = useTypographyStyles();
  
  const {
    anchor,
    event_id,
    heading,
    subheading,
    additional_content,
    background_type = 'none',
    background_color = '#ffffff',
    gradient_start_color = '#3b82f6',
    gradient_end_color = '#8b5cf6',
    gradient_angle = 135,
    background_image_url,
    background_image_fit = 'cover',
    overlay_enabled = false,
    overlay_color = '#000000',
    overlay_opacity = 50,
    vertical_padding = 48,
    content_padding = 32,
    content_background_color,
    content_border_radius = 8,
    show_date = true,
    show_time = true,
    show_location = true,
    show_description = true,
    show_ticket_prices = true,
    show_speakers = true,
    show_cta_button = true,
    layout = 'card',
    button = {}
  } = content || {};

  const { data: event } = useQuery({
    queryKey: ['/api/public/event', event_id],
    queryFn: () => publicClient.getEvent(event_id),
    enabled: !!event_id
  });

  const eventViewUrl = event?.slug 
    ? `${createPageUrl('EventDetails')}?slug=${event.slug}` 
    : (event?.id ? `${createPageUrl('EventDetails')}?id=${event.id}` : null);
  const eventSpeakerIds = event?.speaker_ids || [];
  const needsRoles = !!event_id && !!event && show_ticket_prices;
  const needsSpeakers = !!event_id && !!event && show_speakers && eventSpeakerIds.length > 0;

  const { data: roles = [] } = useQuery({
    queryKey: ['/api/public/roles', { forEvent: event_id }],
    queryFn: () => publicClient.listRoles(),
    enabled: needsRoles,
    staleTime: 5 * 60 * 1000
  });

  const { data: speakers = [] } = useQuery({
    queryKey: ['/api/public/speakers', { forEvent: event_id, speakerIds: eventSpeakerIds }],
    queryFn: () => publicClient.listSpeakers(eventSpeakerIds),
    enabled: needsSpeakers,
    staleTime: 5 * 60 * 1000
  });

  const getBackgroundStyle = () => {
    if (background_type === 'color') {
      return { backgroundColor: background_color };
    }
    if (background_type === 'gradient') {
      return { 
        background: `linear-gradient(${gradient_angle}deg, ${gradient_start_color}, ${gradient_end_color})` 
      };
    }
    return {};
  };

  const hasBackground = background_type && background_type !== 'none';

  const getTextStyle = (prefix) => {
    const typographyStyleId = content?.[`${prefix}_typography_style_id`];
    const typographyStyle = getStyleById(typographyStyleId);
    
    const fontSize = typographyStyle?.font_size || content?.[`${prefix}_font_size`] || 16;
    const savedMobileFontSize = content?.[`${prefix}_font_size_mobile`];
    const effectiveMobileFontSize = typographyStyle?.font_size_mobile || savedMobileFontSize;
    
    return {
      fontFamily: typographyStyle?.font_family || content?.[`${prefix}_font_family`] || 'Poppins',
      fontWeight: typographyStyle?.font_weight || content?.[`${prefix}_font_weight`] || 400,
      fontSize: `${(isMobile && effectiveMobileFontSize) ? effectiveMobileFontSize : fontSize}px`,
      color: typographyStyle?.color || content?.[`${prefix}_color`] || '#1e293b',
      letterSpacing: `${typographyStyle?.letter_spacing ?? content?.[`${prefix}_letter_spacing`] ?? 0}px`,
      lineHeight: typographyStyle?.line_height || content?.[`${prefix}_line_height`] || 1.5
    };
  };

  const pricingConfig = useMemo(() => {
    if (!event?.pricing_config) return null;
    
    if (typeof event.pricing_config === 'string') {
      try {
        return JSON.parse(event.pricing_config);
      } catch (e) {
        return null;
      }
    }
    return event.pricing_config;
  }, [event]);

  const ticketClasses = useMemo(() => {
    if (!pricingConfig) return [];
    
    const rawTicketClasses = pricingConfig.ticket_classes;
    const ticketClassesArray = Array.isArray(rawTicketClasses) ? rawTicketClasses : [];
    
    if (ticketClassesArray.length === 0 && pricingConfig.ticket_price) {
      return [{
        id: 'default',
        name: 'Standard Ticket',
        price: Number(pricingConfig.ticket_price) || 0,
        role_ids: []
      }];
    }
    
    return ticketClassesArray.map(tc => ({
      id: tc.id || 'default',
      name: tc.name || 'Ticket',
      price: Number(tc.price) || 0,
      role_ids: Array.isArray(tc.role_ids) ? tc.role_ids : []
    }));
  }, [pricingConfig]);

  const getRoleNames = (roleIds) => {
    if (!roleIds || roleIds.length === 0) return 'All Members';
    const names = roleIds
      .map(id => roles.find(r => r.id === id)?.name)
      .filter(Boolean);
    return names.length > 0 ? names.join(', ') : 'All Members';
  };

  const eventSpeakers = useMemo(() => {
    if (!event?.speaker_ids || !Array.isArray(event.speaker_ids)) return [];
    return speakers.filter(s => event.speaker_ids.includes(s.id));
  }, [event, speakers]);

  const formatEventDate = (dateStr) => {
    if (!dateStr) return '';
    try {
      return format(parseISO(dateStr), 'EEEE, d MMMM yyyy');
    } catch {
      return dateStr;
    }
  };

  const formatEventTime = (startStr, endStr) => {
    if (!startStr) return '';
    try {
      const start = format(parseISO(startStr), 'h:mm a');
      if (endStr) {
        const end = format(parseISO(endStr), 'h:mm a');
        return `${start} - ${end}`;
      }
      return start;
    } catch {
      return '';
    }
  };

  if (!event_id) {
    return (
      <div className="bg-slate-100 border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
        <Ticket className="w-12 h-12 text-slate-400 mx-auto mb-3" />
        <p className="text-slate-500 font-medium">No event selected</p>
        <p className="text-slate-400 text-sm mt-1">Select an event in the editor to display its details</p>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="bg-slate-100 rounded-lg p-8 text-center">
        <div className="animate-pulse">
          <div className="h-6 bg-slate-200 rounded w-48 mx-auto mb-4"></div>
          <div className="h-4 bg-slate-200 rounded w-32 mx-auto"></div>
        </div>
      </div>
    );
  }

  return (
    <div 
      id={anchor || undefined}
      className="relative w-full"
      style={hasBackground && background_type !== 'image' ? getBackgroundStyle() : {}}
    >
      {background_type === 'image' && background_image_url && (
        <>
          <img 
            src={background_image_url} 
            alt="Background" 
            className="absolute inset-0 w-full h-full"
            style={{ objectFit: background_image_fit }}
          />
          {overlay_enabled && (
            <div 
              className="absolute inset-0" 
              style={{ 
                backgroundColor: overlay_color, 
                opacity: parseInt(overlay_opacity) / 100 
              }} 
            />
          )}
        </>
      )}

      <div 
        className="relative max-w-7xl mx-auto px-4"
        style={{ paddingTop: `${vertical_padding}px`, paddingBottom: `${vertical_padding}px` }}
      >
        {(heading || subheading) && (
          <div className="mb-8">
            {heading && (
              <h2 style={getTextStyle('heading')} className="m-0 mb-2">
                {heading}
              </h2>
            )}
            {subheading && (
              <div 
                style={getTextStyle('subheading')} 
                className="m-0 prose max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheading) }}
              />
            )}
          </div>
        )}

        <div 
          className="rounded-lg overflow-hidden"
          style={{
            backgroundColor: content_background_color || '#ffffff',
            padding: `${content_padding}px`,
            borderRadius: `${content_border_radius}px`,
            boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)'
          }}
        >
          <div className="grid md:grid-cols-3 gap-8">
            <div className="md:col-span-2 space-y-6">
              <div>
                <h3 className="text-2xl font-bold text-slate-900 mb-2">{event.title}</h3>
                {event.summary && (
                  <p className="text-slate-600 text-lg">{event.summary}</p>
                )}
              </div>

              <div className="flex flex-wrap gap-4">
                {show_date && event.start_date && (
                  <div className="flex items-center gap-2 text-slate-600">
                    <Calendar className="w-5 h-5 text-slate-400" />
                    <span>{formatEventDate(event.start_date)}</span>
                  </div>
                )}
                {show_time && event.start_date && (
                  <div className="flex items-center gap-2 text-slate-600">
                    <Clock className="w-5 h-5 text-slate-400" />
                    <span>{formatEventTime(event.start_date, event.end_date)}</span>
                  </div>
                )}
              </div>

              {show_location && event.location && (
                <div className="flex items-start gap-2 text-slate-600">
                  <MapPin className="w-5 h-5 text-slate-400 mt-0.5" />
                  <span>{event.location}</span>
                </div>
              )}

              {show_description && event.description && (
                <div 
                  className="prose max-w-none text-slate-600"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(event.description) }}
                />
              )}

              {show_speakers && eventSpeakers.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">
                    {eventSpeakers.length === 1 ? speakerSingular : speakerPlural}
                  </h4>
                  <div className="flex flex-wrap gap-4">
                    {eventSpeakers.map(speaker => (
                      <div key={speaker.id} className="flex items-center gap-3">
                        {speaker.profile_photo_url ? (
                          <img 
                            src={speaker.profile_photo_url} 
                            alt={speaker.full_name}
                            className="w-12 h-12 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-full bg-slate-200 flex items-center justify-center">
                            <Users className="w-6 h-6 text-slate-400" />
                          </div>
                        )}
                        <div>
                          <p className="font-medium text-slate-900">{speaker.full_name}</p>
                          {speaker.organization && (
                            <p className="text-sm text-slate-600">{speaker.organization}</p>
                          )}
                          {speaker.job_title && (
                            <p className="text-sm text-slate-500">{speaker.job_title}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {show_ticket_prices && ticketClasses.length > 0 && (
              <div className="md:col-span-1">
                <div className="bg-slate-50 rounded-lg p-5">
                  <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4 flex items-center gap-2">
                    <Ticket className="w-4 h-4" />
                    Ticket Prices
                  </h4>
                  <div className="space-y-4">
                    {ticketClasses.map((tc, index) => (
                      <div 
                        key={tc.id || index}
                        className="bg-white rounded-md p-4 border border-slate-200"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <span className="font-semibold text-slate-900">{tc.name}</span>
                          <span className="text-lg font-bold text-slate-900">
                            {tc.price === 0 ? 'Free' : `£${tc.price.toFixed(2)}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                          <Tag className="w-3 h-3" />
                          <span>{getRoleNames(tc.role_ids)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {additional_content && (
            <div 
              className="mt-6 pt-6 border-t border-slate-200 prose max-w-none"
              style={getTextStyle('additional_content')}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(additional_content) }}
            />
          )}

          {show_cta_button && eventViewUrl && (
            <div className="mt-8 flex justify-center">
              <AGCASButton
                text={button.text || 'View Event & Register'}
                link={eventViewUrl}
                buttonStyleId={button.button_style_id}
                customBgColor={button.custom_bg_color}
                customTextColor={button.custom_text_color}
                customBorderColor={button.custom_border_color}
                openInNewTab={button.open_in_new_tab}
                size={button.size || 'large'}
                showArrow={button.show_arrow !== false}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function IEditEventSpotlightElementEditor({ element, onChange }) {
  const content = element.content || {};
  const [expandedSections, setExpandedSections] = useState({
    event: true,
    content: false,
    display: false,
    button: false,
    background: false,
    layout: false,
    typography: false
  });
  const [buttonStyles, setButtonStyles] = useState([]);

  // Use hybrid hook - editors are always authenticated, so this will use base44
  const { data: events = [], isLoading: eventsLoading, error: eventsError } = useEventsData();

  useEffect(() => {
    const fetchStyles = async () => {
      try {
        const styles = await base44.entities.ButtonStyle.list() || [];
        setButtonStyles(styles.filter(s => s.is_active));
      } catch (error) {
        console.error('Failed to fetch button styles:', error);
      }
    };
    fetchStyles();
  }, []);

  const toggleSection = (section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const updateMultipleContent = (updates) => {
    onChange({ ...element, content: { ...content, ...updates } });
  };

  const updateButton = (key, value) => {
    const currentButton = content.button || {};
    updateContent('button', { ...currentButton, [key]: value });
  };

  const upcomingEvents = useMemo(() => {
    const now = new Date();
    return events.filter(e => {
      if (!e.start_date) return true;
      try {
        return new Date(e.start_date) >= now;
      } catch {
        return true;
      }
    });
  }, [events]);

  return (
    <div className="space-y-0 border border-slate-200 rounded-lg overflow-hidden">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., events-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-eventspotlight-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      <div className="border-b border-slate-200">
        <button
          onClick={() => toggleSection('event')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Event Selection</span>
          {expandedSections.event ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.event && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Select Event</Label>
              {eventsLoading ? (
                <div className="p-3 text-sm text-slate-500 bg-slate-50 rounded-md">
                  Loading events...
                </div>
              ) : eventsError ? (
                <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
                  Failed to load events. Please try again.
                </div>
              ) : events.length === 0 ? (
                <div className="p-3 text-sm text-slate-500 bg-slate-50 rounded-md">
                  No events found. Create an event first.
                </div>
              ) : upcomingEvents.length === 0 ? (
                <div className="p-3 text-sm text-slate-500 bg-slate-50 rounded-md">
                  No upcoming events found.
                </div>
              ) : (
                <select
                  value={content.event_id || ''}
                  onChange={(e) => updateContent('event_id', e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md"
                >
                  <option value="">Choose an event...</option>
                  {upcomingEvents.map(evt => (
                    <option key={evt.id} value={evt.id}>
                      {evt.title}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-slate-200">
        <button
          onClick={() => toggleSection('content')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Heading & Content</span>
          {expandedSections.content ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.content && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Heading</Label>
              <Input
                value={content.heading || ''}
                onChange={(e) => updateContent('heading', e.target.value)}
                placeholder="Section heading..."
              />
            </div>
            <div>
              <Label className="text-sm">Subheading</Label>
              <ReactQuill
                value={content.subheading || ''}
                onChange={(value) => updateContent('subheading', value)}
                modules={quillModules}
                className="bg-white"
              />
            </div>
            <div>
              <Label className="text-sm">Additional Content (below event details)</Label>
              <ReactQuill
                value={content.additional_content || ''}
                onChange={(value) => updateContent('additional_content', value)}
                modules={quillModules}
                className="bg-white"
              />
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-slate-200">
        <button
          onClick={() => toggleSection('display')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Display Options</span>
          {expandedSections.display ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.display && (
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-date"
                checked={content.show_date !== false}
                onChange={(e) => updateContent('show_date', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-date" className="cursor-pointer">Show Date</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-time"
                checked={content.show_time !== false}
                onChange={(e) => updateContent('show_time', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-time" className="cursor-pointer">Show Time</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-location"
                checked={content.show_location !== false}
                onChange={(e) => updateContent('show_location', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-location" className="cursor-pointer">Show Location</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-description"
                checked={content.show_description !== false}
                onChange={(e) => updateContent('show_description', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-description" className="cursor-pointer">Show Description</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-speakers"
                checked={content.show_speakers !== false}
                onChange={(e) => updateContent('show_speakers', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-speakers" className="cursor-pointer">Show Speakers</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-ticket-prices"
                checked={content.show_ticket_prices !== false}
                onChange={(e) => updateContent('show_ticket_prices', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-ticket-prices" className="cursor-pointer">Show Ticket Prices</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="show-cta-button"
                checked={content.show_cta_button !== false}
                onChange={(e) => updateContent('show_cta_button', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="show-cta-button" className="cursor-pointer">Show CTA Button</Label>
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-slate-200">
        <button
          onClick={() => toggleSection('button')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">CTA Button Settings</span>
          {expandedSections.button ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.button && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Button Text</Label>
              <Input
                value={content.button?.text || ''}
                onChange={(e) => updateButton('text', e.target.value)}
                placeholder="View Event & Register"
              />
              <p className="text-xs text-slate-500 mt-1">Leave empty to use default: "View Event & Register"</p>
            </div>

            <div>
              <Label className="text-sm">Button Style</Label>
              <Select
                value={content.button?.button_style_id || 'default'}
                onValueChange={(value) => updateButton('button_style_id', value === 'default' ? undefined : value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a style..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  {buttonStyles.map(style => (
                    <SelectItem key={style.id} value={style.id}>
                      {style.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-sm">Button Size</Label>
              <Select
                value={content.button?.size || 'large'}
                onValueChange={(value) => updateButton('size', value)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="large">Large</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="button-show-arrow"
                checked={content.button?.show_arrow !== false}
                onChange={(e) => updateButton('show_arrow', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="button-show-arrow" className="cursor-pointer">Show Arrow</Label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="button-new-tab"
                checked={content.button?.open_in_new_tab === true}
                onChange={(e) => updateButton('open_in_new_tab', e.target.checked)}
                className="w-4 h-4"
              />
              <Label htmlFor="button-new-tab" className="cursor-pointer">Open in New Tab</Label>
            </div>

            <div className="border-t border-slate-200 pt-4 mt-4">
              <Label className="text-sm font-medium">Custom Colors (optional)</Label>
              <div className="grid grid-cols-3 gap-3 mt-2">
                <div>
                  <Label className="text-xs">Background</Label>
                  <div className="flex gap-1">
                    <input
                      type="color"
                      value={content.button?.custom_bg_color || '#3b82f6'}
                      onChange={(e) => updateButton('custom_bg_color', e.target.value)}
                      className="w-10 h-8 rounded border border-slate-300"
                    />
                    <button
                      onClick={() => updateButton('custom_bg_color', undefined)}
                      className="text-xs text-slate-500 hover:text-slate-700"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Text</Label>
                  <div className="flex gap-1">
                    <input
                      type="color"
                      value={content.button?.custom_text_color || '#ffffff'}
                      onChange={(e) => updateButton('custom_text_color', e.target.value)}
                      className="w-10 h-8 rounded border border-slate-300"
                    />
                    <button
                      onClick={() => updateButton('custom_text_color', undefined)}
                      className="text-xs text-slate-500 hover:text-slate-700"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Border</Label>
                  <div className="flex gap-1">
                    <input
                      type="color"
                      value={content.button?.custom_border_color || '#3b82f6'}
                      onChange={(e) => updateButton('custom_border_color', e.target.value)}
                      className="w-10 h-8 rounded border border-slate-300"
                    />
                    <button
                      onClick={() => updateButton('custom_border_color', undefined)}
                      className="text-xs text-slate-500 hover:text-slate-700"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mt-4">
              <p className="text-sm text-blue-700">
                <ExternalLink className="w-4 h-4 inline mr-1" />
                The button will automatically link to the event's detail page where visitors can register.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-slate-200">
        <button
          onClick={() => toggleSection('background')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Background & Styling</span>
          {expandedSections.background ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.background && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Background Type</Label>
              <select
                value={content.background_type || 'none'}
                onChange={(e) => updateContent('background_type', e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-md"
              >
                <option value="none">None</option>
                <option value="color">Solid Color</option>
                <option value="gradient">Gradient</option>
                <option value="image">Image</option>
              </select>
            </div>

            {content.background_type === 'color' && (
              <div>
                <Label className="text-sm">Background Color</Label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={content.background_color || '#ffffff'}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="w-12 h-10 rounded border border-slate-300"
                  />
                  <Input
                    value={content.background_color || '#ffffff'}
                    onChange={(e) => updateContent('background_color', e.target.value)}
                    className="flex-1"
                  />
                </div>
              </div>
            )}

            {content.background_type === 'gradient' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-sm">Start Color</Label>
                    <div className="flex gap-2">
                      <input
                        type="color"
                        value={content.gradient_start_color || '#3b82f6'}
                        onChange={(e) => updateContent('gradient_start_color', e.target.value)}
                        className="w-12 h-10 rounded border border-slate-300"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-sm">End Color</Label>
                    <div className="flex gap-2">
                      <input
                        type="color"
                        value={content.gradient_end_color || '#8b5cf6'}
                        onChange={(e) => updateContent('gradient_end_color', e.target.value)}
                        className="w-12 h-10 rounded border border-slate-300"
                      />
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-sm">Gradient Angle: {content.gradient_angle || 135}°</Label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={content.gradient_angle || 135}
                    onChange={(e) => updateContent('gradient_angle', parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>
              </>
            )}

            {content.background_type === 'image' && (
              <>
                <div>
                  <Label className="text-sm">Background Image URL</Label>
                  <Input
                    value={content.background_image_url || ''}
                    onChange={(e) => updateContent('background_image_url', e.target.value)}
                    placeholder="https://..."
                  />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="overlay-enabled"
                    checked={content.overlay_enabled || false}
                    onChange={(e) => updateContent('overlay_enabled', e.target.checked)}
                    className="w-4 h-4"
                  />
                  <Label htmlFor="overlay-enabled" className="cursor-pointer">Enable Overlay</Label>
                </div>
                {content.overlay_enabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-sm">Overlay Color</Label>
                      <input
                        type="color"
                        value={content.overlay_color || '#000000'}
                        onChange={(e) => updateContent('overlay_color', e.target.value)}
                        className="w-full h-10 rounded border border-slate-300"
                      />
                    </div>
                    <div>
                      <Label className="text-sm">Overlay Opacity: {content.overlay_opacity || 50}%</Label>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={content.overlay_opacity || 50}
                        onChange={(e) => updateContent('overlay_opacity', parseInt(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <div>
              <Label className="text-sm">Content Card Background</Label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={content.content_background_color || '#ffffff'}
                  onChange={(e) => updateContent('content_background_color', e.target.value)}
                  className="w-12 h-10 rounded border border-slate-300"
                />
                <Input
                  value={content.content_background_color || '#ffffff'}
                  onChange={(e) => updateContent('content_background_color', e.target.value)}
                  className="flex-1"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-slate-200">
        <button
          onClick={() => toggleSection('layout')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Layout & Spacing</span>
          {expandedSections.layout ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.layout && (
          <div className="p-4 space-y-4">
            <div>
              <Label className="text-sm">Vertical Padding (px)</Label>
              <Input
                type="number"
                value={content.vertical_padding !== undefined ? content.vertical_padding : 48}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  updateContent('vertical_padding', isNaN(val) ? 0 : Math.max(0, val));
                }}
                min="0"
                max="200"
              />
            </div>
            <div>
              <Label className="text-sm">Content Padding (px)</Label>
              <Input
                type="number"
                value={content.content_padding !== undefined ? content.content_padding : 32}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  updateContent('content_padding', isNaN(val) ? 0 : Math.max(0, val));
                }}
                min="0"
                max="100"
              />
            </div>
            <div>
              <Label className="text-sm">Content Border Radius: {content.content_border_radius || 8}px</Label>
              <input
                type="range"
                min="0"
                max="32"
                value={content.content_border_radius || 8}
                onChange={(e) => updateContent('content_border_radius', parseInt(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>

      <div>
        <button
          onClick={() => toggleSection('typography')}
          className="w-full flex items-center justify-between p-3 bg-slate-100 hover:bg-slate-200 text-left"
        >
          <span className="font-semibold text-sm">Typography</span>
          {expandedSections.typography ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
        
        {expandedSections.typography && (
          <div className="p-4 space-y-6">
            <div className="border-b border-slate-200 pb-4">
              <Label className="text-sm font-semibold mb-2 block">Heading</Label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-slate-500">Font Family</Label>
                  <select
                    value={content.heading_font_family || 'Poppins'}
                    onChange={(e) => updateContent('heading_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-slate-500">Font Weight</Label>
                  <select
                    value={content.heading_font_weight || 700}
                    onChange={(e) => updateContent('heading_font_weight', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontWeights.map(w => (
                      <option key={w.value} value={w.value}>{w.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-slate-500">Font Size</Label>
                  <Input
                    type="number"
                    value={content.heading_font_size || 24}
                    onChange={(e) => updateContent('heading_font_size', parseInt(e.target.value))}
                    min="12"
                    max="72"
                  />
                </div>
                <div>
                  <Label className="text-xs text-slate-500">Color</Label>
                  <input
                    type="color"
                    value={content.heading_color || '#1e293b'}
                    onChange={(e) => updateContent('heading_color', e.target.value)}
                    className="w-full h-10 rounded border border-slate-300"
                  />
                </div>
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold mb-2 block">Subheading</Label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-slate-500">Font Family</Label>
                  <select
                    value={content.subheading_font_family || 'Poppins'}
                    onChange={(e) => updateContent('subheading_font_family', e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
                  >
                    {fontFamilies.map(font => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-xs text-slate-500">Font Size</Label>
                  <Input
                    type="number"
                    value={content.subheading_font_size || 16}
                    onChange={(e) => updateContent('subheading_font_size', parseInt(e.target.value))}
                    min="12"
                    max="48"
                  />
                </div>
                <div>
                  <Label className="text-xs text-slate-500">Color</Label>
                  <input
                    type="color"
                    value={content.subheading_color || '#475569'}
                    onChange={(e) => updateContent('subheading_color', e.target.value)}
                    className="w-full h-10 rounded border border-slate-300"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
