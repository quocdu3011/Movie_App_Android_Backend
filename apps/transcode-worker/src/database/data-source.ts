import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../worker.config';
import { CreateTranscodeJobSchema1700000000006 } from './migrations/1700000000006-CreateTranscodeJobSchema';

const config = loadWorkerConfig();
export default new DataSource({ type: 'postgres', url: config.databaseUrl, entities: [], migrations: [CreateTranscodeJobSchema1700000000006], migrationsTableName: 'typeorm_migrations', synchronize: false, logging: false });
