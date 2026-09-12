import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { successEnvelope } from '@movie/shared-dto';
import { Request } from 'express';
import { AUTH_CONFIG, AuthConfig } from './auth.config';
import { Inject } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, RefreshDto, RegisterDto, ValidateSessionDto } from './dto';
import { ServiceTokenGuard } from './service-token.guard';

interface RequestWithContext extends Request {
  requestId?: string;
  serviceName?: string;
}

function success<T>(data: T, request: RequestWithContext) {
  return successEnvelope(data, request.requestId ?? 'unknown');
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  @Post('register')
  @Header('Cache-Control', 'no-store')
  async register(@Body() body: RegisterDto, @Req() request: RequestWithContext) {
    const user = await this.auth.register(body);
    return success(user, request);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async login(@Body() body: LoginDto, @Req() request: RequestWithContext) {
    return success(await this.auth.login(body), request);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async refresh(@Body() body: RefreshDto, @Req() request: RequestWithContext) {
    return success(await this.auth.refresh(body.refreshToken), request);
  }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: LogoutDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('.well-known/jwks.json')
  @Header('Cache-Control', 'public, max-age=600')
  jwks() {
    return this.config.publicJwks;
  }
}

@Controller('internal/auth')
@UseGuards(ServiceTokenGuard)
export class InternalAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('validate-session')
  async validateSession(@Body() body: ValidateSessionDto, @Req() request: RequestWithContext) {
    const session = await this.auth.validateSession(body.userId, body.sessionId);
    return success(session, request);
  }
}

@Controller()
export class AuthHealthController {
  constructor(private readonly auth: AuthService) {}

  @Get('health')
  health(@Req() request: RequestWithContext) {
    return success({ status: 'ok', service: 'auth-service' }, request);
  }

  @Get('ready')
  async ready(@Req() request: RequestWithContext) {
    await this.auth.pingDatabase();
    return success({ status: 'ready', service: 'auth-service' }, request);
  }
}
