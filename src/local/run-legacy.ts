/** Starts only the simulated legacy host (also used by the Docker image). */
import { startLegacyServer } from '../legacy/server';
import { MemoryLegacyStore } from '../legacy/store';

const port = Number(process.env.PORT ?? 9081);
startLegacyServer({
  store: new MemoryLegacyStore(),
  credentials: { user: process.env.LEGACY_USER ?? 'GATEWAY', password: process.env.LEGACY_PASSWORD ?? 'local-dev-password' },
  adminToken: process.env.LEGACY_ADMIN_TOKEN ?? 'local-admin-token',
  port,
}).then(({ url }) => console.log(`RESLINK/2 legacy host listening on ${url}/reslink (WSDL: ${url}/reslink?wsdl)`));
