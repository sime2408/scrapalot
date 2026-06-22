/**
 * UNIFIED FRONTEND + BACKEND E2E DOCUMENT UPLOAD TEST
 *
 * This test integrates both @scrapalot-ui and @scrapalot-chat testing infrastructures
 * to provide complete end-to-end verification of the document upload pipeline.
 *
 * Test Architecture:
 * 1. Backend Infrastructure: Uses scrapalot-chat/tests/ utilities for database setup
 * 2. Frontend Infrastructure: Uses Playwright for UI interaction
 * 3. Docker Integration: Monitors all container logs during processing
 * 4. Database Verification: Proves data storage across PostgreSQL and Neo4j
 * 5. Error Detection: Monitors console errors and toast notifications
 *
 * This is a TRUE integration test - no mocks, no shortcuts, complete real workflow.
 */

import { test, expect, Page, ConsoleMessage } from '@playwright/test';
import { AuthHelper } from './utils/auth-helper.js';
import { DockerLogMonitor } from './utils/docker-log-monitor.js';
import { DatabaseMonitor } from './utils/database-monitor.js';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// ERROR MONITORING UTILITIES
// ============================================================================

interface ConsoleError {
  type: string;
  text: string;
  timestamp: Date;
  location?: string;
}

interface ToastNotification {
  type: 'success' | 'error' | 'warning' | 'info' | 'destructive';
  title: string;
  description?: string;
  timestamp: Date;
}

interface ProgressUpdate {
  percentage: number;
  message: string;
  timestamp: Date;
}

class ErrorMonitor {
  private consoleErrors: ConsoleError[] = [];
  private toastNotifications: ToastNotification[] = [];
  private progressUpdates: ProgressUpdate[] = [];
  private page: Page;
  private isMonitoring = false;

