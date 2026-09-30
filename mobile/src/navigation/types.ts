import type { EventType } from '@/types';

export type RootStackParamList = {
  EventList: undefined;
  SessionSelect: {
    eventId: string;
    eventTitle: string;
  };
  Scanner: {
    eventId: string;
    eventType: EventType;
    eventTitle: string;
    sessionId?: string;
    sessionTitle?: string;
  };
};
