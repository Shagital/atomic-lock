import { Redis } from 'ioredis'

/**
 * Type definitions for atomic-lock
 */

export interface LockOptions {
  expiryInSeconds?: number
  maxRetries?: number
  circuitBreakerThreshold?: number
  circuitBreakerResetTime?: number
  maxFailureEntries?: number
}

export interface CircuitBreakerStats {
  isOpen: boolean
  failureCount: number
  lastFailure?: number
  nextAttemptAt?: number
}

export interface LockInfo {
  key: string
  value: string
  expiresAt: number
  createdAt?: number
}

export interface LockDriver {
  tryAcquire(key: string, lockValue: string, expiryInSeconds: number): Promise<boolean>
  tryAcquireMultiple(keys: string[], lockValue: string, expiryInSeconds: number): Promise<boolean>
  release(key: string, lockValue: string): Promise<boolean>
  releaseMultiple(keys: string[], lockValue: string): Promise<number>
  exists?(key: string): Promise<boolean>
  getLockInfo?(key: string): Promise<LockInfo | null>
  cleanup?(): Promise<void>
  close?(): Promise<void>
}

export interface RedisConnectionOptions {
  host?: string
  port?: number
  password?: string
  username?: string
  db?: number
  family?: 4 | 6
  connectTimeout?: number
  commandTimeout?: number
  retryDelayOnFailover?: number
  maxRetriesPerRequest?: number | null
  lazyConnect?: boolean
  keepAlive?: number
  keyPrefix?: string
}

export interface RedisConfig {
  // Option 1: Pass existing Redis client instance
  client?: Redis
  
  // Option 2: Redis URL (redis://user:pass@host:port/db)
  url?: string
  
  // Option 3: Individual connection parameters
  host?: string
  port?: number
  password?: string
  username?: string
  db?: number
  
  // Additional ioredis options
  options?: RedisConnectionOptions
}

export interface FileConfig {
  lockDir: string
  cleanupInterval?: number
}

export interface SQLiteConfig {
  db: any // SQLite database instance or connection string
}

export interface MemoryConfig {
  // No specific config needed for memory driver
}

export interface DriverConfig {
  driver: 'redis' | 'file' | 'sqlite' | 'memory'
  redis?: RedisConfig
  file?: FileConfig
  sqlite?: SQLiteConfig
  memory?: MemoryConfig
}