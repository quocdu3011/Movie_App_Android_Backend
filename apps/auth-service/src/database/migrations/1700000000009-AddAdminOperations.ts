import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdminOperations1700000000009 implements MigrationInterface {
  name = 'AddAdminOperations1700000000009';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await queryRunner.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin','content_manager','content_editor','support'))`);
    await queryRunner.query(`
      CREATE TABLE admin_audit_logs (
        id uuid PRIMARY KEY,
        actor_id uuid NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text NOT NULL,
        target_user_id uuid NULL,
        reason text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        request_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK(length(trim(reason)) > 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_admin_audit_logs_created ON admin_audit_logs(created_at DESC,id DESC)`);
    await queryRunner.query(`CREATE INDEX idx_admin_audit_logs_target_user ON admin_audit_logs(target_user_id,created_at DESC) WHERE target_user_id IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS admin_audit_logs');
    await queryRunner.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await queryRunner.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin','content_manager'))`);
  }
}
