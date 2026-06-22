import { Page } from '@playwright/test';
import { dockerLogMonitor } from './docker-log-monitor';

export interface WorkerDiagnostic {
  containerName: string;
  isActive: boolean;
  recentLogs: number;
  lastActivity?: Date;
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  workerType?: 'main' | 'docprocessing' | 'primary' | 'beat';
}

export interface ProcessingDiagnostic {
  stage: string;
  detected: boolean;
  evidence: string[];
  duration?: number;
  timestamp?: Date;
}

export class WorkerDiagnostics {
  
  /**
   * Comprehensive worker status check
   */
  static async checkWorkerStatus(): Promise<WorkerDiagnostic[]> {
    const containers = [
      { name: 'scrapalot-chat', type: 'main' as const },
      { name: 'scrapalot-docprocessing', type: 'docprocessing' as const },
      { name: 'scrapalot-primary', type: 'primary' as const },
      { name: 'scrapalot-beat', type: 'beat' as const }
    ];
    
    const diagnostics: WorkerDiagnostic[] = [];
    
    for (const container of containers) {
      const logs = dockerLogMonitor.getRecentLogs(container.name, 50);
      
      // Determine health status
      let healthStatus: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
      if (logs.length === 0) {
        healthStatus = 'unhealthy';
      } else {
        const errorLogs = logs.filter(log => 
          log.level === 'ERROR' || 
          log.message.toLowerCase().includes('error') ||
          log.message.toLowerCase().includes('failed')
        );
        
        const healthyLogs = logs.filter(log =>
          log.message.toLowerCase().includes('ready') ||
          log.message.toLowerCase().includes('started') ||
          log.message.toLowerCase().includes('healthy')
        );
        
        if (errorLogs.length > healthyLogs.length && errorLogs.length > 5) {
          healthStatus = 'unhealthy';
        } else if (logs.length > 0) {
          healthStatus = 'healthy';
        }
      }
      
      // Find last activity
      const lastActivity = logs.length > 0 ? logs[logs.length - 1].timestamp : undefined;
      
      diagnostics.push({
        containerName: container.name,
        isActive: logs.length > 0,
        recentLogs: logs.length,
        lastActivity,
        healthStatus,
        workerType: container.type
      });
    }
    
    return diagnostics;
  }
  
  /**
   * Check background worker configuration
   */
  static async checkBackgroundWorkerConfig(): Promise<{
    enabledInConfig: boolean | null;
    redisConnection: boolean;
    celeryActivity: boolean;
    evidence: string[];
  }> {
    const evidence: string[] = [];
    
    // Check for ENABLE_BACKGROUND_WORKERS setting
    const configLogs = dockerLogMonitor.searchLogs(
      'scrapalot-chat',
      /ENABLE_BACKGROUND_WORKERS/i,
      new Date(Date.now() - 300000) // Last 5 minutes
    );
    
    let enabledInConfig: boolean | null = null;
    if (configLogs.length > 0) {
      const configLog = configLogs[configLogs.length - 1];
      enabledInConfig = configLog.message.toLowerCase().includes('true');
      evidence.push(`Config setting: ${configLog.message}`);
    }
    
    // Check Redis connection
    const redisLogs = dockerLogMonitor.searchLogs(
      'scrapalot-chat',
      /redis.*connect|connect.*redis|redis.*broker/i,
      new Date(Date.now() - 120000)
    );
    
    const redisConnection = redisLogs.length > 0;
    if (redisConnection) {
      evidence.push(`Redis connection: ${redisLogs.length} logs`);
    }
    
    // Check Celery activity
    const celeryLogs = dockerLogMonitor.searchLogs(
      'scrapalot-chat',
      /celery|worker.*ready|task.*received/i,
      new Date(Date.now() - 120000)
    );
    
    const celeryActivity = celeryLogs.length > 0;
    if (celeryActivity) {
      evidence.push(`Celery activity: ${celeryLogs.length} logs`);
    }
    
    return {
      enabledInConfig,
      redisConnection,
      celeryActivity,
      evidence
    };
  }
  
