import mysql from 'mysql2/promise'

let pool: mysql.Pool | null = null

export function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'specter_dashboard',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'specter',
      connectionLimit: 5,
      waitForConnections: true,
      enableKeepAlive: true,
      ssl: { rejectUnauthorized: false },
    })
  }
  return pool
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T>(sql: string, params?: any[]): Promise<T[]> {
  const [rows] = await getPool().execute(sql, params)
  return rows as T[]
}
