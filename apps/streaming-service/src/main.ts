import 'reflect-metadata';
import 'dotenv/config';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { HttpExceptionEnvelopeFilter } from '@movie/shared-dto';
import { loadHttpServiceConfig } from '@movie/shared-config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const config = loadHttpServiceConfig('streaming-service', 'STREAMING_PORT', 3005);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
