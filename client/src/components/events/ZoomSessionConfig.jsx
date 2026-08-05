import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Video, Users, Check, LinkIcon } from "lucide-react";

async function fetchZoomList(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load Zoom list');
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function formatZoomItemDateTime(item) {
  if (!item?.start_time) return '';
  const d = new Date(item.start_time);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ZoomSessionConfig({
  zoomType = 'meeting',
  zoomHostId = '',
  zoomHostEmail = '',
  zoomRegistrationRequired = false,
  zoomLinkMode = 'auto_create',
  autoCreateZoom = true,
  linkExistingZoomId = '',
  zoomMeetingId = null,
  zoomWebinarId = null,
  zoomJoinUrl = null,
  zoomUsers = [],
  loadingZoomUsers = false,
  onUpdate,
  testIdSuffix = '',
}) {
  const linkedId = zoomMeetingId || zoomWebinarId;
  const linkedType = zoomWebinarId ? 'Webinar' : 'Meeting';

  const isWebinar = zoomType === 'webinar';
  const listUrl = isWebinar ? '/api/zoom/webinars' : '/api/zoom/meetings';
  const { data: upcomingItems = [], isLoading: loadingItems, isError: listError } = useQuery({
    queryKey: [listUrl],
    queryFn: async () => {
      const data = await fetchZoomList(listUrl);
      return data.filter(item => item.status === 'scheduled' && new Date(item.start_time) > new Date());
    },
    staleTime: 60000,
    enabled: zoomLinkMode === 'link_existing',
  });

  const zoomIdOf = (item) => String((isWebinar ? item.zoom_webinar_id : item.zoom_meeting_id) || '');
  const storedId = String(linkExistingZoomId || '');
  const selectedItem = storedId ? upcomingItems.find(item => zoomIdOf(item) === storedId) : null;
  const storedIdMissingFromList = Boolean(storedId) && !selectedItem;
  const typeLabel = isWebinar ? 'webinar' : 'meeting';

  return (
    <div className="space-y-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
      <div className="flex items-center gap-2 text-blue-900 font-medium">
        <Video className="h-4 w-4" />
        Zoom Configuration
      </div>

      {linkedId && (
        <div className="flex items-center gap-2 p-2 bg-green-50 border border-green-200 rounded text-sm text-green-800">
          <Check className="h-4 w-4" />
          <span>
            Zoom {linkedType} linked: {linkedId}
          </span>
          {zoomJoinUrl && (
            <a
              href={zoomJoinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 underline ml-auto"
              data-testid={`link-session-zoom-join${testIdSuffix}`}
            >
              Join URL
            </a>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-2">
          <Label>Zoom Type</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={zoomType === 'meeting' ? 'default' : 'outline'}
              size="sm"
              onClick={() => onUpdate({ zoom_type: 'meeting' })}
              data-testid={`button-session-zoom-meeting${testIdSuffix}`}
            >
              <Video className="h-4 w-4 mr-1" />
              Meeting
            </Button>
            <Button
              type="button"
              variant={zoomType === 'webinar' ? 'default' : 'outline'}
              size="sm"
              onClick={() => onUpdate({ zoom_type: 'webinar' })}
              data-testid={`button-session-zoom-webinar${testIdSuffix}`}
            >
              <Users className="h-4 w-4 mr-1" />
              Webinar
            </Button>
          </div>
          <p className="text-xs text-blue-700">
            {zoomType === 'webinar'
              ? 'Webinars support large audiences with registration and panel features'
              : 'Meetings allow all participants to share video and audio'
            }
          </p>
        </div>

        <div className="space-y-2">
          <Label>Zoom Host</Label>
          <Select
            value={zoomHostId}
            onValueChange={(value) => {
              const user = zoomUsers.find(u => u.id === value);
              onUpdate({
                zoom_host_id: value,
                zoom_host_email: user?.email || '',
              });
            }}
            disabled={loadingZoomUsers}
            data-testid={`select-session-zoom-host${testIdSuffix}`}
          >
            <SelectTrigger data-testid={`select-session-zoom-host-trigger${testIdSuffix}`}>
              <SelectValue placeholder={loadingZoomUsers ? "Loading hosts..." : "Select a Zoom host"} />
            </SelectTrigger>
            <SelectContent>
              {zoomUsers.map(user => (
                <SelectItem key={user.id} value={user.id}>
                  <div className="flex flex-col">
                    <span>{user.first_name} {user.last_name}</span>
                    <span className="text-xs text-slate-500">{user.email}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {zoomType === 'webinar' && (
          <div className="flex items-center justify-between">
            <div>
              <Label>Require Registration</Label>
              <p className="text-xs text-blue-700">Attendees must register before joining</p>
            </div>
            <Switch
              checked={zoomRegistrationRequired}
              onCheckedChange={(checked) => onUpdate({ zoom_registration_required: checked })}
              data-testid={`switch-session-zoom-registration${testIdSuffix}`}
            />
          </div>
        )}

        <Separator />

        <div className="space-y-2">
          <Label>Zoom Setup Mode</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={(zoomLinkMode || 'auto_create') === 'auto_create' ? 'default' : 'outline'}
              size="sm"
              onClick={() => onUpdate({
                zoom_link_mode: 'auto_create',
                auto_create_zoom: true,
                link_existing_zoom_id: '',
              })}
              data-testid={`button-session-zoom-auto${testIdSuffix}`}
            >
              Auto-Create
            </Button>
            <Button
              type="button"
              variant={zoomLinkMode === 'link_existing' ? 'default' : 'outline'}
              size="sm"
              onClick={() => onUpdate({
                zoom_link_mode: 'link_existing',
                auto_create_zoom: false,
              })}
              data-testid={`button-session-zoom-link${testIdSuffix}`}
            >
              <LinkIcon className="h-4 w-4 mr-1" />
              Link Existing
            </Button>
          </div>
        </div>

        {zoomLinkMode === 'link_existing' ? (
          <div className="space-y-2">
            <Label>Select Zoom {isWebinar ? 'Webinar' : 'Meeting'}</Label>
            {listError ? (
              <>
                <Input
                  type="text"
                  placeholder="e.g. 12345678901"
                  value={linkExistingZoomId || ''}
                  onChange={(e) => onUpdate({ link_existing_zoom_id: e.target.value.trim() })}
                  data-testid={`input-session-existing-zoom-id${testIdSuffix}`}
                />
                <p className="text-xs text-amber-700">
                  Couldn't load your Zoom {typeLabel}s (Zoom may not be connected). Enter the numeric Zoom {typeLabel} ID manually.
                </p>
              </>
            ) : (
              <>
                <Select
                  value={storedId}
                  onValueChange={(value) => onUpdate({ link_existing_zoom_id: value })}
                  disabled={loadingItems}
                >
                  <SelectTrigger data-testid={`select-session-existing-zoom-trigger${testIdSuffix}`}>
                    <SelectValue placeholder={loadingItems ? `Loading ${typeLabel}s...` : `Choose a scheduled ${typeLabel}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {upcomingItems.length === 0 && !loadingItems && !storedIdMissingFromList && (
                      <div className="p-4 text-center text-sm text-slate-500">
                        No upcoming {typeLabel}s available.
                      </div>
                    )}
                    {storedIdMissingFromList && (
                      <SelectItem value={storedId} data-testid={`select-session-existing-zoom-stored${testIdSuffix}`}>
                        <div className="flex flex-col">
                          <span className="font-medium">Zoom ID: {storedId}</span>
                          <span className="text-xs text-slate-500">Previously entered (not in upcoming list)</span>
                        </div>
                      </SelectItem>
                    )}
                    {upcomingItems.map((item) => (
                      <SelectItem key={item.id} value={zoomIdOf(item)} data-testid={`select-session-existing-zoom-${item.id}${testIdSuffix}`}>
                        <div className="flex flex-col">
                          <span className="font-medium">{item.topic}</span>
                          <span className="text-xs text-slate-500">{formatZoomItemDateTime(item)}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-blue-700">
                  Choose an upcoming Zoom {typeLabel} to link to this session.
                </p>
              </>
            )}

            {selectedItem && (
              <div className={`p-4 rounded-lg border ${isWebinar ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-200'}`} data-testid={`session-existing-zoom-summary${testIdSuffix}`}>
                <div className="flex items-center gap-2 mb-2">
                  {isWebinar ? (
                    <Users className="h-4 w-4 text-green-600" />
                  ) : (
                    <Video className="h-4 w-4 text-blue-600" />
                  )}
                  <span className={`font-medium ${isWebinar ? 'text-green-900' : 'text-blue-900'}`}>
                    {isWebinar ? 'Webinar' : 'Meeting'} Selected
                  </span>
                </div>
                <div className={`space-y-1 text-sm ${isWebinar ? 'text-green-800' : 'text-blue-800'}`}>
                  <p><strong>Topic:</strong> {selectedItem.topic}</p>
                  <p><strong>Date:</strong> {formatZoomItemDateTime(selectedItem)}</p>
                  <p><strong>Duration:</strong> {selectedItem.duration_minutes || selectedItem.duration} minutes</p>
                  {selectedItem.timezone && (
                    <p><strong>Timezone:</strong> {selectedItem.timezone}</p>
                  )}
                </div>
              </div>
            )}
            {!listError && storedIdMissingFromList && (
              <div className="p-3 rounded-lg border bg-slate-50 border-slate-200 text-sm text-slate-700" data-testid={`session-existing-zoom-raw-id${testIdSuffix}`}>
                <p><strong>Linked Zoom ID:</strong> {storedId}</p>
                <p className="text-xs text-slate-500 mt-1">This ID was entered previously and isn't in the upcoming {typeLabel} list. It will still be saved as-is.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <Label>Auto-create Zoom on Save</Label>
              <p className="text-xs text-blue-700">
                Automatically create a Zoom {zoomType} when the event is saved
              </p>
            </div>
            <Switch
              checked={autoCreateZoom}
              onCheckedChange={(checked) => onUpdate({ auto_create_zoom: checked })}
              data-testid={`switch-session-auto-zoom${testIdSuffix}`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
