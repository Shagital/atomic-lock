import { LockDriver, LockInfo } from '../types'

/**
 * In-memory driver implementation (for testing and single-process scenarios)
 */
export class MemoryLockDriver implements LockDriver {
  private locks = new Map<string, { value: string, expiresAt: number, createdAt: number }>()
  private cleanupInterval?: NodeJS.Timeout

  constructor(config: { cleanupInterval?: number } = {}) {
    if (config.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup().catch(console.error)
      }, config.cleanupInterval)
    }
  }

  async tryAcquire(key: string, lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const now = Date.now()
    const existing = this.locks.get(key)
    
    // Check if existing lock is expired
    if (existing && existing.expiresAt < now) {
      this.locks.delete(key)
    }

    // Check if lock exists and is not expired
    if (this.locks.has(key)) {
      return false
    }

    // Acquire lock
    this.locks.set(key, {
      value: lockValue,
      expiresAt: now + (expiryInSeconds * 1000),
      createdAt: now
    })

    return true
  }

  async tryAcquireMultiple(keys: string[], lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const now = Date.now()
    
    // Clean up expired locks for all keys
    for (const key of keys) {
      const existing = this.locks.get(key)
      if (existing && existing.expiresAt < now) {
        this.locks.delete(key)
      }
    }

    // Check if any locks exist
    for (const key of keys) {
      if (this.locks.has(key)) {
        return false
      }
    }

    // Acquire all locks
    const lockData = {
      value: lockValue,
      expiresAt: now + (expiryInSeconds * 1000),
      createdAt: now
    }

    for (const key of keys) {
      this.locks.set(key, lockData)
    }

    return true
  }

  async release(key: string, lockValue: string): Promise<boolean> {
    const existing = this.locks.get(key)
    
    if (existing && existing.value === lockValue) {
      this.locks.delete(key)
      return true
    }

    return false
  }

  async releaseMultiple(keys: string[], lockValue: string): Promise<number> {
    let released = 0

    for (const key of keys) {
      const success = await this.release(key, lockValue)
      if (success) released++
    }

    return released
  }

  async exists(key: string): Promise<boolean> {
    const existing = this.locks.get(key)
    
    if (!existing) return false

    // Check if expired
    if (existing.expiresAt < Date.now()) {
      this.locks.delete(key)
      return false
    }

    return true
  }

  async getLockInfo(key: string): Promise<LockInfo | null> {
    const existing = this.locks.get(key)
    
    if (!existing) return null

    // Check if expired
    if (existing.expiresAt < Date.now()) {
      this.locks.delete(key)
      return null
    }

    return {
      key,
      value: existing.value,
      expiresAt: existing.expiresAt,
      createdAt: existing.createdAt
    }
  }

  async cleanup(): Promise<void> {
    const now = Date.now()
    
    for (const [key, lock] of this.locks.entries()) {
      if (lock.expiresAt < now) {
        this.locks.delete(key)
      }
    }
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
    this.locks.clear()
  }

  // For testing purposes
  getLockCount(): number {
    return this.locks.size
  }

  getAllLocks(): Map<string, LockInfo> {
    const result = new Map<string, LockInfo>()
    const now = Date.now()
    
    for (const [key, lock] of this.locks.entries()) {
      if (lock.expiresAt >= now) {
        result.set(key, {
          key,
          value: lock.value,
          expiresAt: lock.expiresAt,
          createdAt: lock.createdAt
        })
      }
    }
    
    return result
  }
}
