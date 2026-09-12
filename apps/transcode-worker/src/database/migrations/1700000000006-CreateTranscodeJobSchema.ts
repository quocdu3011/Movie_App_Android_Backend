import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTranscodeJobSchema1700000000006 implements MigrationInterface {
  name = 'CreateTranscodeJobSchema1700000000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE transcode_jobs (
      asset_id uuid NOT NULL,
      generation integer NOT NULL CHECK(generation > 0),
      source_item_id uuid NOT NULL,
      raw_object_key text NOT NULL,
      expected_checksum text NOT NULL CHECK(expected_checksum ~ '^[a-f0-9]{64}$'),
      state text NOT NULL CHECK(state IN ('queued','processing','retry_wait','succeeded','failed')),
      attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0),
      attempt_token uuid NULL,
      lease_until timestamptz NULL,
      available_at timestamptz NOT NULL DEFAULT now(),
      output_prefix text NULL,
      last_error text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(asset_id,generation)
    )`);
    await queryRunner.query(`CREATE INDEX idx_transcode_jobs_claim ON transcode_jobs(available_at,created_at) WHERE state IN ('queued','retry_wait')`);
    await queryRunner.query(`CREATE TABLE worker_inbox (
      consumer_name text NOT NULL,
      event_id uuid NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(consumer_name,event_id)
    )`);
    await queryRunner.query(`CREATE TABLE worker_outbox (
      event_id uuid PRIMARY KEY,
      event_type text NOT NULL CHECK(event_type IN ('video.processing','video.transcoded','video.transcode_failed')),
      aggregate_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL,
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_until timestamptz NULL,
      published_at timestamptz NULL,
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      last_error text NULL,
      envelope jsonb NOT NULL
    )`);
    await queryRunner.query(`CREATE INDEX idx_worker_outbox_pending ON worker_outbox(available_at,occurred_at) WHERE published_at IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS worker_outbox');
    await queryRunner.query('DROP TABLE IF EXISTS worker_inbox');
    await queryRunner.query('DROP TABLE IF EXISTS transcode_jobs');
  }
}
