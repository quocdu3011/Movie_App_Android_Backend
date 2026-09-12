import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
const databaseTargets = [
  ['auth_db', 'movieapp', 'AUTH_DB_PASSWORD'],
  ['profile_db', 'movieapp_profile', 'PROFILE_DB_PASSWORD'],
  ['catalog_db', 'movieapp_catalog', 'CATALOG_DB_PASSWORD'],
  ['streaming_db', 'movieapp_streaming', 'STREAMING_DB_PASSWORD'],
  ['payment_db', 'movieapp_payment', 'PAYMENT_DB_PASSWORD'],
  ['worker_db', 'movieapp_worker', 'WORKER_DB_PASSWORD'],
  ['notification_db', 'movieapp_notification', 'NOTIFICATION_DB_PASSWORD'],
  ['recommendation_db', 'movieapp_recommendation', 'RECOMMENDATION_DB_PASSWORD'],
];

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const connectionString = process.env.POSTGRES_ADMIN_URL?.trim();
if (!connectionString) throw new Error('POSTGRES_ADMIN_URL is required to bootstrap databases');

const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
await client.connect();
try {
  for (const [database, role, passwordVariable] of databaseTargets) {
    const password = process.env[passwordVariable];
    if (!password || password.length < 12) {
      throw new Error(`${passwordVariable} must be configured with at least 12 characters`);
    }
    const roleResult = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (roleResult.rowCount === 0) {
      await client.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`);
    } else {
      await client.query(`ALTER ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`);
    }
    const dbResult = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (dbResult.rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(role)}`);
    } else {
      await client.query(`ALTER DATABASE ${quoteIdentifier(database)} OWNER TO ${quoteIdentifier(role)}`);
    }
    await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(role)}`);
    console.log(`Database ready: ${database} (role ${role})`);
  }
} finally {
  await client.end();
}
