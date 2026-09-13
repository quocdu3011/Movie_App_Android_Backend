import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadCatalogConfig } from '../catalog.config';
import { CreateCatalogSchema1700000000002 } from './migrations/1700000000002-CreateCatalogSchema';
import { AddSearchProjection1700000000007 } from './migrations/1700000000007-AddSearchProjection';

const config = loadCatalogConfig();

export default new DataSource({
  type: 'postgres', url: config.databaseUrl, entities: [],
  migrations: [CreateCatalogSchema1700000000002, AddSearchProjection1700000000007], migrationsTableName: 'typeorm_migrations', synchronize: false, logging: false,
});
