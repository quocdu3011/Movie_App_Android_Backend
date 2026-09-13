import { Controller, Get, Header, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { parseBearerToken } from '@movie/shared-auth';
import { successEnvelope } from '@movie/shared-dto';
import { NOTIFICATION_CONFIG, NotificationConfig, validGatewayToken } from './notification.config';
import { NotificationService } from './notification.service';

@Controller('internal/notifications')
export class NotificationController {
  constructor(@Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig, private readonly notification: NotificationService) {}
  @Post('dlq/:deliveryId/replay')
  @HttpCode(HttpStatus.NO_CONTENT)
  async replay(@Param('deliveryId', new ParseUUIDPipe()) deliveryId: string, @Req() request: Request): Promise<void> {
    if (request.header('x-caller-service') !== 'api-gateway' || !validGatewayToken(parseBearerToken(request.header('authorization') ?? undefined) ?? undefined, this.config)) throw new UnauthorizedException('API Gateway service authentication required');
    await this.notification.replay(deliveryId);
  }
}

@Controller()
export class NotificationHealthController {
  constructor(private readonly notification: NotificationService) {}
  @Get('health') health(@Req() request: Request & { requestId?: string }) { return successEnvelope({ status: 'ok', service: 'notification-service' }, request.requestId ?? 'unknown'); }
  @Get('ready') async ready(@Req() request: Request & { requestId?: string }) { await this.notification.ready(); return successEnvelope({ status: 'ready', service: 'notification-service' }, request.requestId ?? 'unknown'); }
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> { return this.notification.metrics(); }
}
