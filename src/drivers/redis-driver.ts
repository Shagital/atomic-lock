import { LockDriver, LockInfo, RedisConfig } from '../types'
import { Redis } from 'ioredis'

/**
 * Redis driver implementation using ioredis
 */
export class RedisLockDriver implements LockDriver {
  private client: Redis

  constructor(private config: RedisConfig) {
    this.client = this.createRedisClient(config)
  }

  private createRedisClient(config: RedisConfig): Redis {
    // Option 1: Use existing client instance
    if (config.client) {
      return config.client
    }

    // Option 2: Create client from URL
    if (config.url) {
      return config.options ? new Redis(config.url, config.options) : new Redis(config.url)
    }

    // Option 3: Create client from individual parameters
    const connectionOptions = {
      host: config.host || 'localhost',
      port: config.port || 6379,
      password: config.password,
      username: config.username,
      db: config.db || 0,
      ...config.options
    }

    return new Redis(connectionOptions)
  }

  async tryAcquire(key: string, lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, lockValue, 'EX', expiryInSeconds, 'NX')
    return result === 'OK'
  }

  async tryAcquireMultiple(keys: string[], lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const script = `
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
    
    const result = await this.client.eval(script, keys.length, ...keys, lockValue, expiryInSeconds.toString())
    return result === 1
  }

  async release(key: string, lockValue: string): Promise<boolean> {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `
    
    const result = await this.client.eval(script, 1, key, lockValue)
    return result === 1
  }

  async releaseMultiple(keys: string[], lockValue: string): Promise<number> {
    const script = `
      local released = 0
      for i = 1, #KEYS do
        if redis.call("GET", KEYS[i]) == ARGV[1] then
          redis.call("DEL", KEYS[i])
          released = released + 1
        end
      end
      return released
    `
    
    const result = await this.client.eval(script, keys.length, ...keys, lockValue)
    return result as number
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key)
    return result === 1
  }

  async getLockInfo(key: string): Promise<LockInfo | null> {
    const [value, ttl] = await Promise.all([
      this.client.get(key),
      this.client.ttl(key)
    ])
    
    if (!value) return null
    
    return {
      key,
      value,
      expiresAt: Date.now() + (ttl * 1000),
      createdAt: Date.now() - (this.getTtlFromValue(value) - ttl) * 1000
    }
  }

  async cleanup(): Promise<void> {
    // Redis handles expiry automatically, but we can implement
    // a manual cleanup if needed for specific use cases
    const script = `
      local cursor = "0"
      local deleted = 0
      
      repeat
        local scan_result = redis.call("SCAN", cursor, "MATCH", "*", "COUNT", 1000)
        cursor = scan_result[1]
        local keys = scan_result[2]
        
        for i = 1, #keys do
          local ttl = redis.call("TTL", keys[i])
          if ttl == -1 then
            -- Key exists but has no expiry, skip
          elseif ttl == -2 then
            -- Key doesn't exist, skip
          elseif ttl <= 0 then
            -- Key is expired, delete it
            redis.call("DEL", keys[i])
            deleted = deleted + 1
          end
        end
      until cursor == "0"
      
      return deleted
    `
    
    await this.client.eval(script, 0)
  }

  async close(): Promise<void> {
    // Only close if we created the client (not passed an existing one)
    if (!this.config.client) {
      await this.client.quit()
    }
  }

  private getTtlFromValue(value: string): number {
    // Extract timestamp from lock value if available
    const match = value.match(/^(\d+)-/)
    return match ? parseInt(match[1]) : Date.now()
  }
}