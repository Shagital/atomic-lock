import { LockDriver, LockInfo } from '../types'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'

interface FileLock {
  value: string
  expiresAt: number
  createdAt: number
}

/**
 * File system driver implementation
 * Uses atomic file operations and directory-based locking
 */
export class FileLockDriver implements LockDriver {
  private lockDir: string
  private cleanupInterval?: NodeJS.Timeout
  private static readonly MAX_FILENAME_LENGTH = 200 // Safe limit for most filesystems

  constructor(config: { lockDir: string, cleanupInterval?: number }) {
    this.lockDir = config.lockDir
    this.ensureLockDir()
    
    if (config.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanup().catch(console.error)
      }, config.cleanupInterval)
    }
  }

  private async ensureLockDir(): Promise<void> {
    try {
      await fs.mkdir(this.lockDir, { recursive: true })
    } catch (error) {
      // Directory might already exist
    }
  }

  private getLockPath(key: string): string {
    // Sanitize key for filesystem
    const sanitized = key.replace(/[^a-zA-Z0-9-_]/g, '_')
    
    // If the sanitized key is too long, hash it
    if (sanitized.length > FileLockDriver.MAX_FILENAME_LENGTH) {
      const hash = crypto.createHash('sha256').update(key).digest('hex')
      // Include a prefix of the original key for debugging, then the hash
      const prefix = sanitized.substring(0, 20)
      const filename = `${prefix}_${hash}`
      return path.join(this.lockDir, `${filename}.lock`)
    }
    
    return path.join(this.lockDir, `${sanitized}.lock`)
  }

  async tryAcquire(key: string, lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const lockPath = this.getLockPath(key)
    const expiresAt = Date.now() + (expiryInSeconds * 1000)
    
    const lockData: FileLock = {
      value: lockValue,
      expiresAt,
      createdAt: Date.now()
    }

    try {
      // Use 'wx' flag for exclusive creation (atomic)
      await fs.writeFile(lockPath, JSON.stringify(lockData), { flag: 'wx' })
      return true
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if expired
        try {
          const existing = await this.readLockFile(lockPath)
          if (existing && existing.expiresAt < Date.now()) {
            // Expired lock, try to remove and acquire
            await fs.unlink(lockPath)
            return this.tryAcquire(key, lockValue, expiryInSeconds)
          }
        } catch {
          // If we can't read the lock file, assume it's valid
        }
        return false
      }
      throw error
    }
  }

  async tryAcquireMultiple(keys: string[], lockValue: string, expiryInSeconds: number): Promise<boolean> {
    const lockPaths = keys.map(key => this.getLockPath(key))
    const expiresAt = Date.now() + (expiryInSeconds * 1000)
    
    const lockData: FileLock = {
      value: lockValue,
      expiresAt,
      createdAt: Date.now()
    }

    // Check if any locks exist
    for (const lockPath of lockPaths) {
      try {
        const existing = await this.readLockFile(lockPath)
        if (existing && existing.expiresAt >= Date.now()) {
          return false // Lock is active
        }
      } catch {
        // File doesn't exist, which is what we want
      }
    }

    // Try to acquire all locks
    const acquired: string[] = []
    try {
      for (const lockPath of lockPaths) {
        await fs.writeFile(lockPath, JSON.stringify(lockData), { flag: 'wx' })
        acquired.push(lockPath)
      }
      return true
    } catch (error: any) {
      // Rollback any acquired locks
      for (const acquiredPath of acquired) {
        try {
          await fs.unlink(acquiredPath)
        } catch {
          // Best effort cleanup
        }
      }
      return false
    }
  }

  async release(key: string, lockValue: string): Promise<boolean> {
    const lockPath = this.getLockPath(key)
    
    try {
      const existing = await this.readLockFile(lockPath)
      if (existing && existing.value === lockValue) {
        await fs.unlink(lockPath)
        return true
      }
      return false
    } catch {
      return false
    }
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
    const lockPath = this.getLockPath(key)
    
    try {
      const existing = await this.readLockFile(lockPath)
      return existing !== null && existing.expiresAt >= Date.now()
    } catch {
      return false
    }
  }

  async getLockInfo(key: string): Promise<LockInfo | null> {
    const lockPath = this.getLockPath(key)
    
    try {
      const fileLock = await this.readLockFile(lockPath)
      if (!fileLock) return null
      
      return {
        key,
        value: fileLock.value,
        expiresAt: fileLock.expiresAt,
        createdAt: fileLock.createdAt
      }
    } catch {
      return null
    }
  }

  async cleanup(): Promise<void> {
    try {
      const files = await fs.readdir(this.lockDir)
      const now = Date.now()
      
      for (const file of files) {
        if (file.endsWith('.lock')) {
          const lockPath = path.join(this.lockDir, file)
          try {
            const lockData = await this.readLockFile(lockPath)
            if (lockData && lockData.expiresAt < now) {
              await fs.unlink(lockPath)
            }
          } catch {
            // Skip files we can't read/parse
          }
        }
      }
    } catch (error) {
      console.error('Error during lock cleanup:', error)
    }
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
  }

  private async readLockFile(lockPath: string): Promise<FileLock | null> {
    try {
      const content = await fs.readFile(lockPath, 'utf8')
      return JSON.parse(content) as FileLock
    } catch {
      return null
    }
  }
}