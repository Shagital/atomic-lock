import { LockDriver, LockOptions, DriverConfig, CircuitBreakerStats } from '../types'
import { RedisLockDriver } from '../drivers/redis-driver'
import { FileLockDriver } from '../drivers/file-driver'
import { SQLiteLockDriver } from '../drivers/sqlite-driver'
import { MemoryLockDriver } from '../drivers/memory-driver'
import { v4 as uuidv4 } from 'uuid'

/**
 * Universal atomic lock with memory-safe circuit breaker
 */
export class AtomicLock {
  /**
   * Callback-style lock usage. Acquires the lock, runs the callback, always releases the lock.
   * Throws if lock cannot be acquired. Returns the callback's result.
   */
  async withLock<T>(key: string, callback: (lockValue: string) => Promise<T> | T, options: LockOptions = {}): Promise<T> {
    const lockValue = await this.acquire(key, options)
    try {
      return await callback(lockValue)
    } finally {
      await this.release(key, lockValue)
    }
  }
  private driver: LockDriver
  private lockFailures = new Map<string, { count: number, lastFailure: number }>()
  private readonly circuitBreakerThreshold: number
  private readonly circuitBreakerResetTime: number
  private readonly maxFailureEntries: number
  private lastCleanup = Date.now()

  constructor(config: DriverConfig, options: LockOptions = {}) {
    this.driver = this.createDriver(config)
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 5
    this.circuitBreakerResetTime = options.circuitBreakerResetTime ?? 30000
    this.maxFailureEntries = options.maxFailureEntries ?? 1000
  }

  private createDriver(config: DriverConfig): LockDriver {
    switch (config.driver) {
      case 'redis':
        return new RedisLockDriver(config.redis!)
      case 'file':
        return new FileLockDriver(config.file!)
      case 'sqlite':
        return new SQLiteLockDriver(config.sqlite!)
      case 'memory':
        return new MemoryLockDriver(config.memory!)
      default:
        throw new Error(`Unsupported driver: ${config.driver}`)
    }
  }

  async tryAcquire(key: string, options: LockOptions = {}): Promise<string | null> {
    const expiryInSeconds = options.expiryInSeconds ?? 10;
    if (this.isCircuitOpen(key)) {
      return null;
    }
    const lockValue = this.generateLockValue();
    try {
      const acquired = await this.driver.tryAcquire(key, lockValue, expiryInSeconds);
      if (acquired) {
        this.lockFailures.delete(key);
        return lockValue;
      }
      return null;
    } catch (error) {
      this.recordLockFailure(key);
      return null;
    }
  }

  async acquire(key: string, options: LockOptions = {}): Promise<string> {
    const lockValue = await this.tryAcquire(key, options);
    if (!lockValue) {
      throw new Error(`Failed to acquire lock for key: ${key}`);
    }
    return lockValue;
  }

  async release(key: string, lockValue: string): Promise<boolean> {
    try {
      return await this.driver.release(key, lockValue)
    } catch (error) {
      console.error(`Error releasing lock ${key}:`, error)
      return false
    }
  }

  getCircuitBreakerStatus(key: string): CircuitBreakerStats {
    const failure = this.lockFailures.get(key)
    const isOpen = this.isCircuitOpen(key)
    
    return {
      isOpen,
      failureCount: failure?.count ?? 0,
      lastFailure: failure?.lastFailure,
      nextAttemptAt: failure ? failure.lastFailure + this.circuitBreakerResetTime : undefined
    }
  }

  private isCircuitOpen(key: string): boolean {
    const failure = this.lockFailures.get(key)
    if (!failure) return false

    const isOverThreshold = failure.count >= this.circuitBreakerThreshold
    const isWithinResetTime = (Date.now() - failure.lastFailure) < this.circuitBreakerResetTime
    
    return isOverThreshold && isWithinResetTime
  }

  private recordLockFailure(key: string): void {
    const now = Date.now()
    if (now - this.lastCleanup > 60000) {
      this.cleanupFailureRecords()
      this.lastCleanup = now
    }

    if (this.lockFailures.size >= this.maxFailureEntries) {
      const oldestKeys = Array.from(this.lockFailures.keys()).slice(0, 100)
      oldestKeys.forEach(key => this.lockFailures.delete(key))
    }

    const existing = this.lockFailures.get(key)
    
    if (existing) {
      if (now - existing.lastFailure > this.circuitBreakerResetTime) {
        existing.count = 1
      } else {
        existing.count++
      }
      existing.lastFailure = now
    } else {
      this.lockFailures.set(key, {
        count: 1,
        lastFailure: now
      })
    }
  }

  private cleanupFailureRecords(): void {
    const now = Date.now()
    for (const [key, failure] of this.lockFailures.entries()) {
      if (now - failure.lastFailure > this.circuitBreakerResetTime) {
        this.lockFailures.delete(key)
      }
    }
  }

  private generateLockValue(): string {
    return uuidv4();
  }

  async close(): Promise<void> {
    this.lockFailures.clear()
  }
}

export function createLock(config: DriverConfig, options?: LockOptions): AtomicLock {
  return new AtomicLock(config, options)
}
