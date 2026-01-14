import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Loader2, 
  Calendar, 
  Clock, 
  Globe,
  Link as LinkIcon,
  Copy,
  Check,
  Save,
  ExternalLink
} from 'lucide-react';
import { toast } from 'sonner';

const TIMEZONES = [
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney'
];

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DEFAULT_WORKING_HOURS = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: []
};

export default function BookingAvailabilitySettings() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [formData, setFormData] = useState({
    is_active: true,
    timezone: 'Europe/London',
    default_slot_minutes: 30,
    buffer_minutes: 0,
    working_hours: DEFAULT_WORKING_HOURS,
    booking_title: 'Book a Meeting',
    booking_description: ''
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['booking-availability'],
    queryFn: async () => {
      const response = await fetch('/api/booking/availability', {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch availability');
      return response.json();
    }
  });

  useEffect(() => {
    if (data?.profile) {
      setFormData({
        is_active: data.profile.is_active ?? true,
        timezone: data.profile.timezone || 'Europe/London',
        default_slot_minutes: data.profile.default_slot_minutes || 30,
        buffer_minutes: data.profile.buffer_minutes || 0,
        working_hours: data.profile.working_hours || DEFAULT_WORKING_HOURS,
        booking_title: data.profile.booking_title || 'Book a Meeting',
        booking_description: data.profile.booking_description || ''
      });
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (profileData) => {
      const response = await fetch('/api/booking/availability', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileData)
      });
      if (!response.ok) throw new Error('Failed to save availability');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['booking-availability'] });
      toast.success('Availability settings saved');
    },
    onError: (err) => {
      toast.error(err.message);
    }
  });

  const handleSave = () => {
    saveMutation.mutate(formData);
  };

  const toggleDayEnabled = (day) => {
    const currentHours = formData.working_hours[day] || [];
    const newHours = currentHours.length > 0 
      ? [] 
      : [{ start: '09:00', end: '17:00' }];
    
    setFormData({
      ...formData,
      working_hours: {
        ...formData.working_hours,
        [day]: newHours
      }
    });
  };

  const updateDayHours = (day, field, value) => {
    const currentHours = formData.working_hours[day] || [];
    if (currentHours.length === 0) return;
    
    setFormData({
      ...formData,
      working_hours: {
        ...formData.working_hours,
        [day]: [{ ...currentHours[0], [field]: value }]
      }
    });
  };

  const bookingUrl = data?.bookingSlug 
    ? `${window.location.origin}/book/${data.bookingSlug}`
    : null;

  const copyBookingUrl = () => {
    if (bookingUrl) {
      navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Booking link copied!');
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Failed to load availability settings
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Booking Availability
            </CardTitle>
            <CardDescription>
              Let people book meetings with you
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="booking-active" className="text-sm">
              {formData.is_active ? 'Active' : 'Inactive'}
            </Label>
            <Switch
              id="booking-active"
              checked={formData.is_active}
              onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              data-testid="switch-booking-active"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {bookingUrl && formData.is_active && (
          <div className="bg-muted rounded-lg p-4">
            <Label className="text-sm font-medium flex items-center gap-2 mb-2">
              <LinkIcon className="h-4 w-4" />
              Your Booking Link
            </Label>
            <div className="flex gap-2">
              <Input
                value={bookingUrl}
                readOnly
                className="font-mono text-sm"
                data-testid="input-booking-url"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={copyBookingUrl}
                data-testid="button-copy-booking-url"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => window.open(bookingUrl, '_blank')}
                data-testid="button-open-booking-url"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="booking-title">Booking Page Title</Label>
            <Input
              id="booking-title"
              value={formData.booking_title}
              onChange={(e) => setFormData({ ...formData, booking_title: e.target.value })}
              placeholder="Book a Meeting"
              data-testid="input-booking-title"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="timezone" className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Timezone
            </Label>
            <Select
              value={formData.timezone}
              onValueChange={(value) => setFormData({ ...formData, timezone: value })}
            >
              <SelectTrigger id="timezone" data-testid="select-timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map(tz => (
                  <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="booking-description">Description (optional)</Label>
          <Textarea
            id="booking-description"
            value={formData.booking_description}
            onChange={(e) => setFormData({ ...formData, booking_description: e.target.value })}
            placeholder="A brief description shown on your booking page..."
            rows={2}
            data-testid="input-booking-description"
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="slot-duration" className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Meeting Duration
            </Label>
            <Select
              value={String(formData.default_slot_minutes)}
              onValueChange={(value) => setFormData({ ...formData, default_slot_minutes: parseInt(value) })}
            >
              <SelectTrigger id="slot-duration" data-testid="select-slot-duration">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="45">45 minutes</SelectItem>
                <SelectItem value="60">60 minutes</SelectItem>
                <SelectItem value="90">90 minutes</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="buffer-time">Buffer Between Meetings</Label>
            <Select
              value={String(formData.buffer_minutes)}
              onValueChange={(value) => setFormData({ ...formData, buffer_minutes: parseInt(value) })}
            >
              <SelectTrigger id="buffer-time" data-testid="select-buffer-time">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">No buffer</SelectItem>
                <SelectItem value="5">5 minutes</SelectItem>
                <SelectItem value="10">10 minutes</SelectItem>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-3">
          <Label>Working Hours</Label>
          <div className="space-y-2">
            {DAYS.map((day, index) => {
              const hours = formData.working_hours[day] || [];
              const isEnabled = hours.length > 0;

              return (
                <div key={day} className="flex items-center gap-3 py-2">
                  <div className="w-12">
                    <Badge 
                      variant={isEnabled ? 'default' : 'secondary'}
                      className="cursor-pointer w-full justify-center"
                      onClick={() => toggleDayEnabled(day)}
                      data-testid={`badge-day-${day}`}
                    >
                      {DAY_LABELS[index]}
                    </Badge>
                  </div>
                  
                  {isEnabled ? (
                    <div className="flex items-center gap-2 flex-1">
                      <Input
                        type="time"
                        value={hours[0]?.start || '09:00'}
                        onChange={(e) => updateDayHours(day, 'start', e.target.value)}
                        className="w-32"
                        data-testid={`input-${day}-start`}
                      />
                      <span className="text-muted-foreground">to</span>
                      <Input
                        type="time"
                        value={hours[0]?.end || '17:00'}
                        onChange={(e) => updateDayHours(day, 'end', e.target.value)}
                        className="w-32"
                        data-testid={`input-${day}-end`}
                      />
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-sm">Unavailable</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end pt-4">
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending}
            data-testid="button-save-availability"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
