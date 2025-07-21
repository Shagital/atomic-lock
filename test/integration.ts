/**
 * Integration test runner for atomic-lock package
 * This runs the compiled package tests without requiring Jest setup
 */

const { createMemoryLock, AtomicLock } = require('../dist/index.js');

async function runTests(): Promise<void> {
  console.log('🧪 Running Atomic Lock Integration Tests\n');
  
  let passedTests = 0;
  let totalTests = 0;
  
  function test(name: string, testFn: () => Promise<void>): Promise<void> {
    totalTests++;
    return testFn()
      .then(() => {
        console.log(`✅ ${name}`);
        passedTests++;
      })
      .catch((error: Error) => {
        console.log(`❌ ${name}: ${error.message}`);
      });
  }
  
  function assert(condition: any, message: string = 'Assertion failed'): void {
    if (!condition) {
      throw new Error(message);
    }
  }

  // Test 1: Basic lock acquisition
  await test('Basic lock acquisition', async () => {
    const lock = createMemoryLock();
    const lockValue = await lock.tryAcquire('test-key', { expiryInSeconds: 5 });
    assert(lockValue, 'Lock should be acquired');
    assert(typeof lockValue === 'string', 'Lock value should be string');
    await lock.close();
  });

  // Test 2: Lock collision handling
  await test('Lock collision handling', async () => {
    const lock = createMemoryLock();
    const first = await lock.tryAcquire('collision-key', { expiryInSeconds: 5 });
    const second = await lock.tryAcquire('collision-key', { expiryInSeconds: 5 });
    
    assert(first, 'First lock should succeed');
    assert(!second, 'Second lock should fail');
    
    if (first) {
      const released = await lock.release('collision-key', first);
      assert(released, 'Lock should be released');
    }
    await lock.close();
  });

  // Test 3: Wrong lock value rejection
  await test('Wrong lock value rejection', async () => {
    const lock = createMemoryLock();
    const lockValue = await lock.tryAcquire('test-key', { expiryInSeconds: 5 });
    
    assert(lockValue, 'Lock should be acquired');
    
    // Try to release with wrong value
    const wrongRelease = await lock.release('test-key', 'wrong-value');
    assert(!wrongRelease, 'Release with wrong value should fail');
    
    // Release with correct value
    const correctRelease = await lock.release('test-key', lockValue);
    assert(correctRelease, 'Release with correct value should succeed');
    
    await lock.close();
  });

  // Test 4: Circuit breaker functionality
  await test('Circuit breaker functionality', async () => {
    const lock = createMemoryLock();
    
    // Simulate failures using available internal method
    for (let i = 0; i < 6; i++) {
      lock.recordLockFailure('failing-key');
    }
    
    const stats = lock.getCircuitBreakerStatus('failing-key');
    assert(stats.failureCount === 6, 'Should track 6 failures');
    assert(stats.isOpen === true, 'Circuit breaker should be open');
    
    // Note: resetCircuitBreaker method is not available in this implementation
    await lock.close();
  });

  // Test 5: Direct AtomicLock instantiation
  await test('Direct AtomicLock instantiation', async () => {
    const lock = new AtomicLock({ driver: 'memory', memory: {} });
    const lockValue = await lock.tryAcquire('direct-test');
    
    assert(lockValue, 'Direct instantiation should work');
    
    if (lockValue) {
      const released = await lock.release('direct-test', lockValue);
      assert(released, 'Should release lock');
    }
    await lock.close();
  });

  // Test 6: Lock expiry behavior  
  await test('Lock expiry behavior', async () => {
    const lock = createMemoryLock();
    
    // Acquire a lock with very short expiry
    const lockValue = await lock.tryAcquire('expiry-test', { expiryInSeconds: 0.1 });
    assert(lockValue, 'Lock should be acquired');
    
    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Should be able to acquire again after expiry
    const newLockValue = await lock.tryAcquire('expiry-test', { expiryInSeconds: 5 });
    assert(newLockValue, 'Should be able to acquire after expiry');
    
    await lock.release('expiry-test', newLockValue);
    await lock.close();
  });

  console.log(`\n📊 Test Results: ${passedTests}/${totalTests} passed`);
  
  if (passedTests === totalTests) {
    console.log('🎉 All tests passed! Package is ready for production.');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed.');
    process.exit(1);
  }
}

runTests().catch((error: Error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});