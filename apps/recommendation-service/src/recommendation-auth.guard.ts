import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { parseBearerToken } from '@movie/shared-auth';
import { Request } from 'express';
import { RECOMMENDATION_CONFIG, RecommendationConfig, validRecommendationToken } from './recommendation.config';

@Injectable()
export class RecommendationInternalGuard implements CanActivate {
  constructor(@Inject(RECOMMENDATION_CONFIG) private readonly config: RecommendationConfig) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!validRecommendationToken(parseBearerToken(request.header('authorization') ?? undefined) ?? undefined, request.header('x-caller-service') ?? undefined, this.config)) throw new UnauthorizedException('Recommendation service authentication required');
    return true;
  }
}
