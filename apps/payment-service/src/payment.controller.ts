import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { successEnvelope } from '@movie/shared-dto';
import { PaymentGatewayGuard, PaymentInternalGuard } from './payment-auth.guard';
import { PaymentService } from './payment.service';
import { SubscribeDto } from './payment.dto';

interface PaymentRequest extends Request {
  requestId?: string;
  userId?: string;
  rawBody?: Buffer;
}

@Controller('subscriptions')
@UseGuards(PaymentGatewayGuard)
export class SubscriptionController {
  constructor(private readonly payment: PaymentService) {}

  @Get('plans')
  async plans() { return successEnvelope({ items: await this.payment.listPlans() }); }

  @Post('subscribe')
  @HttpCode(HttpStatus.CREATED)
  async subscribe(@Req() request: PaymentRequest, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() body: SubscribeDto) {
    if (!request.userId) throw new UnauthorizedException('Authenticated user context is required');
    return successEnvelope(await this.payment.subscribe(request.userId, idempotencyKey ?? '', body, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }

  @Get('current')
  async current(@Req() request: PaymentRequest) {
    if (!request.userId) throw new UnauthorizedException('Authenticated user context is required');
    return successEnvelope(await this.payment.current(request.userId), request.requestId ?? 'unknown');
  }
}

@Controller('payments')
export class PaymentWebhookController {
  constructor(private readonly payment: PaymentService) {}

  @Post('webhook/:provider')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('provider') provider: string,
    @Req() request: PaymentRequest,
    @Headers('x-payment-signature') signature: string | undefined,
  ) {
    return successEnvelope(await this.payment.handleWebhook(provider, request.rawBody ?? null, signature, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }
}

@Controller('internal/subscriptions')
@UseGuards(PaymentInternalGuard)
export class PaymentInternalController {
  constructor(private readonly payment: PaymentService) {}

  @Get('users/:userId/entitlement')
  async entitlement(@Param('userId', new ParseUUIDPipe()) userId: string, @Req() request: PaymentRequest) {
    return successEnvelope(await this.payment.entitlement(userId), request.requestId ?? 'unknown');
  }
}

@Controller()
export class PaymentHealthController {
  constructor(private readonly payment: PaymentService) {}

  @Get('health') health(@Req() request: PaymentRequest) { return successEnvelope({ status: 'ok', service: 'payment-service' }, request.requestId ?? 'unknown'); }
  @Get('ready') async ready(@Req() request: PaymentRequest) { await this.payment.pingDatabase(); return successEnvelope({ status: 'ready', service: 'payment-service', businessImplemented: true }, request.requestId ?? 'unknown'); }
}
