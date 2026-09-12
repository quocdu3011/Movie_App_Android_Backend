import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProfileSchema1700000000001 implements MigrationInterface {
  name = 'CreateProfileSchema1700000000001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE profiles (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
        avatar_id smallint NULL CHECK (avatar_id IS NULL OR avatar_id >= 0),
        is_kids boolean NOT NULL DEFAULT false,
        deleted_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_profiles_user_active
      ON profiles (user_id, created_at, id)
      WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE TABLE profile_quotas (
        user_id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        event_id uuid PRIMARY KEY,
        event_type text NOT NULL CHECK (event_type = 'profile.deleted'),
        aggregate_id uuid NOT NULL,
        aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
        occurred_at timestamptz NOT NULL,
        available_at timestamptz NOT NULL DEFAULT now(),
        locked_until timestamptz NULL,
        published_at timestamptz NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error text NULL,
        envelope jsonb NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_outbox_events_pending
      ON outbox_events (available_at, occurred_at)
      WHERE published_at IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_profile_deleted_event
      ON outbox_events (aggregate_id, event_type)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS outbox_events');
    await queryRunner.query('DROP TABLE IF EXISTS profile_quotas');
    await queryRunner.query('DROP TABLE IF EXISTS profiles');
  }
}
