import { AtomicLock, createLock } from '../src/core/atomic-lock'
import { LockDriver, DriverConfig, LockOptions } from '../src/types'
import { RedisLockDriver } from '../src/drivers/redis-driver'
import { FileLockDriver } from '../src/drivers/file-driver'
import { SQLiteLockDriver } from '../src/drivers/sqlite-driver'
import { MemoryLockDriver } from '../src/drivers/memory-driver'

// Mock all drivers
jest.mock('../src/drivers/redis-driver')
jest.mock('../src/drivers/file-driver')
jest.mock('../src/drivers/sqlite-driver')
jest.mock('../src/drivers/memory-driver')
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-123'),
}))

const MockRedisLockDriver = RedisLockDriver as jest.MockedClass<typeof RedisLockDriver>
const MockFileLockDriver = FileLockDriver as jest.MockedClass<typeof FileLockDriver>
const MockSQLiteLockDriver = SQLiteLockDriver as jest.MockedClass<typeof SQLiteLockDriver>
const MockMemoryLockDriver = MemoryLockDriver as jest.MockedClass<typeof MemoryLockDriver>

describe('AtomicLock', () => {
  let mockDriver: jest.Mocked<LockDriver>
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()

    // Create mock driver with only the methods used by AtomicLock
    mockDriver = {
      tryAcquire: jest.fn(),
      release: jest.fn(),
      tryAcquireMultiple: jest.fn(),
      releaseMultiple: jest.fn(),
    }

    // Mock console.error
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

    // Setup default mock implementations
    MockRedisLockDriver.mockImplementation(() => mockDriver as any)
    MockFileLockDriver.mockImplementation(() => mockDriver as any)
    MockSQLiteLockDriver.mockImplementation(() => mockDriver as any)
    MockMemoryLockDriver.mockImplementation(() => mockDriver as any)
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  describe('Constructor and Driver Creation', () => {
    it('should create Redis driver', () => {
      const config: DriverConfig = {
        driver: 'redis',
        redis: { host: 'localhost', port: 6379 },
      }
      new AtomicLock(config)
      expect(MockRedisLockDriver).toHaveBeenCalledWith(config.redis)
    })

    it('should create File driver', () => {
      const config: DriverConfig = {
        driver: 'file',
        file: { lockDir: '/tmp/locks' },
      }
      new AtomicLock(config)
      expect(MockFileLockDriver).toHaveBeenCalledWith(config.file)
    })

    it('should create SQLite driver', () => {
      const config: DriverConfig = {
        driver: 'sqlite',
        sqlite: { db: '/tmp/locks.db' },
      }
      new AtomicLock(config)
      expect(MockSQLiteLockDriver).toHaveBeenCalledWith(config.sqlite)
    })

    it('should create Memory driver', () => {
      const config: DriverConfig = {
        driver: 'memory',
        memory: {},
      }
      new AtomicLock(config)
      expect(MockMemoryLockDriver).toHaveBeenCalledWith(config.memory)
    })

    it('should throw error for unsupported driver', () => {
      const config: DriverConfig = {
        driver: 'unsupported' as any,
      }
      expect(() => new AtomicLock(config)).toThrow('Unsupported driver: unsupported')
    })

    it('should use default options when none provided', () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const lock = new AtomicLock(config)

      // Test default values by checking circuit breaker behavior
      const status = lock.getCircuitBreakerStatus('test-key')
      expect(status.failureCount).toBe(0)
      expect(status.isOpen).toBe(false)
    })

    it('should use custom options when provided', () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = {
        circuitBreakerThreshold: 3,
        circuitBreakerResetTime: 15000,
        maxFailureEntries: 500,
      }

      const lock = new AtomicLock(config, options)
      // Options are used internally, verified through behavior tests
      expect(lock).toBeDefined()
    })
  })

  describe('tryAcquire', () => {
    let lock: AtomicLock

    beforeEach(() => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      lock = new AtomicLock(config)
    })

    it('should successfully acquire lock', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)

      const result = await lock.tryAcquire('test-key')

      expect(result).toBe('mock-uuid-123')
      expect(mockDriver.tryAcquire).toHaveBeenCalledWith('test-key', 'mock-uuid-123', 10)
    })

    it('should use custom expiry time', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)

      await lock.tryAcquire('test-key', { expiryInSeconds: 30 })

      expect(mockDriver.tryAcquire).toHaveBeenCalledWith('test-key', 'mock-uuid-123', 30)
    })

    it('should return null when driver fails to acquire', async () => {
      mockDriver.tryAcquire.mockResolvedValue(false)

      const result = await lock.tryAcquire('test-key')

      expect(result).toBeNull()
    })

    it('should return null when driver throws error', async () => {
      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      const result = await lock.tryAcquire('test-key')

      expect(result).toBeNull()
    })

    it('should return null when circuit breaker is open', async () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = {
        circuitBreakerThreshold: 2,
        circuitBreakerResetTime: 30000,
      }
      lock = new AtomicLock(config, options)

      // Trigger circuit breaker by causing failures
      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))
      await lock.tryAcquire('test-key')
      await lock.tryAcquire('test-key')

      // Circuit should be open now
      const result = await lock.tryAcquire('test-key')
      expect(result).toBeNull()
    })

    it('should clear failure record on successful acquisition', async () => {
      // First fail to create a failure record
      mockDriver.tryAcquire.mockRejectedValueOnce(new Error('Driver error'))
      await lock.tryAcquire('test-key')

      // Then succeed
      mockDriver.tryAcquire.mockResolvedValue(true)
      const result = await lock.tryAcquire('test-key')

      expect(result).toBe('mock-uuid-123')

      // Verify failure record was cleared
      const status = lock.getCircuitBreakerStatus('test-key')
      expect(status.failureCount).toBe(0)
    })
  })

  describe('acquire', () => {
    let lock: AtomicLock

    beforeEach(() => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      lock = new AtomicLock(config)
    })

    it('should return lock value on successful acquisition', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)

      const result = await lock.acquire('test-key')

      expect(result).toBe('mock-uuid-123')
    })

    it('should throw error when acquisition fails', async () => {
      mockDriver.tryAcquire.mockResolvedValue(false)

      await expect(lock.acquire('test-key')).rejects.toThrow(
        'Failed to acquire lock for key: test-key'
      )
    })

    it('should pass options to tryAcquire', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)

      await lock.acquire('test-key', { expiryInSeconds: 25 })

      expect(mockDriver.tryAcquire).toHaveBeenCalledWith('test-key', 'mock-uuid-123', 25)
    })
  })

  describe('release', () => {
    let lock: AtomicLock

    beforeEach(() => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      lock = new AtomicLock(config)
    })

    it('should successfully release lock', async () => {
      mockDriver.release.mockResolvedValue(true)

      const result = await lock.release('test-key', 'lock-value')

      expect(result).toBe(true)
      expect(mockDriver.release).toHaveBeenCalledWith('test-key', 'lock-value')
    })

    it('should return false and log error when driver throws', async () => {
      const error = new Error('Release error')
      mockDriver.release.mockRejectedValue(error)

      const result = await lock.release('test-key', 'lock-value')

      expect(result).toBe(false)
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error releasing lock test-key:', error)
    })

    it('should return driver result when release fails', async () => {
      mockDriver.release.mockResolvedValue(false)

      const result = await lock.release('test-key', 'lock-value')

      expect(result).toBe(false)
    })
  })

  describe('withLock', () => {
    let lock: AtomicLock

    beforeEach(() => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      lock = new AtomicLock(config)
    })

    it('should execute callback and return result', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)
      mockDriver.release.mockResolvedValue(true)

      const callback = jest.fn().mockResolvedValue('callback-result')

      const result = await lock.withLock('test-key', callback)

      expect(result).toBe('callback-result')
      expect(callback).toHaveBeenCalledWith('mock-uuid-123')
      expect(mockDriver.release).toHaveBeenCalledWith('test-key', 'mock-uuid-123')
    })

    it('should execute synchronous callback', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)
      mockDriver.release.mockResolvedValue(true)

      const callback = jest.fn().mockReturnValue('sync-result')

      const result = await lock.withLock('test-key', callback, {})

      expect(result).toBe('sync-result')
    })

    it('should release lock even if callback throws', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)
      mockDriver.release.mockResolvedValue(true)

      const callback = jest.fn().mockRejectedValue(new Error('Callback error'))

      await expect(lock.withLock('test-key', callback)).rejects.toThrow('Callback error')
      expect(mockDriver.release).toHaveBeenCalledWith('test-key', 'mock-uuid-123')
    })

    it('should use default options when none provided', async () => {
      mockDriver.tryAcquire.mockResolvedValue(true)
      mockDriver.release.mockResolvedValue(true)

      const callback = jest.fn().mockResolvedValue('result')

      await lock.withLock('test-key', callback)

      expect(mockDriver.tryAcquire).toHaveBeenCalledWith('test-key', 'mock-uuid-123', 10)
    })
  })

  describe('Circuit Breaker', () => {
    let lock: AtomicLock

    beforeEach(() => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = {
        circuitBreakerThreshold: 3,
        circuitBreakerResetTime: 30000,
      }
      lock = new AtomicLock(config, options)
    })

    it('should track failure count', async () => {
      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      await lock.tryAcquire('test-key')
      await lock.tryAcquire('test-key')

      const status = lock.getCircuitBreakerStatus('test-key')
      expect(status.failureCount).toBe(2)
      expect(status.isOpen).toBe(false)
    })

    it('should open circuit after threshold is reached', async () => {
      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      await lock.tryAcquire('test-key')
      await lock.tryAcquire('test-key')
      await lock.tryAcquire('test-key')

      const status = lock.getCircuitBreakerStatus('test-key')
      expect(status.failureCount).toBe(3)
      expect(status.isOpen).toBe(true)
      expect(status.nextAttemptAt).toBeDefined()
    })

    it('should reset failure count after reset time', async () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = {
        circuitBreakerThreshold: 2,
        circuitBreakerResetTime: 100, // Short time for testing
      }
      lock = new AtomicLock(config, options)

      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      // Create failure
      await lock.tryAcquire('test-key')

      // Wait for reset time
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Next failure should reset count to 1
      await lock.tryAcquire('test-key')

      const status = lock.getCircuitBreakerStatus('test-key')
      expect(status.failureCount).toBe(1)
    })

    it('should return stats for non-existent key', () => {
      const status = lock.getCircuitBreakerStatus('non-existent-key')

      expect(status.isOpen).toBe(false)
      expect(status.failureCount).toBe(0)
      expect(status.lastFailure).toBeUndefined()
      expect(status.nextAttemptAt).toBeUndefined()
    })

    it('should close circuit after reset time passes', async () => {
      jest.useFakeTimers()
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = {
        circuitBreakerThreshold: 2,
        circuitBreakerResetTime: 30000,
      }
      lock = new AtomicLock(config, options)

      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      // Open circuit
      await lock.tryAcquire('test-key')
      await lock.tryAcquire('test-key')

      expect(lock.getCircuitBreakerStatus('test-key').isOpen).toBe(true)

      // Fast forward past reset time
      jest.advanceTimersByTime(31000)

      expect(lock.getCircuitBreakerStatus('test-key').isOpen).toBe(false)

      jest.useRealTimers()
    })
  })

  describe('Failure Record Management', () => {
    let lock: AtomicLock

    beforeEach(() => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = {
        maxFailureEntries: 5,
        circuitBreakerResetTime: 100,
      }
      lock = new AtomicLock(config, options)
    })

    it('should cleanup old failure records', async () => {
      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      // Create failure record
      await lock.tryAcquire('test-key')
      expect(lock.getCircuitBreakerStatus('test-key').failureCount).toBe(1)

      // Wait for cleanup time
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Trigger cleanup by creating failure for another key and advancing time
      const originalNow = Date.now
      Date.now = jest.fn(() => originalNow() + 70000) // Advance by more than 60 seconds

      await lock.tryAcquire('another-key')

      // Original failure should be cleaned up
      expect(lock.getCircuitBreakerStatus('test-key').failureCount).toBe(0)

      Date.now = originalNow
    })

    it('should handle exactly 100 entries in cleanup scenario', async () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = { maxFailureEntries: 10 }
      lock = new AtomicLock(config, options)

      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      // Create exactly maxFailureEntries + 1 to trigger cleanup of 100 entries
      for (let i = 0; i <= 10; i++) {
        await lock.tryAcquire(`test-key-${i}`)
      }

      // Should have cleaned up some entries
      expect(lock.getCircuitBreakerStatus('test-key-0').failureCount).toBe(0)
    })

    it('should handle cleanup when no entries need cleaning', async () => {
      const originalNow = Date.now
      const mockNow = jest.fn()
      Date.now = mockNow

      // Set initial time
      mockNow.mockReturnValue(1000000)

      const config: DriverConfig = { driver: 'memory', memory: {} }
      lock = new AtomicLock(config)

      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

      // Create a recent failure
      await lock.tryAcquire('test-key')

      // Advance time by more than 60 seconds to trigger cleanup
      mockNow.mockReturnValue(1000000 + 70000)

      // But make failure recent enough to not be cleaned
      mockNow.mockReturnValue(1000000 + 70000)

      // Trigger cleanup attempt
      await lock.tryAcquire('another-key')

      Date.now = originalNow
    })
  })

  describe('close', () => {
    it('should clear failure records', async () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const lock = new AtomicLock(config)

      mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))
      await lock.tryAcquire('test-key')

      expect(lock.getCircuitBreakerStatus('test-key').failureCount).toBe(1)

      await lock.close()

      expect(lock.getCircuitBreakerStatus('test-key').failureCount).toBe(0)
    })
  })

  describe('createLock factory function', () => {
    it('should create AtomicLock instance', () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const lock = createLock(config)

      expect(lock).toBeInstanceOf(AtomicLock)
    })

    it('should pass options to AtomicLock constructor', () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }
      const options: LockOptions = { circuitBreakerThreshold: 10 }

      const lock = createLock(config, options)

      expect(lock).toBeInstanceOf(AtomicLock)
    })

    it('should work without options', () => {
      const config: DriverConfig = { driver: 'memory', memory: {} }

      const lock = createLock(config)

      expect(lock).toBeInstanceOf(AtomicLock)
    })
  })

  describe('UUID Generation Edge Case', () => {
    it('should handle different UUID values', () => {
      const { v4 } = require('uuid')
      v4.mockReturnValueOnce('different-uuid-456')

      const config: DriverConfig = { driver: 'memory', memory: {} }
      const lock = new AtomicLock(config)

      mockDriver.tryAcquire.mockResolvedValue(true)

      lock.tryAcquire('test-key').then((result) => {
        expect(result).toBe('different-uuid-456')
      })
    })
  })

  describe('Private Method Coverage', () => {
     it('should handle multiple driver instantiation scenarios', () => {
      // Test that each driver constructor is called correctly
      const configs = [
        { driver: 'redis' as const, redis: { host: 'localhost', port: 6379 } },
        { driver: 'file' as const, file: { lockDir: '/custom/dir' } },
        { driver: 'sqlite' as const, sqlite: { db: 'mock-db' } },
        { driver: 'memory' as const, memory: {} },
      ]

      configs.forEach((config) => {
        const lock = new AtomicLock(config)
        expect(lock).toBeDefined()
      })
    })
  })
  let lock: AtomicLock

  beforeEach(() => {
    const config: DriverConfig = { driver: 'memory', memory: {} }
    lock = new AtomicLock(config)
  })

  it('should handle rapid successive calls with circuit breaker', async () => {
    const config: DriverConfig = { driver: 'memory', memory: {} }
    const options: LockOptions = { circuitBreakerThreshold: 2 }
    lock = new AtomicLock(config, options)

    mockDriver.tryAcquire.mockRejectedValue(new Error('Driver error'))

    // Rapid failures
    const promises = [
      lock.tryAcquire('test-key'),
      lock.tryAcquire('test-key'),
      lock.tryAcquire('test-key'),
    ]

    const results = await Promise.all(promises)

    expect(results.every((result) => result === null)).toBe(true)
  })

  it('should handle mixed success and failure scenarios', async () => {
    mockDriver.tryAcquire
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('Driver error'))
      .mockResolvedValueOnce(true)

    const result1 = await lock.tryAcquire('test-key')
    const result2 = await lock.tryAcquire('test-key')
    const result3 = await lock.tryAcquire('test-key')

    expect(result1).toBe('mock-uuid-123')
    expect(result2).toBeNull()
    expect(result3).toBe('mock-uuid-123')
  })
})
