/**
 * Database setup script.
 * Run: npx tsx src/setup.ts
 *
 * Creates the database (if not exists) and runs the schema.
 * The schema SQL is embedded here for portability.
 */

import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { conf } from './Config';

const dbConf = conf.DB_CONFIG as Record<string, string | number | undefined>;

async function main() {
  const host = (dbConf.DB_HOSTNAME as string) || 'localhost';
  const port = Number(dbConf.DB_PORT) || 3306;
  const user = (dbConf.DB_USERNAME as string) || 'transcircle';
  const password = (dbConf.DB_PASSWORD as string) || '';
  const database = (dbConf.DB_DATABASE as string) || 'transcircle';

  console.log(`Connecting to MySQL at ${host}:${port}...`);

  // Connect without database first to create it
  const conn = await mysql.createConnection({ host, port, user, password });

  await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  console.log(`Database "${database}" ensured.`);

  await conn.changeUser({ database });
  console.log('Connected to', database);

  // Look for schema.sql relative to this file
  const schemaPaths = [
    path.resolve(import.meta.dirname, '..', 'schema.sql'),
    path.resolve(import.meta.dirname, '..', '..', 'schema.sql'),
  ];

  let schemaSql = '';
  for (const sp of schemaPaths) {
    if (fs.existsSync(sp)) {
      schemaSql = fs.readFileSync(sp, 'utf-8');
      console.log(`Found schema at ${sp}`);
      break;
    }
  }

  if (schemaSql) {
    // Split by delimiter and run each statement
    const statements = schemaSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('DELIMITER'));

    for (const stmt of statements) {
      try {
        await conn.execute(stmt);
      } catch (err: any) {
        // Table already exists errors are OK
        if (err?.errno === 1050) {
          console.log(`  Table already exists, skipping...`);
        } else {
          console.error(`  Error executing: ${stmt.slice(0, 60)}...`);
          console.error(`  ${err?.message || err}`);
        }
      }
    }
    console.log('Schema applied.');
  } else {
    console.warn('No schema.sql found — skipping table creation.');
  }

  // Create roles
  try {
    await conn.execute(`INSERT IGNORE INTO roles (id, name, description, createdAt) VALUES (UUID(), 'admin', '系统管理员', UNIX_TIMESTAMP(NOW()) * 1000)`);
    await conn.execute(`INSERT IGNORE INTO roles (id, name, description, createdAt) VALUES (UUID(), 'editor', '编辑', UNIX_TIMESTAMP(NOW()) * 1000)`);
    await conn.execute(`INSERT IGNORE INTO roles (id, name, description, createdAt) VALUES (UUID(), 'reviewer', '审稿员', UNIX_TIMESTAMP(NOW()) * 1000)`);
    console.log('Default roles created.');
  } catch { /* roles may already exist */ }

  await conn.end();
  console.log('Done!');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