  /**
   * Analyze document processing pipeline stages
   */
  static async analyzeProcessingPipeline(timeWindow: number = 60000): Promise<ProcessingDiagnostic[]> {
    const stages = [
      {
        stage: 'Document Parsing',
        patterns: [/parse.*pdf|pdf.*parse|extract.*text|document.*extract/i]
      },
      {
        stage: 'Text Chunking', 
        patterns: [/chunk|split.*text|segment.*document|hierarchy.*chunk/i]
      },
      {
        stage: 'Embedding Generation',
        patterns: [/embed|vector.*generat|model.*server|embedding.*creat/i]
      },
      {
        stage: 'Database Storage',
        patterns: [/insert.*document|store.*vector|pgvector.*insert/i]
      },
      {
        stage: 'Graph Processing',
        patterns: [/neo4j|graph.*node|create.*node|relationship.*creat/i]
      },
      {
        stage: 'Job Management',
        patterns: [/job.*creat|queue.*job|task.*delay|background.*task/i]
      }
    ];
    
    const diagnostics: ProcessingDiagnostic[] = [];
    const cutoffTime = new Date(Date.now() - timeWindow);
    
    for (const { stage, patterns } of stages) {
      const evidence: string[] = [];
      let detected = false;
      let earliestTimestamp: Date | undefined;
      
      for (const pattern of patterns) {
        const logs = dockerLogMonitor.searchLogs('scrapalot-chat', pattern, cutoffTime);
        
        if (logs.length > 0) {
          detected = true;
          evidence.push(...logs.map(log => log.message.substring(0, 100)));
          
          const timestamps = logs.map(log => log.timestamp);
          const earliest = new Date(Math.min(...timestamps.map(t => t.getTime())));
          
          if (!earliestTimestamp || earliest < earliestTimestamp) {
            earliestTimestamp = earliest;
          }
        }
      }
      
      diagnostics.push({
        stage,
        detected,
        evidence: evidence.slice(0, 3), // Limit to 3 examples
        timestamp: earliestTimestamp
      });
    }
    
    return diagnostics;
  }
  
  /**
   * Detect rapid completion scenarios
   */
  static async detectRapidCompletion(): Promise<{
    isRapidCompletion: boolean;
    processingDuration: number | null;
    synchronousIndicators: string[];
    asyncIndicators: string[];
    recommendation: string;
  }> {
    const recentLogs = dockerLogMonitor.getRecentLogs('scrapalot-chat', 100);
    
    // Look for completion indicators
    const completionLogs = recentLogs.filter(log =>
      log.message.includes('100%') ||
      log.message.toLowerCase().includes('complet') ||
      log.message.toLowerCase().includes('finish') ||
      log.message.toLowerCase().includes('done')
    );
    
    // Look for synchronous processing indicators
    const synchronousIndicators: string[] = [];
    const syncPatterns = [
      /fallback.*local|local.*fallback/i,
      /synchronous.*process|process.*synchronous/i,
      /no.*worker.*available|worker.*not.*available/i,
      /background.*worker.*disabled|disabled.*background.*worker/i,
      /direct.*process|immediate.*process/i
    ];
    
    for (const pattern of syncPatterns) {
      const matches = recentLogs.filter(log => pattern.test(log.message));
      synchronousIndicators.push(...matches.map(log => log.message));
    }
    
    // Look for asynchronous processing indicators
    const asyncIndicators: string[] = [];
    const asyncPatterns = [
      /celery.*task|task.*celery/i,
      /queue.*job|job.*queue/i,
      /background.*worker|worker.*background/i,
      /async.*task|task.*async/i,
      /redis.*queue|queue.*redis/i
    ];
    
    for (const pattern of asyncPatterns) {
      const matches = recentLogs.filter(log => pattern.test(log.message));
      asyncIndicators.push(...matches.map(log => log.message));
    }
    
    // Estimate processing duration if possible
    let processingDuration: number | null = null;
    if (completionLogs.length > 0 && recentLogs.length > 0) {
      const firstLog = recentLogs[0];
      const lastCompletion = completionLogs[completionLogs.length - 1];
      processingDuration = lastCompletion.timestamp.getTime() - firstLog.timestamp.getTime();
    }
    
    // Determine if rapid completion occurred
    const isRapidCompletion = (
      (processingDuration !== null && processingDuration < 5000) || // Less than 5 seconds
      (synchronousIndicators.length > asyncIndicators.length && synchronousIndicators.length > 0)
    );
    
    // Generate recommendation
    let recommendation = '';
    if (isRapidCompletion) {
      if (synchronousIndicators.length > 0) {
        recommendation = 'System appears to be using synchronous fallback. Check ENABLE_BACKGROUND_WORKERS setting and verify worker containers are running.';
      } else {
        recommendation = 'Processing completed very quickly. This may indicate incomplete pipeline execution or cached results.';
      }
    } else if (asyncIndicators.length > 0) {
      recommendation = 'Asynchronous processing detected. Background workers appear to be functioning correctly.';
    } else {
      recommendation = 'Unable to determine processing mode. Check worker logs and configuration.';
    }
    
    return {
      isRapidCompletion,
      processingDuration,
      synchronousIndicators: synchronousIndicators.slice(0, 3),
      asyncIndicators: asyncIndicators.slice(0, 3),
      recommendation
    };
  }
  
