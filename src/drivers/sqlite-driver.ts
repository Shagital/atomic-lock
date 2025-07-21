import { LockDriver, LockInfo } from '../types'

/**
 * SQLite driver implementation using better-sqlite3 or similar
 */
export class SQLiteLockDriver implements LockDriver {
  private tableName: string

  constructor(private config: { db: any, tableName?: string }) {
    this.tableName = config.tableName || 'atomic_locks'
    this.initializeTable()
  }

  private initializeTable(): void {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        lock_key TEXT PRIMARY KEY,
        lock_value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `
    this.config.db.exec(sql)
    
    // Create index for expiry cleanup
    const indexSql = `
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires_at 
      ON ${this.tableName}(expires_at)
    `
    this.config.db.exec(indexSql)
  }

  async tryAcquire(key: string, lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const expiresAt = Date.now() + (expiryInSeconds * 1000)
    const createdAt = Date.now()

    try {
      // First, clean up expired locks for this key
      this.config.db.prepare(`
        DELETE FROM ${this.tableName} 
        WHERE lock_key = ? AND expires_at < ?
      `).run(key, Date.now())

      // Try to insert the lock
      const stmt = this.config.db.prepare(`
        INSERT INTO ${this.tableName} (lock_key, lock_value, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `)
      
      stmt.run(key, lockValue, expiresAt, createdAt)
      return true
    } catch (error: any) {
      // SQLite will throw UNIQUE constraint error if lock exists
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return false
      }
      throw error
    }
  }

  async tryAcquireMultiple(keys: string[], lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const expiresAt = Date.now() + (expiryInSeconds * 1000)
    const createdAt = Date.now()
    const now = Date.now()

    return this.config.db.transaction(() => {
      // Clean up expired locks for all keys
      const cleanupStmt = this.config.db.prepare(`
        DELETE FROM ${this.tableName} 
        WHERE lock_key IN (${keys.map(() => '?').join(',')}) AND expires_at < ?
      `)
      cleanupStmt.run(...keys, now)

      // Check if any locks exist
      const checkStmt = this.config.db.prepare(`
        SELECT COUNT(*) as count FROM ${this.tableName} 
        WHERE lock_key IN (${keys.map(() => '?').join(',')}) AND expires_at >= ?
      `)
      const result = checkStmt.get(...keys, now) as { count: number }
      
      if (result.count > 0) {
        return false
      }

      // Acquire all locks
      const insertStmt = this.config.db.prepare(`
        INSERT INTO ${this.tableName} (lock_key, lock_value, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `)

      for (const key of keys) {
        insertStmt.run(key, lockValue, expiresAt, createdAt)
      }

      return true
    })()
  }

  async release(key: string, lockValue: string): Promise<boolean> {
    const stmt = this.config.db.prepare(`
      DELETE FROM ${this.tableName} 
      WHERE lock_key = ? AND lock_value = ?
    `)
    
    const result = stmt.run(key, lockValue)
    return result.changes > 0
  }

  async releaseMultiple(keys: string[], lockValue: string): Promise<number> {
    const stmt = this.config.db.prepare(`
      DELETE FROM ${this.tableName} 
      WHERE lock_key IN (${keys.map(() => '?').join(',')}) AND lock_value = ?
    `)
    
    const result = stmt.run(...keys, lockValue)
    return result.changes
  }

  async exists(key: string): Promise<boolean> {
    // Clean up expired lock first
    this.config.db.prepare(`
      DELETE FROM ${this.tableName} 
      WHERE lock_key = ? AND expires_at < ?
    `).run(key, Date.now())

    const stmt = this.config.db.prepare(`
      SELECT 1 FROM ${this.tableName} 
      WHERE lock_key = ? AND expires_at >= ?
    `)
    
    const result = stmt.get(key, Date.now())
    return result !== undefined
  }

  async getLockInfo(key: string): Promise<LockInfo | null> {
    const stmt = this.config.db.prepare(`
      SELECT lock_value as value, expires_at as expiresAt, created_at as createdAt
      FROM ${this.tableName} 
      WHERE lock_key = ? AND expires_at >= ?
    `)
    
    const result = stmt.get(key, Date.now()) as LockInfo | undefined
    return result || null
  }

  async cleanup(): Promise<void> {
    const stmt = this.config.db.prepare(`
      DELETE FROM ${this.tableName} 
      WHERE expires_at < ?
    `)
    
    stmt.run(Date.now())
  }

  async close(): Promise<void> {
    if (this.config.db.close) {
      this.config.db.close()
    }
  }
}
