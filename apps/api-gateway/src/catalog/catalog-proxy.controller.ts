import { Controller, Get, Inject, Param, Patch, Post, Body, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { PublicRoute } from '@movie/shared-auth';
import { errorEnvelope } from '@movie/shared-dto';
import { GATEWAY_CONFIG, GatewayConfig } from '../gateway.config';
import { AuthenticatedRequest } from '../auth/access-auth.guard';
import { RequireRoles } from '../auth/role.guard';

abstract class CatalogProxyBase {
  constructor(@Inject(GATEWAY_CONFIG) protected readonly config: GatewayConfig) {}

  protected async forward(method: string, path: string, body: unknown, request: AuthenticatedRequest, response: Response, admin = false): Promise<void> {
    const session = request.authSession;
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${this.config.catalogUrl}${path}`, {
        method, redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.config.serviceToken}`,
          'x-caller-service': 'api-gateway',
          ...(session?.active && session.userId ? { 'x-user-id': session.userId } : {}),
          ...(session?.role ? { 'x-user-role': session.role } : {}),
          'x-request-id': request.requestId ?? 'unknown',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      response.status(503).json(errorEnvelope(
        { code: 'CATALOG_UNAVAILABLE', message: 'Catalog service unavailable' }, request.requestId ?? 'unknown',
      ));
      return;
    }
    const contentType = upstream.headers.get('content-type');
    if (contentType) response.setHeader('content-type', contentType);
    const personalized = Object.hasOwn(request.query, 'profileId');
    response.setHeader('cache-control', admin || personalized ? 'no-store' : 'public, max-age=300');
    response.setHeader('x-request-id', request.requestId ?? 'unknown');
    response.status(upstream.status);
    if (upstream.status === 204) { response.end(); return; }
    response.send(Buffer.from(await upstream.arrayBuffer()));
  }
}

@Controller('catalog')
@PublicRoute()
export class CatalogPublicProxyController extends CatalogProxyBase {
  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) { super(config); }
  @Get('home')
  home(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', request.originalUrl, undefined, request, response);
  }
  @Get('movies')
  movies(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', request.originalUrl, undefined, request, response);
  }
  @Get('search')
  search(@Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', request.originalUrl, undefined, request, response);
  }
  @Get('movies/:movieId')
  detail(@Param('movieId') _movieId: string, @Req() request: AuthenticatedRequest, @Res() response: Response) {
    return this.forward('GET', request.originalUrl, undefined, request, response);
  }
}

@Controller('admin')
@RequireRoles('admin', 'content_manager')
export class CatalogAdminProxyController extends CatalogProxyBase {
  constructor(@Inject(GATEWAY_CONFIG) config: GatewayConfig) { super(config); }
  @Post('movies') createMovie(@Body() body: unknown, @Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('POST', request.originalUrl, body, request, response, true); }
  @Get('movies') listMovies(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('GET', request.originalUrl, undefined, request, response, true); }
  @Patch('movies/:movieId') patchMovie(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('PATCH', request.originalUrl, body, request, response, true); }
  @Post('movies/:movieId/publish') publish(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('POST', request.originalUrl, undefined, request, response, true); }
  @Post('movies/:movieId/archive') archive(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('POST', request.originalUrl, undefined, request, response, true); }
  @Post('movies/:movieId/seasons') addSeason(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('POST', request.originalUrl, body, request, response, true); }
  @Post('movies/:movieId/playable-items') addPlayable(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('POST', request.originalUrl, body, request, response, true); }
  @Post('movies/:movieId/content-sources') addSource(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('POST', request.originalUrl, body, request, response, true); }
  @Post('content-sources/:sourceId/items') addSourceItem(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('POST', request.originalUrl, body, request, response, true); }
  @Patch('source-items/:sourceItemId') patchSourceItem(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('PATCH', request.originalUrl, body, request, response, true); }
  @Patch('content-sources/:sourceId/metadata-lock') metadataLock(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('PATCH', request.originalUrl, body, request, response, true); }
  @Get('providers/kkphim/search') providerSearch(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('GET', request.originalUrl, undefined, request, response, true); }
  @Post('providers/kkphim/import') @HttpCode(HttpStatus.ACCEPTED) importProvider(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('POST', request.originalUrl, body, request, response, true); }
  @Post('providers/kkphim/sync') @HttpCode(HttpStatus.ACCEPTED) syncProvider(@Req() request: AuthenticatedRequest, @Body() body: unknown, @Res() response: Response) { return this.forward('POST', request.originalUrl, body, request, response, true); }
  @Get('providers/kkphim/sync-runs') syncRuns(@Req() request: AuthenticatedRequest, @Res() response: Response) { return this.forward('GET', request.originalUrl, undefined, request, response, true); }
}
