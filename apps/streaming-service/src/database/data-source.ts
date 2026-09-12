import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadStreamingConfig } from '../streaming.config';
import { CreateStreamingPlaybackSchema1700000000005 } from './migrations/1700000000005-CreateStreamingPlaybackSchema';
import { CreateOwnedMediaSchema1700000000006 } from './migrations/1700000000006-CreateOwnedMediaSchema';

const config = loadStreamingConfig();

export default new DataSource({
  type: 'postgres',
  url: config.databaseUrl,
  entities: [],
  migrations: [CreateStreamingPlaybackSchema1700000000005, CreateOwnedMediaSchema1700000000006],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: false,
});
