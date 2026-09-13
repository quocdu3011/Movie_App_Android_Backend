import { MigrationInterface, QueryRunner } from 'typeorm';
export class CreateNotificationSchema1700000000008 implements MigrationInterface {
  name = 'CreateNotificationSchema1700000000008';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE notification_inbox_events (event_id uuid PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`);
    await queryRunner.query(`CREATE TABLE notification_deliveries (id uuid PRIMARY KEY, event_id uuid NOT NULL, recipient_id text NOT NULL, channel text NOT NULL CHECK(channel IN ('email','push')), event_type text NOT NULL, status text NOT NULL CHECK(status IN ('pending','processing','delivered','dlq')), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_retry_at timestamptz NOT NULL DEFAULT now(), last_error text NULL, payload jsonb NOT NULL, delivered_at timestamptz NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,recipient_id,channel))`);
    await queryRunner.query(`CREATE INDEX idx_notification_delivery_pending ON notification_deliveries(next_retry_at,id) WHERE status='pending'`);
  }
  async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query('DROP TABLE IF EXISTS notification_deliveries'); await queryRunner.query('DROP TABLE IF EXISTS notification_inbox_events'); }
}
