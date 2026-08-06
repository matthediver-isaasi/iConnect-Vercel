import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";

const EMPTY = {};

// Batched mini-agenda data for Training event cards: one request keyed by the
// training event ids on the page, returning
// { [event_id]: [{ start_date, end_date, start_time, item_type, sort_order }] }.
// Dates + type label only — no links (those stay gated behind bookings).
export function useTrainingAgendaSummaries(events) {
  const trainingIds = useMemo(
    () =>
      [...new Set(
        (events || [])
          .filter((e) => e && e.is_training && !e.is_complex && e.id)
          .map((e) => e.id)
      )].sort(),
    [events]
  );

  const { data } = useQuery({
    queryKey: ['training-agenda-summaries', trainingIds.join(',')],
    queryFn: () => publicClient.listEventAgendaSummaries(trainingIds),
    enabled: trainingIds.length > 0,
    staleTime: 30000,
  });

  return data || EMPTY;
}
