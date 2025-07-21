import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals'
import { FileLockDriver } from '../src/drivers/file-driver'
import * as fs from 'fs/promises'
import * as path from 'path'
import { tmpdir } from 'os'

describe('FileLockDriver', () => {
  let driver: FileLockDriver
  let testLockDir: string

  beforeAll(async () => {
    // Create a unique temporary directory for tests
    testLockDir = path.join(tmpdir(), `lock-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
    await fs.mkdir(testLockDir, { recursive: true })
  })

  afterAll(async () => {
    // Clean up test directory
    try {
      await fs.rm(testLockDir, { recursive: true, force: true })
    } catch (error) {
      console.warn('Failed to cleanup test directory:', error)
    }
  })

  beforeEach(() => {
    driver = new FileLockDriver({ 
      lockDir: testLockDir,
      cleanupInterval: 1000 // 1 second for testing
    })
  })

  afterEach(async () => {
    await driver.close()
    // Clean up any remaining lock files
    try {
      const files = await fs.readdir(testLockDir)
      for (const file of files) {
        if (file.endsWith('.lock')) {
          await fs.unlink(path.join(testLockDir, file))
        }
      }
    } catch (error) {
      // Directory might be empty or not exist
    }
  })

  describe('constructor', () => {
    test('should create lock directory if it does not exist', async () => {
      const newLockDir = path.join(testLockDir, 'new-dir')
      const newDriver = new FileLockDriver({ lockDir: newLockDir })
      
      // Give it a moment to create the directory
      await new Promise(resolve => setTimeout(resolve, 10))
      
      const exists = await fs.access(newLockDir).then(() => true).catch(() => false)
      expect(exists).toBe(true)
      
      await newDriver.close()
      await fs.rm(newLockDir, { recursive: true, force: true })
    })
  })

  describe('tryAcquire', () => {
    test('should successfully acquire a new lock', async () => {
      const result = await driver.tryAcquire('test-key', 'value1', 60)
      expect(result).toBe(true)
    })

    test('should fail to acquire an existing active lock', async () => {
      await driver.tryAcquire('test-key', 'value1', 60)
      const result = await driver.tryAcquire('test-key', 'value2', 60)
      expect(result).toBe(false)
    })

    test('should acquire an expired lock', async () => {
      // Acquire lock with very short expiry
      await driver.tryAcquire('test-key', 'value1', 0.001) // 1ms
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10))
      
      const result = await driver.tryAcquire('test-key', 'value2', 60)
      expect(result).toBe(true)
    })

    test('should handle special characters in key names', async () => {
      const result = await driver.tryAcquire('test/key:with@special#chars', 'value1', 60)
      expect(result).toBe(true)
    })
  })

  describe('release', () => {
    test('should successfully release own lock', async () => {
      await driver.tryAcquire('test-key', 'value1', 60)
      const result = await driver.release('test-key', 'value1')
      expect(result).toBe(true)
    })

    test('should fail to release lock with wrong value', async () => {
      await driver.tryAcquire('test-key', 'value1', 60)
      const result = await driver.release('test-key', 'wrong-value')
      expect(result).toBe(false)
    })

    test('should fail to release non-existent lock', async () => {
      const result = await driver.release('non-existent', 'value1')
      expect(result).toBe(false)
    })

    test('should allow re-acquisition after release', async () => {
      await driver.tryAcquire('test-key', 'value1', 60)
      await driver.release('test-key', 'value1')
      const result = await driver.tryAcquire('test-key', 'value2', 60)
      expect(result).toBe(true)
    })
  })

  describe('exists', () => {
    test('should return true for existing active lock', async () => {
      await driver.tryAcquire('test-key', 'value1', 60)
      const result = await driver.exists('test-key')
      expect(result).toBe(true)
    })

    test('should return false for non-existent lock', async () => {
      const result = await driver.exists('non-existent')
      expect(result).toBe(false)
    })

    test('should return false for expired lock', async () => {
      await driver.tryAcquire('test-key', 'value1', 0.001) // 1ms
      await new Promise(resolve => setTimeout(resolve, 10))
      const result = await driver.exists('test-key')
      expect(result).toBe(false)
    })
  })

  describe('getLockInfo', () => {
    test('should return lock info for existing lock', async () => {
      const now = Date.now()
      await driver.tryAcquire('test-key', 'value1', 60)
      
      const info = await driver.getLockInfo('test-key')
      expect(info).not.toBeNull()
      expect(info!.key).toBe('test-key')
      expect(info!.value).toBe('value1')
      expect(info!.createdAt).toBeGreaterThanOrEqual(now)
      expect(info!.expiresAt).toBeGreaterThan(now)
    })

    test('should return null for non-existent lock', async () => {
      const info = await driver.getLockInfo('non-existent')
      expect(info).toBeNull()
    })
  })

  describe('tryAcquireMultiple', () => {
    test('should acquire multiple locks successfully', async () => {
      const result = await driver.tryAcquireMultiple(['key1', 'key2', 'key3'], 'value1', 60)
      expect(result).toBe(true)
      
      // Verify all locks exist
      expect(await driver.exists('key1')).toBe(true)
      expect(await driver.exists('key2')).toBe(true)
      expect(await driver.exists('key3')).toBe(true)
    })

    test('should fail if any lock already exists', async () => {
      await driver.tryAcquire('key2', 'existing', 60)
      
      const result = await driver.tryAcquireMultiple(['key1', 'key2', 'key3'], 'value1', 60)
      expect(result).toBe(false)
      
      // Verify no new locks were created
      expect(await driver.exists('key1')).toBe(false)
      expect(await driver.exists('key3')).toBe(false)
      // key2 should still have the original lock
      const info = await driver.getLockInfo('key2')
      expect(info!.value).toBe('existing')
    })

    test('should handle race condition gracefully', async () => {
      // Simulate race condition by trying to acquire overlapping sets
      const promise1 = driver.tryAcquireMultiple(['key1', 'key2'], 'value1', 60)
      const promise2 = driver.tryAcquireMultiple(['key2', 'key3'], 'value2', 60)
      
      const [result1, result2] = await Promise.all([promise1, promise2])
      
      // Only one should succeed
      expect(result1 !== result2).toBe(true)
    })
  })

  describe('releaseMultiple', () => {
    test('should release multiple locks successfully', async () => {
      await driver.tryAcquireMultiple(['key1', 'key2', 'key3'], 'value1', 60)
      
      const released = await driver.releaseMultiple(['key1', 'key2', 'key3'], 'value1')
      expect(released).toBe(3)
      
      // Verify all locks are released
      expect(await driver.exists('key1')).toBe(false)
      expect(await driver.exists('key2')).toBe(false)
      expect(await driver.exists('key3')).toBe(false)
    })

    test('should only release locks with correct value', async () => {
      await driver.tryAcquire('key1', 'value1', 60)
      await driver.tryAcquire('key2', 'value2', 60)
      await driver.tryAcquire('key3', 'value1', 60)
      
      const released = await driver.releaseMultiple(['key1', 'key2', 'key3'], 'value1')
      expect(released).toBe(2)
      
      // key2 should still exist
      expect(await driver.exists('key2')).toBe(true)
    })
  })

  describe('cleanup', () => {
    test('should remove expired locks', async () => {
      // Create some expired locks
      await driver.tryAcquire('expired1', 'value1', 0.001)
      await driver.tryAcquire('expired2', 'value2', 0.001)
      await driver.tryAcquire('active', 'value3', 60)
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10))
      
      await driver.cleanup()
      
      expect(await driver.exists('expired1')).toBe(false)
      expect(await driver.exists('expired2')).toBe(false)
      expect(await driver.exists('active')).toBe(true)
    })

    test('should handle corrupted lock files gracefully', async () => {
      // Create a corrupted lock file
      const corruptedPath = path.join(testLockDir, 'corrupted.lock')
      await fs.writeFile(corruptedPath, 'invalid json')
      
      // Cleanup should not throw
      await expect(driver.cleanup()).resolves.not.toThrow()
    })
  })

  describe('automatic cleanup', () => {
    test('should automatically clean up expired locks', async () => {
      const driverWithCleanup = new FileLockDriver({ 
        lockDir: testLockDir,
        cleanupInterval: 50 // 50ms for faster testing
      })
      
      try {
        await driverWithCleanup.tryAcquire('auto-expire', 'value1', 0.001)
        
        // Wait for expiration and cleanup
        await new Promise(resolve => setTimeout(resolve, 100))
        
        expect(await driverWithCleanup.exists('auto-expire')).toBe(false)
      } finally {
        await driverWithCleanup.close()
      }
    })
  })

  describe('edge cases', () => {
    test('should handle empty key', async () => {
      const result = await driver.tryAcquire('', 'value1', 60)
      expect(result).toBe(true)
    })

    test('should handle very long keys', async () => {
      const longKey = 'a'.repeat(1000)
      const result = await driver.tryAcquire(longKey, 'value1', 60)
      expect(result).toBe(true)
    })

    test('should handle zero expiry time', async () => {
      const result = await driver.tryAcquire('test-key', 'value1', 0)
      expect(result).toBe(true)
      
      // Should be immediately expired
      expect(await driver.exists('test-key')).toBe(false)
    })

    test('should handle negative expiry time', async () => {
      const result = await driver.tryAcquire('test-key', 'value1', -1)
      expect(result).toBe(true)
      
      // Should be immediately expired
      expect(await driver.exists('test-key')).toBe(false)
    })
  })

  describe('concurrent operations', () => {
    test('should handle concurrent acquire attempts', async () => {
      const promises = Array.from({ length: 10 }, (_, i) => 
        driver.tryAcquire('concurrent-key', `value${i}`, 60)
      )
      
      const results = await Promise.all(promises)
      const successCount = results.filter(r => r).length
      
      // Only one should succeed
      expect(successCount).toBe(1)
    })

    test('should handle concurrent multiple lock attempts', async () => {
      const keys = ['key1', 'key2', 'key3']
      
      const promises = Array.from({ length: 5 }, (_, i) => 
        driver.tryAcquireMultiple(keys, `value${i}`, 60)
      )
      
      const results = await Promise.all(promises)
      const successCount = results.filter(r => r).length
      
      // Only one should succeed
      expect(successCount).toBe(1)
    })
  })

  // Add these tests to the existing test suite to reach 95% coverage

describe('error handling coverage', () => {
  test('should handle permission errors during lock directory creation', async () => {
    // This tests the catch block in ensureLockDir()
    const restrictedPath = '/root/impossible-path'
    const restrictedDriver = new FileLockDriver({ lockDir: restrictedPath })
    
    // The constructor should not throw even if directory creation fails
    expect(restrictedDriver).toBeDefined()
    
    await restrictedDriver.close()
  })

  test('should handle file system errors during cleanup', async () => {
    // Create a driver and then manually corrupt the lock directory
    const testDriver = new FileLockDriver({ lockDir: testLockDir })
    
    try {
      // Create a lock file
      await testDriver.tryAcquire('test-key', 'value1', 60)
      
      // Simulate filesystem error by removing the directory while keeping the driver
      await fs.rm(testLockDir, { recursive: true, force: true })
      
      // Cleanup should handle the error gracefully
      await expect(testDriver.cleanup()).resolves.not.toThrow()
    } finally {
      await testDriver.close()
      // Recreate directory for other tests
      await fs.mkdir(testLockDir, { recursive: true })
    }
  })

  test('should handle race condition in tryAcquireMultiple rollback', async () => {
    // This tests the catch block in the rollback logic of tryAcquireMultiple
    const testDriver = new FileLockDriver({ lockDir: testLockDir })
    
    try {
      // Create a lock that will conflict
      await testDriver.tryAcquire('conflict-key', 'existing', 60)
      
      // Try to acquire multiple locks including the conflicting one
      const result = await testDriver.tryAcquireMultiple(
        ['new-key', 'conflict-key'], 
        'new-value', 
        60
      )
      
      expect(result).toBe(false)
      
      // Verify the new-key was not left behind (rollback worked)
      expect(await testDriver.exists('new-key')).toBe(false)
    } finally {
      await testDriver.close()
    }
  })
})
})