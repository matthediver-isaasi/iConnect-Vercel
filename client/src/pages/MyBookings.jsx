import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Loader2, 
  Calendar, 
  Clock, 
  User,
  Mail,
  Phone,
  MessageSquare,
  X,
  CheckCircle2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { format, startOfToday, addDays } from 'date-fns';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const STATUS_COLORS = {
  pending: 'bg-yellow-100 text-yellow-800',
  confirmed: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
  completed: 'bg-gray-100 text-gray-800'
};

export default function MyBookings() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('all');
  const [cancellingBooking, setCancellingBooking] = useState(null);
  const [page, setPage] = useState(0);
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: ['my-bookings', statusFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
        from_date: startOfToday().toISOString()
      });
      if (statusFilter !== 'all') {
        params.append('status', statusFilter);
      }
      const response = await fetch(`/api/booking/list?${params}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch bookings');
      return response.json();
    }
  });

  const cancelMutation = useMutation({
    mutationFn: async (bookingId) => {
      const response = await fetch(`/api/booking/${bookingId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' })
      });
      if (!response.ok) throw new Error('Failed to cancel booking');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
      toast.success('Booking cancelled');
      setCancellingBooking(null);
    },
    onError: (err) => {
      toast.error(err.message);
    }
  });

  const bookings = data?.bookings || [];
  const total = data?.total || 0;
  const hasMore = (page + 1) * limit < total;

  if (isLoading) {
    return (
      <div className="container mx-auto py-8 px-4">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-8 px-4">
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-muted-foreground" />
            <div>
              <h2 className="text-xl font-semibold">Failed to load bookings</h2>
              <p className="text-muted-foreground mt-2">{error.message}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Calendar className="h-6 w-6" />
            My Bookings
          </h1>
          <p className="text-muted-foreground">
            Manage your scheduled meetings
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px]" data-testid="select-status-filter">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Bookings</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {bookings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Calendar className="h-12 w-12 text-muted-foreground/50" />
            <div>
              <h2 className="text-lg font-semibold">No bookings found</h2>
              <p className="text-muted-foreground mt-1">
                {statusFilter !== 'all' 
                  ? `No ${statusFilter} bookings scheduled`
                  : 'You have no upcoming meetings scheduled'}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {bookings.map((booking) => (
            <Card key={booking.id} data-testid={`booking-card-${booking.id}`}>
              <CardContent className="p-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <Badge className={STATUS_COLORS[booking.status]}>
                        {booking.status}
                      </Badge>
                      <span className="font-medium">{booking.title}</span>
                    </div>
                    
                    <div className="grid gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span>{format(new Date(booking.starts_at), 'EEEE, MMMM d, yyyy')}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-muted-foreground" />
                        <span>
                          {format(new Date(booking.starts_at), 'h:mm a')} - {format(new Date(booking.ends_at), 'h:mm a')}
                        </span>
                        <span className="text-muted-foreground">
                          ({booking.duration_minutes} min)
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex-1">
                    <div className="grid gap-1 text-sm">
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span>{booking.attendee_name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <a 
                          href={`mailto:${booking.attendee_email}`}
                          className="text-primary hover:underline"
                        >
                          {booking.attendee_email}
                        </a>
                      </div>
                      {booking.attendee_phone && (
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <span>{booking.attendee_phone}</span>
                        </div>
                      )}
                      {booking.attendee_notes && (
                        <div className="flex items-start gap-2 mt-1">
                          <MessageSquare className="h-4 w-4 text-muted-foreground mt-0.5" />
                          <span className="text-muted-foreground">{booking.attendee_notes}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {booking.status === 'confirmed' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCancellingBooking(booking)}
                        data-testid={`button-cancel-${booking.id}`}
                      >
                        <X className="h-4 w-4 mr-1" />
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}

          {(page > 0 || hasMore) && (
            <div className="flex items-center justify-between pt-4">
              <Button
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
                data-testid="button-prev-page"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Showing {page * limit + 1} - {Math.min((page + 1) * limit, total)} of {total}
              </span>
              <Button
                variant="outline"
                disabled={!hasMore}
                onClick={() => setPage(p => p + 1)}
                data-testid="button-next-page"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={!!cancellingBooking} onOpenChange={() => setCancellingBooking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Booking</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to cancel this booking with {cancellingBooking?.attendee_name}? 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Booking</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => cancelMutation.mutate(cancellingBooking?.id)}
              className="bg-red-600 hover:bg-red-700"
            >
              {cancelMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Cancel Booking
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
