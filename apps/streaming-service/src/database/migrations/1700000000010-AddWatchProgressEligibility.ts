import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchProgressEligibility1700000000010 implements MigrationInterface {
  name = 'AddWatchProgressEligibility1700000000010';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE playback_sessions ADD COLUMN requires_minimum_progress boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE watch_progress ADD COLUMN requires_minimum_progress boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`CREATE INDEX idx_progress_profile_movie_updated ON watch_progress(profile_id,movie_id,updated_at DESC,session_ordinal DESC,playable_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX idx_progress_profile_movie_updated`);
    await queryRunner.query(`ALTER TABLE watch_progress DROP COLUMN requires_minimum_progress`);
    await queryRunner.query(`ALTER TABLE playback_sessions DROP COLUMN requires_minimum_progress`);
  }
}
