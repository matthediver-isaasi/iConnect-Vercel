import { useState, useMemo, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { 
  Loader2, 
  Calendar, 
  Clock, 
  ChevronLeft, 
  ChevronRight,
  User,
  Mail,
  Phone as PhoneIcon,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  Globe,
  Video,
  MapPin
} from 'lucide-react';
import { format, addDays, startOfWeek, isSameDay } from 'date-fns';
import { publicClient } from '@/api/publicClient';

const MEETING_TYPE_ICONS = {
  phone: PhoneIcon,
  google_meet: Video,
  in_person: MapPin
};

const MEETING_TYPE_LABELS = {
  phone: 'Phone Call',
  google_meet: 'Google Meet',
  in_person: 'In Person'
};

function getVisitorTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'Europe/London';
  }
}

function formatTimeInTimezone(isoString, timezone) {
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone
  });
}

export default function PublicBooking() {
  const { slug } = useParams();
  const [searchParams] = useSearchParams();
  const meetingParam = searchParams.get('meeting');
  
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [weekStart, setWeekStart] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [visitorTimezone] = useState(getVisitorTimezone);
  const [step, setStep] = useState('select');
  const [selectedMeetingType, setSelectedMeetingType] = useState(null);
  
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    notes: ''
  });

  const { data: pageData, isLoading: pageLoading, error: pageError } = useQuery({
    queryKey: ['public-booking', slug],
    queryFn: () => publicClient.getBookingInfo(slug),
    enabled: !!slug
  });

  const meetingTypes = pageData?.meetingTypes || [];
  
  useEffect(() => {
    if (meetingTypes.length > 0 && !selectedMeetingType) {
      if (meetingParam) {
        const matchBySlug = meetingTypes.find(mt => mt.slug === meetingParam);
        const matchById = meetingTypes.find(mt => mt.id === meetingParam);
        if (matchBySlug) {
          setSelectedMeetingType(matchBySlug);
        } else if (matchById) {
          setSelectedMeetingType(matchById);
        } else {
          setSelectedMeetingType(meetingTypes[0]);
        }
      } else if (meetingTypes.length === 1) {
        setSelectedMeetingType(meetingTypes[0]);
      }
    }
  }, [meetingTypes, meetingParam, selectedMeetingType]);

  const weekStartStr = format(weekStart, 'yyyy-MM-dd');
  
  const { data: slotsData, isLoading: slotsLoading, error: slotsError } = useQuery({
    queryKey: ['public-booking-slots', slug, weekStartStr],
    queryFn: async () => {
      console.log('[PublicBooking] Fetching slots for', slug, 'from', weekStartStr);
      const data = await publicClient.getBookingSlots(slug, { date: weekStartStr, days: 14 });
      console.log('[PublicBooking] Slots data received:', data);
      return data;
    },
    enabled: !!slug && !!pageData
  });
  
  // Debug logging
  console.log('[PublicBooking] State:', { 
    slug, 
    pageData: !!pageData, 
    pageLoading,
    slotsData: !!slotsData, 
    slotsLoading,
    slotsError: slotsError?.message,
    weekStartStr 
  });

  const bookingMutation = useMutation({
    mutationFn: (bookingData) => publicClient.submitBooking(slug, bookingData),
    onSuccess: () => {
      setStep('confirmed');
    },
    onError: (error) => {
      console.error('[PublicBooking] Booking failed:', error);
    }
  });

  const weekDays = useMemo(() => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      days.push(addDays(weekStart, i));
    }
    return days;
  }, [weekStart]);

  const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
  const availableSlots = slotsData?.slots?.[selectedDateStr] || [];

  const effectiveDuration = selectedMeetingType?.duration_minutes || pageData?.profile?.slotMinutes || 30;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!selectedSlot || !formData.name || !formData.email) return;

    bookingMutation.mutate({
      attendee_name: formData.name,
      attendee_email: formData.email,
      attendee_phone: formData.phone || null,
      attendee_notes: formData.notes || null,
      attendee_timezone: visitorTimezone,
      starts_at: selectedSlot.start,
      duration_minutes: effectiveDuration,
      meeting_template_id: selectedMeetingType?.id || null
    });
  };

  if (pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (pageError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full mx-4">
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-muted-foreground" />
            <div>
              <h2 className="text-xl font-semibold">Booking Page Not Found</h2>
              <p className="text-muted-foreground mt-2">{pageError.message}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (step === 'confirmed') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="flex flex-col items-center gap-6 py-12 text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-green-600" />
            </div>
            <div>
              <h2 className="text-2xl font-semibold">Booking Confirmed!</h2>
              <p className="text-muted-foreground mt-2">
                Your meeting with {pageData?.agent?.name} has been scheduled.
              </p>
            </div>
            <div className="bg-muted rounded-lg p-4 w-full">
              <div className="flex items-center gap-2 justify-center">
                <Calendar className="h-4 w-4" />
                <span className="font-medium">
                  {format(new Date(selectedSlot.start), 'EEEE, MMMM d, yyyy')}
                </span>
              </div>
              <div className="flex items-center gap-2 justify-center mt-1 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>
                  {formatTimeInTimezone(selectedSlot.start, visitorTimezone)} - {formatTimeInTimezone(selectedSlot.end, visitorTimezone)}
                </span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              A confirmation email has been sent to {formData.email}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-4xl mx-auto">
        <Card>
          <CardHeader className="text-center border-b">
            <div className="flex flex-col items-center gap-4">
              {pageData?.tenant?.logo && (
                <img 
                  src={pageData.tenant.logo} 
                  alt={pageData.tenant.name}
                  className="h-12 object-contain"
                />
              )}
              <Avatar className="h-20 w-20">
                <AvatarImage src={pageData?.agent?.avatar} />
                <AvatarFallback className="text-2xl">
                  {pageData?.agent?.name?.charAt(0) || 'A'}
                </AvatarFallback>
              </Avatar>
              <div>
                <CardTitle className="text-2xl">{selectedMeetingType?.name || pageData?.profile?.title || 'Book a Meeting'}</CardTitle>
                {pageData?.agent?.name && (
                  <CardDescription className="mt-1">
                    with {pageData.agent.name}
                  </CardDescription>
                )}
                {pageData?.profile?.description && (
                  <p className="text-sm text-muted-foreground mt-2 max-w-md">
                    {pageData.profile.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  {effectiveDuration} min
                </div>
                {selectedMeetingType && (
                  <div className="flex items-center gap-1">
                    {(() => {
                      const Icon = MEETING_TYPE_ICONS[selectedMeetingType.meeting_type] || PhoneIcon;
                      return <Icon className="h-4 w-4" />;
                    })()}
                    {MEETING_TYPE_LABELS[selectedMeetingType.meeting_type] || selectedMeetingType.meeting_type}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <Globe className="h-4 w-4" />
                  {visitorTimezone}
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {meetingTypes.length > 1 && !selectedMeetingType && (
              <div className="p-6 border-b">
                <h3 className="font-semibold mb-4">Select a Meeting Type</h3>
                <div className="space-y-2">
                  {meetingTypes.map((mt) => {
                    const Icon = MEETING_TYPE_ICONS[mt.meeting_type] || PhoneIcon;
                    return (
                      <button
                        key={mt.id}
                        onClick={() => setSelectedMeetingType(mt)}
                        className="w-full p-4 border rounded-lg text-left hover-elevate flex items-start gap-4"
                        data-testid={`meeting-type-${mt.slug}`}
                      >
                        <div className="p-2 bg-muted rounded-lg shrink-0">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{mt.name}</span>
                            <Badge variant="secondary" className="text-xs">
                              {mt.duration_minutes} min
                            </Badge>
                          </div>
                          {mt.description && (
                            <p className="text-sm text-muted-foreground mt-1">{mt.description}</p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            
            {step === 'select' && (meetingTypes.length === 0 || selectedMeetingType) && (
              <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
                <div className="p-6">
                  {meetingTypes.length > 1 && selectedMeetingType && (
                    <div className="mb-4 p-3 bg-muted rounded-lg flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {(() => {
                          const Icon = MEETING_TYPE_ICONS[selectedMeetingType.meeting_type] || PhoneIcon;
                          return <Icon className="h-4 w-4" />;
                        })()}
                        <span className="font-medium">{selectedMeetingType.name}</span>
                        <Badge variant="secondary" className="text-xs">
                          {selectedMeetingType.duration_minutes} min
                        </Badge>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedMeetingType(null)}
                        data-testid="button-change-meeting-type"
                      >
                        Change
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold">Select a Date</h3>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setWeekStart(addDays(weekStart, -7))}
                        disabled={weekStart <= new Date()}
                        data-testid="button-prev-week"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setWeekStart(addDays(weekStart, 7))}
                        data-testid="button-next-week"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-7 gap-1 text-center text-sm">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
                      <div key={day} className="text-muted-foreground py-2">{day}</div>
                    ))}
                    {weekDays.map((day, index) => {
                      const dateStr = format(day, 'yyyy-MM-dd');
                      const hasSlots = (slotsData?.slots?.[dateStr]?.length || 0) > 0;
                      const isPast = day < new Date(new Date().setHours(0,0,0,0));
                      const isSelected = isSameDay(day, selectedDate);

                      return (
                        <Button
                          key={index}
                          variant={isSelected ? 'default' : 'ghost'}
                          className={`h-12 ${!hasSlots || isPast ? 'opacity-50' : ''}`}
                          disabled={!hasSlots || isPast}
                          onClick={() => {
                            setSelectedDate(day);
                            setSelectedSlot(null);
                          }}
                          data-testid={`button-date-${dateStr}`}
                        >
                          <div className="flex flex-col">
                            <span>{format(day, 'd')}</span>
                            {hasSlots && !isPast && (
                              <span className="w-1 h-1 rounded-full bg-green-500 mx-auto mt-0.5" />
                            )}
                          </div>
                        </Button>
                      );
                    })}
                  </div>

                  <div className="mt-4 text-sm text-muted-foreground text-center">
                    {format(weekStart, 'MMMM yyyy')}
                  </div>
                </div>

                <div className="p-6">
                  <h3 className="font-semibold mb-4">
                    {format(selectedDate, 'EEEE, MMMM d')}
                  </h3>

                  {slotsError ? (
                    <div className="text-center py-12 text-red-500">
                      <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
                      <p>Error loading slots: {slotsError.message}</p>
                    </div>
                  ) : slotsLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : availableSlots.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <Calendar className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p>No available times on this date</p>
                    </div>
                  ) : (
                    <ScrollArea className="h-[300px]">
                      <div className="grid grid-cols-2 gap-2">
                        {availableSlots.map((slot, index) => (
                          <Button
                            key={index}
                            variant={selectedSlot?.start === slot.start ? 'default' : 'outline'}
                            className="justify-center"
                            onClick={() => setSelectedSlot(slot)}
                            data-testid={`button-slot-${index}`}
                          >
                            {formatTimeInTimezone(slot.start, visitorTimezone)}
                          </Button>
                        ))}
                      </div>
                    </ScrollArea>
                  )}

                  {selectedSlot && (
                    <Button
                      className="w-full mt-4"
                      onClick={() => setStep('form')}
                      data-testid="button-continue-to-form"
                    >
                      Continue
                    </Button>
                  )}
                </div>
              </div>
            )}

            {step === 'form' && (
              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                <div className="bg-muted rounded-lg p-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      <span className="font-medium">
                        {format(new Date(selectedSlot.start), 'EEEE, MMMM d, yyyy')}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-muted-foreground">
                      <Clock className="h-4 w-4" />
                      <span>
                        {formatTimeInTimezone(selectedSlot.start, visitorTimezone)} - {formatTimeInTimezone(selectedSlot.end, visitorTimezone)}
                      </span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setStep('select')}
                    data-testid="button-change-time"
                  >
                    Change
                  </Button>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name" className="flex items-center gap-2">
                      <User className="h-4 w-4" />
                      Your Name *
                    </Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="John Smith"
                      required
                      data-testid="input-attendee-name"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="email" className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Email Address *
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      placeholder="john@example.com"
                      required
                      data-testid="input-attendee-email"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="phone" className="flex items-center gap-2">
                      <PhoneIcon className="h-4 w-4" />
                      Phone Number (optional)
                    </Label>
                    <Input
                      id="phone"
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      placeholder="+44 123 456 7890"
                      data-testid="input-attendee-phone"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="notes" className="flex items-center gap-2">
                      <MessageSquare className="h-4 w-4" />
                      Additional Notes (optional)
                    </Label>
                    <Textarea
                      id="notes"
                      value={formData.notes}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      placeholder="Anything you'd like us to know before the meeting..."
                      rows={3}
                      data-testid="input-attendee-notes"
                    />
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep('select')}
                    data-testid="button-back-to-slots"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Back
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={bookingMutation.isPending || !formData.name || !formData.email}
                    data-testid="button-confirm-booking"
                  >
                    {bookingMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                    )}
                    Confirm Booking
                  </Button>
                </div>

                {bookingMutation.error && (
                  <div className="text-red-600 text-sm text-center">
                    {bookingMutation.error.message}
                  </div>
                )}
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
