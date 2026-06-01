import fs from 'node:fs';
import path from 'node:path';
import { conf } from './Config';

const loggerConf = conf.LOGGER as Record<string, string | undefined>;
const debugConf = conf.DEBUG_CONFIG as Record<string, boolean | undefined>;

const logDir = path.resolve(import.meta.dirname, '..', 'logs');

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatTimestamp(format: string): string {
  const d = new Date();
  const map: Record<string, string> = {
    yyyy: d.getFullYear().toString(),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  let result = format;
  for (const [k, v] of Object.entries(map)) {
    result = result.replace(k, v);
  }
  return result;
}

export function log(context: string): void {
  const timeFmt = loggerConf.LOGTIME_FORMAT || 'yyyy-MM-DD HH:mm:ss';
  const fileFmt = loggerConf.LOGFILE_FORMAT || 'yyyyMMDD';
  const timestamp = formatTimestamp(timeFmt);

  const lines = context.split(/\r?\n/);
  const data = lines.map((line) => `[${timestamp}] ${line}`).join('\n');

  console.log(data);

  if (debugConf?.DEBUG_MODE) return;

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logfile = path.join(logDir, formatTimestamp(fileFmt) + '.log');
  fs.appendFile(logfile, data + '\n', 'utf-8', (err) => {
    if (err) console.error(`Failed to log: ${err.message}`);
  });
}
