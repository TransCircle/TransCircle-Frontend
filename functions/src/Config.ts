import * as fs from 'node:fs';
import * as path from 'node:path';
import * as toml from 'toml';

interface ConfigSection {
  [key: string]: string | number | bigint | boolean | object | undefined;
}

// Resolve config.toml from functions/ root
const CONFIG_PATH = path.resolve(import.meta.dirname, '..', 'config.toml');
const CONFIG_EXAMPLE = path.resolve(import.meta.dirname, '..', 'config.toml.example');

if (!fs.existsSync(CONFIG_PATH)) {
  if (fs.existsSync(CONFIG_EXAMPLE)) {
    fs.copyFileSync(CONFIG_EXAMPLE, CONFIG_PATH);
    console.warn('config.toml not found — copied from config.toml.example');
  } else {
    console.error('Neither config.toml nor config.toml.example found');
    process.exit(1);
  }
}

let config: Record<string, ConfigSection>;
try {
  config = toml.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error('Failed to parse config.toml:', err);
  process.exit(1);
}

// Environment variable overrides: SECTION__KEY
for (const [envKey, envValue] of Object.entries(process.env)) {
  if (envValue === undefined) continue;
  const sep = envKey.indexOf('__');
  if (sep === -1) continue;
  const section = envKey.slice(0, sep);
  const key = envKey.slice(sep + 2);
  if (!section || !key) continue;
  const sectionObj = config[section];
  if (!sectionObj || !(key in sectionObj)) continue;

  const orig = sectionObj[key];
  switch (typeof orig) {
    case 'boolean': {
      const v = envValue.toLowerCase();
      sectionObj[key] = v === 'true' || v === '1';
      break;
    }
    case 'number': {
      const n = Number(envValue);
      if (!isNaN(n)) sectionObj[key] = n;
      break;
    }
    case 'bigint':
      try { sectionObj[key] = BigInt(envValue); } catch { /* ignore */ }
      break;
    case 'object':
      try { sectionObj[key] = JSON.parse(envValue); } catch { /* ignore */ }
      break;
    default:
      sectionObj[key] = envValue;
  }
}

export const conf = config;
