import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOwnedMediaSchema1700000000006 implements MigrationInterface {
  name = 'CreateOwnedMediaSchema1700000000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE video_assets
      ADD COLUMN expected_size_bytes bigint NULL CHECK(expected_size_bytes > 0),
      ADD COLUMN expected_checksum text NULL CHECK(expected_checksum ~ '^[a-f0-9]{64}$'),
      ADD COLUMN checksum_algorithm text NULL CHECK(checksum_algorithm IN ('sha256')),
      ADD COLUMN upload_idempotency_key text NULL,
      ADD COLUMN processed_attempt integer NULL CHECK(processed_attempt IS NULL OR processed_attempt > 0),
      ADD CONSTRAINT video_assets_upload_contract CHECK(
        (processing_status='upload_pending' AND expected_size_bytes IS NOT NULL AND expected_checksum IS NOT NULL AND checksum_algorithm='sha256')
        OR processing_status<>'upload_pending'
      )`);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_video_assets_upload_key ON video_assets(source_item_id,upload_idempotency_key) WHERE upload_idempotency_key IS NOT NULL`);
    await queryRunner.query(`CREATE TABLE upload_completions (
      asset_id uuid NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
      generation integer NOT NULL CHECK(generation > 0),
      completed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(asset_id,generation)
    )`);
    await queryRunner.query(`ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_event_type_check`);
    await queryRunner.query(`ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check
      CHECK(event_type IN ('playback.qualified','video.uploaded','video.ready','video.transcode_failed'))`);
    await queryRunner.query(`CREATE INDEX idx_video_assets_transcode ON video_assets(processing_status,updated_at) WHERE processing_status IN ('queued','processing','failed')`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_event_type_check`);
    await queryRunner.query(`ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check CHECK(event_type IN ('playback.qualified'))`);
    await queryRunner.query('DROP TABLE IF EXISTS upload_completions');
    await queryRunner.query('DROP INDEX IF EXISTS uq_video_assets_upload_key');
    await queryRunner.query('DROP INDEX IF EXISTS idx_video_assets_transcode');
    await queryRunner.query('ALTER TABLE video_assets DROP CONSTRAINT IF EXISTS video_assets_upload_contract');
    await queryRunner.query('ALTER TABLE video_assets DROP COLUMN IF EXISTS processed_attempt, DROP COLUMN IF EXISTS upload_idempotency_key, DROP COLUMN IF EXISTS checksum_algorithm, DROP COLUMN IF EXISTS expected_checksum, DROP COLUMN IF EXISTS expected_size_bytes');
  }
}
