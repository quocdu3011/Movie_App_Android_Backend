import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthSchema1700000000000 implements MigrationInterface {
  name = 'CreateAuthSchema1700000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text NOT NULL,
        full_name text NOT NULL,
        password_hash text NOT NULL,
        role varchar(32) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','content_manager')),
        status varchar(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned','deleted')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email))');
    await queryRunner.query(`
      CREATE TABLE auth_sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id text NOT NULL,
        device_name text NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_auth_sessions_user_active ON auth_sessions (user_id, expires_at) WHERE revoked_at IS NULL');
    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz NULL,
        revoked_at timestamptz NULL,
        replaced_by uuid NULL REFERENCES refresh_tokens(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_refresh_tokens_session ON refresh_tokens (session_id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS refresh_tokens');
    await queryRunner.query('DROP TABLE IF EXISTS auth_sessions');
    await queryRunner.query('DROP INDEX IF EXISTS uq_users_email_lower');
    await queryRunner.query('DROP TABLE IF EXISTS users');
  }
}
