// Local webinar records use duration_minutes; raw Zoom responses use duration.
export function getZoomWebinarEndTime(webinar) {
  const minutes = Number(webinar.duration_minutes ?? webinar.duration ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error("Webinar duration must be a positive number");
  }
  return new Date(new Date(webinar.start_time).getTime() + minutes * 60000).toISOString();
}
