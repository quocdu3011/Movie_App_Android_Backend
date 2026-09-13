import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadNotificationConfig } from '../notification.config';
import { CreateNotificationSchema1700000000008 } from './migrations/1700000000008-CreateNotificationSchema';
const config = loadNotificationConfig();
export default new DataSource({ type: 'postgres', url: config.databaseUrl, entities: [], migrations: [CreateNotificationSchema1700000000008], migrationsTableName: 'typeorm_migrations', synchronize: false });
