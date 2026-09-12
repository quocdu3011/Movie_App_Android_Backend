import 'reflect-metadata';
import 'dotenv/config';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { HttpExceptionEnvelopeFilter } from '@movie/shared-dto';
import { loadHttpServiceConfig } from '@movie/shared-config';
import { AppModule } from './app.module';
import { TranscodeService } from './transcode.service';

async function bootstrap(): Promise<void> {
  const config = loadHttpServiceConfig('transcode-worker', 'TRANSCODE_PORT', 3010);
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  app.enableShutdownHooks();
  app.get(TranscodeService);
  await app.listen(config.port, '0.0.0.0');
}

void bootstrap();
