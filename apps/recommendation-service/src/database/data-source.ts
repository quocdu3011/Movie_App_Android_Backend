import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadRecommendationConfig } from '../recommendation.config';
import { CreateRecommendationSchema1700000000008 } from './migrations/1700000000008-CreateRecommendationSchema';

const config = loadRecommendationConfig();
export default new DataSource({ type: 'postgres', url: config.databaseUrl, entities: [], migrations: [CreateRecommendationSchema1700000000008], migrationsTableName: 'typeorm_migrations', synchronize: false });
