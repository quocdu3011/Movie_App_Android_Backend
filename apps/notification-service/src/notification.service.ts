import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NOTIFICATION_CONFIG, NotificationConfig } from './notification.config';

interface DeliveryPolicy { recipientId: string; channel: 'email' | 'push' }

function returnedRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  // The PostgreSQL driver used by TypeORM returns [rows, affectedCount] for
  // statements with RETURNING, while some driver versions return rows directly.
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return result as T[];
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private timer?: NodeJS.Timeout;
  private processing = false;
  constructor(@InjectDataSource() private readonly dataSource: DataSource, @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig) {}
  async ready(): Promise<void> { await this.dataSource.query('SELECT 1'); }
  async metrics(): Promise<string> {
    const rows = returnedRows<{ status: string; count: string }>(await this.dataSource.query(`SELECT status, count(*)::text AS count FROM notification_deliveries GROUP BY status ORDER BY status`));
    return ['# HELP movieapp_notification_deliveries Durable notification deliveries by processing status.', '# TYPE movieapp_notification_deliveries gauge', ...rows.map((row) => `movieapp_notification_deliveries{status="${row.status}"} ${row.count}`), ''].join('\n');
  }
  start(): void { this.timer = setInterval(() => void this.deliver(), this.config.pollMs); this.timer.unref(); void this.deliver(); }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  async receive(event: { eventId: string; eventType: string; payload: Record<string, unknown> }): Promise<void> {
    const policies = this.policy(event.eventType, event.payload);
    await this.dataSource.transaction(async (manager) => {
      const inbox = returnedRows<{ event_id: string }>(await manager.query(`INSERT INTO notification_inbox_events(event_id,event_type) VALUES($1,$2) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`, [event.eventId, event.eventType]));
      if (!inbox.length) return;
      for (const policy of policies) await manager.query(`INSERT INTO notification_deliveries(id,event_id,recipient_id,channel,event_type,status,payload) VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb) ON CONFLICT(event_id,recipient_id,channel) DO NOTHING`, [randomUUID(), event.eventId, policy.recipientId, policy.channel, event.eventType, JSON.stringify({ eventType: event.eventType })]);
    });
  }

  async replay(deliveryId: string): Promise<void> {
    const result = returnedRows<{ id: string }>(await this.dataSource.query(`UPDATE notification_deliveries SET status='pending',attempts=0,next_retry_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND status='dlq' RETURNING id`, [deliveryId]));
    if (!result.length) throw new NotFoundException('DLQ delivery not found');
  }

  private policy(eventType: string, payload: Record<string, unknown>): DeliveryPolicy[] {
    if (eventType === 'payment.success' && typeof payload.userId === 'string') return [{ recipientId: payload.userId, channel: 'email' }];
    if (eventType === 'subscription.expiring' && typeof payload.userId === 'string') return [{ recipientId: payload.userId, channel: 'push' }, { recipientId: payload.userId, channel: 'email' }];
    if (eventType === 'movie.published') return [{ recipientId: 'catalog-announcements', channel: 'push' }];
    if (eventType === 'video.transcode_failed') return [{ recipientId: 'content-admins', channel: 'email' }];
    return [];
  }

  private async deliver(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const rows = returnedRows<{ id: string; recipient_id: string; channel: string; event_type: string; attempts: number }>(await this.dataSource.query(`WITH candidates AS (SELECT id FROM notification_deliveries WHERE status='pending' AND next_retry_at<=now() ORDER BY next_retry_at,id LIMIT 20 FOR UPDATE SKIP LOCKED) UPDATE notification_deliveries d SET status='processing',attempts=attempts+1,updated_at=now() FROM candidates c WHERE d.id=c.id RETURNING d.id,d.recipient_id,d.channel,d.event_type,d.attempts`));
      for (const row of rows) {
        const failure = this.config.mockFailRecipients.has(row.recipient_id);
        if (!failure) {
          await this.dataSource.query(`UPDATE notification_deliveries SET status='delivered',delivered_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`, [row.id]);
          this.logger.log(`Mock notification delivered id=${row.id} channel=${row.channel} event=${row.event_type}`);
        } else if (row.attempts >= this.config.maxAttempts) await this.dataSource.query(`UPDATE notification_deliveries SET status='dlq',last_error='mock_delivery_failed',updated_at=now() WHERE id=$1`, [row.id]);
        else await this.dataSource.query(`UPDATE notification_deliveries SET status='pending',next_retry_at=now()+($2 || ' milliseconds')::interval,last_error='mock_delivery_failed',updated_at=now() WHERE id=$1`, [row.id, 50 * 2 ** row.attempts]);
      }
    } finally { this.processing = false; }
  }
}
