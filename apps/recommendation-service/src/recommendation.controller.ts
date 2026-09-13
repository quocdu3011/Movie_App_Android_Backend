import { Controller, Get, Header, HttpCode, HttpStatus, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { successEnvelope } from '@movie/shared-dto';
import { RecommendationInternalGuard } from './recommendation-auth.guard';
import { RecommendationService } from './recommendation.service';

@Controller('internal')
@UseGuards(RecommendationInternalGuard)
export class RecommendationController {
  constructor(private readonly recommendation: RecommendationService) {}
  @Get('recommendations/:profileId')
  async recommendations(@Param('profileId', new ParseUUIDPipe()) profileId: string, @Req() request: Request & { requestId?: string }) {
    const userId = request.header('x-user-id');
    if (!userId) return successEnvelope({ type: 'fallback_new_releases', items: [] }, request.requestId ?? 'unknown');
    return successEnvelope(await this.recommendation.recommendations(profileId, userId), request.requestId ?? 'unknown');
  }
  @Get('trending')
  @HttpCode(HttpStatus.OK)
  async trending(@Query('isKids') isKids: string | undefined, @Req() request: Request & { requestId?: string }) { return successEnvelope(await this.recommendation.trending(isKids === 'true'), request.requestId ?? 'unknown'); }
}

@Controller()
export class RecommendationHealthController {
  constructor(private readonly recommendation: RecommendationService) {}
  @Get('health') health(@Req() request: Request & { requestId?: string }) { return successEnvelope({ status: 'ok', service: 'recommendation-service' }, request.requestId ?? 'unknown'); }
  @Get('ready') async ready(@Req() request: Request & { requestId?: string }) { await this.recommendation.ready(); return successEnvelope({ status: 'ready', service: 'recommendation-service' }, request.requestId ?? 'unknown'); }
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> { return this.recommendation.metrics(); }
}
