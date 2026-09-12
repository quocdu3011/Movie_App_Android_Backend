import 'dotenv/config';
import { DataSource } from 'typeorm';
import { AuthSession } from '../sessions/auth-session.entity';
import { RefreshToken } from '../sessions/refresh-token.entity';
import { User } from '../users/user.entity';
import { CreateAuthSchema1700000000000 } from './migrations/1700000000000-CreateAuthSchema';

const databaseUrl = process.env.AUTH_DATABASE_URL;
if (!databaseUrl) throw new Error('AUTH_DATABASE_URL is required');

export default new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: [User, AuthSession, RefreshToken],
  migrations: [CreateAuthSchema1700000000000],
  migrationsTableName: 'typeorm_migrations',
  synchronize: false,
});
