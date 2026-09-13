import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadProfileConfig } from '../profile.config';
import { CreateProfileSchema1700000000001 } from './migrations/1700000000001-CreateProfileSchema';
import { AddFavorites1700000000007 } from './migrations/1700000000007-AddFavorites';
import { OutboxEvent } from '../profiles/outbox-event.entity';
import { Profile } from '../profiles/profile.entity';
import { ProfileQuota } from '../profiles/profile-quota.entity';

const config = loadProfileConfig();

export default new DataSource({
  type: 'postgres',
  url: config.databaseUrl,
  entities: [Profile, ProfileQuota, OutboxEvent],
  migrations: [CreateProfileSchema1700000000001, AddFavorites1700000000007],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
  logging: false,
});
