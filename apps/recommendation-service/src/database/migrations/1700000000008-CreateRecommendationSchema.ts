import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRecommendationSchema1700000000008 implements MigrationInterface {
  name = 'CreateRecommendationSchema1700000000008';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE processed_events (consumer_name text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(consumer_name,event_id))`);
    await queryRunner.query(`CREATE TABLE watch_events (event_id uuid PRIMARY KEY, session_id uuid NOT NULL UNIQUE, user_id uuid NOT NULL, profile_id uuid NOT NULL, movie_id uuid NOT NULL, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await queryRunner.query(`CREATE INDEX idx_watch_events_trending ON watch_events(occurred_at DESC,movie_id)`);
    await queryRunner.query(`CREATE INDEX idx_watch_events_profile ON watch_events(profile_id,occurred_at DESC)`);
  }
  async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query('DROP TABLE IF EXISTS watch_events'); await queryRunner.query('DROP TABLE IF EXISTS processed_events'); }
}
