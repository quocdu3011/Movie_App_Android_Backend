export const MOVIEAPP_TOPICS = [
  'movie.published',
  'movie.updated',
  'movie.archived',
  'movie.source.updated',
  'video.uploaded',
  'video.processing',
  'video.transcoded',
  'video.transcode_failed',
  'video.ready',
  'payment.success',
  'subscription.expiring',
  'profile.deleted',
  'playback.qualified',
] as const;

export type MovieAppTopic = (typeof MOVIEAPP_TOPICS)[number];

export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: MovieAppTopic;
  schemaVersion: number;
  aggregateId: string;
  aggregateVersion: string;
  occurredAt: string;
  producer: string;
  correlationId: string;
  payload: TPayload;
}
