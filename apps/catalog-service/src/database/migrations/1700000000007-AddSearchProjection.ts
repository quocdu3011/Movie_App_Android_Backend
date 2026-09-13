import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSearchProjection1700000000007 implements MigrationInterface {
  name = 'AddSearchProjection1700000000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE search_inbox_events (event_id uuid PRIMARY KEY, event_type text NOT NULL, movie_id uuid NOT NULL, aggregate_version bigint NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`);
    await queryRunner.query(`CREATE TABLE search_projection_versions (movie_id uuid PRIMARY KEY, version bigint NOT NULL CHECK(version > 0), indexed_at timestamptz NOT NULL DEFAULT now())`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS search_projection_versions');
    await queryRunner.query('DROP TABLE IF EXISTS search_inbox_events');
  }
}