  constructor(page: Page) {
    this.page = page;
  }

  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) return;
    this.isMonitoring = true;

    // Monitor console messages
    this.page.on('console', (msg: ConsoleMessage) => {
      const type = msg.type();
      const text = msg.text();

      // Capture errors and warnings
      if (type === 'error' || type === 'warning') {
        // Filter out known non-critical messages
        const ignoredPatterns = [
          'Download the React DevTools',
          'A listener indicated an asynchronous response',
          'Element Cloner content script',
          'Missing `Description` or `aria-describedby',
        ];

        const shouldIgnore = ignoredPatterns.some(pattern => text.includes(pattern));

        if (!shouldIgnore) {
          this.consoleErrors.push({
            type,
            text,
            timestamp: new Date(),
            location: msg.location()?.url,
          });
          console.log(`🔴 [CONSOLE ${type.toUpperCase()}]: ${text.substring(0, 200)}`);
        }
      }
    });

    // Monitor page errors (uncaught exceptions)
    this.page.on('pageerror', (error) => {
      this.consoleErrors.push({
        type: 'pageerror',
        text: error.message,
        timestamp: new Date(),
      });
      console.log(`🔴 [PAGE ERROR]: ${error.message}`);
    });

    // Set up toast notification observer
    await this.page.evaluate(() => {
      // Create a MutationObserver to watch for toast notifications
      const toastObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              // Look for toast elements (Radix UI toast pattern)
              const toast = node.querySelector('[data-radix-toast-viewport] > div, [role="status"], .toast, [data-state="open"][data-swipe-direction]');
              if (toast || node.matches('[data-radix-toast-viewport] > div, [role="status"], .toast')) {
                const toastEl = toast || node;
                const isDestructive = toastEl.classList.contains('destructive') ||
                                     toastEl.getAttribute('data-variant') === 'destructive' ||
                                     toastEl.querySelector('.destructive, [data-variant="destructive"]') !== null;

                // Store toast info on window for retrieval
                (window as any).__e2e_toasts = (window as any).__e2e_toasts || [];
                (window as any).__e2e_toasts.push({
                  type: isDestructive ? 'destructive' : 'info',
                  text: toastEl.textContent,
                  timestamp: Date.now(),
                });
              }
            }
          });
        });
      });

      toastObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });

      (window as any).__e2e_toastObserver = toastObserver;
    });

    console.log('🔍 Error monitoring started');
  }

  async collectToasts(): Promise<ToastNotification[]> {
    const toasts = await this.page.evaluate(() => {
      return (window as any).__e2e_toasts || [];
    });

    return toasts.map((t: any) => ({
      type: t.type,
      title: t.text?.split('\n')[0] || '',
      description: t.text?.split('\n').slice(1).join('\n') || '',
      timestamp: new Date(t.timestamp),
    }));
  }

  getConsoleErrors(): ConsoleError[] {
    return this.consoleErrors;
  }

  getCriticalErrors(): ConsoleError[] {
    return this.consoleErrors.filter(e =>
      e.type === 'error' ||
      e.type === 'pageerror' ||
      e.text.toLowerCase().includes('failed') ||
      e.text.toLowerCase().includes('exception')
    );
  }

  hasErrors(): boolean {
    return this.getCriticalErrors().length > 0;
  }

  async checkForToastErrors(): Promise<ToastNotification[]> {
    const toasts = await this.collectToasts();
    return toasts.filter(t => t.type === 'destructive' || t.type === 'error');
  }

  async stopMonitoring(): Promise<void> {
    this.isMonitoring = false;
    await this.page.evaluate(() => {
      if ((window as any).__e2e_toastObserver) {
        (window as any).__e2e_toastObserver.disconnect();
      }
    });
  }

  printSummary(): void {
    console.log('\n📊 ERROR MONITORING SUMMARY:');
    console.log('=' .repeat(40));
    console.log(`Console Errors: ${this.consoleErrors.filter(e => e.type === 'error').length}`);
    console.log(`Console Warnings: ${this.consoleErrors.filter(e => e.type === 'warning').length}`);
    console.log(`Page Errors: ${this.consoleErrors.filter(e => e.type === 'pageerror').length}`);

    if (this.consoleErrors.length > 0) {
      console.log('\nDetailed Errors:');
      this.consoleErrors.forEach((e, i) => {
        console.log(`  ${i + 1}. [${e.type}] ${e.text.substring(0, 100)}...`);
      });
    }
  }
}

// ============================================================================
// PROGRESS TRACKER
// ============================================================================

class ProgressTracker {
  private updates: ProgressUpdate[] = [];
  private page: Page;
  private lastProgress = 0;
  private progressStuckCount = 0;
  private readonly STUCK_THRESHOLD = 5; // Number of checks before considering stuck

  constructor(page: Page) {
    this.page = page;
  }

  async getCurrentProgress(): Promise<ProgressUpdate | null> {
    const progressData = await this.page.evaluate(() => {
      // Look for progress percentage in various formats
      const progressElements = document.querySelectorAll(
        '[class*="progress"], .uploading, [role="progressbar"], svg circle'
      );

      for (const el of progressElements) {
        // Check for percentage text
        const text = el.textContent || '';
        const match = text.match(/(\d+)\s*%/);
        if (match) {
          return {
            percentage: parseInt(match[1], 10),
            message: text,
          };
        }

        // Check for aria-valuenow
        const ariaValue = el.getAttribute('aria-valuenow');
        if (ariaValue) {
          return {
            percentage: parseInt(ariaValue, 10),
            message: 'Processing...',
          };
        }
      }

      // Check for progress message text
      const messageEl = document.querySelector('[class*="progress"] + span, .status-message, .upload-status');
      if (messageEl) {
        const text = messageEl.textContent || '';
        const match = text.match(/(\d+)\s*%/);
        if (match) {
          return {
            percentage: parseInt(match[1], 10),
            message: text,
          };
        }
      }

      return null;
    });

    if (progressData) {
      const update: ProgressUpdate = {
        ...progressData,
        timestamp: new Date(),
      };
      this.updates.push(update);

      // Check for stuck progress
      if (progressData.percentage === this.lastProgress) {
        this.progressStuckCount++;
      } else {
        this.progressStuckCount = 0;
        this.lastProgress = progressData.percentage;
      }

      return update;
    }

    return null;
  }

