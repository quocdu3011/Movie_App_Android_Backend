import { MigrationInterface, QueryRunner } from 'typeorm';

export class DefaultLegacyProgressEligibilityToFalse1700000000011 implements MigrationInterface {
  name = 'DefaultLegacyProgressEligibilityToFalse1700000000011';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE playback_sessions ALTER COLUMN requires_minimum_progress SET DEFAULT false`);
    await queryRunner.query(`ALTER TABLE watch_progress ALTER COLUMN requires_minimum_progress SET DEFAULT false`);
    await queryRunner.query(`UPDATE playback_sessions SET requires_minimum_progress=false WHERE requires_minimum_progress=true`);
    await queryRunner.query(`UPDATE watch_progress SET requires_minimum_progress=false WHERE requires_minimum_progress=true`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE playback_sessions ALTER COLUMN requires_minimum_progress SET DEFAULT true`);
    await queryRunner.query(`ALTER TABLE watch_progress ALTER COLUMN requires_minimum_progress SET DEFAULT true`);
  }
}
