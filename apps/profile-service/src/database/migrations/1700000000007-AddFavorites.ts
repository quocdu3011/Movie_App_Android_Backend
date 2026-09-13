import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFavorites1700000000007 implements MigrationInterface {
  name = 'AddFavorites1700000000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE favorite_movies (profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, movie_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(profile_id,movie_id))`);
    await queryRunner.query(`CREATE INDEX idx_favorite_movies_profile_created ON favorite_movies(profile_id,created_at DESC,movie_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS favorite_movies');
  }
}
