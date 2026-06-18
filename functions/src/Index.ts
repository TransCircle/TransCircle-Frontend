import app from './Router';
import { log } from './Logger';
import { conf } from './Config';
import { ensureMiddlewareTables } from './init';

const servConf = conf.SERV_CONFIG as Record<string, string | number | undefined> | undefined;
const debugConf = conf.DEBUG_CONFIG as Record<string, boolean | undefined> | undefined;

const PORT = Number(servConf?.SERV_PORT) || 1145;
const HOST = (servConf?.SERV_HOSTNAME as string) || '0.0.0.0';

log('=-=-=-=-=-=-=-=-= TransCircle Backend Starting =-=-=-=-=-=-=-=-=');

// Eagerly verify middleware tables before accepting requests
ensureMiddlewareTables().catch((err) =>
  log(`WARNING: middleware table check failed: ${err.message}`)
);

if (debugConf?.APISERV_ENABLE !== false) {
  app.listen(PORT, HOST, () => {
    log(`Backend server started at http://${HOST}:${PORT}/`);
    log(`API base: http://${HOST}:${PORT}/v1/`);
  });
} else {
  log('API server is disabled by config (APISERV_ENABLE = false)');
}

log('=-=-=-=-=-=-=-=-= Server Running =-=-=-=-=-=-=-=-=');