  /**
   * Generate comprehensive diagnostic report
   */
  static async generateDiagnosticReport(): Promise<string> {
    const workerStatus = await this.checkWorkerStatus();
    const backgroundConfig = await this.checkBackgroundWorkerConfig();
    const processingPipeline = await this.analyzeProcessingPipeline();
    const rapidCompletion = await this.detectRapidCompletion();
    
    const report = [
      '🔧 SCRAPALOT WORKER DIAGNOSTIC REPORT',
      '=' .repeat(50),
      '',
      '📦 CONTAINER STATUS:',
      ...workerStatus.map(w => 
        `  ${w.containerName}: ${w.isActive ? '✅' : '❌'} ${w.healthStatus.toUpperCase()} (${w.recentLogs} logs)`
      ),
      '',
      '⚙️ BACKGROUND WORKER CONFIGURATION:',
      `  Enabled in config: ${backgroundConfig.enabledInConfig === null ? 'Unknown' : backgroundConfig.enabledInConfig ? 'Yes' : 'No'}`,
      `  Redis connection: ${backgroundConfig.redisConnection ? 'Yes' : 'No'}`,
      `  Celery activity: ${backgroundConfig.celeryActivity ? 'Yes' : 'No'}`,
      '',
      '🔄 PROCESSING PIPELINE ANALYSIS:',
      ...processingPipeline.map(p => 
        `  ${p.stage}: ${p.detected ? '✅' : '❌'} (${p.evidence.length} evidence)`
      ),
      '',
      '⚡ RAPID COMPLETION ANALYSIS:',
      `  Rapid completion detected: ${rapidCompletion.isRapidCompletion ? 'Yes' : 'No'}`,
      `  Processing duration: ${rapidCompletion.processingDuration ? rapidCompletion.processingDuration + 'ms' : 'Unknown'}`,
      `  Synchronous indicators: ${rapidCompletion.synchronousIndicators.length}`,
      `  Async indicators: ${rapidCompletion.asyncIndicators.length}`,
      '',
      '💡 RECOMMENDATION:',
      `  ${rapidCompletion.recommendation}`,
      '',
      '🔍 EVIDENCE SAMPLES:',
    ];
    
    if (backgroundConfig.evidence.length > 0) {
      report.push('  Configuration evidence:');
      report.push(...backgroundConfig.evidence.map(e => `    - ${e.substring(0, 80)}...`));
    }
    
    if (rapidCompletion.synchronousIndicators.length > 0) {
      report.push('  Synchronous processing evidence:');
      report.push(...rapidCompletion.synchronousIndicators.map(e => `    - ${e.substring(0, 80)}...`));
    }
    
    if (rapidCompletion.asyncIndicators.length > 0) {
      report.push('  Asynchronous processing evidence:');
      report.push(...rapidCompletion.asyncIndicators.map(e => `    - ${e.substring(0, 80)}...`));
    }
    
    const detectedPipeline = processingPipeline.filter(p => p.detected);
    if (detectedPipeline.length > 0) {
      report.push('  Processing pipeline evidence:');
      detectedPipeline.forEach(p => {
        report.push(`    ${p.stage}:`);
        p.evidence.forEach(e => report.push(`      - ${e}...`));
      });
    }
    
    return report.join('\n');
  }
  
  /**
   * Quick health check for testing
   */
  static async quickHealthCheck(): Promise<{
    mainAppActive: boolean;
    workersActive: number;
    backgroundWorkersEnabled: boolean | null;
    recentProcessingActivity: boolean;
  }> {
    const workerStatus = await this.checkWorkerStatus();
    const backgroundConfig = await this.checkBackgroundWorkerConfig();
    
    const mainApp = workerStatus.find(w => w.workerType === 'main');
    const workers = workerStatus.filter(w => w.workerType !== 'main' && w.isActive);
    
    const recentLogs = dockerLogMonitor.getRecentLogs('scrapalot-chat', 30);
    const recentProcessingActivity = recentLogs.some(log =>
      log.message.toLowerCase().includes('process') ||
      log.message.toLowerCase().includes('document') ||
      log.message.toLowerCase().includes('upload')
    );
    
    return {
      mainAppActive: mainApp?.isActive || false,
      workersActive: workers.length,
      backgroundWorkersEnabled: backgroundConfig.enabledInConfig,
      recentProcessingActivity
    };
  }
}

/**
 * Test helper for monitoring file upload processing
 */
export async function monitorFileUploadProcessing(
  page: Page,
  uploadAction: () => Promise<void>,
  timeout: number = 45000
): Promise<{
  processingDetected: boolean;
  rapidCompletion: boolean;
  stages: ProcessingDiagnostic[];
  duration: number;
}> {
  const startTime = Date.now();
  
  // Clear logs before upload
  dockerLogMonitor.clearLogs('scrapalot-chat');
  
  // Start monitoring
  const processingPromise = dockerLogMonitor.waitForLog(
    'scrapalot-chat',
    /process|chunk|embed|parse/i,
    timeout
  ).catch(() => null);
  
  // Perform upload
  await uploadAction();
  
  // Wait for processing or timeout
  await Promise.race([
    processingPromise,
    new Promise(resolve => setTimeout(resolve, timeout))
  ]);
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  // Analyze results
  const stages = await WorkerDiagnostics.analyzeProcessingPipeline(duration + 5000);
  const processingDetected = stages.some(s => s.detected);
  const rapidCompletion = duration < 5000 && !processingDetected;
  
  return {
    processingDetected,
    rapidCompletion,
    stages,
    duration
  };
}