import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post,
  Req, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { successEnvelope } from '@movie/shared-dto';
import { ProfileService } from './profile.service';
import { CreateProfileDto, UpdateProfileDto, ValidateProfileDto } from './profile.dto';
import { ProfileGatewayGuard, ProfileInternalGuard } from './profile-auth.guard';

interface ProfileRequest extends Request {
  requestId?: string;
}

function authenticatedUserId(request: ProfileRequest): string {
  const userId = request.header('x-user-id');
  if (!userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    throw new UnauthorizedException('Trusted API Gateway user context is missing');
  }
  return userId;
}

@Controller('profiles')
@UseGuards(ProfileGatewayGuard)
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Get()
  async list(@Req() request: ProfileRequest) {
    return successEnvelope(await this.profiles.list(authenticatedUserId(request)), request.requestId ?? 'unknown');
  }

  @Post()
  async create(@Body() body: CreateProfileDto, @Req() request: ProfileRequest) {
    return successEnvelope(await this.profiles.create(authenticatedUserId(request), body), request.requestId ?? 'unknown');
  }

  @Patch(':profileId')
  async update(@Param('profileId', new ParseUUIDPipe()) profileId: string, @Body() body: UpdateProfileDto, @Req() request: ProfileRequest) {
    return successEnvelope(
      await this.profiles.update(authenticatedUserId(request), profileId, body),
      request.requestId ?? 'unknown',
    );
  }

  @Delete(':profileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('profileId', new ParseUUIDPipe()) profileId: string, @Req() request: ProfileRequest): Promise<void> {
    await this.profiles.delete(authenticatedUserId(request), profileId, request.requestId ?? 'unknown');
  }
}

@Controller('internal/profiles')
@UseGuards(ProfileInternalGuard)
export class InternalProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Post('validate')
  async validate(@Body() body: ValidateProfileDto, @Req() request: ProfileRequest) {
    return successEnvelope(
      await this.profiles.validate(body.userId, body.profileId),
      request.requestId ?? 'unknown',
    );
  }
}

@Controller()
export class ProfileHealthController {
  constructor(private readonly profiles: ProfileService) {}

  @Get('health')
  health(@Req() request: ProfileRequest) {
    return successEnvelope({ status: 'ok', service: 'profile-service' }, request.requestId ?? 'unknown');
  }

  @Get('ready')
  async ready(@Req() request: ProfileRequest) {
    await this.profiles.pingDatabase();
    return successEnvelope({ status: 'ready', service: 'profile-service', businessImplemented: true }, request.requestId ?? 'unknown');
  }
}
