import bcrypt from 'bcryptjs';
import { Store, StoreMembership, User } from '../src/database/models/index.js';
import { sequelize } from '../src/database/sequelize.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validEmail(value: string): string {
  const email = value.toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('BOOTSTRAP_EMAIL must be a valid email address.');
  }
  return email;
}

const storeName = requiredEnv('BOOTSTRAP_STORE_NAME');
const email = validEmail(requiredEnv('BOOTSTRAP_EMAIL'));
const password = requiredEnv('BOOTSTRAP_PASSWORD');

if (storeName.length > 150) {
  throw new Error('BOOTSTRAP_STORE_NAME must be at most 150 characters.');
}
if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
  throw new Error('BOOTSTRAP_PASSWORD must be between 12 and 72 bytes.');
}

try {
  const passwordHash = await bcrypt.hash(password, 12);
  let createdStoreId = '';

  await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(731904281)', { transaction });

    if (await User.count({ transaction })) {
      throw new Error('Bootstrap stopped: at least one user already exists.');
    }

    const user = await User.create({ email, passwordHash }, { transaction });
    const store = await Store.create({ name: storeName }, { transaction });
    createdStoreId = store.id;
    await StoreMembership.create(
      { userId: user.id, storeId: store.id, role: 'owner' },
      { transaction }
    );
  });

  console.info('Initial owner and store created. Remove the bootstrap variables from .env.');
  console.info(`StockControll store ID: ${createdStoreId}`);
} finally {
  await sequelize.close();
}
