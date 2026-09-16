import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { EventEnvelope, MovieAppTopic } from '@movie/shared-kafka';
import { PAYMENT_CONFIG, PaymentConfig } from './payment.config';
import { SubscribeDto } from './payment.dto';

type PaymentState = 'pending' | 'success' | 'failed' | 'expired' | 'reconciliation_required' | 'refunded';

interface PlanRow {
  id: string; name: string; price: string; currency: string; duration_days: number;
  max_concurrent_streams: number; max_resolution: string; version: string;
}

interface PaymentOrderRow {
  payment_id: string; subscription_id: string; user_id: string; provider: string; payment_method: string;
  amount: string; currency: string; payment_status: PaymentState; payment_expires_at: Date;
  subscription_status: string; snapshot_name: string; snapshot_price: string; snapshot_currency: string;
  snapshot_duration_days: number; snapshot_max_concurrent_streams: number; snapshot_max_resolution: string;
  created_at: Date;
}

interface MockWebhookEvent {
  eventId?: unknown; orderId?: unknown; status?: unknown; amount?: unknown; currency?: unknown;
  providerTransactionId?: unknown;
}

function asRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return result as T[];
}

function normalizedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result ? result.slice(0, max) : null;
}

function cents(value: unknown): bigint | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : String(value ?? '').trim();
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

