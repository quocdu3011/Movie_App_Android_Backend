import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RequestIdMiddleware } from '@movie/shared-dto';
import { RECOMMENDATION_CONFIG, loadRecommendationConfig } from './recommendation.config';
import { RecommendationInternalGuard } from './recommendation-auth.guard';
import { RecommendationConsumer } from './recommendation.consumer';
import { RecommendationController, RecommendationHealthController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';

const config = loadRecommendationConfig();

@Module({
  imports: [TypeOrmModule.forRoot({ type: 'postgres', url: config.databaseUrl, entities: [], synchronize: false, retryAttempts: 2, retryDelay: 1_000 })],
  controllers: [RecommendationController, RecommendationHealthController],
  providers: [{ provide: RECOMMENDATION_CONFIG, useValue: config }, RecommendationInternalGuard, RecommendationService, RecommendationConsumer],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
