import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadCatalogConfig } from '../catalog.config';
import { CreateCatalogSchema1700000000002 } from './migrations/1700000000002-CreateCatalogSchema';

const config = loadCatalogConfig();

export default new DataSource({
  type: 'postgres', url: config.databaseUrl, entities: [],
  migrations: [CreateCatalogSchema1700000000002], migrationsTableName: 'typeorm_migrations', synchronize: false, logging: false,
});
