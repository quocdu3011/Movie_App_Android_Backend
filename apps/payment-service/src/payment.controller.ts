import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { successEnvelope } from '@movie/shared-dto';
import { PaymentAdminGuard, PaymentGatewayGuard, PaymentInternalGuard } from './payment-auth.guard';
import { PaymentService } from './payment.service';
import { SubscribeDto } from './payment.dto';

interface PaymentRequest extends Request {
  requestId?: string;
  userId?: string;
  rawBody?: Buffer;
  adminRole?: 'admin' | 'support';
  adminActorId?: string;
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

@Controller('admin')
@UseGuards(PaymentAdminGuard)
export class PaymentAdminController {
  constructor(private readonly payment: PaymentService) {}
  @Get('plans') async plans(@Req() request: PaymentRequest) { this.adminOnly(request); return successEnvelope(await this.payment.adminPlans(), request.requestId ?? 'unknown'); }
  @Post('plans') @HttpCode(HttpStatus.CREATED) async create(@Body() body: Record<string, unknown>, @Req() request: PaymentRequest) { this.adminOnly(request); this.requireReason(body.reason); return successEnvelope(await this.payment.createPlan(body), request.requestId ?? 'unknown'); }
  @Patch('plans/:planId') async patch(@Param('planId') planId: string, @Body() body: Record<string, unknown>, @Req() request: PaymentRequest) { this.adminOnly(request); this.requireReason(body.reason); return successEnvelope(await this.payment.patchPlan(planId, body), request.requestId ?? 'unknown'); }
  @Get('transactions') async transactions(@Query() query: Record<string, string | undefined>, @Req() request: PaymentRequest) { return successEnvelope(await this.payment.adminTransactions({ page: optionalNumber(query.page), pageSize: optionalNumber(query.pageSize), status: query.status, from: query.from, to: query.to }), request.requestId ?? 'unknown'); }
  @Get('users/:userId/subscriptions') async subscriptions(@Param('userId', new ParseUUIDPipe()) userId: string, @Req() request: PaymentRequest) { return successEnvelope(await this.payment.adminSubscriptions(userId), request.requestId ?? 'unknown'); }
  @Post('users/:userId/subscriptions/extend') @HttpCode(HttpStatus.OK) async extend(@Param('userId', new ParseUUIDPipe()) userId: string, @Body() body: { days?: number; reason?: string }, @Req() request: PaymentRequest) { this.adminOnly(request); if (!body.reason?.trim() || body.reason.trim().length < 10) throw new BadRequestException('Reason must be at least 10 characters'); return successEnvelope(await this.payment.extendSubscription(userId, Number(body.days)), request.requestId ?? 'unknown'); }
  @Get('overview/payment') async metrics(@Req() request: PaymentRequest) { return successEnvelope(await this.payment.adminMetrics(), request.requestId ?? 'unknown'); }

  private adminOnly(request: PaymentRequest): void {
    if (request.adminRole !== 'admin') throw new ForbiddenException('Administrator role required');
  }

  private requireReason(value: unknown): void {
    if (typeof value !== 'string' || value.trim().length < 10 || value.trim().length > 1000) throw new BadRequestException('Reason must be 10 to 1000 characters');
  }
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value.trim() === '' ? undefined : Number(value);
}

@Controller()
export class PaymentHealthController {
  constructor(private readonly payment: PaymentService) {}

  @Get('health') health(@Req() request: PaymentRequest) { return successEnvelope({ status: 'ok', service: 'payment-service' }, request.requestId ?? 'unknown'); }
  @Get('ready') async ready(@Req() request: PaymentRequest) { await this.payment.pingDatabase(); return successEnvelope({ status: 'ready', service: 'payment-service', businessImplemented: true }, request.requestId ?? 'unknown'); }
}
