import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { parseBearerToken } from '@movie/shared-auth';
import { CATALOG_CONFIG, CatalogConfig, validGatewayToken } from './catalog.config';
import { Request } from 'express';

@Injectable()
export class CatalogGatewayGuard implements CanActivate {
  constructor(@Inject(CATALOG_CONFIG) private readonly config: CatalogConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const caller = request.header('x-caller-service');
    const token = parseBearerToken(request.header('authorization') ?? undefined);
    if (!validGatewayToken(token ?? undefined, this.config) || caller !== 'api-gateway') throw new UnauthorizedException('API Gateway service authentication required');
    const userId = request.header('x-user-id');
    if (userId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      throw new ForbiddenException('Trusted user context is invalid');
    }
    return true;
  }
}
