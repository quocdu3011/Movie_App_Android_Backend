import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadStreamingConfig } from '../streaming.config';
import { CreateStreamingPlaybackSchema1700000000005 } from './migrations/1700000000005-CreateStreamingPlaybackSchema';
import { CreateOwnedMediaSchema1700000000006 } from './migrations/1700000000006-CreateOwnedMediaSchema';
import { AddWatchProgressEligibility1700000000010 } from './migrations/1700000000010-AddWatchProgressEligibility';
import { DefaultLegacyProgressEligibilityToFalse1700000000011 } from './migrations/1700000000011-DefaultLegacyProgressEligibilityToFalse';

const config = loadStreamingConfig();

export default new DataSource({
  type: 'postgres',
  url: config.databaseUrl,
  entities: [],
  migrations: [CreateStreamingPlaybackSchema1700000000005, CreateOwnedMediaSchema1700000000006, AddWatchProgressEligibility1700000000010, DefaultLegacyProgressEligibilityToFalse1700000000011],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: false,
});
