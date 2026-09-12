import { Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { PublicRoute } from '@movie/shared-auth';
import { Request, Response } from 'express';
import { errorEnvelope } from '@movie/shared-dto';
import { AuthenticatedRequest } from '../auth/access-auth.guard';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { Inject } from '@nestjs/common';

interface PaymentGatewayRequest extends AuthenticatedRequest { rawBody?: Buffer }

abstract class PaymentProxyBase {
  constructor(@Inject(GATEWAY_CONFIG) protected readonly config: GatewayConfig) {}

  protected async forward(method: string, path: string, body: unknown, request: AuthenticatedRequest, response: Response): Promise<void> {
    const session = request.authSession;
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.config.paymentUrl}${path}`, {
        method, redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.config.serviceToken}`,
          'x-caller-service': 'api-gateway',
          ...(session?.active && session.userId ? { 'x-user-id': session.userId } : {}),
          'x-request-id': request.requestId ?? 'unknown',
          ...(request.headers['idempotency-key'] ? { 'idempotency-key': String(request.headers['idempotency-key']) } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      response.status(503).json(errorEnvelope({ code: 'PAYMENT_UNAVAILABLE', message: 'Payment service unavailable' }, request.requestId ?? 'unknown'));
      return;
    }
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-request-id', request.requestId ?? 'unknown');
    response.status(upstream.status);
    if (upstream.status === 204) { response.end(); return; }
    response.send(Buffer.from(await upstream.arrayBuffer()));
  }
}

@Controller('subscriptions')
export class SubscriptionProxyController extends PaymentProxyBase {
  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) { super(config); }

  @Get('plans')
  @PublicRoute()
  plans(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', '/subscriptions/plans', undefined, request, response);
  }

  @Post('subscribe')
  @HttpCode(HttpStatus.CREATED)
  subscribe(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('POST', '/subscriptions/subscribe', request.body, request, response);
  }

  @Get('current')
  current(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', '/subscriptions/current', undefined, request, response);
  }
}

@Controller('payments')
export class PaymentWebhookProxyController extends PaymentProxyBase {
  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) { super(config); }

  @Post('webhook/:provider')
  @PublicRoute()
  @HttpCode(HttpStatus.OK)
  async webhook(@Param('provider') provider: string, @Req() request: RawBodyRequest<Request> & PaymentGatewayRequest, @Res() response: Response, @Headers('x-payment-signature') signature: string | undefined) {
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > 65_536) {
      response.status(400).json(errorEnvelope({ code: 'INVALID_WEBHOOK_BODY', message: 'Webhook raw body is unavailable or too large' }, request.requestId ?? 'unknown'));
      return;
    }
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.config.paymentUrl}/payments/webhook/${encodeURIComponent(provider)}`, {
        method: 'POST', redirect: 'manual',
        headers: {
          'content-type': request.header('content-type') ?? 'application/json',
          ...(signature ? { 'x-payment-signature': signature } : {}),
          'x-request-id': request.requestId ?? 'unknown',
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException('Payment service unavailable');
    }
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-request-id', request.requestId ?? 'unknown');
    response.status(upstream.status);
    response.send(Buffer.from(await upstream.arrayBuffer()));
  }
}
