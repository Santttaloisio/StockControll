import { Umzug, SequelizeStorage } from 'umzug';
import { sequelize } from '../src/database/sequelize.js';

const migrator = new Umzug({
  migrations: { glob: 'src/database/migrations/*.ts' },
  context: sequelize,
  storage: new SequelizeStorage({ sequelize }),
  logger: console
});

try {
  await sequelize.authenticate();
  const migrations = await migrator.up();
  console.info(`Database is up to date (${migrations.length} migration(s) applied).`);
} finally {
  await sequelize.close();
}
