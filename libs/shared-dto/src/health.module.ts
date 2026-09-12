import { Controller, DynamicModule, Get, Inject, Module, Req } from '@nestjs/common';
import { successEnvelope } from './envelope';
import { RequestWithId } from './request-id.middleware';

const SERVICE_NAME = Symbol('SERVICE_NAME');

@Controller()
class ServiceHealthController {
  constructor(@Inject(SERVICE_NAME) private readonly serviceName: string) {}

  @Get('health')
  health(@Req() request: RequestWithId) {
    return successEnvelope({ status: 'ok', service: this.serviceName }, request.requestId);
  }

  @Get('ready')
  ready(@Req() request: RequestWithId) {
    return successEnvelope({ status: 'ready', service: this.serviceName, businessImplemented: false }, request.requestId);
  }
}

@Module({})
export class ServiceHealthModule {
  static register(serviceName: string): DynamicModule {
    return {
      module: ServiceHealthModule,
      controllers: [ServiceHealthController],
      providers: [{ provide: SERVICE_NAME, useValue: serviceName }],
    };
  }
}
