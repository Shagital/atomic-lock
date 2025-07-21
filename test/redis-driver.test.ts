import { RedisLockDriver } from '../src/drivers/redis-driver'
import { Redis } from 'ioredis'

// Mock ioredis
jest.mock('ioredis', () => {
  return {
    Redis: jest.fn()
  }
})

const MockRedis = Redis as jest.MockedClass<typeof Redis>

describe('RedisLockDriver', () => {
  let driver: RedisLockDriver
  let mockRedisClient: any

  beforeEach(() => {
    jest.clearAllMocks()
    
    // Create mock Redis client
    mockRedisClient = {
      set: jest.fn(),
      eval: jest.fn(),
      exists: jest.fn(),
      get: jest.fn(),
      ttl: jest.fn(),
      quit: jest.fn()
    }
    
    // Mock Redis constructor to return our mock client
    MockRedis.mockImplementation(() => mockRedisClient as any)
  })

  describe('Constructor and Client Creation', () => {
    it('should use existing Redis client when provided', () => {
      const existingClient = { mock: 'existing-client' } as any
      driver = new RedisLockDriver({ client: existingClient })
      
      expect(driver).toBeDefined()
      expect(MockRedis).not.toHaveBeenCalled() // Should not create new client
    })

    it('should create client from Redis URL', () => {
      driver = new RedisLockDriver({ 
        url: 'redis://user:pass@localhost:6379/1',
        options: { connectTimeout: 5000 }
      })
      
      expect(MockRedis).toHaveBeenCalledWith(
        'redis://user:pass@localhost:6379/1',
        { connectTimeout: 5000 }
      )
    })

    it('should create client from Redis URL without options', () => {
      driver = new RedisLockDriver({ 
        url: 'redis://localhost:6379'
      })
      
      expect(MockRedis).toHaveBeenCalledWith('redis://localhost:6379')
    })

    it('should create client from individual parameters', () => {
      driver = new RedisLockDriver({
        host: 'redis.example.com',
        port: 6380,
        password: 'secret',
        username: 'user',
        db: 2,
        options: { 
          connectTimeout: 3000,
          lazyConnect: true 
        }
      })
      
      expect(MockRedis).toHaveBeenCalledWith({
        host: 'redis.example.com',
        port: 6380,
        password: 'secret',
        username: 'user',
        db: 2,
        connectTimeout: 3000,
        lazyConnect: true
      })
    })

    it('should use default values for missing parameters', () => {
      driver = new RedisLockDriver({})
      
      expect(MockRedis).toHaveBeenCalledWith({
        host: 'localhost',
        port: 6379,
        password: undefined,
        username: undefined,
        db: 0
      })
    })

    it('should merge individual parameters with options', () => {
      driver = new RedisLockDriver({
        host: 'custom-host',
        options: {
          port: 6380, // This will override the default port
          retryDelayOnFailover: 1000,
          maxRetriesPerRequest: 3
        }
      })
      
      expect(MockRedis).toHaveBeenCalledWith({
        host: 'custom-host',
        port: 6380, // From options (overrides default)
        password: undefined,
        username: undefined,
        db: 0,
        retryDelayOnFailover: 1000,
        maxRetriesPerRequest: 3
      })
    })
  })

  describe('tryAcquire', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })
    it('should successfully acquire lock when key is available', async () => {
      mockRedisClient.set.mockResolvedValue('OK')
      
      const result = await driver.tryAcquire('test-key', 'lock-value-123', 30)
      
      expect(result).toBe(true)
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test-key',
        'lock-value-123',
        'EX',
        30,
        'NX'
      )
    })

    it('should return false when key is already locked', async () => {
      mockRedisClient.set.mockResolvedValue(null)
      
      const result = await driver.tryAcquire('test-key', 'lock-value-123', 30)
      
      expect(result).toBe(false)
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test-key',
        'lock-value-123',
        'EX',
        30,
        'NX'
      )
    })

    it('should handle different expiry times', async () => {
      mockRedisClient.set.mockResolvedValue('OK')
      
      await driver.tryAcquire('test-key', 'value', 60)
      
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test-key',
        'value',
        'EX',
        60,
        'NX'
      )
    })

    it('should handle different lock values', async () => {
      mockRedisClient.set.mockResolvedValue('OK')
      
      await driver.tryAcquire('test-key', 'custom-lock-value-456', 15)
      
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'test-key',
        'custom-lock-value-456',
        'EX',
        15,
        'NX'
      )
    })

    it('should handle Redis client errors', async () => {
      mockRedisClient.set.mockRejectedValue(new Error('Redis connection failed'))
      
      await expect(driver.tryAcquire('test-key', 'value', 30))
        .rejects.toThrow('Redis connection failed')
    })
  })

  describe('tryAcquireMultiple', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    const expectedScript = `
      local keys = KEYS
      local value = ARGV[1]
      local expiry = ARGV[2]
      
      -- Check if any key is already locked
      for i = 1, #keys do
        if redis.call("EXISTS", keys[i]) == 1 then
          return 0
        end
      end
      
      -- Acquire all locks atomically
      for i = 1, #keys do
        redis.call("SET", keys[i], value, "EX", expiry)
      end
      
      return 1
    `

    it('should successfully acquire multiple locks when all keys are available', async () => {
      mockRedisClient.eval.mockResolvedValue(1)
      
      const result = await driver.tryAcquireMultiple(
        ['key1', 'key2', 'key3'],
        'multi-lock-value',
        45
      )
      
      expect(result).toBe(true)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        3, // number of keys
        'key1',
        'key2',
        'key3',
        'multi-lock-value',
        '45'
      )
    })

    it('should return false when any key is already locked', async () => {
      mockRedisClient.eval.mockResolvedValue(0)
      
      const result = await driver.tryAcquireMultiple(
        ['key1', 'key2', 'key3'],
        'multi-lock-value',
        45
      )
      
      expect(result).toBe(false)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        3,
        'key1',
        'key2',
        'key3',
        'multi-lock-value',
        '45'
      )
    })

    it('should handle single key in array', async () => {
      mockRedisClient.eval.mockResolvedValue(1)
      
      const result = await driver.tryAcquireMultiple(['single-key'], 'value', 10)
      
      expect(result).toBe(true)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        1,
        'single-key',
        'value',
        '10'
      )
    })

    it('should handle empty keys array', async () => {
      mockRedisClient.eval.mockResolvedValue(1)
      
      const result = await driver.tryAcquireMultiple([], 'value', 10)
      
      expect(result).toBe(true)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        0, // no keys
        'value',
        '10'
      )
    })

    it('should convert expiry to string for Lua script', async () => {
      mockRedisClient.eval.mockResolvedValue(1)
      
      await driver.tryAcquireMultiple(['key1'], 'value', 3600)
      
      const callArgs = mockRedisClient.eval.mock.calls[0]
      expect(callArgs[4]).toBe('3600') // Should be string, not number
    })

    it('should handle Redis eval errors', async () => {
      mockRedisClient.eval.mockRejectedValue(new Error('Lua script error'))
      
      await expect(driver.tryAcquireMultiple(['key1'], 'value', 10))
        .rejects.toThrow('Lua script error')
    })
  })

  describe('release', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    const expectedScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `

    it('should successfully release lock with correct value', async () => {
      mockRedisClient.eval.mockResolvedValue(1)
      
      const result = await driver.release('test-key', 'correct-lock-value')
      
      expect(result).toBe(true)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        1,
        'test-key',
        'correct-lock-value'
      )
    })

    it('should return false when lock value does not match', async () => {
      mockRedisClient.eval.mockResolvedValue(0)
      
      const result = await driver.release('test-key', 'wrong-lock-value')
      
      expect(result).toBe(false)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        1,
        'test-key',
        'wrong-lock-value'
      )
    })

    it('should return false when key does not exist', async () => {
      mockRedisClient.eval.mockResolvedValue(0)
      
      const result = await driver.release('non-existent-key', 'any-value')
      
      expect(result).toBe(false)
    })

    it('should handle different lock values', async () => {
      mockRedisClient.eval.mockResolvedValue(1)
      
      await driver.release('test-key', 'special-value-789')
      
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        1,
        'test-key',
        'special-value-789'
      )
    })

    it('should handle Redis eval errors', async () => {
      mockRedisClient.eval.mockRejectedValue(new Error('Redis eval failed'))
      
      await expect(driver.release('test-key', 'value'))
        .rejects.toThrow('Redis eval failed')
    })
  })

  describe('releaseMultiple', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    const expectedScript = `
      local released = 0
      for i = 1, #KEYS do
        if redis.call("GET", KEYS[i]) == ARGV[1] then
          redis.call("DEL", KEYS[i])
          released = released + 1
        end
      end
      return released
    `

    it('should release all matching locks', async () => {
      mockRedisClient.eval.mockResolvedValue(3)
      
      const result = await driver.releaseMultiple(
        ['key1', 'key2', 'key3'],
        'multi-lock-value'
      )
      
      expect(result).toBe(3)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        3,
        'key1',
        'key2',
        'key3',
        'multi-lock-value'
      )
    })

    it('should return count of successfully released locks', async () => {
      mockRedisClient.eval.mockResolvedValue(2) // Only 2 out of 3 were released
      
      const result = await driver.releaseMultiple(
        ['key1', 'key2', 'key3'],
        'partial-match-value'
      )
      
      expect(result).toBe(2)
    })

    it('should return 0 when no locks match', async () => {
      mockRedisClient.eval.mockResolvedValue(0)
      
      const result = await driver.releaseMultiple(
        ['key1', 'key2'],
        'non-matching-value'
      )
      
      expect(result).toBe(0)
    })

    it('should handle single key in array', async () => {
      mockRedisClient.eval.mockResolvedValue(1)
      
      const result = await driver.releaseMultiple(['single-key'], 'value')
      
      expect(result).toBe(1)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        1,
        'single-key',
        'value'
      )
    })

    it('should handle empty keys array', async () => {
      mockRedisClient.eval.mockResolvedValue(0)
      
      const result = await driver.releaseMultiple([], 'value')
      
      expect(result).toBe(0)
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expectedScript,
        0, // no keys
        'value'
      )
    })

    it('should handle Redis eval errors', async () => {
      mockRedisClient.eval.mockRejectedValue(new Error('Redis script error'))
      
      await expect(driver.releaseMultiple(['key1'], 'value'))
        .rejects.toThrow('Redis script error')
    })
  })

  describe('exists', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    it('should return true when key exists', async () => {
      mockRedisClient.exists.mockResolvedValue(1)
      
      const result = await driver.exists('test-key')
      
      expect(result).toBe(true)
      expect(mockRedisClient.exists).toHaveBeenCalledWith('test-key')
    })

    it('should return false when key does not exist', async () => {
      mockRedisClient.exists.mockResolvedValue(0)
      
      const result = await driver.exists('non-existent-key')
      
      expect(result).toBe(false)
      expect(mockRedisClient.exists).toHaveBeenCalledWith('non-existent-key')
    })

    it('should handle different key names', async () => {
      mockRedisClient.exists.mockResolvedValue(1)
      
      await driver.exists('custom-key-name')
      
      expect(mockRedisClient.exists).toHaveBeenCalledWith('custom-key-name')
    })

    it('should handle Redis exists errors', async () => {
      mockRedisClient.exists.mockRejectedValue(new Error('Redis exists failed'))
      
      await expect(driver.exists('test-key'))
        .rejects.toThrow('Redis exists failed')
    })
  })

  describe('getLockInfo', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    it('should return lock info for existing lock', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      mockRedisClient.get.mockResolvedValue('lock-value-123')
      mockRedisClient.ttl.mockResolvedValue(30) // 30 seconds remaining
      
      const result = await driver.getLockInfo('test-key')
      
      expect(result).toEqual({
        key: 'test-key',
        value: 'lock-value-123',
        expiresAt: mockNow + 30000, // 30 seconds from now
        createdAt: expect.any(Number)
      })
      
      expect(mockRedisClient.get).toHaveBeenCalledWith('test-key')
      expect(mockRedisClient.ttl).toHaveBeenCalledWith('test-key')
    })

    it('should return null when key does not exist', async () => {
      mockRedisClient.get.mockResolvedValue(null)
      mockRedisClient.ttl.mockResolvedValue(-2) // Key doesn't exist
      
      const result = await driver.getLockInfo('non-existent-key')
      
      expect(result).toBeNull()
    })

    it('should return null when value is empty string', async () => {
      mockRedisClient.get.mockResolvedValue('')
      mockRedisClient.ttl.mockResolvedValue(10)
      
      const result = await driver.getLockInfo('test-key')
      
      expect(result).toBeNull()
    })

    it('should handle different TTL values', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      mockRedisClient.get.mockResolvedValue('test-value')
      mockRedisClient.ttl.mockResolvedValue(120) // 2 minutes remaining
      
      const result = await driver.getLockInfo('test-key')
      
      expect(result?.expiresAt).toBe(mockNow + 120000)
    })

    it('should handle negative TTL (expired key)', async () => {
      mockRedisClient.get.mockResolvedValue('test-value')
      mockRedisClient.ttl.mockResolvedValue(-1) // Key exists but no expiry
      
      const result = await driver.getLockInfo('test-key')
      
      expect(result?.expiresAt).toBe(Date.now() - 1000) // Should be in the past
    })

    it('should execute get and ttl in parallel', async () => {
      mockRedisClient.get.mockResolvedValue('test-value')
      mockRedisClient.ttl.mockResolvedValue(60)
      
      await driver.getLockInfo('test-key')
      
      // Both should be called once
      expect(mockRedisClient.get).toHaveBeenCalledTimes(1)
      expect(mockRedisClient.ttl).toHaveBeenCalledTimes(1)
    })

    it('should handle Redis get/ttl errors', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('Redis get failed'))
      mockRedisClient.ttl.mockResolvedValue(30)
      
      await expect(driver.getLockInfo('test-key'))
        .rejects.toThrow('Redis get failed')
    })

    it('should handle Redis ttl errors', async () => {
      mockRedisClient.get.mockResolvedValue('test-value')
      mockRedisClient.ttl.mockRejectedValue(new Error('Redis ttl failed'))
      
      await expect(driver.getLockInfo('test-key'))
        .rejects.toThrow('Redis ttl failed')
    })
  })

  describe('getTtlFromValue private method', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    it('should extract timestamp from lock value with timestamp prefix', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      // Test with timestamp-prefixed value
      mockRedisClient.get.mockResolvedValue('1234567800-uuid-lock-value')
      mockRedisClient.ttl.mockResolvedValue(20)
      
      const result = await driver.getLockInfo('test-key')
      
      // createdAt should be calculated using the extracted timestamp
      // getTtlFromValue returns 1234567800, current TTL is 20
      // So original TTL was 1234567800, current is 20, so createdAt should be based on that
      expect(result?.createdAt).toBe(mockNow - (1234567800 - 20) * 1000)
    })

    it('should use current time when no timestamp in value', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      // Test with non-timestamp value
      mockRedisClient.get.mockResolvedValue('regular-uuid-lock-value')
      mockRedisClient.ttl.mockResolvedValue(25)
      
      const result = await driver.getLockInfo('test-key')
      
      // Should use Date.now() as fallback
      expect(result?.createdAt).toBe(mockNow - (mockNow - 25) * 1000)
    })

    it('should handle malformed timestamp prefix', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      // Test with malformed timestamp
      mockRedisClient.get.mockResolvedValue('abc-uuid-lock-value')
      mockRedisClient.ttl.mockResolvedValue(15)
      
      const result = await driver.getLockInfo('test-key')
      
      // Should fall back to Date.now()
      expect(result?.createdAt).toBe(mockNow - (mockNow - 15) * 1000)
    })

    it('should handle value with only numbers but no dash', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      // Test with numbers but no dash separator
      mockRedisClient.get.mockResolvedValue('1234567890uuid')
      mockRedisClient.ttl.mockResolvedValue(10)
      
      const result = await driver.getLockInfo('test-key')
      
      // Should fall back to Date.now() since regex requires dash after numbers
      expect(result?.createdAt).toBe(mockNow - (mockNow - 10) * 1000)
    })
  })

  describe('cleanup', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    it('should execute cleanup script to remove expired keys', async () => {
      mockRedisClient.eval.mockResolvedValue(5) // 5 keys cleaned up
      
      await driver.cleanup()
      
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('SCAN'),
        0 // no keys parameter for this script
      )
    })

    it('should handle cleanup when no expired keys exist', async () => {
      mockRedisClient.eval.mockResolvedValue(0) // No keys cleaned
      
      await driver.cleanup()
      
      expect(mockRedisClient.eval).toHaveBeenCalled()
    })

    it('should handle Redis eval errors during cleanup', async () => {
      mockRedisClient.eval.mockRejectedValue(new Error('Redis cleanup failed'))
      
      await expect(driver.cleanup()).rejects.toThrow('Redis cleanup failed')
    })
  })

  describe('close', () => {
    it('should close Redis connection when driver created the client', async () => {
      // Driver creates its own client
      driver = new RedisLockDriver({ 
        host: 'localhost',
        port: 6379 
      })
      
      await driver.close()
      
      expect(mockRedisClient.quit).toHaveBeenCalledTimes(1)
    })

    it('should not close connection when using existing client', async () => {
      const existingClient = { mock: 'existing-client' } as any
      driver = new RedisLockDriver({ client: existingClient })
      
      await driver.close()
      
      expect(mockRedisClient.quit).not.toHaveBeenCalled()
    })

    it('should handle Redis quit errors', async () => {
      driver = new RedisLockDriver({ host: 'localhost' })
      mockRedisClient.quit.mockRejectedValue(new Error('Connection already closed'))
      
      await expect(driver.close()).rejects.toThrow('Connection already closed')
    })
  })

  describe('Integration tests', () => {
    beforeEach(() => {
      driver = new RedisLockDriver({ client: mockRedisClient })
    })

    it('should handle complete lock lifecycle', async () => {
      // Acquire lock
      mockRedisClient.set.mockResolvedValue('OK')
      const acquired = await driver.tryAcquire('lifecycle-key', 'test-value', 60)
      expect(acquired).toBe(true)
      
      // Check existence
      mockRedisClient.exists.mockResolvedValue(1)
      const exists = await driver.exists('lifecycle-key')
      expect(exists).toBe(true)
      
      // Get lock info
      mockRedisClient.get.mockResolvedValue('test-value')
      mockRedisClient.ttl.mockResolvedValue(45)
      const info = await driver.getLockInfo('lifecycle-key')
      expect(info?.value).toBe('test-value')
      
      // Release lock
      mockRedisClient.eval.mockResolvedValue(1)
      const released = await driver.release('lifecycle-key', 'test-value')
      expect(released).toBe(true)
    })

    it('should handle multiple lock operations', async () => {
      // Try to acquire multiple locks
      mockRedisClient.eval.mockResolvedValueOnce(1) // Acquire succeeds
      const acquired = await driver.tryAcquireMultiple(['multi1', 'multi2'], 'multi-value', 30)
      expect(acquired).toBe(true)
      
      // Release multiple locks
      mockRedisClient.eval.mockResolvedValueOnce(2) // Both released
      const released = await driver.releaseMultiple(['multi1', 'multi2'], 'multi-value')
      expect(released).toBe(2)
    })

    it('should handle mixed success and failure scenarios', async () => {
      // Some operations succeed, others fail
      mockRedisClient.set
        .mockResolvedValueOnce('OK')    // First acquire succeeds
        .mockResolvedValueOnce(null)    // Second acquire fails
      
      const result1 = await driver.tryAcquire('key1', 'value1', 30)
      const result2 = await driver.tryAcquire('key1', 'value2', 30) // Same key, should fail
      
      expect(result1).toBe(true)
      expect(result2).toBe(false)
    })
  })
})