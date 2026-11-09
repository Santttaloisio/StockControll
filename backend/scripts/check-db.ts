import { sequelize } from '../src/database/sequelize.js';

try {
  await sequelize.authenticate();
  console.info('PostgreSQL connection verified.');
} finally {
  await sequelize.close();
}