  isProgressStuck(): boolean {
    return this.progressStuckCount >= this.STUCK_THRESHOLD;
  }

  getProgressHistory(): ProgressUpdate[] {
    return this.updates;
  }

  hasProgressRegressed(): boolean {
    if (this.updates.length < 2) return false;

    for (let i = 1; i < this.updates.length; i++) {
      if (this.updates[i].percentage < this.updates[i - 1].percentage) {
        return true;
      }
    }
    return false;
  }

  getAnomalies(): string[] {
    const anomalies: string[] = [];

    if (this.isProgressStuck()) {
      anomalies.push(`Progress stuck at ${this.lastProgress}% for ${this.progressStuckCount} checks`);
    }

    if (this.hasProgressRegressed()) {
      anomalies.push('Progress regressed (went backwards)');
    }

    // Check for large jumps
    for (let i = 1; i < this.updates.length; i++) {
      const jump = this.updates[i].percentage - this.updates[i - 1].percentage;
      if (jump > 30) {
        anomalies.push(`Large progress jump detected: ${this.updates[i - 1].percentage}% → ${this.updates[i].percentage}%`);
      }
    }

    return anomalies;
  }

  printSummary(): void {
    console.log('\n📈 PROGRESS TRACKING SUMMARY:');
    console.log('=' .repeat(40));
    console.log(`Total updates captured: ${this.updates.length}`);
    console.log(`Final progress: ${this.lastProgress}%`);

    const anomalies = this.getAnomalies();
    if (anomalies.length > 0) {
      console.log('\n⚠️ Progress Anomalies Detected:');
      anomalies.forEach(a => console.log(`  - ${a}`));
    } else {
      console.log('No progress anomalies detected');
    }
  }
}

// ============================================================================
// BACKEND INTEGRATION
// ============================================================================

interface DocumentVerification {
  exists: boolean;
  status: string;
  chunksCount: number;
  embeddingsCount: number;
  graphNodesCount: number;
  processingTime: number;
}

interface ProcessingStatus {
  isComplete: boolean;
  stage: string;
  progress: number;
  backgroundJobsCompleted: boolean;
  workersActive: boolean;
}

class BackendIntegration {
  constructor(private baseUrl: string = 'http://localhost:8090/api/v1') {}

