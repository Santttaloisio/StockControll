import { app } from './app.js';
import { validateJwtConfiguration } from './modules/auth/auth.service.js';

const port = Number(process.env.APP_PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('APP_PORT must be an integer between 1 and 65535');
}

validateJwtConfiguration();

app.listen(port, () => {
  console.info(`StockControll API listening on port ${port}.`);
});
