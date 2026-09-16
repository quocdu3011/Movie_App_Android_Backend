import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCatalogHomeProjection1700000000012 implements MigrationInterface {
  name = 'AddCatalogHomeProjection1700000000012';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE content_sources ADD COLUMN provider_view_count bigint NOT NULL DEFAULT 0 CHECK(provider_view_count >= 0)`);
    await queryRunner.query(`ALTER TABLE content_sources ADD COLUMN provider_vote_count bigint NOT NULL DEFAULT 0 CHECK(provider_vote_count >= 0)`);
    await queryRunner.query(`ALTER TABLE content_sources ADD COLUMN provider_is_completed boolean NOT NULL DEFAULT false`);

    await queryRunner.query(`
      CREATE TABLE catalog_home_collections (
        type text PRIMARY KEY CHECK(length(btrim(type)) BETWEEN 1 AND 120),
        name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
        display_order integer NOT NULL CHECK(display_order > 0),
        refreshed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE catalog_home_collection_items (
        collection_type text NOT NULL REFERENCES catalog_home_collections(type) ON DELETE CASCADE,
        position smallint NOT NULL CHECK(position BETWEEN 1 AND 20),
        movie_id uuid NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
        PRIMARY KEY(collection_type,position),
        UNIQUE(collection_type,movie_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_catalog_home_items_movie ON catalog_home_collection_items(movie_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS catalog_home_collection_items');
    await queryRunner.query('DROP TABLE IF EXISTS catalog_home_collections');
    await queryRunner.query('ALTER TABLE content_sources DROP COLUMN IF EXISTS provider_is_completed');
    await queryRunner.query('ALTER TABLE content_sources DROP COLUMN IF EXISTS provider_vote_count');
    await queryRunner.query('ALTER TABLE content_sources DROP COLUMN IF EXISTS provider_view_count');
  }
}