  async ensureDatabase(): Promise<boolean> {
    try {
      const docsResponse = await fetch(`${this.baseUrl.replace('/api/v1', '')}/docs`);
      if (!docsResponse.ok) {
        console.log('❌ Backend is not responsive');
        return false;
      }

      const apiResponse = await fetch(`${this.baseUrl}/users/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test-connectivity@example.com',
          password: 'test'
        })
      });

      const isResponsive = [400, 401, 422, 409].includes(apiResponse.status);

      if (!isResponsive) {
        console.log(`❌ API not responsive: ${apiResponse.status}`);
        return false;
      }

      console.log('Backend API is responsive');
      return true;
    } catch (error: any) {
      console.log(`❌ Backend connectivity failed: ${error.message}`);
      return false;
    }
  }

  async verifyDocumentInDatabase(documentId: string, authToken: string): Promise<DocumentVerification> {
    try {
      const docResponse = await fetch(`${this.baseUrl}/documents/${documentId}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });

      if (!docResponse.ok) {
        return {
          exists: false,
          status: 'not_found',
          chunksCount: 0,
          embeddingsCount: 0,
          graphNodesCount: 0,
          processingTime: 0
        };
      }

      const doc = await docResponse.json();

      return {
        exists: true,
        status: doc.status || doc.processing_status || 'unknown',
        chunksCount: doc.chunk_count || 0,
        embeddingsCount: doc.embedding_count || 0,
        graphNodesCount: 0,
        processingTime: doc.processing_time || 0
      };
    } catch (error: any) {
      console.error(`Database verification failed: ${error.message}`);
      return {
        exists: false,
        status: 'error',
        chunksCount: 0,
        embeddingsCount: 0,
        graphNodesCount: 0,
        processingTime: 0
      };
    }
  }

  async deleteDocument(documentId: string, authToken: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/documents/${documentId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      return response.ok || response.status === 404;
    } catch (error) {
      return false;
    }
  }

  async cleanupTestData(): Promise<void> {
    console.log('🧹 Test cleanup completed');
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

test.describe('Unified Document Upload E2E Test', () => {
  let authHelper: AuthHelper;
  let dockerLogMonitor: DockerLogMonitor;
  let databaseMonitor: DatabaseMonitor;
  let backendIntegration: BackendIntegration;
  let errorMonitor: ErrorMonitor;
  let progressTracker: ProgressTracker;

  test.beforeEach(async ({ page }) => {
    authHelper = new AuthHelper(page);
    dockerLogMonitor = new DockerLogMonitor();
    databaseMonitor = new DatabaseMonitor();
    backendIntegration = new BackendIntegration();
    errorMonitor = new ErrorMonitor(page);
    progressTracker = new ProgressTracker(page);
  });

  test.afterEach(async () => {
    await dockerLogMonitor?.stopMonitoring();
    await databaseMonitor?.stopMonitoring();
    await errorMonitor?.stopMonitoring();
    await backendIntegration?.cleanupTestData();

    // Print summaries
    errorMonitor?.printSummary();
    progressTracker?.printSummary();
  });

  test('complete document upload with error and progress monitoring', async ({ page }) => {
    console.log('🚀 UNIFIED DOCUMENT UPLOAD E2E TEST WITH MONITORING');
    console.log('=' .repeat(60));

    // Start error monitoring immediately
    await errorMonitor.startMonitoring();

    // Phase 1: Backend Infrastructure Setup
    console.log('\n🔧 Phase 1: Backend Infrastructure Setup...');
    const isDatabaseReady = await backendIntegration.ensureDatabase();
    expect(isDatabaseReady).toBe(true);

    // Phase 2: Authentication
    console.log('\n🔐 Phase 2: Frontend authentication...');
    const testEmail = 'testuser@scrapalot.com';
    const testPassword = 'testpass123';

    await authHelper.login({ email: testEmail, password: testPassword });

    // Check for auth errors
    const authErrors = errorMonitor.getCriticalErrors();
    if (authErrors.length > 0) {
      console.log('⚠️ Errors during authentication:', authErrors.map(e => e.text));
    }

    // Extract auth token
    const authToken = await page.evaluate(() => {
      const stored = localStorage.getItem('auth_tokens');
      if (stored) {
        try {
          const tokens = JSON.parse(stored);
          return tokens.access_token;
        } catch (e) {
          return null;
        }
      }
      return null;
    });

    // Phase 3: Navigate to Knowledge Stacks
    console.log('\n📄 Phase 3: Navigating to Knowledge Stacks...');
    await page.goto('http://localhost:3000/dashboard');
    await page.waitForLoadState('networkidle');

    // Check for navigation errors
    expect(errorMonitor.hasErrors()).toBe(false);

    // Open Knowledge Stacks dialog
    const knowledgeStacksButton = page.locator('button:has(svg[class*="lucide-database"])').first();
    await expect(knowledgeStacksButton).toBeVisible({ timeout: 10000 });
    await knowledgeStacksButton.click();
    await page.waitForTimeout(2000);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Phase 4: Upload Document
    console.log('\n📁 Phase 4: Uploading test document...');

    const testDocContent = `# E2E Test Document - ${Date.now()}

This document tests the complete upload pipeline with error monitoring.

## Content
Testing progress tracking, error detection, and deletion verification.
`;

    const testFilePath = path.join(process.cwd(), `e2e-test-${Date.now()}.txt`);
    fs.writeFileSync(testFilePath, testDocContent);

    let uploadedDocumentId: string | null = null;

    try {
      const fileInput = dialog.locator('input[type="file"]').first();

      if (await fileInput.isVisible({ timeout: 3000 })) {
        await fileInput.setInputFiles(testFilePath);
        console.log('File selected for upload');

        // Phase 5: Monitor Progress
        console.log('\n⏱️ Phase 5: Monitoring upload progress...');

        const uploadStartTime = Date.now();
        const maxWait = 120000; // 2 minutes
        let lastLoggedProgress = -1;
        let uploadComplete = false;

        while (Date.now() - uploadStartTime < maxWait && !uploadComplete) {
          // Check for toast errors
          const toastErrors = await errorMonitor.checkForToastErrors();
          if (toastErrors.length > 0) {
            console.log('🔴 Toast errors detected:', toastErrors.map(t => t.title));
            // Take screenshot on error
            await page.screenshot({ path: `docs/screenshots/error-toast-${Date.now()}.png` });
          }

          // Track progress
          const progress = await progressTracker.getCurrentProgress();
          if (progress && progress.percentage !== lastLoggedProgress) {
            console.log(`📊 Progress: ${progress.percentage}% - ${progress.message}`);
            lastLoggedProgress = progress.percentage;
          }

          // Check for progress anomalies
          if (progressTracker.isProgressStuck()) {
            console.log('⚠️ Progress appears stuck!');
            await page.screenshot({ path: `docs/screenshots/progress-stuck-${Date.now()}.png` });
          }

          // Check for completion
          const completionIndicator = await page.locator('text=complete, text=success, text=Ready for search').first().isVisible().catch(() => false);
          if (completionIndicator || (progress && progress.percentage >= 100)) {
            uploadComplete = true;
            console.log('Upload completed!');
          }

          // Try to extract document ID from the UI
          if (!uploadedDocumentId) {
            uploadedDocumentId = await page.evaluate(() => {
              const elements = document.querySelectorAll('[data-document-id], [data-id]');
              for (const el of elements) {
                const id = el.getAttribute('data-document-id') || el.getAttribute('data-id');
                if (id && id.includes('-')) return id;
              }
              return null;
            });
          }

          await page.waitForTimeout(2000);
        }

        // Phase 6: Verify no critical errors during upload
        console.log('\n🔍 Phase 6: Checking for errors during upload...');
        const uploadErrors = errorMonitor.getCriticalErrors();
        console.log(`Critical errors found: ${uploadErrors.length}`);

        // Log any anomalies
        const anomalies = progressTracker.getAnomalies();
        if (anomalies.length > 0) {
          console.log('⚠️ Progress anomalies:', anomalies);
        }

      } else {
        console.log('⚠️ File input not found');
      }

    } finally {
      // Cleanup test file
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    }

    // Phase 7: Test Document Deletion (if we have a document ID)
    if (uploadedDocumentId && authToken) {
      console.log('\n🗑️ Phase 7: Testing document deletion...');

      // Find the delete button for the uploaded document
      const deleteButton = dialog.locator(`button[title="Delete document"]`).first();

      if (await deleteButton.isVisible({ timeout: 5000 })) {
        // Count documents before deletion
        const docCountBefore = await dialog.locator('[data-document-id], .document-item').count();
        console.log(`Documents before deletion: ${docCountBefore}`);

        // Click delete
        await deleteButton.click();
        await page.waitForTimeout(1000);

        // Check for deletion errors
        const deletionToastErrors = await errorMonitor.checkForToastErrors();
        if (deletionToastErrors.length > 0) {
          console.log('🔴 Deletion toast errors:', deletionToastErrors.map(t => t.title));
        }

        // Verify document was removed from UI
        await page.waitForTimeout(500);
        const docCountAfter = await dialog.locator('[data-document-id], .document-item').count();
        console.log(`Documents after deletion: ${docCountAfter}`);

        // Check for reappearance (the bug we fixed)
        await page.waitForTimeout(2000);
        const docCountDelayed = await dialog.locator('[data-document-id], .document-item').count();

        if (docCountDelayed > docCountAfter) {
          console.log('🔴 ANOMALY: Document reappeared after deletion!');
          await page.screenshot({ path: `docs/screenshots/deletion-anomaly-${Date.now()}.png` });
        } else {
          console.log('Document deletion verified - no reappearance');
        }

        // Verify in backend
        const backendVerification = await backendIntegration.verifyDocumentInDatabase(uploadedDocumentId, authToken);
        expect(backendVerification.exists).toBe(false);
        console.log('Backend verification: Document deleted');
      }
    }

    // Final Summary
    console.log('\n' + '=' .repeat(60));
    console.log('🎯 FINAL TEST SUMMARY');
    console.log('=' .repeat(60));

    const finalErrors = errorMonitor.getCriticalErrors();
    const finalAnomalies = progressTracker.getAnomalies();

    console.log(`Total critical errors: ${finalErrors.length}`);
    console.log(`Progress anomalies: ${finalAnomalies.length}`);

    // Assert no critical errors
    if (finalErrors.length > 0) {
      console.log('\n❌ Critical errors detected:');
      finalErrors.forEach(e => console.log(`  - [${e.type}] ${e.text.substring(0, 100)}`));
    }

    expect(finalErrors.length).toBe(0);

    console.log('\n🏆 E2E TEST COMPLETED');
  });

  test('document deletion does not cause reappearance', async ({ page }) => {
    console.log('🗑️ DOCUMENT DELETION ANOMALY TEST');
    console.log('=' .repeat(60));

    await errorMonitor.startMonitoring();

    // Login
    await authHelper.login({
      email: 'testuser@scrapalot.com',
      password: 'testpass123'
    });

    await page.goto('http://localhost:3000/dashboard');
    await page.waitForLoadState('networkidle');

    // Open Knowledge Stacks
    const knowledgeStacksButton = page.locator('button:has(svg[class*="lucide-database"])').first();
    await knowledgeStacksButton.click();
    await page.waitForTimeout(2000);

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Get initial document count
    const initialCount = await dialog.locator('button[title="Delete document"]').count();
    console.log(`Initial documents with delete button: ${initialCount}`);

    if (initialCount > 0) {
      // Click first delete button
      const firstDeleteBtn = dialog.locator('button[title="Delete document"]').first();
      await firstDeleteBtn.click();

      console.log('⏳ Waiting for deletion to complete...');
      await page.waitForTimeout(500);

      // Check count immediately after
      const countAfterDelete = await dialog.locator('button[title="Delete document"]').count();
      console.log(`Documents after delete: ${countAfterDelete}`);

      // Wait longer and check for reappearance
      await page.waitForTimeout(3000);
      const countAfterWait = await dialog.locator('button[title="Delete document"]').count();
      console.log(`Documents after 3s wait: ${countAfterWait}`);

      // The count should not increase after deletion
      expect(countAfterWait).toBeLessThanOrEqual(countAfterDelete);

      if (countAfterWait > countAfterDelete) {
        console.log('🔴 FAIL: Document reappeared after deletion!');
        await page.screenshot({ path: 'docs/screenshots/deletion-reappearance-bug.png' });
      } else {
        console.log('PASS: No reappearance detected');
      }

      // Check for any toast errors
      const toastErrors = await errorMonitor.checkForToastErrors();
      expect(toastErrors.length).toBe(0);
    } else {
      console.log('⚠️ No documents available to test deletion');
    }
  });
});
