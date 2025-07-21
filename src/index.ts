// Core exports
export { AtomicLock, createLock } from './core/atomic-lock'
export type { LockDriver, LockOptions, DriverConfig, CircuitBreakerStats, LockInfo } from './types'

// Driver exports
export { RedisLockDriver } from './drivers/redis-driver'
export { FileLockDriver } from './drivers/file-driver'
export { SQLiteLockDriver } from './drivers/sqlite-driver'
export { MemoryLockDriver } from './drivers/memory-driver'

// Convenience factory functions
import { AtomicLock } from './core/atomic-lock'

export function createRedisLock(client: any, options?: any) {
  return new AtomicLock({ driver: 'redis', redis: { client } }, options)
}

export function createFileLock(lockDir: string, options?: any) {
  return new AtomicLock({ driver: 'file', file: { lockDir } }, options)
}

export function createSQLiteLock(db: any, options?: any) {
  return new AtomicLock({ driver: 'sqlite', sqlite: { db } }, options)
}

export function createMemoryLock(options?: any) {
  return new AtomicLock({ driver: 'memory', memory: {} }, options)
}
