import { SQLiteLockDriver } from '../src/drivers/sqlite-driver'

describe('SQLiteLockDriver', () => {
  let driver: SQLiteLockDriver
  let mockDb: any
  let mockPrepare: jest.Mock
  let mockExec: jest.Mock
  let mockTransaction: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    
    // Create mock prepared statement
    const mockStmt = {
      run: jest.fn().mockReturnValue({ changes: 1 }),
      get: jest.fn()
    }
    
    // Create mock database
    mockPrepare = jest.fn().mockReturnValue(mockStmt)
    mockExec = jest.fn()
    mockTransaction = jest.fn()
    
    mockDb = {
      exec: mockExec,
      prepare: mockPrepare,
      transaction: mockTransaction,
      close: jest.fn()
    }
    
    // Mock transaction to execute callback immediately
    mockTransaction.mockImplementation((callback) => {
      return () => callback()
    })
  })

  describe('Constructor and Initialization', () => {
    it('should create driver with default table name', () => {
      driver = new SQLiteLockDriver({ db: mockDb })
      
      expect(driver).toBeDefined()
      expect(mockExec).toHaveBeenCalledTimes(2) // Table creation + index creation
      
      // Check table creation SQL
      const tableCall = mockExec.mock.calls[0][0]
      expect(tableCall).toContain('CREATE TABLE IF NOT EXISTS atomic_locks')
      expect(tableCall).toContain('lock_key TEXT PRIMARY KEY')
      expect(tableCall).toContain('lock_value TEXT NOT NULL')
      expect(tableCall).toContain('expires_at INTEGER NOT NULL')
      expect(tableCall).toContain('created_at INTEGER NOT NULL')
      
      // Check index creation SQL
      const indexCall = mockExec.mock.calls[1][0]
      expect(indexCall).toContain('CREATE INDEX IF NOT EXISTS idx_atomic_locks_expires_at')
      expect(indexCall).toContain('ON atomic_locks(expires_at)')
    })

    it('should create driver with custom table name', () => {
      driver = new SQLiteLockDriver({ 
        db: mockDb, 
        tableName: 'custom_locks' 
      })
      
      expect(mockExec).toHaveBeenCalledTimes(2)
      
      // Check custom table name is used
      const tableCall = mockExec.mock.calls[0][0]
      expect(tableCall).toContain('CREATE TABLE IF NOT EXISTS custom_locks')
      
      const indexCall = mockExec.mock.calls[1][0]
      expect(indexCall).toContain('idx_custom_locks_expires_at')
      expect(indexCall).toContain('ON custom_locks(expires_at)')
    })

    it('should handle database exec errors during initialization', () => {
      mockExec.mockImplementation(() => {
        throw new Error('Database initialization failed')
      })
      
      expect(() => {
        new SQLiteLockDriver({ db: mockDb })
      }).toThrow('Database initialization failed')
    })
  })

  describe('tryAcquire', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks() // Clear initialization calls
    })

    it('should successfully acquire lock when key is available', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockStmt = { run: jest.fn() }
      mockPrepare.mockReturnValueOnce(mockStmt) // cleanup statement
      mockPrepare.mockReturnValueOnce(mockStmt) // insert statement
      
      const result = await driver.tryAcquire('test-key', 'lock-value-123', 30)
      
      expect(result).toBe(true)
      expect(mockPrepare).toHaveBeenCalledTimes(2)
      
      // Check cleanup call
      expect(mockPrepare).toHaveBeenNthCalledWith(1, expect.stringContaining('DELETE FROM atomic_locks'))
      expect(mockStmt.run).toHaveBeenNthCalledWith(1, 'test-key', mockNow)
      
      // Check insert call
      expect(mockPrepare).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO atomic_locks'))
      expect(mockStmt.run).toHaveBeenNthCalledWith(2, 'test-key', 'lock-value-123', mockNow + 30000, mockNow)
    })

    it('should return false when lock already exists (SQLITE_CONSTRAINT_PRIMARYKEY)', async () => {
      const mockStmt = { run: jest.fn() }
      mockPrepare.mockReturnValueOnce(mockStmt) // cleanup statement
      mockPrepare.mockReturnValueOnce(mockStmt) // insert statement
      
      // Mock insert to throw primary key constraint error
      const error = new Error('UNIQUE constraint failed') as any
      error.code = 'SQLITE_CONSTRAINT_PRIMARYKEY'
      mockStmt.run
        .mockReturnValueOnce(undefined) // cleanup succeeds
        .mockImplementationOnce(() => { throw error }) // insert fails
      
      const result = await driver.tryAcquire('existing-key', 'value', 30)
      
      expect(result).toBe(false)
    })

    it('should throw error for non-constraint database errors', async () => {
      const mockStmt = { run: jest.fn() }
      mockPrepare.mockReturnValueOnce(mockStmt) // cleanup statement
      mockPrepare.mockReturnValueOnce(mockStmt) // insert statement
      
      const error = new Error('Database connection lost') as any
      error.code = 'SQLITE_IOERR'
      mockStmt.run
        .mockReturnValueOnce(undefined) // cleanup succeeds
        .mockImplementationOnce(() => { throw error }) // insert fails with non-constraint error
      
      await expect(driver.tryAcquire('test-key', 'value', 30))
        .rejects.toThrow('Database connection lost')
    })

    it('should handle different expiry times and values', async () => {
      const mockNow = 1000000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockStmt = { run: jest.fn() }
      mockPrepare.mockReturnValue(mockStmt)
      
      await driver.tryAcquire('test-key', 'custom-value', 120)
      
      // Check that correct expiry time is calculated
      expect(mockStmt.run).toHaveBeenLastCalledWith(
        'test-key', 
        'custom-value', 
        mockNow + 120000, // 120 seconds
        mockNow
      )
    })

    it('should use custom table name in SQL statements', async () => {
      driver = new SQLiteLockDriver({ db: mockDb, tableName: 'custom_locks' })
      jest.clearAllMocks()
      
      const mockStmt = { run: jest.fn() }
      mockPrepare.mockReturnValue(mockStmt)
      
      await driver.tryAcquire('test-key', 'value', 30)
      
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM custom_locks'))
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO custom_locks'))
    })
  })

  describe('tryAcquireMultiple', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should successfully acquire multiple locks when all keys are available', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockStmt = { 
        run: jest.fn(),
        get: jest.fn().mockReturnValue({ count: 0 }) // No existing locks
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      // Mock transaction to return the result of the callback
      mockTransaction.mockImplementation((callback) => {
        return () => callback()
      })
      
      const result = await driver.tryAcquireMultiple(
        ['key1', 'key2', 'key3'], 
        'multi-value', 
        45
      )
      
      expect(result).toBe(true)
      expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function))
      
      // Should prepare 3 statements: cleanup, check, insert
      expect(mockPrepare).toHaveBeenCalledTimes(3)
      
      // Check cleanup statement - more flexible regex that handles whitespace
      expect(mockPrepare).toHaveBeenNthCalledWith(1, expect.stringMatching(/DELETE\s+FROM\s+\w+\s+WHERE\s+lock_key\s+IN\s*\(\?,\?,\?\)/))
      expect(mockStmt.run).toHaveBeenCalledWith('key1', 'key2', 'key3', mockNow)
      
      // Check existence check statement
      expect(mockPrepare).toHaveBeenNthCalledWith(2, expect.stringMatching(/SELECT\s+COUNT\(\*\)\s+as\s+count\s+FROM\s+\w+\s+WHERE\s+lock_key\s+IN\s*\(\?,\?,\?\)/))
      expect(mockStmt.get).toHaveBeenCalledWith('key1', 'key2', 'key3', mockNow)
      
      // Check insert statement (called 3 times for 3 keys)
      expect(mockStmt.run).toHaveBeenCalledWith('key1', 'multi-value', mockNow + 45000, mockNow)
      expect(mockStmt.run).toHaveBeenCalledWith('key2', 'multi-value', mockNow + 45000, mockNow)
      expect(mockStmt.run).toHaveBeenCalledWith('key3', 'multi-value', mockNow + 45000, mockNow)
    })

    it('should return false when any locks already exist', async () => {
      const mockStmt = { 
        run: jest.fn(),
        get: jest.fn().mockReturnValue({ count: 1 }) // 1 existing lock
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      mockTransaction.mockImplementation((callback) => {
        return () => callback()
      })
      
      const result = await driver.tryAcquireMultiple(['key1', 'key2'], 'value', 30)
      
      expect(result).toBe(false)
      
      // Should not proceed to insert stage
      expect(mockPrepare).toHaveBeenCalledTimes(2) // Only cleanup and check, no insert
    })

    it('should handle empty keys array', async () => {
      const mockStmt = { 
        run: jest.fn(),
        get: jest.fn().mockReturnValue({ count: 0 })
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      mockTransaction.mockImplementation((callback) => {
        return () => callback()
      })
      
      const result = await driver.tryAcquireMultiple([], 'value', 30)
      
      expect(result).toBe(true)
      
      // Should still execute but with empty IN clause
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringMatching(/IN \(\)/))
    })

    it('should handle single key in array', async () => {
      const mockStmt = { 
        run: jest.fn(),
        get: jest.fn().mockReturnValue({ count: 0 })
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      mockTransaction.mockImplementation((callback) => {
        return () => callback()
      })
      
      const result = await driver.tryAcquireMultiple(['single-key'], 'value', 30)
      
      expect(result).toBe(true)
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringMatching(/IN \(\?\)/))
    })

    it('should use custom table name in transaction', async () => {
      driver = new SQLiteLockDriver({ db: mockDb, tableName: 'custom_locks' })
      jest.clearAllMocks()
      
      const mockStmt = { 
        run: jest.fn(),
        get: jest.fn().mockReturnValue({ count: 0 })
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      mockTransaction.mockImplementation((callback) => {
        return () => callback()
      })
      
      await driver.tryAcquireMultiple(['key1'], 'value', 30)
      
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM custom_locks'))
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('SELECT COUNT(*) as count FROM custom_locks'))
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO custom_locks'))
    })
  })

  describe('release', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should successfully release lock with correct value', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 1 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.release('test-key', 'correct-value')
      
      expect(result).toBe(true)
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringMatching(
        /DELETE\s+FROM\s+\w+\s+WHERE\s+lock_key\s*=\s*\?\s+AND\s+lock_value\s*=\s*\?/
      ))
      expect(mockStmt.run).toHaveBeenCalledWith('test-key', 'correct-value')
    })

    it('should return false when no rows affected (wrong value or non-existent key)', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 0 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.release('test-key', 'wrong-value')
      
      expect(result).toBe(false)
    })

    it('should use custom table name', async () => {
      driver = new SQLiteLockDriver({ db: mockDb, tableName: 'custom_locks' })
      jest.clearAllMocks()
      
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 1 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      await driver.release('test-key', 'value')
      
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM custom_locks'))
    })
  })

  describe('releaseMultiple', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should release multiple locks and return count', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 3 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.releaseMultiple(['key1', 'key2', 'key3'], 'multi-value')
      
      expect(result).toBe(3)
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringMatching(
        /DELETE\s+FROM\s+\w+\s+WHERE\s+lock_key\s+IN\s*\(\?,\?,\?\)\s+AND\s+lock_value\s*=\s*\?/
      ))
      expect(mockStmt.run).toHaveBeenCalledWith('key1', 'key2', 'key3', 'multi-value')
    })

    it('should return 0 when no locks match', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 0 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.releaseMultiple(['key1', 'key2'], 'non-matching-value')
      
      expect(result).toBe(0)
    })

    it('should return partial count when some locks match', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 2 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.releaseMultiple(['key1', 'key2', 'key3'], 'partial-value')
      
      expect(result).toBe(2) // Only 2 out of 3 matched
    })

    it('should handle empty keys array', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 0 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.releaseMultiple([], 'value')
      
      expect(result).toBe(0)
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringMatching(/IN \(\)/))
    })

    it('should handle single key in array', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 1 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.releaseMultiple(['single-key'], 'value')
      
      expect(result).toBe(1)
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringMatching(/IN \(\?\)/))
    })
  })

  describe('exists', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should return true when lock exists and is not expired', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockStmt = { 
        run: jest.fn(), // cleanup statement
        get: jest.fn().mockReturnValue({ exists: true }) // select statement
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.exists('test-key')
      
      expect(result).toBe(true)
      
      // Should first clean up expired locks - use flexible regex for whitespace
      expect(mockPrepare).toHaveBeenNthCalledWith(1, expect.stringMatching(
        /DELETE\s+FROM\s+\w+\s+WHERE\s+lock_key\s*=\s*\?\s+AND\s+expires_at\s*<\s*\?/
      ))
      expect(mockStmt.run).toHaveBeenCalledWith('test-key', mockNow)
      
      // Then check for existence
      expect(mockPrepare).toHaveBeenNthCalledWith(2, expect.stringMatching(
        /SELECT\s+1\s+FROM\s+\w+\s+WHERE\s+lock_key\s*=\s*\?\s+AND\s+expires_at\s*>=\s*\?/
      ))
      expect(mockStmt.get).toHaveBeenCalledWith('test-key', mockNow)
    })

    it('should return false when lock does not exist', async () => {
      const mockStmt = { 
        run: jest.fn(),
        get: jest.fn().mockReturnValue(undefined) // No result
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.exists('non-existent-key')
      
      expect(result).toBe(false)
    })

    it('should clean up expired lock and return false', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockStmt = { 
        run: jest.fn().mockReturnValue({ changes: 1 }), // Cleanup removed a lock
        get: jest.fn().mockReturnValue(undefined) // No lock exists after cleanup
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.exists('expired-key')
      
      expect(result).toBe(false)
      
      // Verify cleanup was called
      expect(mockStmt.run).toHaveBeenCalledWith('expired-key', mockNow)
    })
  })

  describe('getLockInfo', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should return lock info for existing lock', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockLockData = {
        value: 'test-value',
        expiresAt: mockNow + 30000,
        createdAt: mockNow - 5000
      }
      
      const mockStmt = { get: jest.fn().mockReturnValue(mockLockData) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.getLockInfo('test-key')
      
      expect(result).toEqual(mockLockData)
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining(
        'SELECT lock_value as value, expires_at as expiresAt, created_at as createdAt'
      ))
      expect(mockStmt.get).toHaveBeenCalledWith('test-key', mockNow)
    })

    it('should return null when lock does not exist', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue(undefined) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.getLockInfo('non-existent-key')
      
      expect(result).toBeNull()
    })

    it('should return null when lock is expired', async () => {
      const mockStmt = { get: jest.fn().mockReturnValue(undefined) }
      mockPrepare.mockReturnValue(mockStmt)
      
      const result = await driver.getLockInfo('expired-key')
      
      expect(result).toBeNull()
    })

    it('should include expires_at >= ? condition to filter expired locks', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockStmt = { get: jest.fn().mockReturnValue(null) }
      mockPrepare.mockReturnValue(mockStmt)
      
      await driver.getLockInfo('test-key')
      
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('expires_at >= ?'))
      expect(mockStmt.get).toHaveBeenCalledWith('test-key', mockNow)
    })
  })

  describe('cleanup', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should remove all expired locks', async () => {
      const mockNow = 1234567890000
      jest.spyOn(Date, 'now').mockReturnValue(mockNow)
      
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 5 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      await driver.cleanup()
      
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringMatching(
        /DELETE\s+FROM\s+\w+\s+WHERE\s+expires_at\s*<\s*\?/
      ))
      expect(mockStmt.run).toHaveBeenCalledWith(mockNow)
    })

    it('should use custom table name', async () => {
      driver = new SQLiteLockDriver({ db: mockDb, tableName: 'custom_locks' })
      jest.clearAllMocks()
      
      const mockStmt = { run: jest.fn() }
      mockPrepare.mockReturnValue(mockStmt)
      
      await driver.cleanup()
      
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM custom_locks'))
    })

    it('should handle case when no expired locks exist', async () => {
      const mockStmt = { run: jest.fn().mockReturnValue({ changes: 0 }) }
      mockPrepare.mockReturnValue(mockStmt)
      
      await driver.cleanup()
      
      expect(mockStmt.run).toHaveBeenCalled()
      // Should not throw even when no changes
    })
  })

  describe('close', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
    })

    it('should close database connection when close method exists', async () => {
      await driver.close()
      
      expect(mockDb.close).toHaveBeenCalledTimes(1)
    })

    it('should handle database without close method', async () => {
      const dbWithoutClose = { 
        exec: jest.fn(),
        prepare: jest.fn().mockReturnValue({ run: jest.fn() }),
        transaction: jest.fn()
      }
      
      driver = new SQLiteLockDriver({ db: dbWithoutClose })
      
      // Should not throw
      await driver.close()
      
      expect(dbWithoutClose).not.toHaveProperty('close')
    })
  })

  describe('SQL Injection Protection', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should use parameterized queries for all operations', async () => {
      const mockStmt = { 
        run: jest.fn().mockReturnValue({ changes: 1 }),
        get: jest.fn().mockReturnValue({ count: 0 })
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      // Test various operations with potentially malicious input
      const maliciousKey = "'; DROP TABLE atomic_locks; --"
      const maliciousValue = "'; DELETE FROM atomic_locks; --"
      
      await driver.tryAcquire(maliciousKey, maliciousValue, 30)
      await driver.release(maliciousKey, maliciousValue)
      await driver.exists(maliciousKey)
      await driver.getLockInfo(maliciousKey)
      
      // All calls should use parameterized queries (?)
      mockPrepare.mock.calls.forEach(call => {
        const sql = call[0]
        expect(sql).toContain('?')
        expect(sql).not.toContain(maliciousKey)
        expect(sql).not.toContain(maliciousValue)
      })
    })
  })

  describe('Integration Scenarios', () => {
    beforeEach(() => {
      driver = new SQLiteLockDriver({ db: mockDb })
      jest.clearAllMocks()
    })

    it('should handle complete lock lifecycle', async () => {
      const mockStmt = { 
        run: jest.fn().mockReturnValue({ changes: 1 }),
        get: jest.fn()
      }
      mockPrepare.mockReturnValue(mockStmt)
      
      // Mock different return values for different operations
      mockStmt.get
        .mockReturnValueOnce({ exists: true }) // exists() call
        .mockReturnValueOnce({  // getLockInfo() call
          value: 'test-value',
          expiresAt: Date.now() + 30000,
          createdAt: Date.now()
        })
      
      // Acquire lock
      const acquired = await driver.tryAcquire('lifecycle-key', 'test-value', 60)
      expect(acquired).toBe(true)
      
      // Check existence
      const exists = await driver.exists('lifecycle-key')
      expect(exists).toBe(true)
      
      // Get lock info
      const info = await driver.getLockInfo('lifecycle-key')
      expect(info?.value).toBe('test-value')
      
      // Release lock
      const released = await driver.release('lifecycle-key', 'test-value')
      expect(released).toBe(true)
    })

    it('should handle concurrent lock attempts', async () => {
      const mockStmt = { run: jest.fn() }
      mockPrepare.mockReturnValue(mockStmt)
      
      // First attempt succeeds
      mockStmt.run.mockReturnValueOnce({ changes: 0 }) // cleanup
      mockStmt.run.mockReturnValueOnce({ changes: 1 }) // insert succeeds
      
      const result1 = await driver.tryAcquire('concurrent-key', 'value1', 30)
      expect(result1).toBe(true)
      
      // Second attempt fails with constraint error
      const error = new Error('UNIQUE constraint failed') as any
      error.code = 'SQLITE_CONSTRAINT_PRIMARYKEY'
      mockStmt.run.mockReturnValueOnce({ changes: 0 }) // cleanup
      mockStmt.run.mockImplementationOnce(() => { throw error }) // insert fails
      
      const result2 = await driver.tryAcquire('concurrent-key', 'value2', 30)
      expect(result2).toBe(false)
    })
  })
})