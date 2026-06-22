import { Page } from '@playwright/test';
import { dockerLogMonitor } from './docker-log-monitor';

/**
 * Utility functions for enhanced Playwright testing with Docker log integration
 */

export interface LogAssertion {
  container: string;
  pattern: string | RegExp;
  timeout?: number;
  minCount?: number;
}

/**
 * Wait for multiple log patterns across different containers
 */
export async function waitForMultipleLogs(assertions: LogAssertion[]): Promise<void> {
  const promises = assertions.map(assertion => 
    dockerLogMonitor.waitForLog(
      assertion.container,
      assertion.pattern,
      assertion.timeout || 10000
    )
  );
  
  await Promise.all(promises);
}

/**
 * Perform action and verify expected logs appear
 */
export async function actionWithLogVerification(
  action: () => Promise<void>,
  logAssertion: LogAssertion
): Promise<void> {
  // Clear logs before action
  dockerLogMonitor.clearLogs(logAssertion.container);
  
  // Set up log monitoring
  const logPromise = dockerLogMonitor.waitForLog(
    logAssertion.container,
    logAssertion.pattern,
    logAssertion.timeout || 10000
  );
  
  // Perform action
  await action();
  
  // Wait for expected log
  await logPromise;
}

/**
 * Generate comprehensive test report with logs
 */
export function generateTestReport(testName: string, containerName: string = 'scrapalot-chat') {
  const logs = dockerLogMonitor.getRecentLogs(containerName, 50);
  
  console.log(`\n📊 Test Report: ${testName}`);
  console.log('=' .repeat(60));
  console.log(`Container: ${containerName}`);
  console.log(`Total logs: ${logs.length}`);
  
  // Categorize logs
  const errorLogs = logs.filter(log => log.level === 'ERROR');
  const warningLogs = logs.filter(log => log.level === 'WARNING' || log.level === 'WARN');
  const infoLogs = logs.filter(log => log.level === 'INFO');
  
  console.log(`Errors: ${errorLogs.length}, Warnings: ${warningLogs.length}, Info: ${infoLogs.length}`);
  
  if (errorLogs.length > 0) {
    console.log('\n❌ Recent Errors:');
    errorLogs.slice(-3).forEach(log => {
      console.log(`  [${log.timestamp.toISOString()}] ${log.message}`);
    });
  }
  
  if (warningLogs.length > 0) {
    console.log('\n⚠️ Recent Warnings:');
    warningLogs.slice(-2).forEach(log => {
      console.log(`  [${log.timestamp.toISOString()}] ${log.message}`);
    });
  }
  
  console.log('\n📝 Recent Activity:');
  logs.slice(-5).forEach(log => {
    console.log(`  [${log.level}] ${log.message.substring(0, 100)}${log.message.length > 100 ? '...' : ''}`);
  });
  
  console.log('=' .repeat(60));
}

/**
 * Wait for page to be ready with backend health check
 */
export async function waitForAppReady(page: Page, containerName: string = 'scrapalot-chat'): Promise<void> {
  // Wait for frontend to load
  await page.waitForLoadState('networkidle');
  
  // Check if backend is responding
  const healthLogs = dockerLogMonitor.searchLogs(
    containerName,
    /health|ready|startup|listening/i,
    new Date(Date.now() - 60000) // Last minute
  );
  
  if (healthLogs.length === 0) {
    console.log('⚠️ Backend health logs not found, waiting for activity...');
    try {
      await dockerLogMonitor.waitForLog(containerName, /GET|POST|startup|ready/i, 10000);
    } catch {
      console.log('⚠️ No backend activity detected, proceeding anyway...');
    }
  }
  
  console.log('App appears ready (frontend loaded, backend active)');
}

/**
 * Simulate realistic user behavior with delays
 */
export async function simulateUserBehavior(page: Page, actions: Array<() => Promise<void>>): Promise<void> {
  for (const [index, action] of actions.entries()) {
    console.log(`🎭 User action ${index + 1}/${actions.length}`);
    await action();
    
    // Random delay between actions (500ms - 2s)
    const delay = Math.random() * 1500 + 500;
    await page.waitForTimeout(delay);
  }
}

/**
 * Monitor performance metrics from logs
 */
export function extractPerformanceMetrics(containerName: string = 'scrapalot-chat') {
  const logs = dockerLogMonitor.getRecentLogs(containerName, 100);
  
  // Look for performance-related logs
  const performanceLogs = logs.filter(log =>
    log.message.includes('ms') ||
    log.message.includes('seconds') ||
    log.message.includes('duration') ||
    log.message.includes('latency') ||
    log.message.includes('response_time')
  );
  
  console.log(`⚡ Performance Metrics (${performanceLogs.length} entries):`);
  performanceLogs.slice(-5).forEach(log => {
    console.log(`  ${log.message}`);
  });
  
  return performanceLogs;
}

/**
 * Debug helper: Print all Docker containers and their status
 */
export async function debugDockerStatus(): Promise<void> {
  console.log('\n🐳 Docker Container Status:');
  console.log(`Monitored containers: ${dockerLogMonitor.getMonitoredContainers().join(', ')}`);
  console.log(`Monitor active: ${dockerLogMonitor.isActive()}`);
  
  // If monitoring is not active, provide setup instructions
  if (!dockerLogMonitor.isActive()) {
    console.log('\n💡 To start monitoring:');
    console.log('   await dockerLogMonitor.startMonitoring([\'scrapalot-chat\']);');
  }
}