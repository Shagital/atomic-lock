# @shagital/atomic-lock

Universal atomic locking with pluggable drivers. One API, multiple backends: Redis, SQLite, File System, Memory, and more.

## Why Atomic Lock?

While other locking libraries are tied to specific backends, Atomic Lock provides a **universal interface** with production-grade features:

- Universal API: Same code works with Redis, SQLite, Files, or Memory
- High Performance: Non-blocking operations with intelligent retry strategies  
- Circuit Breaker: Automatic failure detection and recovery
- Batch Operations: Atomic multi-lock acquisition across any driver
- Monitoring: Built-in performance tracking and failure analytics
- Smart Retries: Adaptive backoff with jitter
- Easy Testing: Memory driver for unit tests

## Installation

```bash
npm install @shagital/atomic-lock

# Install drivers you need
npm install ioredis              # For Redis
npm install better-sqlite3       # For SQLite
# File and Memory drivers included
```

## Quick Start

### Redis Driver
```typescript
import { createRedisLock } from '@shagital/atomic-lock'
import Redis from 'ioredis'

const redis = new Redis('redis://localhost:6379')
const lock = createRedisLock(redis)

const lockValue = await lock.tryAcquire('user:123')
if (lockValue) {
  try {
    // Your critical section
    await processUserData()
  } finally {
    await lock.release('user:123', lockValue)
  }
}
```

### SQLite Driver
```typescript
import { createSQLiteLock } from '@shagital/atomic-lock'
import Database from 'better-sqlite3'

const db = new Database('./locks.db')
const lock = createSQLiteLock(db)

const lockValue = await lock.acquire('batch-job', { 
  expiryInSeconds: 300,
  maxRetries: 10 
})

try {
  await runBatchJob()
} finally {
  await lock.release('batch-job', lockValue)
}
```

### File System Driver
```typescript
import { createFileLock } from '@shagital/atomic-lock'

const lock = createFileLock('./locks')

// Perfect for single-machine deployments
const lockValue = await lock.tryAcquire('file-processor')
if (lockValue) {
  await processFiles()
  await lock.release('file-processor', lockValue)
}
```

### Memory Driver (Testing)
```typescript
import { createMemoryLock } from '@shagital/atomic-lock'

const lock = createMemoryLock()

// Perfect for unit tests - no external dependencies
describe('MyService', () => {
  it('should handle concurrent access', async () => {
    const lock1 = await lock.tryAcquire('resource')
    const lock2 = await lock.tryAcquire('resource')
    
    expect(lock1).toBeTruthy()
    expect(lock2).toBeNull() // Second acquisition fails
  })
})
```

### Universal Factory Function
```typescript
import { createLock } from '@shagital/atomic-lock'

const lock = createLock({
  driver: 'redis',
  redis: { client: redisInstance }
})
```

## Advanced Features

### Callback-Style Lock Usage

Automatically acquire, execute, and release locks:

```typescript
const result = await lock.withLock('resource', async (lockValue) => {
  // Lock is automatically acquired before this runs
  // and automatically released when this completes or throws
  return await processData()
})
```

### Batch Lock Acquisition

Atomically acquire multiple locks or none at all:

```typescript
const resources = ['user:123', 'account:456', 'order:789']
const locks = await lock.tryAcquireMultiple(resources, { 
  expiryInSeconds: 60 
})

if (locks) {
  try {
    // All locks acquired - safe to proceed
    await transferMoney(userId, accountId, orderId)
  } finally {
    // Release all locks atomically
    await lock.releaseMultiple(locks)
  }
} else {
  throw new Error('Could not acquire all required locks')
}
```

### Circuit Breaker Protection

Automatic failure detection prevents cascade failures:

```typescript
// Configure circuit breaker
const lock = createRedisLock(redis, {
  circuitBreakerThreshold: 5,      // Open after 5 failures
  circuitBreakerResetTime: 30000,  // Reset after 30 seconds
  maxFailureEntries: 1000          // Memory limit for failure tracking
})

// Monitor circuit breaker status
const status = lock.getCircuitBreakerStatus('problematic-resource')
if (status.isOpen) {
  console.log(`Circuit breaker open, next attempt at: ${new Date(status.nextAttemptAt)}`)
}

// Reset circuit breaker when issue is resolved
lock.resetCircuitBreaker('problematic-resource')
```

### Smart Retry Strategies

```typescript
// High-priority operation with custom retry strategy
const lockValue = await lock.acquire('critical-resource', {
  expiryInSeconds: 120,
  maxRetries: 20              // More aggressive retries
})

// Non-blocking for high-throughput scenarios
const lockValue = await lock.tryAcquire('optional-resource')
if (!lockValue) {
  return { status: 'busy', message: 'Resource locked, try again later' }
}
```

