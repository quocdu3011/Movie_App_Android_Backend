import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStreamingPlaybackSchema1700000000005 implements MigrationInterface {
  name = 'CreateStreamingPlaybackSchema1700000000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE video_assets (
        id uuid PRIMARY KEY,
        source_item_id uuid NOT NULL UNIQUE,
        playable_id uuid NOT NULL,
        movie_id uuid NOT NULL,
        raw_object_key text NULL,
        master_manifest_key text NULL,
        available_resolutions text[] NOT NULL DEFAULT '{}',
        duration_seconds integer NULL CHECK(duration_seconds IS NULL OR duration_seconds > 0),
        processing_status text NOT NULL CHECK(processing_status IN ('upload_pending','queued','processing','ready','failed','expired')),
        generation integer NOT NULL DEFAULT 1 CHECK(generation > 0),
        upload_expires_at timestamptz NULL,
        failure_code text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_video_assets_ready ON video_assets(source_item_id) WHERE processing_status='ready'`);
    await queryRunner.query(`
      CREATE TABLE playback_sessions (
        id uuid PRIMARY KEY,
        ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
        user_id uuid NOT NULL,
        auth_session_id uuid NOT NULL,
        profile_id uuid NOT NULL,
        movie_id uuid NOT NULL,
        playable_id uuid NOT NULL,
        source_item_id uuid NOT NULL,
        source_type text NOT NULL CHECK(source_type IN ('owned','third_party')),
        state text NOT NULL CHECK(state IN ('reserved','ready','playing','stopped','failed','expired')),
        last_seq bigint NOT NULL DEFAULT 0 CHECK(last_seq >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz NULL,
        qualified_at timestamptz NULL,
        closed_at timestamptz NULL,
        CHECK(expires_at >= created_at),
        CHECK((state IN ('stopped','failed','expired') AND closed_at IS NOT NULL) OR state NOT IN ('stopped','failed','expired'))
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_playback_sessions_user_live ON playback_sessions(user_id,expires_at) WHERE state IN ('reserved','ready','playing')`);
    await queryRunner.query(`CREATE INDEX idx_playback_sessions_profile_recent ON playback_sessions(profile_id,created_at DESC)`);
    await queryRunner.query(`CREATE INDEX idx_playback_sessions_reap ON playback_sessions(expires_at,id) WHERE state IN ('reserved','ready','playing')`);
    await queryRunner.query(`
      CREATE TABLE playback_requests (
        user_id uuid NOT NULL,
        idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
        request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
        session_id uuid NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        PRIMARY KEY(user_id,idempotency_key)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_playback_requests_expiry ON playback_requests(expires_at)`);
    await queryRunner.query(`
      CREATE TABLE watch_progress (
        profile_id uuid NOT NULL,
        playable_id uuid NOT NULL,
        movie_id uuid NOT NULL,
        source_item_id uuid NOT NULL,
        session_ordinal bigint NOT NULL,
        last_seq bigint NOT NULL CHECK(last_seq >= 0),
        position_seconds integer NOT NULL CHECK(position_seconds >= 0),
        duration_seconds integer NULL CHECK(duration_seconds IS NULL OR duration_seconds > 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(profile_id,playable_id),
        CHECK(duration_seconds IS NULL OR position_seconds <= duration_seconds)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_progress_profile_updated ON watch_progress(profile_id,updated_at DESC)`);
    await queryRunner.query(`
      CREATE TABLE playback_events (
        session_id uuid NOT NULL REFERENCES playback_sessions(id) ON DELETE CASCADE,
        event_id uuid NOT NULL,
        event_type text NOT NULL CHECK(event_type IN ('started','qualified','failed','stopped')),
        payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(session_id,event_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE processed_events (
        consumer_name text NOT NULL,
        event_id uuid NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(consumer_name,event_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        event_id uuid PRIMARY KEY,
        event_type text NOT NULL CHECK(event_type IN ('playback.qualified')),
        aggregate_id uuid NOT NULL,
        aggregate_version bigint NOT NULL CHECK(aggregate_version > 0),
        occurred_at timestamptz NOT NULL,
        available_at timestamptz NOT NULL DEFAULT now(),
        locked_until timestamptz NULL,
        published_at timestamptz NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        last_error text NULL,
        envelope jsonb NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_streaming_outbox_pending ON outbox_events(available_at,occurred_at) WHERE published_at IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS outbox_events');
    await queryRunner.query('DROP TABLE IF EXISTS processed_events');
    await queryRunner.query('DROP TABLE IF EXISTS playback_events');
    await queryRunner.query('DROP TABLE IF EXISTS watch_progress');
    await queryRunner.query('DROP TABLE IF EXISTS playback_requests');
    await queryRunner.query('DROP TABLE IF EXISTS playback_sessions');
    await queryRunner.query('DROP TABLE IF EXISTS video_assets');
  }
}
