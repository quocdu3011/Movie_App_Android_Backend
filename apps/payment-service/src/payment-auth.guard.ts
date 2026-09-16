import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { parseBearerToken } from '@movie/shared-auth';
import { Request } from 'express';
import { PAYMENT_CONFIG, PaymentConfig, validServiceToken } from './payment.config';

interface PaymentRequest extends Request {
  callerService?: string;
  userId?: string;
  adminRole?: 'admin' | 'support';
  adminActorId?: string;
}

function authenticate(request: PaymentRequest, config: PaymentConfig): string {
  const caller = request.header('x-caller-service') ?? undefined;
  if (!validServiceToken(parseBearerToken(request.header('authorization') ?? undefined) ?? undefined, caller, config)) {
    throw new UnauthorizedException('Payment service authentication required');
  }
  request.callerService = caller;
  return caller ?? '';
}

@Injectable()
export class PaymentGatewayGuard implements CanActivate {
  constructor(@Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<PaymentRequest>();
    if (authenticate(request, this.config) !== 'api-gateway') throw new ForbiddenException('Payment user routes are only available through the API Gateway');
    const userId = request.header('x-user-id');
    if (userId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      throw new ForbiddenException('Trusted user context is invalid');
    }
    request.userId = userId ?? undefined;
    return true;
  }
}

@Injectable()
export class PaymentInternalGuard implements CanActivate {
  constructor(@Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<PaymentRequest>();
    if (authenticate(request, this.config) !== 'streaming-service') throw new ForbiddenException('Payment entitlement is only available to Streaming');
    return true;
  }
}

@Injectable()
export class PaymentAdminGuard implements CanActivate {
  constructor(@Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<PaymentRequest>();
    if (authenticate(request, this.config) !== 'api-gateway') throw new ForbiddenException('Payment admin routes are only available through the API Gateway');
    const role = request.header('x-user-role'); const actorId = request.header('x-user-id');
    if (!actorId || !['admin', 'support'].includes(role ?? '')) throw new ForbiddenException('Payment administrator role required');
    request.adminRole = role as 'admin' | 'support'; request.adminActorId = actorId;
    return true;
  }
}
