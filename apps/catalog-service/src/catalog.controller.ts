import {
  Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post,
  Query, Req, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { successEnvelope } from '@movie/shared-dto';
import { CatalogService } from './catalog.service';
import { CatalogGatewayGuard, CatalogStreamingGuard } from './catalog-auth.guard';
import {
  CatalogQueryDto, CreateContentSourceDto, CreateMovieDto, CreatePlayableDto, CreateSeasonDto,
  CreateSourceItemDto, ImportProviderDto, MetadataLockDto, PatchMovieDto, PatchSourceItemDto,
  SearchProviderQueryDto, SourceItemStatusDto, SyncProviderDto,
} from './catalog.dto';

interface CatalogRequest extends Request { requestId?: string }

@Controller('catalog')
@UseGuards(CatalogGatewayGuard)
export class CatalogPublicController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('home')
  async home(@Query('pageSize') pageSize?: string) { return successEnvelope(await this.catalog.home(Number(pageSize) || 20)); }

  @Get('movies')
  async list(@Query() query: CatalogQueryDto, @Req() request: CatalogRequest) {
    return successEnvelope(await this.catalog.listPublic(query, request.header('x-user-id'), request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }

  @Get('search')
  async search(@Query() query: CatalogQueryDto, @Req() request: CatalogRequest) {
    if (!query.q?.trim()) return successEnvelope({ items: [], page: query.page, pageSize: query.pageSize, totalItems: 0, totalPages: 0 }, request.requestId ?? 'unknown');
    return successEnvelope(await this.catalog.listPublic(query, request.header('x-user-id'), request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }

  @Get('movies/:movieId')
  async detail(@Param('movieId', new ParseUUIDPipe()) movieId: string, @Query('profileId', new ParseUUIDPipe({ optional: true })) profileId: string | undefined, @Req() request: CatalogRequest) {
    return successEnvelope(await this.catalog.detail(movieId, profileId, request.header('x-user-id'), request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }
}

@Controller('admin')
@UseGuards(CatalogGatewayGuard)
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogService) {}

  @Post('movies')
  @HttpCode(HttpStatus.CREATED)
  async createMovie(@Body() body: CreateMovieDto) { return successEnvelope(await this.catalog.createMovie(body as unknown as Record<string, unknown>)); }

  @Get('movies')
  async listMovies(@Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('status') status?: string) {
    return successEnvelope(await this.catalog.adminMovies(Number(page) || 1, Number(pageSize) || 20, status));
  }

  @Patch('movies/:movieId')
  async patchMovie(@Param('movieId', new ParseUUIDPipe()) movieId: string, @Body() body: PatchMovieDto) { return successEnvelope(await this.catalog.patchMovie(movieId, body as unknown as Record<string, unknown>)); }

  @Post('movies/:movieId/publish')
  @HttpCode(HttpStatus.OK)
  async publish(@Param('movieId', new ParseUUIDPipe()) movieId: string) { return successEnvelope(await this.catalog.publish(movieId)); }

  @Post('movies/:movieId/archive')
  @HttpCode(HttpStatus.OK)
  async archive(@Param('movieId', new ParseUUIDPipe()) movieId: string) { return successEnvelope(await this.catalog.archive(movieId)); }

  @Post('movies/:movieId/seasons')
  @HttpCode(HttpStatus.CREATED)
  async addSeason(@Param('movieId', new ParseUUIDPipe()) movieId: string, @Body() body: CreateSeasonDto) { return successEnvelope(await this.catalog.addSeason(movieId, body.seasonNumber, body.isSynthetic)); }

  @Post('movies/:movieId/playable-items')
  @HttpCode(HttpStatus.CREATED)
  async addPlayable(@Param('movieId', new ParseUUIDPipe()) movieId: string, @Body() body: CreatePlayableDto) { return successEnvelope(await this.catalog.addPlayable(movieId, body as unknown as Record<string, unknown>)); }

  @Post('movies/:movieId/content-sources')
  @HttpCode(HttpStatus.CREATED)
  async addSource(@Param('movieId', new ParseUUIDPipe()) movieId: string, @Body() body: CreateContentSourceDto) { return successEnvelope(await this.catalog.addContentSource(movieId, body as unknown as Record<string, unknown>)); }

  @Post('content-sources/:sourceId/items')
  @HttpCode(HttpStatus.CREATED)
  async addSourceItem(@Param('sourceId', new ParseUUIDPipe()) sourceId: string, @Body() body: CreateSourceItemDto) { return successEnvelope(await this.catalog.addSourceItem(sourceId, body as unknown as Record<string, unknown>)); }

  @Patch('source-items/:sourceItemId')
  async patchSourceItem(@Param('sourceItemId', new ParseUUIDPipe()) sourceItemId: string, @Body() body: PatchSourceItemDto, @Req() request: CatalogRequest) {
    return successEnvelope(await this.catalog.patchSourceItem(sourceItemId, body as unknown as Record<string, unknown>, request.header('x-user-id') ?? undefined, request.requestId ?? 'unknown'));
  }

  @Patch('content-sources/:sourceId/metadata-lock')
  async metadataLock(@Param('sourceId', new ParseUUIDPipe()) sourceId: string, @Body() body: MetadataLockDto) { return successEnvelope(await this.catalog.metadataLock(sourceId, body.locked)); }

  @Get('providers/kkphim/search')
  async searchProvider(@Query() query: SearchProviderQueryDto) { return successEnvelope(await this.catalog.searchProvider(query.keyword, query.page)); }

  @Post('providers/kkphim/import')
  @HttpCode(HttpStatus.ACCEPTED)
  async importProvider(@Body() body: ImportProviderDto, @Req() request: CatalogRequest) {
    return successEnvelope(await this.catalog.createSyncRun({ mode: 'import', slug: body.slug, movieId: body.movieId }, request.header('x-user-id')), request.requestId ?? 'unknown');
  }

  @Post('providers/kkphim/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  async syncProvider(@Body() body: SyncProviderDto, @Req() request: CatalogRequest) {
    return successEnvelope(await this.catalog.createSyncRun({ mode: body.mode, maxPages: body.maxPages }, request.header('x-user-id')), request.requestId ?? 'unknown');
  }

  @Get('providers/kkphim/sync-runs')
  async syncRuns(@Query('page') page?: string, @Query('pageSize') pageSize?: string) { return successEnvelope(await this.catalog.syncRunList(Number(page) || 1, Number(pageSize) || 20)); }
}

@Controller()
export class CatalogHealthController {
  constructor(private readonly catalog: CatalogService) {}
  @Get('health')
  health(@Req() request: CatalogRequest) { return successEnvelope({ status: 'ok', service: 'catalog-service' }, request.requestId ?? 'unknown'); }
  @Get('ready')
  async ready(@Req() request: CatalogRequest) { await this.catalog.pingDatabase(); return successEnvelope({ status: 'ready', service: 'catalog-service', businessImplemented: true }, request.requestId ?? 'unknown'); }
}

@Controller('internal/catalog')
@UseGuards(CatalogStreamingGuard)
export class CatalogStreamingController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('playables/:playableId')
  async playbackSelection(
    @Param('playableId', new ParseUUIDPipe()) playableId: string,
    @Query('sourceItemId', new ParseUUIDPipe()) sourceItemId: string,
  ) {
    return successEnvelope(await this.catalog.playbackSelection(playableId, sourceItemId));
  }

  @Post('source-items/:sourceItemId/status')
  async reportStatus(
    @Param('sourceItemId', new ParseUUIDPipe()) sourceItemId: string,
    @Body() body: SourceItemStatusDto,
    @Req() request: CatalogRequest,
  ) {
    return successEnvelope(await this.catalog.reportSourceStatus(sourceItemId, body.status, body.retryAfter ?? null, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }

  @Get('owned-source-items/:sourceItemId')
  async ownedSourceItem(@Param('sourceItemId', new ParseUUIDPipe()) sourceItemId: string) {
    return successEnvelope(await this.catalog.ownedSourceItem(sourceItemId));
  }

  @Post('owned-source-items/:sourceItemId/ready')
  async ownedReady(@Param('sourceItemId', new ParseUUIDPipe()) sourceItemId: string, @Req() request: CatalogRequest) {
    return successEnvelope(await this.catalog.markOwnedReady(sourceItemId, request.requestId ?? 'unknown'), request.requestId ?? 'unknown');
  }
}
