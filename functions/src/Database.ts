import mysql from 'mysql2/promise';
import { conf } from './Config';

const dbConf = conf.DB_CONFIG as Record<string, string | number | undefined>;

const pool = mysql.createPool({
  host: (dbConf.DB_HOSTNAME as string) || 'localhost',
  port: Number(dbConf.DB_PORT) || 3306,
  user: (dbConf.DB_USERNAME as string) || 'transcircle',
  password: (dbConf.DB_PASSWORD as string) || '',
  database: (dbConf.DB_DATABASE as string) || 'transcircle',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+00:00',
});

/** Execute a query, return rows */
export async function query<T extends mysql.RowDataPacket[]>(
  sql: string,
  params?: any[],
): Promise<T> {
  const [rows] = await pool.execute<T>(sql, params);
  return rows;
}

/** Execute a query, return first row or null */
export async function queryOne<T extends mysql.RowDataPacket[]>(
  sql: string,
  params?: unknown[],
): Promise<T[number] | null> {
  const rows = await query<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/** Execute a write query (INSERT/UPDATE/DELETE), return ResultSetHeader */
export async function exec(
  sql: string,
  params?: any[],
): Promise<mysql.ResultSetHeader> {
  const [result] = await pool.execute<mysql.ResultSetHeader>(sql, params);
  return result;
}

/** Get a raw connection from the pool (for transactions) */
export async function getConnection(): Promise<mysql.PoolConnection> {
  return pool.getConnection();
}

export default pool;
