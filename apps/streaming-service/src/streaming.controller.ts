import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { successEnvelope } from '@movie/shared-dto';
import { Request, Response } from 'express';
import { PlaybackEventDto, PlaybackProgressDto, CreatePlaybackSessionDto, InitiateUploadDto, TranscodeCompletedDto, TranscodeFailedDto, TranscodeProcessingDto } from './streaming.dto';
import { StreamingService } from './streaming.service';
import { StreamingAdminGuard, StreamingGatewayGuard, StreamingInternalGuard, StreamingRequest, StreamingWorkerGuard } from './streaming-auth.guard';

@Controller('streaming')
@UseGuards(StreamingGatewayGuard)
export class StreamingController {
  constructor(private readonly streaming: StreamingService) {}

  @Post('playback-sessions')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: CreatePlaybackSessionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: StreamingRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const data = await this.streaming.createPlaybackSession(
      request.userId!, request.authSessionId!, idempotencyKey ?? '', body, request.requestId ?? 'unknown',
    );
    this.setMediaCookie(response, data.mediaAuth);
    return successEnvelope(data, request.requestId ?? 'unknown');
  }

  @Post('playback-sessions/:sessionId/heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Req() request: StreamingRequest) {
    return successEnvelope(
      await this.streaming.heartbeat(sessionId, request.userId!, request.authSessionId!, request.requestId ?? 'unknown'),
      request.requestId ?? 'unknown',
    );
  }

  @Post('playback-sessions/:sessionId/progress')
  @HttpCode(HttpStatus.OK)
  async progress(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() body: PlaybackProgressDto,
    @Req() request: StreamingRequest,
  ) {
    return successEnvelope(
      await this.streaming.saveProgress(sessionId, request.userId!, request.authSessionId!, body, request.requestId ?? 'unknown'),
      request.requestId ?? 'unknown',
    );
  }

  @Post('playback-sessions/:sessionId/events')
  @HttpCode(HttpStatus.OK)
  async event(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() body: PlaybackEventDto,
    @Req() request: StreamingRequest,
  ) {
    return successEnvelope(
      await this.streaming.recordEvent(sessionId, request.userId!, request.authSessionId!, body, request.requestId ?? 'unknown'),
      request.requestId ?? 'unknown',
    );
  }

  @Post('playback-sessions/:sessionId/media-auth')
  @HttpCode(HttpStatus.OK)
  async mediaAuth(@Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Req() request: StreamingRequest, @Res({ passthrough: true }) response: Response) {
    const data = await this.streaming.mediaAuth(sessionId, request.userId!, request.authSessionId!, request.requestId ?? 'unknown');
    this.setMediaCookie(response, data);
    return successEnvelope(data, request.requestId ?? 'unknown');
  }

  private setMediaCookie(response: Response, credential: { cookieName?: string; cookieValue?: string; path?: string; expiresAt?: string } | null): void {
    if (!credential?.cookieName || !credential.cookieValue || !credential.path || !credential.expiresAt) return;
    response.cookie(credential.cookieName, credential.cookieValue, { httpOnly: true, sameSite: 'lax', secure: false, path: credential.path, expires: new Date(credential.expiresAt) });
  }
}

@Controller('admin/videos')
@UseGuards(StreamingAdminGuard)
export class StreamingAdminController {
  constructor(private readonly streaming: StreamingService) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  async initiate(@Body() body: InitiateUploadDto, @Headers('idempotency-key') key: string | undefined, @Req() request: StreamingRequest) {
    return successEnvelope(await this.streaming.initiateUpload(body, key ?? '', request.userId!, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }

  @Post(':assetId/upload-complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Param('assetId', new ParseUUIDPipe()) assetId: string, @Req() request: StreamingRequest) {
    return successEnvelope(await this.streaming.completeUpload(assetId, request.userId!, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }
}

@Controller('admin/playback-sessions')
@UseGuards(StreamingAdminGuard)
export class StreamingOperationsAdminController {
  constructor(private readonly streaming: StreamingService) {}

  @Get()
  async list(@Query() query: Record<string, string | undefined>, @Req() request: StreamingRequest) {
    this.adminOnly(request);
    return successEnvelope(await this.streaming.adminPlaybackSessions({ page: optionalNumber(query.page), pageSize: optionalNumber(query.pageSize), userId: query.userId, status: query.status }), request.requestId ?? 'unknown');
  }

  @Post(':sessionId/terminate')
  @HttpCode(HttpStatus.OK)
  async terminate(@Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Body() body: { reason?: string }, @Req() request: StreamingRequest) {
    this.adminOnly(request);
    await this.streaming.terminatePlaybackSession(sessionId, body.reason ?? '');
    return successEnvelope({ sessionId, terminated: true }, request.requestId ?? 'unknown');
  }

  @Get('overview/streaming')
  async metrics(@Req() request: StreamingRequest) { this.adminOnly(request); return successEnvelope(await this.streaming.adminPlaybackMetrics(), request.requestId ?? 'unknown'); }

  private adminOnly(request: StreamingRequest): void {
    if (request.userRole !== 'admin') throw new ForbiddenException('Administrator role required');
  }
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined || value.trim() === '' ? undefined : Number(value);
}

@Controller('internal/streaming/assets')
@UseGuards(StreamingWorkerGuard)
export class StreamingWorkerController {
  constructor(private readonly streaming: StreamingService) {}

  @Post(':assetId/processing')
  async processing(@Param('assetId', new ParseUUIDPipe()) assetId: string, @Body() body: TranscodeProcessingDto, @Req() request: Request & { requestId?: string }) {
    return successEnvelope(await this.streaming.applyProcessing(assetId, body, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }

  @Post(':assetId/transcoded')
  async transcoded(@Param('assetId', new ParseUUIDPipe()) assetId: string, @Body() body: TranscodeCompletedDto, @Req() request: Request & { requestId?: string }) {
    return successEnvelope(await this.streaming.applyTranscoded(assetId, body, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }

  @Post(':assetId/transcode-failed')
  async failed(@Param('assetId', new ParseUUIDPipe()) assetId: string, @Body() body: TranscodeFailedDto, @Req() request: Request & { requestId?: string }) {
    return successEnvelope(await this.streaming.applyTranscodeFailed(assetId, body, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }
}

@Controller('internal/streaming/profiles')
@UseGuards(StreamingInternalGuard)
export class StreamingProfileController {
  constructor(private readonly streaming: StreamingService) {}

  @Get(':profileId/progress')
  async progress(
    @Param('profileId', new ParseUUIDPipe()) profileId: string,
    @Query('playableId') playableId: string | undefined,
    @Req() request: Request & { requestId?: string },
  ) {
    return successEnvelope(await this.streaming.getProfileProgress(profileId, playableId), request.requestId ?? 'unknown');
  }
}

@Controller()
export class StreamingHealthController {
  constructor(private readonly streaming: StreamingService) {}

  @Get('health')
  health(@Req() request: Request & { requestId?: string }) {
    return successEnvelope({ status: 'ok', service: 'streaming-service' }, request.requestId ?? 'unknown');
  }

  @Get('ready')
  async ready(@Req() request: Request & { requestId?: string }) {
    await this.streaming.ready();
    return successEnvelope({ status: 'ready', service: 'streaming-service' }, request.requestId ?? 'unknown');
  }
}
