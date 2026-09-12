import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentSchema1700000000004 implements MigrationInterface {
  name = 'CreatePaymentSchema1700000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE plans (
        id text PRIMARY KEY CHECK(length(btrim(id)) BETWEEN 1 AND 80),
        name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 160),
        price numeric(12,2) NOT NULL CHECK(price >= 0),
        currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
        duration_days integer NOT NULL CHECK(duration_days > 0),
        max_concurrent_streams integer NOT NULL CHECK(max_concurrent_streams > 0),
        max_resolution text NOT NULL CHECK(length(btrim(max_resolution)) BETWEEN 1 AND 20),
        active boolean NOT NULL DEFAULT true,
        version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE purchase_guards (
        user_id uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE subscriptions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        plan_id text NOT NULL REFERENCES plans(id),
        status text NOT NULL CHECK(status IN ('pending','active','expired','cancelled')),
        start_at timestamptz NULL,
        end_at timestamptz NULL,
        auto_renew boolean NOT NULL DEFAULT false CHECK(auto_renew=false),
        payment_expires_at timestamptz NULL,
        snapshot_name text NOT NULL,
        snapshot_price numeric(12,2) NOT NULL CHECK(snapshot_price >= 0),
        snapshot_currency char(3) NOT NULL CHECK(snapshot_currency ~ '^[A-Z]{3}$'),
        snapshot_duration_days integer NOT NULL CHECK(snapshot_duration_days > 0),
        snapshot_max_concurrent_streams integer NOT NULL CHECK(snapshot_max_concurrent_streams > 0),
        snapshot_max_resolution text NOT NULL,
        version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(start_at IS NULL OR end_at IS NULL OR end_at > start_at),
        CHECK((status='pending' AND start_at IS NULL AND end_at IS NULL AND payment_expires_at IS NOT NULL)
          OR (status='active' AND start_at IS NOT NULL AND end_at IS NOT NULL)
          OR status IN ('expired','cancelled'))
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_subscriptions_one_open_per_user ON subscriptions(user_id) WHERE status IN ('pending','active')`);
    await queryRunner.query(`CREATE INDEX idx_subscriptions_active_end ON subscriptions(end_at,user_id) WHERE status='active'`);
    await queryRunner.query(`CREATE INDEX idx_subscriptions_user_recent ON subscriptions(user_id,created_at DESC)`);
    await queryRunner.query(`
      CREATE TABLE payments (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        subscription_id uuid NOT NULL REFERENCES subscriptions(id),
        provider text NOT NULL,
        payment_method text NOT NULL,
        amount numeric(12,2) NOT NULL CHECK(amount >= 0),
        currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
        status text NOT NULL CHECK(status IN ('pending','success','failed','expired','reconciliation_required','refunded')),
        provider_transaction_id text NULL,
        payment_expires_at timestamptz NOT NULL,
        paid_at timestamptz NULL,
        version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_reconciled_at timestamptz NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX uq_payments_provider_transaction ON payments(provider,provider_transaction_id) WHERE provider_transaction_id IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX idx_payments_pending_expiry ON payments(payment_expires_at,id) WHERE status='pending'`);
    await queryRunner.query(`CREATE INDEX idx_payments_user_recent ON payments(user_id,created_at DESC)`);
    await queryRunner.query(`
      CREATE TABLE payment_requests (
        user_id uuid NOT NULL,
        idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
        request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
        payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id,idempotency_key)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE payment_webhook_receipts (
        provider text NOT NULL,
        event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 200),
        payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
        payment_id uuid NOT NULL REFERENCES payments(id),
        outcome text NOT NULL CHECK(outcome IN ('success','failed','expired','ignored','reconciliation_required')),
        response jsonb NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(provider,event_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_payment_receipts_payment ON payment_webhook_receipts(payment_id,received_at DESC)`);
    await queryRunner.query(`
      CREATE TABLE subscription_reminders (
        subscription_id uuid NOT NULL REFERENCES subscriptions(id),
        end_at timestamptz NOT NULL,
        reminder_type text NOT NULL CHECK(reminder_type IN ('3_days')),
        event_id uuid NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(subscription_id,end_at,reminder_type)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE mock_provider_orders (
        order_id uuid PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
        amount numeric(12,2) NOT NULL CHECK(amount >= 0),
        currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
        payment_method text NOT NULL,
        provider_status text NOT NULL CHECK(provider_status IN ('pending','succeeded','failed','expired')),
        provider_transaction_id text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        event_id uuid PRIMARY KEY,
        event_type text NOT NULL CHECK(event_type IN ('payment.success','payment.reconciliation_required','subscription.expiring')),
        aggregate_id uuid NOT NULL,
        aggregate_version bigint NOT NULL CHECK(aggregate_version > 0),
        occurred_at timestamptz NOT NULL,
        available_at timestamptz NOT NULL DEFAULT now(),
        locked_until timestamptz NULL,
        published_at timestamptz NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        last_error text NULL,
        envelope jsonb NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_payment_outbox_pending ON outbox_events(available_at,occurred_at) WHERE published_at IS NULL`);

    if (process.env.NODE_ENV !== 'production') {
      await queryRunner.query(`
        INSERT INTO plans(id,name,price,currency,duration_days,max_concurrent_streams,max_resolution,active)
        VALUES
          ('demo-monthly','Demo 30 ngày',49000.00,'VND',30,2,'1080p',true),
          ('demo-annual','Demo 365 ngày',399000.00,'VND',365,4,'4K',true)
        ON CONFLICT(id) DO NOTHING
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS outbox_events');
    await queryRunner.query('DROP TABLE IF EXISTS mock_provider_orders');
    await queryRunner.query('DROP TABLE IF EXISTS subscription_reminders');
    await queryRunner.query('DROP TABLE IF EXISTS payment_webhook_receipts');
    await queryRunner.query('DROP TABLE IF EXISTS payment_requests');
    await queryRunner.query('DROP TABLE IF EXISTS payments');
    await queryRunner.query('DROP TABLE IF EXISTS subscriptions');
    await queryRunner.query('DROP TABLE IF EXISTS purchase_guards');
    await queryRunner.query('DROP TABLE IF EXISTS plans');
  }
}
