import { config as loadEnv } from 'dotenv';
import { Sequelize } from 'sequelize';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '../.env') });

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const port = Number(requiredEnv('DB_PORT'));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('DB_PORT must be an integer between 1 and 65535');
}

export const sequelize = new Sequelize({
  dialect: 'postgres',
  host: requiredEnv('DB_HOST'),
  port,
  database: requiredEnv('DB_NAME'),
  username: requiredEnv('DB_USER'),
  password: requiredEnv('DB_PASSWORD'),
  logging: false
});
