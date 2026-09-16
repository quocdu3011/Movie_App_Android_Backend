import 'dotenv/config';
import { DataSource } from 'typeorm';
import { loadCatalogConfig } from '../catalog.config';
import { CreateCatalogSchema1700000000002 } from './migrations/1700000000002-CreateCatalogSchema';
import { AddSearchProjection1700000000007 } from './migrations/1700000000007-AddSearchProjection';
import { AddCatalogHomeProjection1700000000012 } from './migrations/1700000000012-AddCatalogHomeProjection';

const config = loadCatalogConfig();

export default new DataSource({
  type: 'postgres', url: config.databaseUrl, entities: [],
  migrations: [CreateCatalogSchema1700000000002, AddSearchProjection1700000000007, AddCatalogHomeProjection1700000000012], migrationsTableName: 'typeorm_migrations', synchronize: false, logging: false,
});
