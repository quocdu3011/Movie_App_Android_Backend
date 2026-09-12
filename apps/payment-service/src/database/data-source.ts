import 'dotenv/config';
import { DataSource } from 'typeorm';
import { CreatePaymentSchema1700000000004 } from './migrations/1700000000004-CreatePaymentSchema';

const databaseUrl = process.env.PAYMENT_DATABASE_URL;
if (!databaseUrl) throw new Error('PAYMENT_DATABASE_URL is required');

export default new DataSource({
  type: 'postgres', url: databaseUrl, entities: [],
  migrations: [CreatePaymentSchema1700000000004], migrationsTableName: 'typeorm_migrations', synchronize: false, logging: false,
});
