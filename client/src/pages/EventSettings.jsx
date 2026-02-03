
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Settings, Calendar, Clock, MapPin, Ticket, RefreshCw, Save, Image as ImageIcon, Upload, X, FileText, Plus, Trash2, Edit2, Tag } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";

export default function EventSettingsPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [cancellationDeadlineHours, setCancellationDeadlineHours] = useState(24);
  const [xeroInvoiceEnabled, setXeroInvoiceEnabled] = useState(false);
  const [xeroSalesAccountCode, setXeroSalesAccountCode] = useState("");
  const [xeroStripeBankAccountCode, setXeroStripeBankAccountCode] = useState("");
  const [xeroInvoiceStatus, setXeroInvoiceStatus] = useState("DRAFT");
  const [summaryMaxLength, setSummaryMaxLength] = useState(150);
  const [descriptionPreviewLines, setDescriptionPreviewLines] = useState(3);
  const [showEventSeats, setShowEventSeats] = useState(true);
  const [eventCardTitleClamp, setEventCardTitleClamp] = useState(true);
  const [showEventCardPrices, setShowEventCardPrices] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editingEventImage, setEditingEventImage] = useState(null);
  const [selectedImage, setSelectedImage] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [editingEventDescription, setEditingEventDescription] = useState("");
  const [editingEventPublicUrl, setEditingEventPublicUrl] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  
  const [editingProgram, setEditingProgram] = useState(null);
  const [selectedProgramImage, setSelectedProgramImage] = useState(null);
  const [programImagePreview, setProgramImagePreview] = useState(null);
  const [editingProgramDescription, setEditingProgramDescription] = useState("");
  const [editingOfferType, setEditingOfferType] = useState("none");
  const [editingBogoLogicType, setEditingBogoLogicType] = useState("buy_x_get_y_free");
  const [editingBogoBuyQty, setEditingBogoBuyQty] = useState("");
  const [editingBogoGetFreeQty, setEditingBogoGetFreeQty] = useState("");
  const [editingBulkThreshold, setEditingBulkThreshold] = useState("");
  const [editingBulkPercentage, setEditingBulkPercentage] = useState("");
  const [uploadingProgram, setUploadingProgram] = useState(false);
  
  const [creatingProgram, setCreatingProgram] = useState(false);
  const [newProgramName, setNewProgramName] = useState("");
  const [newProgramTag, setNewProgramTag] = useState("");
  const [newProgramPrice, setNewProgramPrice] = useState("");
  const [newProgramDescription, setNewProgramDescription] = useState("");
  const [newProgramImage, setNewProgramImage] = useState(null);
  const [newProgramImagePreview, setNewProgramImagePreview] = useState(null);
  const [newOfferType, setNewOfferType] = useState("none");
  const [newBogoLogicType, setNewBogoLogicType] = useState("buy_x_get_y_free");
  const [newBogoBuyQty, setNewBogoBuyQty] = useState("");
  const [newBogoGetFreeQty, setNewBogoGetFreeQty] = useState("");
  const [newBulkThreshold, setNewBulkThreshold] = useState("");
  const [newBulkPercentage, setNewBulkPercentage] = useState("");
  const [savingNewProgram, setSavingNewProgram] = useState(false);
  
  // Event Types state - now stores objects with {name, bgColor, textColor}
  const [eventTypes, setEventTypes] = useState([]);
  const [newEventType, setNewEventType] = useState("");
  const [newEventTypeBgColor, setNewEventTypeBgColor] = useState("#dcfce7"); // green-100
  const [newEventTypeTextColor, setNewEventTypeTextColor] = useState("#15803d"); // green-700
  const [editingEventTypeIndex, setEditingEventTypeIndex] = useState(null);
  const [editingEventTypeValue, setEditingEventTypeValue] = useState("");
  const [editingEventTypeBgColor, setEditingEventTypeBgColor] = useState("");
  const [editingEventTypeTextColor, setEditingEventTypeTextColor] = useState("");
  const [savingEventTypes, setSavingEventTypes] = useState(false);
  
  // CTA Button configuration
  const [ctaButtonStyle, setCtaButtonStyle] = useState("default"); // "default" or "gradient"
  const [ctaButtonLabel, setCtaButtonLabel] = useState("View Details");
  const [savingCtaConfig, setSavingCtaConfig] = useState(false);
  
  // Time format setting (12 or 24 hour)
  const [use24HourFormat, setUse24HourFormat] = useState(false);
  
  // Default VAT rate for ticket classes
  const [defaultVatRate, setDefaultVatRate] = useState(null); // Stores { taxType, name, effectiveRate }
  
  // Booking terms and conditions
  const [bookingTerms, setBookingTerms] = useState("");
  const [savingBookingTerms, setSavingBookingTerms] = useState(false);
  
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_EventSettings')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: events = [], isLoading: loadingEvents } = useQuery({
    queryKey: ['events'],
    queryFn: () => base44.entities.Event.list('-start_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: settings = [], isLoading: loadingSettings } = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => base44.entities.SystemSettings.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: programs = [], isLoading: loadingPrograms } = useQuery({
    queryKey: ['programs'],
    queryFn: () => base44.entities.Program.filter({ is_active: true }),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Load current setting values
  useEffect(() => {
    const deadlineSetting = settings.find(s => s.setting_key === 'cancellation_deadline_hours');
    if (deadlineSetting) {
      setCancellationDeadlineHours(parseInt(deadlineSetting.setting_value) || 0);
    }
    
    const xeroSetting = settings.find(s => s.setting_key === 'xero_invoice_enabled');
    if (xeroSetting) {
      setXeroInvoiceEnabled(xeroSetting.setting_value === 'true');
    }
    
    const xeroAccountSetting = settings.find(s => s.setting_key === 'xero_sales_account_code');
    if (xeroAccountSetting) {
      setXeroSalesAccountCode(xeroAccountSetting.setting_value || '');
    }
    
    const xeroStatusSetting = settings.find(s => s.setting_key === 'xero_invoice_status');
    if (xeroStatusSetting) {
      setXeroInvoiceStatus(xeroStatusSetting.setting_value || 'DRAFT');
    }
    
    const xeroStripeBankSetting = settings.find(s => s.setting_key === 'xero_stripe_bank_account_code');
    if (xeroStripeBankSetting) {
      setXeroStripeBankAccountCode(xeroStripeBankSetting.setting_value || '');
    }
    
    // Load event types - migrate old string format to new object format
    const eventTypesSetting = settings.find(s => s.setting_key === 'event_types');
    if (eventTypesSetting?.setting_value) {
      try {
        const parsed = JSON.parse(eventTypesSetting.setting_value);
        // Migrate old string format to new object format
        const migrated = parsed.map(type => {
          if (typeof type === 'string') {
            return {
              name: type,
              bgColor: '#dcfce7', // green-100
              textColor: '#15803d' // green-700
            };
          }
          return type;
        });
        setEventTypes(migrated);
      } catch (e) {
        console.error('Failed to parse event types:', e);
      }
    }
    
    // Load summary max length setting
    const summaryLengthSetting = settings.find(s => s.setting_key === 'event_summary_max_length');
    if (summaryLengthSetting) {
      setSummaryMaxLength(parseInt(summaryLengthSetting.setting_value) || 150);
    }
    
    // Load show event seats setting
    const showSeatsSetting = settings.find(s => s.setting_key === 'show_event_seats');
    if (showSeatsSetting) {
      setShowEventSeats(showSeatsSetting.setting_value === 'true');
    }
    
    // Load event card title clamp setting
    const titleClampSetting = settings.find(s => s.setting_key === 'event_card_title_clamp');
    if (titleClampSetting) {
      setEventCardTitleClamp(titleClampSetting.setting_value !== 'false');
    }
    
    // Load show event card prices setting
    const showPricesSetting = settings.find(s => s.setting_key === 'show_event_card_prices');
    if (showPricesSetting) {
      setShowEventCardPrices(showPricesSetting.setting_value === 'true');
    }
    
    // Load description preview lines setting
    const descPreviewLinesSetting = settings.find(s => s.setting_key === 'event_description_preview_lines');
    if (descPreviewLinesSetting) {
      setDescriptionPreviewLines(parseInt(descPreviewLinesSetting.setting_value) || 3);
    }
    
    // Load CTA button configuration
    const ctaButtonSetting = settings.find(s => s.setting_key === 'event_cta_button');
    if (ctaButtonSetting?.setting_value) {
      try {
        const ctaConfig = JSON.parse(ctaButtonSetting.setting_value);
        setCtaButtonStyle(ctaConfig.style || 'default');
        setCtaButtonLabel(ctaConfig.label || 'View Details');
      } catch (e) {
        console.error('Failed to parse CTA button config:', e);
      }
    }
    
    // Load default VAT rate for ticket classes
    const defaultVatSetting = settings.find(s => s.setting_key === 'event_default_vat_rate');
    if (defaultVatSetting?.setting_value) {
      try {
        setDefaultVatRate(JSON.parse(defaultVatSetting.setting_value));
      } catch (e) {
        console.error('Failed to parse default VAT rate:', e);
      }
    }
    
    // Load booking terms and conditions
    const bookingTermsSetting = settings.find(s => s.setting_key === 'event_booking_terms');
    if (bookingTermsSetting?.setting_value) {
      setBookingTerms(bookingTermsSetting.setting_value);
    }
    
    // Load time format setting (12 or 24 hour)
    const timeFormatSetting = settings.find(s => s.setting_key === 'event_time_format_24h');
    if (timeFormatSetting) {
      setUse24HourFormat(timeFormatSetting.setting_value === 'true');
    }
  }, [settings]);

  const syncEventsMutation = useMutation({
    mutationFn: () => base44.functions.invoke('syncBackstageEvents', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['events'] });
      toast.success('Events synced successfully');
    },
    onError: (error) => {
      toast.error('Failed to sync events: ' + error.message);
    }
  });

  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      // Save cancellation deadline setting
      const deadlineSetting = settings.find(s => s.setting_key === 'cancellation_deadline_hours');
      
      if (deadlineSetting) {
        await base44.entities.SystemSettings.update(deadlineSetting.id, {
          setting_value: cancellationDeadlineHours.toString(),
          description: 'Number of hours before event start that cancellations are allowed'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'cancellation_deadline_hours',
          setting_value: cancellationDeadlineHours.toString(),
          description: 'Number of hours before event start that cancellations are allowed'
        });
      }
      
      // Save Xero invoice setting
      const xeroSetting = settings.find(s => s.setting_key === 'xero_invoice_enabled');
      
      if (xeroSetting) {
        await base44.entities.SystemSettings.update(xeroSetting.id, {
          setting_value: xeroInvoiceEnabled.toString(),
          description: 'Enable or disable Xero invoice generation for program ticket purchases'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'xero_invoice_enabled',
          setting_value: xeroInvoiceEnabled.toString(),
          description: 'Enable or disable Xero invoice generation for program ticket purchases'
        });
      }
      
      // Save Xero sales account code
      const xeroAccountSetting = settings.find(s => s.setting_key === 'xero_sales_account_code');
      
      if (xeroAccountSetting) {
        await base44.entities.SystemSettings.update(xeroAccountSetting.id, {
          setting_value: xeroSalesAccountCode,
          description: 'Default Xero account code for event invoices'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'xero_sales_account_code',
          setting_value: xeroSalesAccountCode,
          description: 'Default Xero account code for event invoices'
        });
      }
      
      // Save Xero invoice status (DRAFT or AUTHORISED)
      const xeroStatusSetting = settings.find(s => s.setting_key === 'xero_invoice_status');
      
      if (xeroStatusSetting) {
        await base44.entities.SystemSettings.update(xeroStatusSetting.id, {
          setting_value: xeroInvoiceStatus,
          description: 'Default Xero invoice status - DRAFT or AUTHORISED (Live)'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'xero_invoice_status',
          setting_value: xeroInvoiceStatus,
          description: 'Default Xero invoice status - DRAFT or AUTHORISED (Live)'
        });
      }
      
      // Save Xero Stripe bank account code
      const xeroStripeBankSetting = settings.find(s => s.setting_key === 'xero_stripe_bank_account_code');
      
      if (xeroStripeBankSetting) {
        await base44.entities.SystemSettings.update(xeroStripeBankSetting.id, {
          setting_value: xeroStripeBankAccountCode,
          description: 'Xero bank account code for Stripe payments'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'xero_stripe_bank_account_code',
          setting_value: xeroStripeBankAccountCode,
          description: 'Xero bank account code for Stripe payments'
        });
      }
      
      // Save summary max length setting
      const summaryLengthSetting = settings.find(s => s.setting_key === 'event_summary_max_length');
      
      if (summaryLengthSetting) {
        await base44.entities.SystemSettings.update(summaryLengthSetting.id, {
          setting_value: summaryMaxLength.toString(),
          description: 'Maximum character length for event summaries'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_summary_max_length',
          setting_value: summaryMaxLength.toString(),
          description: 'Maximum character length for event summaries'
        });
      }
      
      // Save show event seats setting
      const showSeatsSetting = settings.find(s => s.setting_key === 'show_event_seats');
      
      if (showSeatsSetting) {
        await base44.entities.SystemSettings.update(showSeatsSetting.id, {
          setting_value: showEventSeats.toString(),
          description: 'Show available seats on event cards and details pages'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'show_event_seats',
          setting_value: showEventSeats.toString(),
          description: 'Show available seats on event cards and details pages'
        });
      }
      
      // Save description preview lines setting
      const descPreviewLinesSetting = settings.find(s => s.setting_key === 'event_description_preview_lines');
      
      if (descPreviewLinesSetting) {
        await base44.entities.SystemSettings.update(descPreviewLinesSetting.id, {
          setting_value: descriptionPreviewLines.toString(),
          description: 'Number of lines to show in event description preview before Show More'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_description_preview_lines',
          setting_value: descriptionPreviewLines.toString(),
          description: 'Number of lines to show in event description preview before Show More'
        });
      }
      
      // Save event card title clamp setting
      const titleClampSetting = settings.find(s => s.setting_key === 'event_card_title_clamp');
      
      if (titleClampSetting) {
        await base44.entities.SystemSettings.update(titleClampSetting.id, {
          setting_value: eventCardTitleClamp.toString(),
          description: 'Enable line clamping on event card titles'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_card_title_clamp',
          setting_value: eventCardTitleClamp.toString(),
          description: 'Enable line clamping on event card titles'
        });
      }
      
      // Save show event card prices setting
      const showPricesSetting = settings.find(s => s.setting_key === 'show_event_card_prices');
      
      if (showPricesSetting) {
        await base44.entities.SystemSettings.update(showPricesSetting.id, {
          setting_value: showEventCardPrices.toString(),
          description: 'Show ticket prices on event cards'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'show_event_card_prices',
          setting_value: showEventCardPrices.toString(),
          description: 'Show ticket prices on event cards'
        });
      }
      
      // Save default VAT rate setting
      const defaultVatSetting = settings.find(s => s.setting_key === 'event_default_vat_rate');
      const vatRateValue = defaultVatRate ? JSON.stringify(defaultVatRate) : '';
      
      if (defaultVatSetting) {
        await base44.entities.SystemSettings.update(defaultVatSetting.id, {
          setting_value: vatRateValue,
          description: 'Default VAT rate for new event ticket classes'
        });
      } else if (vatRateValue) {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_default_vat_rate',
          setting_value: vatRateValue,
          description: 'Default VAT rate for new event ticket classes'
        });
      }
      
      // Save time format setting (12 or 24 hour)
      const timeFormatSetting = settings.find(s => s.setting_key === 'event_time_format_24h');
      
      if (timeFormatSetting) {
        await base44.entities.SystemSettings.update(timeFormatSetting.id, {
          setting_value: use24HourFormat.toString(),
          description: 'Use 24-hour time format for event times'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_time_format_24h',
          setting_value: use24HourFormat.toString(),
          description: 'Use 24-hour time format for event times'
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      queryClient.invalidateQueries({ queryKey: ['public-system-settings'] });
      toast.success('Settings saved successfully');
    } catch (error) {
      toast.error('Failed to save settings: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSyncEvents = () => {
    syncEventsMutation.mutate();
  };

  // Event Types handlers
  const handleAddEventType = () => {
    const trimmedType = newEventType.trim();
    if (!trimmedType) {
      toast.error('Please enter an event type');
      return;
    }
    if (eventTypes.some(t => t.name === trimmedType)) {
      toast.error('This event type already exists');
      return;
    }
    setEventTypes([...eventTypes, {
      name: trimmedType,
      bgColor: newEventTypeBgColor,
      textColor: newEventTypeTextColor
    }]);
    setNewEventType("");
    setNewEventTypeBgColor("#dcfce7");
    setNewEventTypeTextColor("#15803d");
  };

  const handleRemoveEventType = (index) => {
    const updated = eventTypes.filter((_, i) => i !== index);
    setEventTypes(updated);
  };

  const handleStartEditEventType = (index) => {
    const eventType = eventTypes[index];
    setEditingEventTypeIndex(index);
    setEditingEventTypeValue(eventType.name);
    setEditingEventTypeBgColor(eventType.bgColor || '#dcfce7');
    setEditingEventTypeTextColor(eventType.textColor || '#15803d');
  };

  const handleSaveEditEventType = () => {
    const trimmedValue = editingEventTypeValue.trim();
    if (!trimmedValue) {
      toast.error('Event type cannot be empty');
      return;
    }
    if (eventTypes.some((t, i) => i !== editingEventTypeIndex && t.name === trimmedValue)) {
      toast.error('This event type already exists');
      return;
    }
    const updated = [...eventTypes];
    updated[editingEventTypeIndex] = {
      name: trimmedValue,
      bgColor: editingEventTypeBgColor,
      textColor: editingEventTypeTextColor
    };
    setEventTypes(updated);
    setEditingEventTypeIndex(null);
    setEditingEventTypeValue("");
    setEditingEventTypeBgColor("");
    setEditingEventTypeTextColor("");
  };

  const handleCancelEditEventType = () => {
    setEditingEventTypeIndex(null);
    setEditingEventTypeValue("");
    setEditingEventTypeBgColor("");
    setEditingEventTypeTextColor("");
  };

  const handleUpdateEventTypeColor = (index, colorType, value) => {
    const updated = [...eventTypes];
    updated[index] = { ...updated[index], [colorType]: value };
    setEventTypes(updated);
  };

  const handleSaveEventTypes = async () => {
    setSavingEventTypes(true);
    try {
      const eventTypesSetting = settings.find(s => s.setting_key === 'event_types');
      const value = JSON.stringify(eventTypes);
      
      if (eventTypesSetting) {
        await base44.entities.SystemSettings.update(eventTypesSetting.id, {
          setting_value: value
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_types',
          setting_value: value
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      toast.success('Event types saved successfully');
    } catch (error) {
      console.error('Failed to save event types:', error);
      toast.error('Failed to save event types: ' + (error.message || 'Unknown error'));
    } finally {
      setSavingEventTypes(false);
    }
  };

  // CTA Button configuration handler
  const handleSaveCtaConfig = async () => {
    setSavingCtaConfig(true);
    try {
      const ctaConfig = { style: ctaButtonStyle, label: ctaButtonLabel };
      const ctaButtonSetting = settings.find(s => s.setting_key === 'event_cta_button');
      const value = JSON.stringify(ctaConfig);
      
      if (ctaButtonSetting) {
        await base44.entities.SystemSettings.update(ctaButtonSetting.id, {
          setting_value: value
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_cta_button',
          setting_value: value
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      toast.success('CTA button configuration saved successfully');
    } catch (error) {
      console.error('Failed to save CTA button config:', error);
      toast.error('Failed to save CTA button config: ' + (error.message || 'Unknown error'));
    } finally {
      setSavingCtaConfig(false);
    }
  };

  // Booking terms and conditions handler
  const handleSaveBookingTerms = async () => {
    setSavingBookingTerms(true);
    try {
      const bookingTermsSetting = settings.find(s => s.setting_key === 'event_booking_terms');
      
      if (bookingTermsSetting) {
        await base44.entities.SystemSettings.update(bookingTermsSetting.id, {
          setting_value: bookingTerms,
          description: 'Terms and conditions displayed during event booking'
        });
      } else {
        await base44.entities.SystemSettings.create({
          setting_key: 'event_booking_terms',
          setting_value: bookingTerms,
          description: 'Terms and conditions displayed during event booking'
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      toast.success('Booking terms and conditions saved successfully');
    } catch (error) {
      console.error('Failed to save booking terms:', error);
      toast.error('Failed to save booking terms: ' + (error.message || 'Unknown error'));
    } finally {
      setSavingBookingTerms(false);
    }
  };

  const handleEditImage = (event) => {
    setEditingEventImage(event);
    setSelectedImage(null);
    setImagePreview(null);
    setEditingEventDescription(event.description || "");
    setEditingEventPublicUrl(event.backstage_public_url || ""); // Initialize public URL
  };

  const handleImageSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      setSelectedImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleImageUpload = async () => {
    if (!editingEventImage) return;
    
    // Check if there are any changes to save
    const hasImageChange = selectedImage !== null;
    const hasDescriptionChange = editingEventDescription !== (editingEventImage.description || "");
    const hasUrlChange = editingEventPublicUrl !== (editingEventImage.backstage_public_url || ""); // Check for URL change
    
    if (!hasImageChange && !hasDescriptionChange && !hasUrlChange) { // Update condition
      toast.error('No changes to save');
      return;
    }
    
    setUploadingImage(true);
    try {
      // Get user email from session storage
      const storedMember = localStorage.getItem('agcas_member');
      const memberInfo = storedMember ? JSON.parse(storedMember) : null;
      
      if (!memberInfo || !memberInfo.email) {
        throw new Error('User session not found. Please log in again.');
      }
      
      // Prepare payload
      const payload = {
        eventId: editingEventImage.id,
        userEmail: memberInfo.email,
        description: editingEventDescription,
        backstagePublicUrl: editingEventPublicUrl // Add public URL to payload
      };
      
      // If image is selected, convert to base64 and add to payload
      if (hasImageChange) {
        const reader = new FileReader();
        reader.readAsDataURL(selectedImage);
        
        await new Promise((resolve, reject) => {
          reader.onload = () => {
            payload.imageBase64 = reader.result;
            payload.fileName = selectedImage.name;
            resolve();
          };
          reader.onerror = () => {
            reject(new Error('Failed to read image file'));
          };
        });
      }
      
      // Use the Base44 SDK to invoke the function
      const response = await base44.functions.invoke('updateEventImage', payload);
      
      if (response.data && response.data.success) {
        queryClient.invalidateQueries({ queryKey: ['events'] });
        toast.success('Event updated successfully');
        setEditingEventImage(null);
        setSelectedImage(null);
        setImagePreview(null);
        setEditingEventDescription("");
        setEditingEventPublicUrl(""); // Reset public URL
      } else {
        throw new Error(response.data ? response.data.error : 'Failed to update event');
      }
      
    } catch (error) {
      console.error('Event update error:', error);
      toast.error('Failed to update event: ' + error.message);
    } finally {
      setUploadingImage(false);
    }
  };

  // Program editing handlers
  const handleEditProgram = (program) => {
    setEditingProgram(program);
    setSelectedProgramImage(null);
    setProgramImagePreview(null);
    setEditingProgramDescription(program.description || "");
    
    // Determine offer type based on existing data
    let offerType = program.offer_type || "none";
    if (!program.offer_type) {
      // Backward compatibility: infer from existing fields
      if (program.bogo_buy_quantity !== null && program.bogo_get_free_quantity !== null) {
        offerType = "bogo";
      } else if (program.bulk_discount_threshold !== null && program.bulk_discount_percentage !== null) {
        offerType = "bulk_discount";
      }
    }
    setEditingOfferType(offerType);
    
    // BOGO fields
    setEditingBogoLogicType(program.bogo_logic_type || "buy_x_get_y_free");
    setEditingBogoBuyQty(program.bogo_buy_quantity === null || program.bogo_buy_quantity === undefined ? "" : program.bogo_buy_quantity.toString());
    setEditingBogoGetFreeQty(program.bogo_get_free_quantity === null || program.bogo_get_free_quantity === undefined ? "" : program.bogo_get_free_quantity.toString());
    
    // Bulk discount fields
    setEditingBulkThreshold(program.bulk_discount_threshold === null || program.bulk_discount_threshold === undefined ? "" : program.bulk_discount_threshold.toString());
    setEditingBulkPercentage(program.bulk_discount_percentage === null || program.bulk_discount_percentage === undefined ? "" : program.bulk_discount_percentage.toString());
  };

  const handleProgramImageSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      setSelectedProgramImage(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setProgramImagePreview(reader.result);
      };
      reader.readAsDataURL(file);
    }
  };

  // Helper to build a comparable offer state object
  // `offerType` here is expected to be already correctly determined ("none", "bogo", "bulk_discount")
  const buildComparableOfferState = (
    offerType,
    bogoBuyQty,
    bogoGetFreeQty,
    bogoLogicType,
    bulkThreshold,
    bulkPercentage
  ) => {
    const state = {
      offerType: offerType,
      bogoBuyQuantity: null,
      bogoGetFreeQuantity: null,
      bogoLogicType: null,
      bulkDiscountThreshold: null,
      bulkDiscountPercentage: null,
    };

    if (offerType === "bogo") {
      state.bogoBuyQuantity = bogoBuyQty === "" || bogoBuyQty === null ? null : parseInt(bogoBuyQty);
      state.bogoGetFreeQuantity = bogoGetFreeQty === "" || bogoGetFreeQty === null ? null : parseInt(bogoGetFreeQty);
      state.bogoLogicType = bogoLogicType;
    } else if (offerType === "bulk_discount") {
      state.bulkDiscountThreshold = bulkThreshold === "" || bulkThreshold === null ? null : parseInt(bulkThreshold);
      state.bulkDiscountPercentage = bulkPercentage === "" || bulkPercentage === null ? null : parseFloat(bulkPercentage);
    }
    return state;
  };

  const handleProgramUpdate = async () => {
    if (!editingProgram) return;
    
    const hasImageChange = selectedProgramImage !== null;
    const hasDescriptionChange = editingProgramDescription !== (editingProgram.description || "");

    // Determine the 'current' effective offer type from the program data (with backward compatibility)
    let currentEffectiveOfferType = editingProgram.offer_type || "none";
    if (!editingProgram.offer_type) {
      if (editingProgram.bogo_buy_quantity !== null && editingProgram.bogo_get_free_quantity !== null) {
        currentEffectiveOfferType = "bogo";
      } else if (editingProgram.bulk_discount_threshold !== null && editingProgram.bulk_discount_percentage !== null) {
        currentEffectiveOfferType = "bulk_discount";
      }
    }

    // Build original state from `editingProgram` using actual stored values
    const originalOfferState = buildComparableOfferState(
      currentEffectiveOfferType,
      editingProgram.bogo_buy_quantity,
      editingProgram.bogo_get_free_quantity,
      editingProgram.bogo_logic_type,
      editingProgram.bulk_discount_threshold,
      editingProgram.bulk_discount_percentage
    );

    // Build proposed state from current dialog states (convert inputs to numbers/null for comparison)
    const proposedOfferState = buildComparableOfferState(
      editingOfferType,
      editingBogoBuyQty,
      editingBogoGetFreeQty,
      editingBogoLogicType,
      editingBulkThreshold,
      editingBulkPercentage
    );
    
    const hasOfferSettingsChange = JSON.stringify(originalOfferState) !== JSON.stringify(proposedOfferState);
    
    if (!hasImageChange && !hasDescriptionChange && !hasOfferSettingsChange) {
      toast.error('No changes to save');
      return;
    }
    
    // Validate offer-specific fields
    if (editingOfferType === "bogo") {
      if (!editingBogoBuyQty || !editingBogoGetFreeQty) {
        toast.error('Please enter both BOGO buy and free quantities');
        return;
      }
      const buyQty = parseInt(editingBogoBuyQty);
      const freeQty = parseInt(editingBogoGetFreeQty);
      if (isNaN(buyQty) || buyQty < 1 || isNaN(freeQty) || freeQty < 1) {
        toast.error('BOGO quantities must be positive integers');
        return;
      }
    }
    
    if (editingOfferType === "bulk_discount") {
      if (!editingBulkThreshold || !editingBulkPercentage) {
        toast.error('Please enter both bulk discount threshold and percentage');
        return;
      }
      const threshold = parseInt(editingBulkThreshold);
      const percentage = parseFloat(editingBulkPercentage);
      if (isNaN(threshold) || threshold < 2) {
        toast.error('Bulk discount threshold must be an integer of at least 2');
        return;
      }
      if (isNaN(percentage) || percentage < 0 || percentage > 100) {
        toast.error('Bulk discount percentage must be a number between 0 and 100');
        return;
      }
    }
    
    setUploadingProgram(true);
    try {
      // Get user email from session storage
      const storedMember = localStorage.getItem('agcas_member');
      const memberInfo = storedMember ? JSON.parse(storedMember) : null;
      
      if (!memberInfo || !memberInfo.email) {
        throw new Error('User session not found. Please log in again.');
      }
      
      // Prepare payload
      const payload = {
        programId: editingProgram.id,
        userEmail: memberInfo.email,
        description: editingProgramDescription,
        offerType: editingOfferType // Add offer type to payload
      };
      
      // Add offer-specific fields based on type, or clear if not applicable
      if (editingOfferType === "bogo") {
        payload.bogoBuyQuantity = parseInt(editingBogoBuyQty);
        payload.bogoGetFreeQuantity = parseInt(editingBogoGetFreeQty);
        payload.bogoLogicType = editingBogoLogicType;
        // Explicitly clear other offer types
        payload.bulkDiscountThreshold = null;
        payload.bulkDiscountPercentage = null;
      } else if (editingOfferType === "bulk_discount") {
        payload.bulkDiscountThreshold = parseInt(editingBulkThreshold);
        payload.bulkDiscountPercentage = parseFloat(editingBulkPercentage);
        // Explicitly clear other offer types
        payload.bogoBuyQuantity = null;
        payload.bogoGetFreeQuantity = null;
        payload.bogoLogicType = null;
      } else { // editingOfferType === "none"
        payload.bogoBuyQuantity = null;
        payload.bogoGetFreeQuantity = null;
        payload.bogoLogicType = null;
        payload.bulkDiscountThreshold = null;
        payload.bulkDiscountPercentage = null;
      }
      
      // If image is selected, convert to base64 and add to payload
      if (hasImageChange) {
        const reader = new FileReader();
        reader.readAsDataURL(selectedProgramImage);
        
        await new Promise((resolve, reject) => {
          reader.onload = () => {
            payload.imageBase64 = reader.result;
            payload.fileName = selectedProgramImage.name;
            resolve();
          };
          reader.onerror = () => {
            reject(new Error('Failed to read image file'));
          };
        });
      }
      
      // Use the Base44 SDK to invoke the function
      const response = await base44.functions.invoke('updateProgramDetails', payload);
      
      if (response.data && response.data.success) {
        queryClient.invalidateQueries({ queryKey: ['programs'] });
        toast.success('Program updated successfully');
        setEditingProgram(null);
        setSelectedProgramImage(null);
        setProgramImagePreview(null);
        setEditingProgramDescription("");
        setEditingOfferType("none"); // Reset all new states
        setEditingBogoLogicType("buy_x_get_y_free");
        setEditingBogoBuyQty("");
        setEditingBogoGetFreeQty("");
        setEditingBulkThreshold("");
        setEditingBulkPercentage("");
      } else {
        throw new Error(response.data ? response.data.error : 'Failed to update program');
      }
      
    } catch (error) {
      console.error('Program update error:', error);
      toast.error('Failed to update program: ' + error.message);
    } finally {
      setUploadingProgram(false);
    }
  };

  const handleNewProgramImageSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      setNewProgramImage(file);
      const reader = new FileReader();
      reader.onload = (e) => {
        setNewProgramImagePreview(e.target.result);
      };
      reader.readAsDataURL(file);
    }
  };

  const resetCreateProgramForm = () => {
    setCreatingProgram(false);
    setNewProgramName("");
    setNewProgramTag("");
    setNewProgramPrice("");
    setNewProgramDescription("");
    setNewProgramImage(null);
    setNewProgramImagePreview(null);
    setNewOfferType("none");
    setNewBogoLogicType("buy_x_get_y_free");
    setNewBogoBuyQty("");
    setNewBogoGetFreeQty("");
    setNewBulkThreshold("");
    setNewBulkPercentage("");
  };

  const handleCreateProgram = async () => {
    if (!newProgramName.trim()) {
      toast.error('Program name is required');
      return;
    }
    if (!newProgramTag.trim()) {
      toast.error('Program tag is required');
      return;
    }
    if (!newProgramPrice || parseFloat(newProgramPrice) < 0) {
      toast.error('Please enter a valid ticket price');
      return;
    }

    if (newOfferType === "bogo") {
      const buyQty = parseInt(newBogoBuyQty);
      const freeQty = parseInt(newBogoGetFreeQty);
      if (isNaN(buyQty) || buyQty < 1) {
        toast.error('BOGO buy quantity must be at least 1');
        return;
      }
      if (isNaN(freeQty) || freeQty < 1) {
        toast.error('BOGO free quantity must be at least 1');
        return;
      }
    }

    if (newOfferType === "bulk_discount") {
      const threshold = parseInt(newBulkThreshold);
      const percentage = parseFloat(newBulkPercentage);
      if (isNaN(threshold) || threshold < 2) {
        toast.error('Bulk discount threshold must be at least 2');
        return;
      }
      if (isNaN(percentage) || percentage < 0 || percentage > 100) {
        toast.error('Bulk discount percentage must be between 0 and 100');
        return;
      }
    }

    setSavingNewProgram(true);
    try {
      const programData = {
        name: newProgramName.trim(),
        program_tag: newProgramTag.trim(),
        program_ticket_price: parseFloat(newProgramPrice),
        description: newProgramDescription.trim() || null,
        is_active: true,
        offer_type: newOfferType,
      };

      if (newOfferType === "bogo") {
        programData.bogo_buy_quantity = parseInt(newBogoBuyQty);
        programData.bogo_get_free_quantity = parseInt(newBogoGetFreeQty);
        programData.bogo_logic_type = newBogoLogicType;
      } else if (newOfferType === "bulk_discount") {
        programData.bulk_discount_threshold = parseInt(newBulkThreshold);
        programData.bulk_discount_percentage = parseFloat(newBulkPercentage);
      }

      if (newProgramImage) {
        const reader = new FileReader();
        const imageBase64 = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(newProgramImage);
        });

        const storedMember = localStorage.getItem('agcas_member');
        const memberInfo = storedMember ? JSON.parse(storedMember) : null;
        
        if (memberInfo?.email) {
          const uploadResponse = await base44.functions.invoke('uploadProgramImage', {
            imageBase64,
            fileName: newProgramImage.name,
            userEmail: memberInfo.email,
          });
          
          if (uploadResponse.data?.imageUrl) {
            programData.image_url = uploadResponse.data.imageUrl;
          }
        }
      }

      await base44.entities.Program.create(programData);
      
      queryClient.invalidateQueries({ queryKey: ['programs'] });
      toast.success('Program created successfully');
      resetCreateProgramForm();
    } catch (error) {
      console.error('Create program error:', error);
      toast.error('Failed to create program: ' + error.message);
    } finally {
      setSavingNewProgram(false);
    }
  };

  const isLoading = loadingEvents || loadingSettings || loadingPrograms;

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Event Settings
            </h1>
            <p className="text-slate-600">
              Manage synced events and system configuration
            </p>
          </div>
          <Button 
            onClick={handleSyncEvents} 
            disabled={syncEventsMutation.isPending}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${syncEventsMutation.isPending ? 'animate-spin' : ''}`} />
            Sync Events
          </Button>
        </div>

        {/* Configuration Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-amber-600" />
              <CardTitle>Cancellation Settings</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="max-w-2xl space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cancellation-deadline">
                  Cancellation Deadline (Hours Before Event)
                </Label>
                <div className="flex items-center gap-4">
                  <Input
                    id="cancellation-deadline"
                    type="number"
                    min="0"
                    step="1"
                    value={cancellationDeadlineHours}
                    onChange={(e) => setCancellationDeadlineHours(parseInt(e.target.value) || 0)}
                    className="w-32"
                  />
                  <span className="text-sm text-slate-600">hours</span>
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    className="ml-auto"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save Settings
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  Members will not be able to cancel tickets within this timeframe before the event starts.
                  Set to 0 to allow cancellations up until the event start time.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Invoice Settings Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-green-600" />
              <CardTitle>Invoice Settings</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="max-w-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="xero-invoice-toggle">
                    Generate Xero Invoices
                  </Label>
                  <p className="text-xs text-slate-500">
                    When enabled, Xero invoices will be automatically generated for program ticket purchases.
                    Disable this during testing to avoid creating invoices in your accounting system.
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Switch
                    id="xero-invoice-toggle"
                    checked={xeroInvoiceEnabled}
                    onCheckedChange={setXeroInvoiceEnabled}
                    data-testid="switch-xero-invoice"
                  />
                </div>
              </div>
              
              {/* Default Xero Account Code */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-200">
                <div className="space-y-1">
                  <Label htmlFor="xero-account-code">
                    Default Xero Account Code
                  </Label>
                  <p className="text-xs text-slate-500">
                    The Xero account code to use for event invoice line items (e.g., 200 for Sales).
                    Check your Xero Chart of Accounts for valid codes.
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Input
                    id="xero-account-code"
                    type="text"
                    value={xeroSalesAccountCode}
                    onChange={(e) => setXeroSalesAccountCode(e.target.value)}
                    placeholder="e.g., 200"
                    className="w-32"
                    data-testid="input-xero-account-code"
                  />
                </div>
              </div>
              
              {/* Invoice Status (Draft vs Live) */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-200">
                <div className="space-y-1">
                  <Label htmlFor="xero-invoice-status">
                    Default Invoice Status
                  </Label>
                  <p className="text-xs text-slate-500">
                    Choose whether invoices are created as Draft (for review before approval) or Live (approved and ready to send).
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm ${xeroInvoiceStatus === 'DRAFT' ? 'font-medium' : 'text-slate-500'}`}>Draft</span>
                    <Switch
                      id="xero-invoice-status"
                      checked={xeroInvoiceStatus === 'AUTHORISED'}
                      onCheckedChange={(checked) => setXeroInvoiceStatus(checked ? 'AUTHORISED' : 'DRAFT')}
                      data-testid="switch-xero-invoice-status"
                    />
                    <span className={`text-sm ${xeroInvoiceStatus === 'AUTHORISED' ? 'font-medium' : 'text-slate-500'}`}>Live</span>
                  </div>
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    size="sm"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                </div>
              </div>
              
              {/* Stripe Bank Account Code */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-200">
                <div className="space-y-1">
                  <Label htmlFor="xero-stripe-bank-code">
                    Stripe Bank Account Code
                  </Label>
                  <p className="text-xs text-slate-500">
                    The Xero bank account code where Stripe payments are deposited.
                    Used when recording payments against invoices for Stripe transactions.
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Input
                    id="xero-stripe-bank-code"
                    type="text"
                    value={xeroStripeBankAccountCode}
                    onChange={(e) => setXeroStripeBankAccountCode(e.target.value)}
                    placeholder="e.g., 090"
                    className="w-32"
                    data-testid="input-xero-stripe-bank-code"
                  />
                </div>
              </div>
              
              {/* Default VAT Rate Setting */}
              <div className="pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="default-vat-rate">
                      Default VAT Rate for Ticket Classes
                    </Label>
                    <p className="text-xs text-slate-500">
                      This VAT rate will be automatically applied to new ticket classes when creating events.
                      Sync VAT rates from Xero in Admin Setup if none are available.
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <Select
                      value={defaultVatRate?.taxType || ""}
                      onValueChange={(value) => {
                        if (value === "none") {
                          setDefaultVatRate(null);
                        } else {
                          const vatRates = settings.find(s => s.setting_key === 'xero_vat_rates');
                          if (vatRates?.setting_value) {
                            try {
                              const parsed = JSON.parse(vatRates.setting_value);
                              const selectedRate = parsed.rates?.find(r => r.taxType === value);
                              if (selectedRate) {
                                setDefaultVatRate({
                                  taxType: selectedRate.taxType,
                                  name: selectedRate.name,
                                  effectiveRate: selectedRate.effectiveRate
                                });
                              }
                            } catch (e) {
                              console.error('Failed to parse VAT rates:', e);
                            }
                          }
                        }
                      }}
                    >
                      <SelectTrigger className="w-[220px]" data-testid="select-default-vat-rate">
                        <SelectValue placeholder="Select VAT rate..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No VAT / Tax Exempt</SelectItem>
                        {(() => {
                          const vatRates = settings.find(s => s.setting_key === 'xero_vat_rates');
                          if (vatRates?.setting_value) {
                            try {
                              const parsed = JSON.parse(vatRates.setting_value);
                              return parsed.rates?.map((rate) => (
                                <SelectItem key={rate.taxType} value={rate.taxType}>
                                  {rate.name} ({rate.effectiveRate}%)
                                </SelectItem>
                              ));
                            } catch (e) {
                              return null;
                            }
                          }
                          return null;
                        })()}
                      </SelectContent>
                    </Select>
                    <Button
                      onClick={handleSaveSettings}
                      disabled={isSaving}
                      size="sm"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      Save
                    </Button>
                  </div>
                </div>
                {defaultVatRate && (
                  <p className="text-xs text-green-600 mt-2">
                    Current default: {defaultVatRate.name} ({defaultVatRate.effectiveRate}%)
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Event Summary Settings Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-cyan-600" />
              <CardTitle>Event Summary Settings</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="max-w-2xl space-y-4">
              <div className="space-y-2">
                <Label htmlFor="summary-max-length">
                  Summary Maximum Character Length
                </Label>
                <div className="flex items-center gap-4">
                  <Input
                    id="summary-max-length"
                    type="number"
                    min="50"
                    max="500"
                    step="10"
                    value={summaryMaxLength}
                    onChange={(e) => setSummaryMaxLength(parseInt(e.target.value) || 150)}
                    className="w-32"
                    data-testid="input-summary-max-length"
                  />
                  <span className="text-sm text-slate-600">characters</span>
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    className="ml-auto"
                    data-testid="button-save-summary-settings"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save Settings
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  This limit applies when creating or editing events. The summary is displayed on event cards and listings.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Event Description Preview Settings */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-teal-600" />
              <CardTitle>Event Description Preview</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="max-w-2xl space-y-4">
              <div className="space-y-2">
                <Label htmlFor="description-preview-lines">
                  Lines to Show Before "Show More"
                </Label>
                <div className="flex items-center gap-4">
                  <Input
                    id="description-preview-lines"
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={descriptionPreviewLines}
                    onChange={(e) => setDescriptionPreviewLines(parseInt(e.target.value) || 3)}
                    className="w-32"
                    data-testid="input-description-preview-lines"
                  />
                  <span className="text-sm text-slate-600">lines</span>
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    className="ml-auto"
                    data-testid="button-save-description-preview-settings"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save Settings
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  On the event details page, the description will be truncated to this number of lines with a "Show more" button to reveal the rest.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Event Display Settings Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-purple-600" />
              <CardTitle>Event Display Settings</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="max-w-2xl space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
                <div className="space-y-1">
                  <Label htmlFor="show-event-seats" className="font-medium">
                    Enable Seat Visibility
                  </Label>
                  <p className="text-sm text-slate-500">
                    Master switch for seat counts. When OFF, seats are hidden everywhere. When ON, you can control visibility per event.
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Switch
                    id="show-event-seats"
                    checked={showEventSeats}
                    onCheckedChange={setShowEventSeats}
                    data-testid="switch-show-event-seats"
                  />
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    size="sm"
                    data-testid="button-save-display-settings"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                </div>
              </div>
              
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
                <div className="space-y-1">
                  <Label htmlFor="event-card-title-clamp" className="font-medium">
                    Limit Event Title Lines
                  </Label>
                  <p className="text-sm text-slate-500">
                    When ON, event titles on cards are limited to 2 lines. When OFF, the full title is displayed regardless of length.
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Switch
                    id="event-card-title-clamp"
                    checked={eventCardTitleClamp}
                    onCheckedChange={setEventCardTitleClamp}
                    data-testid="switch-event-card-title-clamp"
                  />
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    size="sm"
                    data-testid="button-save-title-clamp-settings"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                </div>
              </div>
              
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
                <div className="space-y-1">
                  <Label htmlFor="show-event-card-prices" className="font-medium">
                    Show Ticket Prices on Cards
                  </Label>
                  <p className="text-sm text-slate-500">
                    When ON, event cards display the cheapest ticket price (e.g., "£ Tickets from £10.00" or "Free to register").
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Switch
                    id="show-event-card-prices"
                    checked={showEventCardPrices}
                    onCheckedChange={setShowEventCardPrices}
                    data-testid="switch-show-event-card-prices"
                  />
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    size="sm"
                    data-testid="button-save-prices-settings"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Time Settings Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-cyan-600" />
              <CardTitle>Time Settings</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="max-w-2xl space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200">
                <div className="space-y-1">
                  <Label htmlFor="use-24-hour-format" className="font-medium">
                    Use 24-Hour Time Format
                  </Label>
                  <p className="text-sm text-slate-500">
                    When ON, times display in 24-hour format (e.g., 14:00). When OFF, times display in 12-hour format (e.g., 2:00 PM).
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <Switch
                    id="use-24-hour-format"
                    checked={use24HourFormat}
                    onCheckedChange={setUse24HourFormat}
                    data-testid="switch-use-24-hour-format"
                  />
                  <Button
                    onClick={handleSaveSettings}
                    disabled={isSaving}
                    size="sm"
                    data-testid="button-save-time-format-settings"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Event Types Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <Tag className="w-5 h-5 text-indigo-600" />
              <CardTitle>Event Types</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                Define event types (e.g., Workshop, Self-paced Training, Conference) that can be assigned to events. Each type has customizable badge colors.
              </p>
              
              {/* Add New Event Type */}
              <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
                <Label className="text-sm font-medium">Add New Event Type</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    placeholder="Enter event type name..."
                    value={newEventType}
                    onChange={(e) => setNewEventType(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAddEventType()}
                    className="flex-1 min-w-[200px]"
                    data-testid="input-new-event-type"
                  />
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <Label className="text-xs text-slate-500">Background:</Label>
                      <input
                        type="color"
                        value={newEventTypeBgColor}
                        onChange={(e) => setNewEventTypeBgColor(e.target.value)}
                        className="w-8 h-8 rounded border border-slate-300 cursor-pointer"
                        data-testid="input-new-event-type-bg-color"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Label className="text-xs text-slate-500">Text:</Label>
                      <input
                        type="color"
                        value={newEventTypeTextColor}
                        onChange={(e) => setNewEventTypeTextColor(e.target.value)}
                        className="w-8 h-8 rounded border border-slate-300 cursor-pointer"
                        data-testid="input-new-event-type-text-color"
                      />
                    </div>
                  </div>
                  {newEventType && (
                    <Badge 
                      style={{ backgroundColor: newEventTypeBgColor, color: newEventTypeTextColor }}
                      className="border-0"
                    >
                      {newEventType || 'Preview'}
                    </Badge>
                  )}
                  <Button
                    onClick={handleAddEventType}
                    variant="outline"
                    data-testid="button-add-event-type"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add
                  </Button>
                </div>
              </div>
              
              {/* Event Types List */}
              {eventTypes.length === 0 ? (
                <p className="text-sm text-slate-500 py-4">No event types defined yet. Add your first event type above.</p>
              ) : (
                <div className="space-y-2">
                  {eventTypes.map((type, index) => (
                    <div 
                      key={index} 
                      className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200"
                      data-testid={`event-type-item-${index}`}
                    >
                      {editingEventTypeIndex === index ? (
                        <div className="flex flex-wrap items-center gap-3 flex-1">
                          <Input
                            value={editingEventTypeValue}
                            onChange={(e) => setEditingEventTypeValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveEditEventType();
                              if (e.key === 'Escape') handleCancelEditEventType();
                            }}
                            className="flex-1 min-w-[150px]"
                            autoFocus
                            data-testid={`input-edit-event-type-${index}`}
                          />
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1">
                              <Label className="text-xs text-slate-500">Bg:</Label>
                              <input
                                type="color"
                                value={editingEventTypeBgColor}
                                onChange={(e) => setEditingEventTypeBgColor(e.target.value)}
                                className="w-8 h-8 rounded border border-slate-300 cursor-pointer"
                                data-testid={`input-edit-event-type-bg-color-${index}`}
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <Label className="text-xs text-slate-500">Text:</Label>
                              <input
                                type="color"
                                value={editingEventTypeTextColor}
                                onChange={(e) => setEditingEventTypeTextColor(e.target.value)}
                                className="w-8 h-8 rounded border border-slate-300 cursor-pointer"
                                data-testid={`input-edit-event-type-text-color-${index}`}
                              />
                            </div>
                          </div>
                          <Badge 
                            style={{ backgroundColor: editingEventTypeBgColor, color: editingEventTypeTextColor }}
                            className="border-0"
                          >
                            {editingEventTypeValue || 'Preview'}
                          </Badge>
                          <div className="flex items-center gap-1">
                            <Button
                              onClick={handleSaveEditEventType}
                              size="sm"
                              data-testid={`button-save-event-type-${index}`}
                            >
                              <Save className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={handleCancelEditEventType}
                              size="sm"
                              variant="outline"
                              data-testid={`button-cancel-edit-event-type-${index}`}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-3">
                            <Badge 
                              style={{ backgroundColor: type.bgColor || '#dcfce7', color: type.textColor || '#15803d' }}
                              className="border-0 shadow-sm"
                            >
                              {type.name}
                            </Badge>
                            <div className="flex items-center gap-2">
                              <div className="flex items-center gap-1">
                                <Label className="text-xs text-slate-500">Bg:</Label>
                                <input
                                  type="color"
                                  value={type.bgColor || '#dcfce7'}
                                  onChange={(e) => handleUpdateEventTypeColor(index, 'bgColor', e.target.value)}
                                  className="w-6 h-6 rounded border border-slate-300 cursor-pointer"
                                  data-testid={`input-event-type-bg-color-${index}`}
                                />
                              </div>
                              <div className="flex items-center gap-1">
                                <Label className="text-xs text-slate-500">Text:</Label>
                                <input
                                  type="color"
                                  value={type.textColor || '#15803d'}
                                  onChange={(e) => handleUpdateEventTypeColor(index, 'textColor', e.target.value)}
                                  className="w-6 h-6 rounded border border-slate-300 cursor-pointer"
                                  data-testid={`input-event-type-text-color-${index}`}
                                />
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              onClick={() => handleStartEditEventType(index)}
                              size="sm"
                              variant="ghost"
                              data-testid={`button-edit-event-type-${index}`}
                            >
                              <Edit2 className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={() => handleRemoveEventType(index)}
                              size="sm"
                              variant="ghost"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              data-testid={`button-remove-event-type-${index}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              
              <div className="pt-4 border-t border-slate-200">
                <Button
                  onClick={handleSaveEventTypes}
                  disabled={savingEventTypes}
                  data-testid="button-save-event-types"
                >
                  {savingEventTypes ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      Save Event Types
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* CTA Button Configuration Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-blue-600" />
              <CardTitle>Event Card CTA Button</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="max-w-2xl space-y-6">
              <p className="text-sm text-slate-600">
                Configure the appearance and label of the call-to-action button displayed on event cards.
              </p>
              
              {/* Button Style Selection */}
              <div className="space-y-3">
                <Label className="text-sm font-medium">Button Style</Label>
                <RadioGroup 
                  value={ctaButtonStyle} 
                  onValueChange={setCtaButtonStyle}
                  className="flex flex-col gap-3"
                >
                  <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
                    <RadioGroupItem value="default" id="cta-default" data-testid="radio-cta-default" />
                    <Label htmlFor="cta-default" className="flex-1 cursor-pointer">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">Default Button</p>
                          <p className="text-sm text-slate-500">Standard solid button with primary color</p>
                        </div>
                        <Button size="sm" className="pointer-events-none">
                          {ctaButtonLabel || 'View Details'}
                        </Button>
                      </div>
                    </Label>
                  </div>
                  <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
                    <RadioGroupItem value="gradient" id="cta-gradient" data-testid="radio-cta-gradient" />
                    <Label htmlFor="cta-gradient" className="flex-1 cursor-pointer">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">Gradient Button</p>
                          <p className="text-sm text-slate-500">Eye-catching gradient with animation</p>
                        </div>
                        <Button 
                          size="sm" 
                          className="pointer-events-none bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 hover:from-indigo-700 hover:via-purple-700 hover:to-pink-700 text-white shadow-lg"
                        >
                          {ctaButtonLabel || 'View Details'}
                        </Button>
                      </div>
                    </Label>
                  </div>
                </RadioGroup>
              </div>
              
              {/* Button Label */}
              <div className="space-y-2">
                <Label htmlFor="cta-label" className="text-sm font-medium">Button Label</Label>
                <Input
                  id="cta-label"
                  value={ctaButtonLabel}
                  onChange={(e) => setCtaButtonLabel(e.target.value)}
                  placeholder="View Details"
                  className="max-w-xs"
                  data-testid="input-cta-label"
                />
                <p className="text-xs text-slate-500">The text displayed on the button (e.g., "View Details", "Learn More", "Register Now")</p>
              </div>
              
              <div className="pt-4 border-t border-slate-200">
                <Button
                  onClick={handleSaveCtaConfig}
                  disabled={savingCtaConfig}
                  data-testid="button-save-cta-config"
                >
                  {savingCtaConfig ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      Save CTA Configuration
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Booking Terms and Conditions Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-600" />
              <CardTitle>Booking Terms and Conditions</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <p className="text-sm text-slate-600">
                Add terms and conditions that members must accept before confirming an event booking. 
                If left empty, no terms acceptance will be required.
              </p>
              
              <div className="space-y-2">
                <Label className="text-sm font-medium">Terms and Conditions Content</Label>
                <div className="border rounded-md">
                  <ReactQuill
                    value={bookingTerms}
                    onChange={setBookingTerms}
                    placeholder="Enter your booking terms and conditions here..."
                    theme="snow"
                    modules={{
                      toolbar: [
                        [{ 'header': [1, 2, 3, false] }],
                        ['bold', 'italic', 'underline'],
                        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                        ['link'],
                        ['clean']
                      ]
                    }}
                    style={{ minHeight: '200px' }}
                    data-testid="input-booking-terms"
                  />
                </div>
              </div>
              
              <div className="pt-4 border-t border-slate-200">
                <Button
                  onClick={handleSaveBookingTerms}
                  disabled={savingBookingTerms}
                  data-testid="button-save-booking-terms"
                >
                  {savingBookingTerms ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      Save Terms and Conditions
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Programs Section */}
        <Card className="border-slate-200 shadow-sm mb-8">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Ticket className="w-5 h-5 text-purple-600" />
                <CardTitle>Programs</CardTitle>
              </div>
              <Button
                onClick={() => setCreatingProgram(true)}
                className="bg-purple-600 hover:bg-purple-700"
                data-testid="button-create-program"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Program
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {programs.length === 0 ? (
              <p className="text-center text-slate-500 py-8">No active programs found</p>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {programs.map((program) => (
                  <Card key={program.id} className="border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                    {program.image_url && (
                      <div className="h-32 overflow-hidden bg-slate-100">
                        <img 
                          src={program.image_url} 
                          alt={program.name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}
                    <CardHeader className="border-b border-slate-200">
                      <CardTitle className="text-base">{program.name}</CardTitle>
                      {program.description && (
                        <p className="text-sm text-slate-600 line-clamp-2 mt-2">
                          {program.description}
                        </p>
                      )}
                    </CardHeader>
                    <CardContent className="pt-4">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleEditProgram(program)}
                        className="w-full"
                      >
                        <ImageIcon className="w-3 h-3 mr-2" />
                        Edit Program
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Event Edit Dialog */}
      <Dialog open={!!editingEventImage} onOpenChange={(open) => {
        if (!open) {
          setEditingEventImage(null);
          setSelectedImage(null);
          setImagePreview(null);
          setEditingEventDescription("");
          setEditingEventPublicUrl("");
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Event Details</DialogTitle>
          </DialogHeader>
          
          {editingEventImage && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-slate-900 mb-2">{editingEventImage.title}</h3>
                <p className="text-sm text-slate-600">
                  Update the image, description, and public event link
                </p>
              </div>

              {/* Current Image */}
              <div>
                <Label className="text-sm font-medium text-slate-700 mb-2 block">Current Image</Label>
                {editingEventImage.image_url ? (
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <img 
                      src={editingEventImage.image_url} 
                      alt="Current event image"
                      className="w-full h-48 object-cover"
                    />
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-lg p-8 text-center bg-slate-50">
                    <ImageIcon className="w-12 h-12 text-slate-300 mx-auto mb-2" />
                    <p className="text-sm text-slate-500">No image set</p>
                  </div>
                )}
              </div>

              {/* Image Preview */}
              {imagePreview && (
                <div>
                  <Label className="text-sm font-medium text-slate-700 mb-2 block">New Image Preview</Label>
                  <div className="border border-blue-200 rounded-lg overflow-hidden">
                    <img 
                      src={imagePreview} 
                      alt="Preview"
                      className="w-full h-48 object-cover"
                    />
                  </div>
                </div>
              )}

              {/* File Input */}
              <div>
                <Label htmlFor="image-upload" className="text-sm font-medium text-slate-700 mb-2 block">
                  Select New Image (Optional)
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="image-upload"
                    type="file"
                    accept="image/*"
                    onChange={handleImageSelect}
                    className="flex-1"
                  />
                  {selectedImage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setSelectedImage(null);
                        setImagePreview(null);
                      }}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Description Editor */}
              <div>
                <Label htmlFor="event-description" className="text-sm font-medium text-slate-700 mb-2 block">
                  Event Description
                </Label>
                <Textarea
                  id="event-description"
                  value={editingEventDescription}
                  onChange={(e) => setEditingEventDescription(e.target.value)}
                  placeholder="Enter event description..."
                  rows={6}
                  className="w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  This description will override the synced description from Backstage
                </p>
              </div>

              {/* Public Event URL */}
              <div>
                <Label htmlFor="event-public-url" className="text-sm font-medium text-slate-700 mb-2 block">
                  Public Event Page URL
                </Label>
                <Input
                  id="event-public-url"
                  type="url"
                  value={editingEventPublicUrl}
                  onChange={(e) => setEditingEventPublicUrl(e.target.value)}
                  placeholder="https://agcasevents.zohobackstage.eu/event/..."
                  className="w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Paste the public Backstage event link that attendees will use to view event details
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingEventImage(null);
                setSelectedImage(null);
                setImagePreview(null);
                setEditingEventDescription("");
                setEditingEventPublicUrl("");
              }}
              disabled={uploadingImage}
            >
              Cancel
            </Button>
            <Button
              onClick={handleImageUpload}
              disabled={uploadingImage}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {uploadingImage ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Program Edit Dialog */}
      <Dialog open={!!editingProgram} onOpenChange={(open) => {
        if (!open) {
          setEditingProgram(null);
          setSelectedProgramImage(null);
          setProgramImagePreview(null);
          setEditingProgramDescription("");
          setEditingOfferType("none"); // Reset new states
          setEditingBogoLogicType("buy_x_get_y_free");
          setEditingBogoBuyQty("");
          setEditingBogoGetFreeQty("");
          setEditingBulkThreshold("");
          setEditingBulkPercentage("");
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Program Details</DialogTitle>
          </DialogHeader>
          
          {editingProgram && (
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-slate-900 mb-2">{editingProgram.name}</h3>
                <p className="text-sm text-slate-600">
                  Update the image, description, and offer details for this program
                </p>
              </div>

              {/* Current Image */}
              <div>
                <Label className="text-sm font-medium text-slate-700 mb-2 block">Current Image</Label>
                {editingProgram.image_url ? (
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <img 
                      src={editingProgram.image_url} 
                      alt="Current program image"
                      className="w-full h-48 object-cover"
                    />
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-lg p-8 text-center bg-slate-50">
                    <ImageIcon className="w-12 h-12 text-slate-300 mx-auto mb-2" />
                    <p className="text-sm text-slate-500">No image set</p>
                  </div>
                )}
              </div>

              {/* Image Preview */}
              {programImagePreview && (
                <div>
                  <Label className="text-sm font-medium text-slate-700 mb-2 block">New Image Preview</Label>
                  <div className="border border-blue-200 rounded-lg overflow-hidden">
                    <img 
                      src={programImagePreview} 
                      alt="Preview"
                      className="w-full h-48 object-cover"
                    />
                  </div>
                </div>
              )}

              {/* File Input */}
              <div>
                <Label htmlFor="program-image-upload" className="text-sm font-medium text-slate-700 mb-2 block">
                  Select New Image (Optional)
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="program-image-upload"
                    type="file"
                    accept="image/*"
                    onChange={handleProgramImageSelect}
                    className="flex-1"
                  />
                  {selectedProgramImage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setSelectedProgramImage(null);
                        setProgramImagePreview(null);
                      }}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Description Editor */}
              <div>
                <Label htmlFor="program-description" className="text-sm font-medium text-slate-700 mb-2 block">
                  Program Description
                </Label>
                <Textarea
                  id="program-description"
                  value={editingProgramDescription}
                  onChange={(e) => setEditingProgramDescription(e.target.value)}
                  placeholder="Enter program description..."
                  rows={6}
                  className="w-full"
                />
                <p className="text-xs text-slate-500 mt-1">
                  This description will be displayed on the program cards
                </p>
              </div>

              {/* Offer Configuration */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
                <div>
                  <Label className="text-sm font-medium text-slate-700 mb-3 block">
                    Offer Type
                  </Label>
                  <RadioGroup value={editingOfferType} onValueChange={setEditingOfferType}>
                    <div className="space-y-3">
                      <div 
                        className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                          editingOfferType === 'none' 
                            ? 'border-blue-500 bg-blue-50' 
                            : 'border-slate-200 hover:bg-slate-100'
                        }`}
                        onClick={() => setEditingOfferType('none')}
                      >
                        <RadioGroupItem value="none" id="offer-none" className="mt-1" />
                        <div className="flex-1">
                          <Label htmlFor="offer-none" className="font-medium cursor-pointer">No Offer</Label>
                          <p className="text-xs text-slate-600 mt-1">
                            Standard pricing with no discounts
                          </p>
                        </div>
                      </div>

                      <div 
                        className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                          editingOfferType === 'bogo' 
                            ? 'border-blue-500 bg-blue-50' 
                            : 'border-slate-200 hover:bg-slate-100'
                        }`}
                        onClick={() => setEditingOfferType('bogo')}
                      >
                        <RadioGroupItem value="bogo" id="offer-bogo" className="mt-1" />
                        <div className="flex-1">
                          <Label htmlFor="offer-bogo" className="font-medium cursor-pointer">BOGO (Buy X Get Y Free)</Label>
                          <p className="text-xs text-slate-600 mt-1">
                            Customers receive free tickets with their purchase
                          </p>
                        </div>
                      </div>

                      <div 
                        className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                          editingOfferType === 'bulk_discount' 
                            ? 'border-blue-500 bg-blue-50' 
                            : 'border-slate-200 hover:bg-slate-100'
                        }`}
                        onClick={() => setEditingOfferType('bulk_discount')}
                      >
                        <RadioGroupItem value="bulk_discount" id="offer-bulk" className="mt-1" />
                        <div className="flex-1">
                          <Label htmlFor="offer-bulk" className="font-medium cursor-pointer">Bulk Discount</Label>
                          <p className="text-xs text-slate-600 mt-1">
                            Percentage discount when buying multiple tickets
                          </p>
                        </div>
                      </div>
                    </div>
                  </RadioGroup>
                </div>

                {/* BOGO Configuration */}
                {editingOfferType === 'bogo' && (
                  <div className="space-y-4 pt-4 border-t border-slate-300">
                    <div>
                      <Label className="text-sm font-medium text-slate-700 mb-2 block">
                        BOGO Configuration
                      </Label>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="bogo-buy-qty" className="text-xs text-slate-600 mb-1 block">
                            Buy Quantity
                          </Label>
                          <Input
                            id="bogo-buy-qty"
                            type="number"
                            min="1"
                            value={editingBogoBuyQty}
                            onChange={(e) => setEditingBogoBuyQty(e.target.value)}
                            placeholder="e.g., 4"
                          />
                        </div>
                        <div>
                          <Label htmlFor="bogo-free-qty" className="text-xs text-slate-600 mb-1 block">
                            Get Free Quantity
                          </Label>
                          <Input
                            id="bogo-free-qty"
                            type="number"
                            min="1"
                            value={editingBogoGetFreeQty}
                            onChange={(e) => setEditingBogoGetFreeQty(e.target.value)}
                            placeholder="e.g., 1"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <Label className="text-sm font-medium text-slate-700 mb-2 block">
                        BOGO Logic Type
                      </Label>
                      <RadioGroup value={editingBogoLogicType} onValueChange={setEditingBogoLogicType}>
                        <div className="space-y-2">
                          <div className="flex items-start gap-2">
                            <RadioGroupItem value="buy_x_get_y_free" id="logic-legacy" className="mt-1" />
                            <div className="flex-1">
                              <Label htmlFor="logic-legacy" className="text-sm cursor-pointer">
                                Buy X, Get Y Free (Legacy)
                              </Label>
                              <p className="text-xs text-slate-500 mt-0.5">
                                User enters {editingBogoBuyQty || 'X'} &rarr; Receives {editingBogoBuyQty && editingBogoGetFreeQty ? parseInt(editingBogoBuyQty) + parseInt(editingBogoGetFreeQty) : 'X+Y'} &rarr; Pays for {editingBogoBuyQty || 'X'}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-start gap-2">
                            <RadioGroupItem value="enter_total_pay_less" id="logic-new" className="mt-1" />
                            <div className="flex-1">
                              <Label htmlFor="logic-new" className="text-sm cursor-pointer">
                                Enter Total, Pay for Fewer
                              </Label>
                              <p className="text-xs text-slate-500 mt-0.5">
                                User enters {editingBogoBuyQty && editingBogoGetFreeQty ? parseInt(editingBogoBuyQty) + parseInt(editingBogoGetFreeQty) : 'X+Y'} &rarr; Receives {editingBogoBuyQty && editingBogoGetFreeQty ? parseInt(editingBogoBuyQty) + parseInt(editingBogoGetFreeQty) : 'X+Y'} &rarr; Pays for {editingBogoBuyQty || 'X'}
                              </p>
                            </div>
                          </div>
                        </div>
                      </RadioGroup>
                    </div>
                  </div>
                )}

                {/* Bulk Discount Configuration */}
                {editingOfferType === 'bulk_discount' && (
                  <div className="space-y-4 pt-4 border-t border-slate-300">
                    <div>
                      <Label className="text-sm font-medium text-slate-700 mb-2 block">
                        Bulk Discount Configuration
                      </Label>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="bulk-threshold" className="text-xs text-slate-600 mb-1 block">
                            Minimum Tickets
                          </Label>
                          <Input
                            id="bulk-threshold"
                            type="number"
                            min="2"
                            value={editingBulkThreshold}
                            onChange={(e) => setEditingBulkThreshold(e.target.value)}
                            placeholder="e.g., 10"
                          />
                        </div>
                        <div>
                          <Label htmlFor="bulk-percentage" className="text-xs text-slate-600 mb-1 block">
                            Discount %
                          </Label>
                          <Input
                            id="bulk-percentage"
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={editingBulkPercentage}
                            onChange={(e) => setEditingBulkPercentage(e.target.value)}
                            placeholder="e.g., 15"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-slate-500 mt-2">
                        {editingBulkThreshold && editingBulkPercentage 
                          ? `Customers buying ${editingBulkThreshold}+ tickets will receive ${editingBulkPercentage}% off`
                          : 'Enter values to see preview'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditingProgram(null);
                setSelectedProgramImage(null);
                setProgramImagePreview(null);
                setEditingProgramDescription("");
                setEditingOfferType("none");
                setEditingBogoLogicType("buy_x_get_y_free");
                setEditingBogoBuyQty("");
                setEditingBogoGetFreeQty("");
                setEditingBulkThreshold("");
                setEditingBulkPercentage("");
              }}
              disabled={uploadingProgram}
            >
              Cancel
            </Button>
            <Button
              onClick={handleProgramUpdate}
              disabled={uploadingProgram}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {uploadingProgram ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Changes
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Program Dialog */}
      <Dialog open={creatingProgram} onOpenChange={(open) => {
        if (!open) {
          resetCreateProgramForm();
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create New Program</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="new-program-name" className="text-sm font-medium text-slate-700 mb-2 block">
                  Program Name *
                </Label>
                <Input
                  id="new-program-name"
                  value={newProgramName}
                  onChange={(e) => setNewProgramName(e.target.value)}
                  placeholder="e.g., Annual Conference"
                  data-testid="input-new-program-name"
                />
              </div>
              <div>
                <Label htmlFor="new-program-tag" className="text-sm font-medium text-slate-700 mb-2 block">
                  Program Tag *
                </Label>
                <Input
                  id="new-program-tag"
                  value={newProgramTag}
                  onChange={(e) => setNewProgramTag(e.target.value)}
                  placeholder="e.g., CONF2025"
                  data-testid="input-new-program-tag"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Used to link events to this program
                </p>
              </div>
            </div>

            <div>
              <Label htmlFor="new-program-price" className="text-sm font-medium text-slate-700 mb-2 block">
                Ticket Price (£) *
              </Label>
              <Input
                id="new-program-price"
                type="number"
                min="0"
                step="0.01"
                value={newProgramPrice}
                onChange={(e) => setNewProgramPrice(e.target.value)}
                placeholder="0.00"
                className="w-40"
                data-testid="input-new-program-price"
              />
            </div>

            <div>
              <Label htmlFor="new-program-description" className="text-sm font-medium text-slate-700 mb-2 block">
                Description
              </Label>
              <Textarea
                id="new-program-description"
                value={newProgramDescription}
                onChange={(e) => setNewProgramDescription(e.target.value)}
                placeholder="Enter program description..."
                rows={4}
                className="w-full"
                data-testid="textarea-new-program-description"
              />
            </div>

            <div>
              <Label htmlFor="new-program-image" className="text-sm font-medium text-slate-700 mb-2 block">
                Program Image (Optional)
              </Label>
              {newProgramImagePreview && (
                <div className="mb-2 border border-blue-200 rounded-lg overflow-hidden">
                  <img 
                    src={newProgramImagePreview} 
                    alt="Preview"
                    className="w-full h-32 object-cover"
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <Input
                  id="new-program-image"
                  type="file"
                  accept="image/*"
                  onChange={handleNewProgramImageSelect}
                  className="flex-1"
                  data-testid="input-new-program-image"
                />
                {newProgramImage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setNewProgramImage(null);
                      setNewProgramImagePreview(null);
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            </div>

            {/* Offer Configuration */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
              <div>
                <Label className="text-sm font-medium text-slate-700 mb-3 block">
                  Offer Type
                </Label>
                <RadioGroup value={newOfferType} onValueChange={setNewOfferType}>
                  <div className="space-y-3">
                    <div 
                      className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        newOfferType === 'none' 
                          ? 'border-blue-500 bg-blue-50' 
                          : 'border-slate-200 hover:bg-slate-100'
                      }`}
                      onClick={() => setNewOfferType('none')}
                    >
                      <RadioGroupItem value="none" id="new-offer-none" className="mt-1" />
                      <div className="flex-1">
                        <Label htmlFor="new-offer-none" className="font-medium cursor-pointer">No Offer</Label>
                        <p className="text-xs text-slate-600 mt-1">
                          Standard pricing with no discounts
                        </p>
                      </div>
                    </div>

                    <div 
                      className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        newOfferType === 'bogo' 
                          ? 'border-blue-500 bg-blue-50' 
                          : 'border-slate-200 hover:bg-slate-100'
                      }`}
                      onClick={() => setNewOfferType('bogo')}
                    >
                      <RadioGroupItem value="bogo" id="new-offer-bogo" className="mt-1" />
                      <div className="flex-1">
                        <Label htmlFor="new-offer-bogo" className="font-medium cursor-pointer">BOGO (Buy X Get Y Free)</Label>
                        <p className="text-xs text-slate-600 mt-1">
                          Customers receive free tickets with their purchase
                        </p>
                      </div>
                    </div>

                    <div 
                      className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                        newOfferType === 'bulk_discount' 
                          ? 'border-blue-500 bg-blue-50' 
                          : 'border-slate-200 hover:bg-slate-100'
                      }`}
                      onClick={() => setNewOfferType('bulk_discount')}
                    >
                      <RadioGroupItem value="bulk_discount" id="new-offer-bulk" className="mt-1" />
                      <div className="flex-1">
                        <Label htmlFor="new-offer-bulk" className="font-medium cursor-pointer">Bulk Discount</Label>
                        <p className="text-xs text-slate-600 mt-1">
                          Percentage discount when buying multiple tickets
                        </p>
                      </div>
                    </div>
                  </div>
                </RadioGroup>
              </div>

              {/* BOGO Configuration */}
              {newOfferType === 'bogo' && (
                <div className="space-y-4 pt-4 border-t border-slate-300">
                  <div>
                    <Label className="text-sm font-medium text-slate-700 mb-2 block">
                      BOGO Configuration
                    </Label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="new-bogo-buy-qty" className="text-xs text-slate-600 mb-1 block">
                          Buy Quantity
                        </Label>
                        <Input
                          id="new-bogo-buy-qty"
                          type="number"
                          min="1"
                          value={newBogoBuyQty}
                          onChange={(e) => setNewBogoBuyQty(e.target.value)}
                          placeholder="e.g., 4"
                          data-testid="input-new-bogo-buy-qty"
                        />
                      </div>
                      <div>
                        <Label htmlFor="new-bogo-free-qty" className="text-xs text-slate-600 mb-1 block">
                          Get Free Quantity
                        </Label>
                        <Input
                          id="new-bogo-free-qty"
                          type="number"
                          min="1"
                          value={newBogoGetFreeQty}
                          onChange={(e) => setNewBogoGetFreeQty(e.target.value)}
                          placeholder="e.g., 1"
                          data-testid="input-new-bogo-free-qty"
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <Label className="text-sm font-medium text-slate-700 mb-2 block">
                      BOGO Logic Type
                    </Label>
                    <RadioGroup value={newBogoLogicType} onValueChange={setNewBogoLogicType}>
                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <RadioGroupItem value="buy_x_get_y_free" id="new-logic-legacy" className="mt-1" />
                          <div className="flex-1">
                            <Label htmlFor="new-logic-legacy" className="text-sm cursor-pointer">
                              Buy X, Get Y Free (Legacy)
                            </Label>
                            <p className="text-xs text-slate-500 mt-0.5">
                              User enters {newBogoBuyQty || 'X'} &rarr; Receives {newBogoBuyQty && newBogoGetFreeQty ? parseInt(newBogoBuyQty) + parseInt(newBogoGetFreeQty) : 'X+Y'} &rarr; Pays for {newBogoBuyQty || 'X'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-start gap-2">
                          <RadioGroupItem value="enter_total_pay_less" id="new-logic-new" className="mt-1" />
                          <div className="flex-1">
                            <Label htmlFor="new-logic-new" className="text-sm cursor-pointer">
                              Enter Total, Pay for Fewer
                            </Label>
                            <p className="text-xs text-slate-500 mt-0.5">
                              User enters {newBogoBuyQty && newBogoGetFreeQty ? parseInt(newBogoBuyQty) + parseInt(newBogoGetFreeQty) : 'X+Y'} &rarr; Receives {newBogoBuyQty && newBogoGetFreeQty ? parseInt(newBogoBuyQty) + parseInt(newBogoGetFreeQty) : 'X+Y'} &rarr; Pays for {newBogoBuyQty || 'X'}
                            </p>
                          </div>
                        </div>
                      </div>
                    </RadioGroup>
                  </div>
                </div>
              )}

              {/* Bulk Discount Configuration */}
              {newOfferType === 'bulk_discount' && (
                <div className="space-y-4 pt-4 border-t border-slate-300">
                  <div>
                    <Label className="text-sm font-medium text-slate-700 mb-2 block">
                      Bulk Discount Configuration
                    </Label>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="new-bulk-threshold" className="text-xs text-slate-600 mb-1 block">
                          Minimum Tickets
                        </Label>
                        <Input
                          id="new-bulk-threshold"
                          type="number"
                          min="2"
                          value={newBulkThreshold}
                          onChange={(e) => setNewBulkThreshold(e.target.value)}
                          placeholder="e.g., 10"
                          data-testid="input-new-bulk-threshold"
                        />
                      </div>
                      <div>
                        <Label htmlFor="new-bulk-percentage" className="text-xs text-slate-600 mb-1 block">
                          Discount %
                        </Label>
                        <Input
                          id="new-bulk-percentage"
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={newBulkPercentage}
                          onChange={(e) => setNewBulkPercentage(e.target.value)}
                          placeholder="e.g., 15"
                          data-testid="input-new-bulk-percentage"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      {newBulkThreshold && newBulkPercentage 
                        ? `Customers buying ${newBulkThreshold}+ tickets will receive ${newBulkPercentage}% off`
                        : 'Enter values to see preview'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={resetCreateProgramForm}
              disabled={savingNewProgram}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateProgram}
              disabled={savingNewProgram}
              className="bg-purple-600 hover:bg-purple-700"
              data-testid="button-save-new-program"
            >
              {savingNewProgram ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Program
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