function publicPlan(row: PlanRow): Record<string, unknown> {
  return {
    id: row.id, name: row.name, price: Number(row.price), currency: row.currency.trim(), durationDays: row.duration_days,
    maxConcurrentStreams: row.max_concurrent_streams, maxResolution: row.max_resolution, version: Number(row.version),
  };
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {}

  async pingDatabase(): Promise<void> { await this.dataSource.query('SELECT 1'); }

  async listPlans() {
    const rows = await this.dataSource.query(`SELECT id,name,price::text AS price,currency,duration_days,max_concurrent_streams,max_resolution,version FROM plans WHERE active=true ORDER BY price,id`) as PlanRow[];
    return rows.map(publicPlan);
  }

  async adminPlans() {
    const rows = await this.dataSource.query(`SELECT id,name,price::text AS price,currency,duration_days AS "durationDays",max_concurrent_streams AS "maxConcurrentStreams",max_resolution AS "maxResolution",active,version::text AS version,created_at AS "createdAt",updated_at AS "updatedAt" FROM plans ORDER BY price,id`);
    return { items: rows };
  }

  async createPlan(input: Record<string, unknown>) {
    const id = normalizedText(input.id, 80) ?? `plan-${randomUUID()}`; const name = normalizedText(input.name, 160); const currency = normalizedText(input.currency, 3)?.toUpperCase() ?? 'VND';
    const price = cents(input.price); const durationDays = Number(input.durationDays); const streams = Number(input.maxConcurrentStreams); const resolution = normalizedText(input.maxResolution, 20);
    if (!name || price === null || price < 0n || !/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(durationDays) || durationDays < 1 || !Number.isSafeInteger(streams) || streams < 1 || !resolution) throw new BadRequestException('Plan input is invalid');
    try {
      const rows = await this.dataSource.query(`INSERT INTO plans(id,name,price,currency,duration_days,max_concurrent_streams,max_resolution,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,price::text AS price,currency,duration_days AS "durationDays",max_concurrent_streams AS "maxConcurrentStreams",max_resolution AS "maxResolution",active,version::text AS version`, [id, name, (Number(price) / 100).toFixed(2), currency, durationDays, streams, resolution, input.active !== false]);
      return rows[0];
    } catch (error) { if (this.isUniqueViolation(error)) throw new ConflictException('Plan id already exists'); throw error; }
  }

  async patchPlan(planId: string, input: Record<string, unknown>) {
    const allowed: Array<[string, unknown]> = [['name', input.name === undefined ? undefined : normalizedText(input.name, 160)], ['price', input.price === undefined ? undefined : cents(input.price)], ['currency', input.currency === undefined ? undefined : normalizedText(input.currency, 3)?.toUpperCase()], ['duration_days', input.durationDays === undefined ? undefined : Number(input.durationDays)], ['max_concurrent_streams', input.maxConcurrentStreams === undefined ? undefined : Number(input.maxConcurrentStreams)], ['max_resolution', input.maxResolution === undefined ? undefined : normalizedText(input.maxResolution, 20)], ['active', input.active]];
    const fields: string[] = []; const values: unknown[] = [];
    for (const [column, value] of allowed) {
      if (value === undefined) continue;
      if (value === null || value === '' || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) || (column === 'currency' && (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value))) || (['duration_days', 'max_concurrent_streams'].includes(column) && (typeof value !== 'number' || value < 1))) throw new BadRequestException('Plan update is invalid');
      values.push(column === 'price' ? (Number(value as bigint) / 100).toFixed(2) : value); fields.push(`${column}=$${values.length}`);
    }
    if (!fields.length) throw new BadRequestException('No plan changes supplied');
    values.push(planId); const rows = await this.dataSource.query(`UPDATE plans SET ${fields.join(',')},version=version+1,updated_at=now() WHERE id=$${values.length} RETURNING id,name,price::text AS price,currency,duration_days AS "durationDays",max_concurrent_streams AS "maxConcurrentStreams",max_resolution AS "maxResolution",active,version::text AS version`, values);
    if (!rows[0]) throw new NotFoundException('Plan not found'); return rows[0];
  }

  async adminTransactions(query: { page?: number; pageSize?: number; status?: string; from?: string; to?: string; }) {
    const page = Math.max(1, Math.floor(query.page ?? 1)); const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25))); const values: unknown[] = []; const where: string[] = [];
    if (query.status?.trim()) { values.push(query.status.trim()); where.push(`p.status=$${values.length}`); }
    if (query.from?.trim()) { values.push(query.from); where.push(`p.created_at >= $${values.length}::timestamptz`); }
    if (query.to?.trim()) { values.push(query.to); where.push(`p.created_at <= $${values.length}::timestamptz`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.dataSource.query(`SELECT count(*)::int AS count FROM payments p ${clause}`, values) as Array<{ count: number }>;
    values.push(pageSize, (page - 1) * pageSize);
    const items = await this.dataSource.query(`SELECT p.id,p.user_id AS "userId",p.subscription_id AS "subscriptionId",p.provider,p.payment_method AS "paymentMethod",p.amount::text AS amount,p.currency,p.status,p.provider_transaction_id AS "providerTransactionId",p.created_at AS "createdAt",p.paid_at AS "paidAt" FROM payments p ${clause} ORDER BY p.created_at DESC,p.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items, page, pageSize, totalItems: count[0]?.count ?? 0 };
  }

  async adminSubscriptions(userId: string) {
    const items = await this.dataSource.query(`SELECT id,plan_id AS "planId",status,start_at AS "startAt",end_at AS "endAt",snapshot_name AS "planName",snapshot_duration_days AS "durationDays",created_at AS "createdAt" FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC`, [userId]); return { items };
  }

  async extendSubscription(userId: string, days: number) {
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new BadRequestException('Extension days must be 1 to 3650');
    const rows = await this.dataSource.query(`UPDATE subscriptions SET end_at=end_at+($2 || ' days')::interval,version=version+1,updated_at=now() WHERE user_id=$1 AND status='active' AND end_at>now() RETURNING id,end_at AS "endAt"`, [userId, String(days)]);
    if (!rows[0]) throw new NotFoundException('Active subscription not found'); return rows[0];
  }

  async adminMetrics() {
    const rows = await this.dataSource.query(`SELECT count(*) FILTER (WHERE status='active' AND end_at>now())::int AS active, count(*) FILTER (WHERE status='pending')::int AS pending FROM subscriptions`) as Array<{ active: number; pending: number }>;
    return { activeSubscriptions: rows[0]?.active ?? 0, pendingSubscriptions: rows[0]?.pending ?? 0 };
  }

  async subscribe(userId: string, idempotencyKey: string, input: SubscribeDto, requestId: string) {
    if (!userId) throw new UnauthorizedException('Authenticated user context is required');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new UnauthorizedException('Authenticated user context is invalid');
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey)) throw new BadRequestException('Idempotency-Key must be 8 to 120 safe characters');
    if (!this.config.mockEnabled) throw new ServiceUnavailableException('No payment provider is configured');
    const planId = normalizedText(input.planId, 80);
    const paymentMethod = input.paymentMethod;
    if (!planId || !['card', 'wallet', 'bank_transfer'].includes(paymentMethod)) throw new BadRequestException('Payment request is invalid');
    const requestHash = createHash('sha256').update(JSON.stringify({ planId, paymentMethod })).digest('hex');

    const result = await this.dataSource.transaction(async (manager) => {
      await manager.query(`INSERT INTO purchase_guards(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, [userId]);
      await manager.query(`SELECT user_id FROM purchase_guards WHERE user_id=$1 FOR UPDATE`, [userId]);

      const existingRequests = await manager.query(`SELECT request_hash,payment_id FROM payment_requests WHERE user_id=$1 AND idempotency_key=$2`, [userId, idempotencyKey]) as Array<{ request_hash: string; payment_id: string }>;
      if (existingRequests[0]) {
        if (existingRequests[0].request_hash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency-Key was already used for a different request' });
        const existing = await this.orderByPayment(manager, existingRequests[0].payment_id);
        if (!existing) throw new ConflictException({ code: 'PAYMENT_ORDER_MISSING', message: 'Idempotent payment order is unavailable' });
        return { order: existing, replay: true };
      }

      await manager.query(`UPDATE subscriptions SET status='expired',version=version+1,updated_at=now() WHERE user_id=$1 AND status='active' AND end_at<=now()`, [userId]);
      const open = await manager.query(`SELECT id,status FROM subscriptions WHERE user_id=$1 AND status IN ('pending','active') LIMIT 1 FOR UPDATE`, [userId]) as Array<{ id: string; status: string }>;
      if (open[0]) throw new ConflictException({ code: 'SUBSCRIPTION_ALREADY_OPEN', message: open[0].status === 'active' ? 'An active subscription already exists' : 'A payment is already pending for this user' });

      const plans = await manager.query(`SELECT id,name,price::text AS price,currency,duration_days,max_concurrent_streams,max_resolution,version FROM plans WHERE id=$1 AND active=true FOR SHARE`, [planId]) as PlanRow[];
      const plan = plans[0];
      if (!plan) throw new NotFoundException('Active plan not found');
      const subscriptionId = randomUUID();
      const paymentId = randomUUID();
      const inserted = await manager.query(`
        INSERT INTO subscriptions(id,user_id,plan_id,status,payment_expires_at,snapshot_name,snapshot_price,snapshot_currency,snapshot_duration_days,snapshot_max_concurrent_streams,snapshot_max_resolution)
        VALUES($1,$2,$3,'pending',now()+($4 || ' minutes')::interval,$5,$6,$7,$8,$9,$10)
        RETURNING payment_expires_at
      `, [subscriptionId, userId, plan.id, this.config.pendingTtlMinutes, plan.name, plan.price, plan.currency, plan.duration_days, plan.max_concurrent_streams, plan.max_resolution]) as Array<{ payment_expires_at: Date }>;
      const expiresAt = inserted[0]?.payment_expires_at;
      if (!expiresAt) throw new Error('Payment expiry was not created');
      await manager.query(`
        INSERT INTO payments(id,user_id,subscription_id,provider,payment_method,amount,currency,status,payment_expires_at)
        VALUES($1,$2,$3,'mock',$4,$5,$6,'pending',$7)
      `, [paymentId, userId, subscriptionId, paymentMethod, plan.price, plan.currency, expiresAt]);
      await manager.query(`INSERT INTO payment_requests(user_id,idempotency_key,request_hash,payment_id) VALUES($1,$2,$3,$4)`, [userId, idempotencyKey, requestHash, paymentId]);
      const order = await this.orderByPayment(manager, paymentId);
      if (!order) throw new Error('Created payment order could not be read');
      return { order, replay: false };
    });

    // Provider setup is intentionally after commit. A retry with the same key reuses
    // the same order and safely retries createOrder if the provider was unavailable.
    await this.ensureMockOrder(result.order);
    return { ...this.publicOrder(result.order), idempotentReplay: result.replay, requestId };
  }

  async current(userId: string) {
    if (!userId) throw new UnauthorizedException('Authenticated user context is required');
    const rows = await this.dataSource.query(`
      SELECT s.id AS "subscriptionId",s.status,s.start_at AS "startAt",s.end_at AS "endAt",s.auto_renew AS "autoRenew",
        s.snapshot_name AS "planName",s.snapshot_price::text AS "price",s.snapshot_currency AS currency,
        s.snapshot_duration_days AS "durationDays",s.snapshot_max_concurrent_streams AS "maxConcurrentStreams",s.snapshot_max_resolution AS "maxResolution",
        p.id AS "paymentId",p.status AS "paymentStatus",p.payment_method AS "paymentMethod",p.payment_expires_at AS "paymentExpiresAt",p.created_at AS "createdAt"
      FROM subscriptions s JOIN payments p ON p.subscription_id=s.id
      WHERE s.user_id=$1 AND (s.status='pending' OR (s.status='active' AND s.end_at>now()))
      ORDER BY s.created_at DESC LIMIT 1
    `, [userId]) as Array<Record<string, unknown>>;
    return rows[0] ? this.publicCurrent(rows[0]) : null;
  }

  async entitlement(userId: string) {
    const rows = await this.dataSource.query(`
      SELECT id AS "subscriptionId",plan_id AS "planId",snapshot_name AS "planName",start_at AS "startAt",end_at AS "endAt",
        snapshot_max_concurrent_streams AS "maxConcurrentStreams",snapshot_max_resolution AS "maxResolution"
      FROM subscriptions WHERE user_id=$1 AND status='active' AND end_at>now() ORDER BY end_at DESC,id LIMIT 1
    `, [userId]) as Array<Record<string, unknown>>;
    if (!rows[0]) return {
      hasSubscription: false, tier: 'free', subscriptionId: null, planId: null, planName: null,
      startAt: null, endAt: null,
      limits: { maxConcurrentStreams: this.config.freeMaxConcurrentStreams, maxResolution: this.config.freeMaxResolution },
    };
    return {
      hasSubscription: true, tier: 'subscription', subscriptionId: rows[0].subscriptionId, planId: rows[0].planId,
      planName: rows[0].planName, startAt: rows[0].startAt, endAt: rows[0].endAt,
      limits: { maxConcurrentStreams: Number(rows[0].maxConcurrentStreams), maxResolution: rows[0].maxResolution },
    };
  }

  async handleWebhook(provider: string, rawBody: Buffer | null, signature: string | undefined, requestId: string) {
    if (provider !== 'mock' || !this.config.mockEnabled || !this.config.mockHmacSecret) throw new NotFoundException('Payment provider is unavailable');
    if (!rawBody || rawBody.length === 0 || rawBody.length > 65_536) throw new BadRequestException('Webhook body is missing or too large');
    if (!this.validSignature(rawBody, signature)) throw new UnauthorizedException('Invalid webhook signature');

    let event: MockWebhookEvent;
    try { event = JSON.parse(rawBody.toString('utf8')) as MockWebhookEvent; } catch { throw new BadRequestException('Webhook payload is invalid JSON'); }
    const eventId = normalizedText(event.eventId, 200);
    const orderId = normalizedText(event.orderId, 36);
    const rawState = normalizedText(event.status, 16);
    const currency = normalizedText(event.currency, 3)?.toUpperCase();
    const amount = cents(event.amount);
    const providerTransactionId = normalizedText(event.providerTransactionId, 200);
    if (!eventId || !orderId || !/^[0-9a-f-]{36}$/i.test(orderId) || !rawState || !['success', 'failed', 'expired'].includes(rawState) || !currency || !/^[A-Z]{3}$/.test(currency) || amount === null) {
      throw new BadRequestException('Webhook fields are invalid');
    }
    const state = rawState as 'success' | 'failed' | 'expired';
    if (state === 'success' && !providerTransactionId) throw new BadRequestException('Successful webhook requires providerTransactionId');
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const orderUsers = await this.dataSource.query(`SELECT user_id FROM payments WHERE id=$1`, [orderId]) as Array<{ user_id: string }>;
    if (!orderUsers[0]) throw new NotFoundException('Payment order not found');

    return this.dataSource.transaction(async (manager) => {
      const userId = orderUsers[0].user_id;
      await manager.query(`INSERT INTO purchase_guards(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, [userId]);
      await manager.query(`SELECT user_id FROM purchase_guards WHERE user_id=$1 FOR UPDATE`, [userId]);
      const prior = await manager.query(`SELECT payload_hash,response FROM payment_webhook_receipts WHERE provider=$1 AND event_id=$2`, [provider, eventId]) as Array<{ payload_hash: string; response: Record<string, unknown> }>;
      if (prior[0]) {
        if (prior[0].payload_hash !== payloadHash) throw new ConflictException({ code: 'WEBHOOK_EVENT_ID_REUSED', message: 'Webhook eventId was already used for a different payload' });
        return { ...prior[0].response, duplicate: true, requestId };
      }

      const paymentRows = await manager.query(`
        SELECT p.id,p.user_id,p.subscription_id,p.provider,p.amount::text AS amount,p.currency,p.status,p.payment_expires_at,p.provider_transaction_id,
          s.status AS subscription_status,s.snapshot_duration_days,s.version AS subscription_version
        FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE p.id=$1 FOR UPDATE OF p,s
      `, [orderId]) as Array<Record<string, unknown>>;
      const payment = paymentRows[0];
      if (!payment) throw new NotFoundException('Payment order not found');
      if (payment.provider !== provider) throw new ConflictException({ code: 'WEBHOOK_PROVIDER_MISMATCH', message: 'Webhook provider does not match payment order' });
      if (cents(payment.amount) !== amount || String(payment.currency).trim() !== currency) throw new ConflictException({ code: 'WEBHOOK_AMOUNT_MISMATCH', message: 'Webhook amount or currency does not match payment order' });

      const existingTransaction = providerTransactionId
        ? await manager.query(`SELECT id FROM payments WHERE provider=$1 AND provider_transaction_id=$2 AND id<>$3 LIMIT 1`, [provider, providerTransactionId, orderId]) as Array<{ id: string }>
        : [];
      if (existingTransaction[0]) throw new ConflictException({ code: 'PROVIDER_TRANSACTION_REUSED', message: 'Provider transaction is already linked to another order' });

      let outcome: 'success' | 'failed' | 'expired' | 'ignored' | 'reconciliation_required' = 'ignored';
      let response: Record<string, unknown>;
      const currentStatus = String(payment.status) as PaymentState;
      if (state === 'success') {
        if (currentStatus === 'success') {
          if (payment.provider_transaction_id && payment.provider_transaction_id !== providerTransactionId) throw new ConflictException({ code: 'PROVIDER_TRANSACTION_CONFLICT', message: 'Paid order has a different provider transaction' });
          response = { received: true, paymentId: orderId, status: 'success', duplicate: true };
        } else if (currentStatus !== 'pending' || new Date(String(payment.payment_expires_at)).getTime() <= Date.now() || payment.subscription_status !== 'pending' || await this.hasOtherActiveSubscription(manager, userId, String(payment.subscription_id))) {
          outcome = 'reconciliation_required';
          await manager.query(`UPDATE payments SET status='reconciliation_required',provider_transaction_id=$2,version=version+1,updated_at=now() WHERE id=$1`, [orderId, providerTransactionId]);
          await manager.query(`UPDATE subscriptions SET status='cancelled',payment_expires_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND status='pending'`, [payment.subscription_id]);
          await manager.query(`UPDATE mock_provider_orders SET provider_status='succeeded',provider_transaction_id=$2,updated_at=now() WHERE order_id=$1`, [orderId, providerTransactionId]);
          const updated = await manager.query(`SELECT version FROM payments WHERE id=$1`, [orderId]) as Array<{ version: string }>;
          await this.writeEvent(manager, 'payment.reconciliation_required', orderId, String(updated[0]?.version ?? 1), requestId, {
            paymentId: orderId, subscriptionId: payment.subscription_id, userId, providerTransactionId,
          });
          response = { received: true, paymentId: orderId, status: 'reconciliation_required', duplicate: false };
        } else {
          outcome = 'success';
          const activated = asRows<{ version: string }>(await manager.query(`
            UPDATE subscriptions SET status='active',start_at=now(),end_at=now()+(snapshot_duration_days || ' days')::interval,
              payment_expires_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND status='pending' RETURNING version
          `, [payment.subscription_id]));
          if (!activated[0]) throw new ConflictException({ code: 'SUBSCRIPTION_STATE_CONFLICT', message: 'Subscription state changed while processing payment' });
          await manager.query(`UPDATE payments SET status='success',provider_transaction_id=$2,paid_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND status='pending'`, [orderId, providerTransactionId]);
          await manager.query(`UPDATE mock_provider_orders SET provider_status='succeeded',provider_transaction_id=$2,updated_at=now() WHERE order_id=$1`, [orderId, providerTransactionId]);
          await this.writeEvent(manager, 'payment.success', String(payment.subscription_id), String(activated[0].version), requestId, {
            userId, subscriptionId: payment.subscription_id, paymentId: orderId,
          });
          response = { received: true, paymentId: orderId, subscriptionId: payment.subscription_id, status: 'success', duplicate: false };
        }
      } else if (currentStatus === 'pending') {
        outcome = state;
        await manager.query(`UPDATE payments SET status=$2,version=version+1,updated_at=now() WHERE id=$1 AND status='pending'`, [orderId, state]);
        await manager.query(`UPDATE subscriptions SET status='cancelled',payment_expires_at=NULL,version=version+1,updated_at=now() WHERE id=$1 AND status='pending'`, [payment.subscription_id]);
        await manager.query(`UPDATE mock_provider_orders SET provider_status=$2,updated_at=now() WHERE order_id=$1`, [orderId, state === 'failed' ? 'failed' : 'expired']);
        response = { received: true, paymentId: orderId, status: state, duplicate: false };
      } else {
        response = { received: true, paymentId: orderId, status: currentStatus, ignored: true, duplicate: false };
      }

      await manager.query(`INSERT INTO payment_webhook_receipts(provider,event_id,payload_hash,payment_id,outcome,response) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [provider, eventId, payloadHash, orderId, outcome, JSON.stringify(response)]);
      return { ...response, requestId };
    });
  }

  async reconcileExpiredPending(): Promise<number> {
    if (!this.config.mockEnabled) return 0;
    const candidates = await this.dataSource.query(`
      SELECT p.id,p.user_id,o.provider_status FROM payments p
      JOIN mock_provider_orders o ON o.order_id=p.id
      WHERE p.status='pending' AND p.payment_expires_at<=now() AND o.provider_status IN ('failed','expired')
      ORDER BY p.payment_expires_at,p.id LIMIT 50
    `) as Array<{ id: string; user_id: string; provider_status: 'failed' | 'expired' }>;
    let closed = 0;
    for (const candidate of candidates) {
      const didClose = await this.dataSource.transaction(async (manager) => {
        await manager.query(`INSERT INTO purchase_guards(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING`, [candidate.user_id]);
        await manager.query(`SELECT user_id FROM purchase_guards WHERE user_id=$1 FOR UPDATE`, [candidate.user_id]);
        const updated = asRows<{ id: string }>(await manager.query(`
          UPDATE payments SET status=$2,version=version+1,last_reconciled_at=now(),updated_at=now()
          WHERE id=$1 AND status='pending' AND payment_expires_at<=now() RETURNING id
        `, [candidate.id, candidate.provider_status]));
        if (!updated[0]) return false;
        await manager.query(`UPDATE subscriptions SET status='cancelled',payment_expires_at=NULL,version=version+1,updated_at=now() WHERE id=(SELECT subscription_id FROM payments WHERE id=$1) AND status='pending'`, [candidate.id]);
        return true;
      });
      if (didClose) closed += 1;
    }
    return closed;
  }

  async expireSubscriptionsAndRemind(): Promise<{ expired: number; reminders: number }> {
    return this.dataSource.transaction(async (manager) => {
      const expired = asRows<{ id: string }>(await manager.query(`
        UPDATE subscriptions SET status='expired',version=version+1,updated_at=now()
        WHERE status='active' AND end_at<=now() RETURNING id
      `));
      const due = await manager.query(`
        SELECT id,user_id,end_at,version FROM subscriptions s
        WHERE status='active' AND end_at>now() AND end_at<=now()+interval '3 days'
          AND NOT EXISTS(SELECT 1 FROM subscription_reminders r WHERE r.subscription_id=s.id AND r.end_at=s.end_at AND r.reminder_type='3_days')
        ORDER BY end_at,id LIMIT 100 FOR UPDATE OF s SKIP LOCKED
      `) as Array<{ id: string; user_id: string; end_at: Date; version: string }>;
      let reminders = 0;
      for (const subscription of due) {
        const eventId = randomUUID();
        const inserted = asRows<{ subscription_id: string }>(await manager.query(`
          INSERT INTO subscription_reminders(subscription_id,end_at,reminder_type,event_id)
          VALUES($1,$2,'3_days',$3) ON CONFLICT(subscription_id,end_at,reminder_type) DO NOTHING RETURNING subscription_id
        `, [subscription.id, subscription.end_at, eventId]));
        if (!inserted[0]) continue;
        await this.writeEvent(manager, 'subscription.expiring', subscription.id, subscription.version, eventId, {
          userId: subscription.user_id, subscriptionId: subscription.id, endAt: subscription.end_at, reminderType: '3_days',
        }, eventId);
        reminders += 1;
      }
      return { expired: expired.length, reminders };
    });
  }

  private async hasOtherActiveSubscription(manager: EntityManager, userId: string, subscriptionId: string): Promise<boolean> {
    const rows = await manager.query(`SELECT id FROM subscriptions WHERE user_id=$1 AND id<>$2 AND status='active' AND end_at>now() LIMIT 1`, [userId, subscriptionId]) as Array<{ id: string }>;
    return rows.length > 0;
  }

  private validSignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!this.config.mockHmacSecret || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
    const expected = Buffer.from(`sha256=${createHmac('sha256', this.config.mockHmacSecret).update(rawBody).digest('hex')}`);
    const supplied = Buffer.from(signature);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
  }

  private async ensureMockOrder(order: PaymentOrderRow): Promise<void> {
    if (!this.config.mockEnabled) throw new ServiceUnavailableException('No payment provider is configured');
    await this.dataSource.query(`
      INSERT INTO mock_provider_orders(order_id,amount,currency,payment_method,provider_status)
      VALUES($1,$2,$3,$4,'pending') ON CONFLICT(order_id) DO NOTHING
    `, [order.payment_id, order.amount, order.currency, order.payment_method]);
    const rows = await this.dataSource.query(`SELECT amount::text AS amount,currency,payment_method FROM mock_provider_orders WHERE order_id=$1`, [order.payment_id]) as Array<{ amount: string; currency: string; payment_method: string }>;
    if (!rows[0] || cents(rows[0].amount) !== cents(order.amount) || rows[0].currency.trim() !== order.currency.trim() || rows[0].payment_method !== order.payment_method) {
      throw new ConflictException({ code: 'MOCK_PROVIDER_ORDER_CONFLICT', message: 'Mock provider order does not match the payment snapshot' });
    }
  }

  private async orderByPayment(manager: EntityManager, paymentId: string): Promise<PaymentOrderRow | null> {
    const rows = await manager.query(`
      SELECT p.id AS payment_id,p.subscription_id,p.user_id,p.provider,p.payment_method,p.amount::text AS amount,p.currency,p.status AS payment_status,p.payment_expires_at,
        s.status AS subscription_status,s.snapshot_name,s.snapshot_price::text AS snapshot_price,s.snapshot_currency,s.snapshot_duration_days,
        s.snapshot_max_concurrent_streams,s.snapshot_max_resolution,p.created_at
      FROM payments p JOIN subscriptions s ON s.id=p.subscription_id WHERE p.id=$1
    `, [paymentId]) as PaymentOrderRow[];
    return rows[0] ?? null;
  }

  private publicOrder(order: PaymentOrderRow): Record<string, unknown> {
    return {
      paymentId: order.payment_id, orderId: order.payment_id, subscriptionId: order.subscription_id,
      status: order.payment_status, paymentExpiresAt: order.payment_expires_at,
      amount: Number(order.amount), currency: order.currency.trim(), paymentMethod: order.payment_method,
      planSnapshot: {
        name: order.snapshot_name, price: Number(order.snapshot_price), currency: order.snapshot_currency.trim(),
        durationDays: order.snapshot_duration_days, maxConcurrentStreams: order.snapshot_max_concurrent_streams,
        maxResolution: order.snapshot_max_resolution,
      },
      provider: { name: order.provider, orderId: order.payment_id, status: order.payment_status },
    };
  }

  private publicCurrent(row: Record<string, unknown>): Record<string, unknown> {
    return {
      subscriptionId: row.subscriptionId, status: row.status, startAt: row.startAt, endAt: row.endAt,
      autoRenew: row.autoRenew, plan: {
        name: row.planName, price: Number(row.price), currency: String(row.currency).trim(), durationDays: row.durationDays,
        maxConcurrentStreams: row.maxConcurrentStreams, maxResolution: row.maxResolution,
      },
      payment: { paymentId: row.paymentId, status: row.paymentStatus, method: row.paymentMethod, expiresAt: row.paymentExpiresAt, createdAt: row.createdAt },
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
    return candidate.code === '23505' || candidate.driverError?.code === '23505';
  }

  private async writeEvent<TPayload>(
    manager: EntityManager,
    eventType: Extract<MovieAppTopic, 'payment.success' | 'payment.reconciliation_required' | 'subscription.expiring'>,
    aggregateId: string,
    aggregateVersion: string,
    correlationId: string,
    payload: TPayload,
    eventId = randomUUID(),
  ): Promise<void> {
    const envelope: EventEnvelope<TPayload> = {
      eventId, eventType, schemaVersion: 1, aggregateId, aggregateVersion,
      occurredAt: new Date().toISOString(), producer: 'payment-service', correlationId, payload,
    };
    await manager.query(`INSERT INTO outbox_events(event_id,event_type,aggregate_id,aggregate_version,occurred_at,envelope) VALUES($1,$2,$3,$4,now(),$5::jsonb)`, [eventId, eventType, aggregateId, aggregateVersion, JSON.stringify(envelope)]);
  }
}