## Driver Comparison

| Driver | Use Case | Atomicity | Performance | Persistence | Setup |
|--------|----------|-----------|-------------|-------------|-------|
| **Redis** | Distributed systems | ✅ Lua scripts | Fastest | ✅ Durable | Redis server |
| **SQLite** | Single-machine apps | ✅ Transactions | Fast | ✅ Durable | Database file |
| **File** | Simple deployments | ✅ OS-level | Good | ✅ Durable | File system |
| **Memory** | Testing/Single-process | ✅ In-process | Fastest | ❌ Volatile | None |

## Configuration

### Universal Lock Options
```typescript
const lock = createRedisLock(redis, {
  // Lock behavior
  expiryInSeconds: 30,              // Default lock expiry
  maxRetries: 8,                    // Retry attempts for acquire()
  
  // Circuit breaker
  circuitBreakerThreshold: 5,       // Failures before circuit opens
  circuitBreakerResetTime: 30000,   // Time before circuit reset (ms)
  maxFailureEntries: 1000           // Max failure records to keep in memory
})
```

### Driver-Specific Options
```typescript
// File driver with cleanup
const fileLock = createFileLock('./locks', {
  cleanupInterval: 60000  // Clean expired locks every minute
})

// SQLite with custom table
const sqliteLock = new AtomicLock({
  driver: 'sqlite',
  sqlite: { 
    db: database, 
    tableName: 'my_locks' 
  }
})
```

## Error Handling

```typescript
try {
  const lockValue = await lock.acquire('resource')
  // ... work ...
  await lock.release('resource', lockValue)
} catch (error) {
  if (error.message.includes('Circuit breaker open')) {
    // System is protecting itself
    await handleCircuitBreakerOpen()
  } else if (error.message.includes('Failed to acquire lock')) {
    // Couldn't get lock after retries
    await handleLockTimeout()
  } else {
    // Driver-specific errors (Redis connection, file permissions, etc.)
    await handleDriverError(error)
  }
}
```

## Custom Drivers

Implement the `LockDriver` interface to add new backends:

```typescript
import { LockDriver, LockInfo } from '@shagital/atomic-lock'

class PostgresLockDriver implements LockDriver {
  async tryAcquire(key: string, lockValue: string, expiryInSeconds: number): Promise<boolean> {
    // Your implementation
  }
  
  // ... implement other methods
}

const lock = new AtomicLock({
  driver: 'postgres',
  postgres: { pool: pgPool }
})
```

## Migration Between Drivers

Switching drivers is seamless - just change the configuration:

```typescript
// Development - use memory
const lock = createMemoryLock()

// Staging - use SQLite  
const lock = createSQLiteLock(database)

// Production - use Redis
const lock = createRedisLock(redis)

// Code using the lock stays exactly the same!
const lockValue = await lock.tryAcquire('resource')
```

## API Reference

### AtomicLock

#### `tryAcquire(key: string, options?: LockOptions): Promise<string | null>`
Non-blocking lock acquisition. Returns lock value or null.

#### `acquire(key: string, options?: LockOptions): Promise<string>`  
Blocking lock acquisition with retries. Throws on failure.

#### `withLock<T>(key: string, callback: (lockValue: string) => Promise<T> | T, options?: LockOptions): Promise<T>`
Callback-style lock usage. Acquires the lock, runs the callback, always releases the lock.

#### `tryAcquireMultiple(keys: string[], options?: LockOptions): Promise<Map<string, string> | null>`
Atomic batch lock acquisition.

#### `release(key: string, lockValue: string): Promise<boolean>`
Release a single lock safely.

#### `releaseMultiple(locks: Map<string, string>): Promise<number>`
Release multiple locks atomically.

#### `close(): Promise<void>`
Clean up resources and clear failure records.

### Monitoring

#### `getCircuitBreakerStatus(key: string): CircuitBreakerStats`
Get circuit breaker status for a key.

#### `getAllCircuitBreakerStats(): Map<string, CircuitBreakerStats>`
Get all circuit breaker stats.

#### `resetCircuitBreaker(key: string): void`
Reset circuit breaker for a key.

### Factory Functions

#### `createLock(config: DriverConfig, options?: LockOptions): AtomicLock`
Universal factory function for creating locks with any driver.

## Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) first.

## License

MIT

## Support

- Email: [hello@shagital.com](mailto:hello@shagital.com)
- Issues: [GitHub Issues](https://github.com/shagital/atomic-lock/issues)
- Docs: [Full Documentation](https://shagital.github.io/atomic-lock)