import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface DockerLogEntry {
  timestamp: Date;
  level: string;
  message: string;
  container: string;
  raw: string;
}

export class DockerLogMonitor extends EventEmitter {
  private processes: Map<string, ChildProcess> = new Map();
  private logs: Map<string, DockerLogEntry[]> = new Map();
  private isMonitoring: boolean = false;

  constructor() {
    super();
  }

  /**
   * Start monitoring Docker logs for specified containers
   * @param containers Array of container names to monitor
   */
  async startMonitoring(containers: string[] = ['scrapalot-chat']) {
    if (this.isMonitoring) {
      throw new Error('Already monitoring Docker logs');
    }

    this.isMonitoring = true;
    
    for (const container of containers) {
      await this.monitorContainer(container);
    }

    console.log(`🐳 Started monitoring Docker logs for: ${containers.join(', ')}`);
  }

  /**
   * Monitor logs for a specific container
   */
  private async monitorContainer(containerName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Follow logs with timestamps
      const process = spawn('docker', [
        'logs',
        '--follow',
        '--timestamps',
        containerName
      ]);

      this.processes.set(containerName, process);
      this.logs.set(containerName, []);

      process.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const logEntry = this.parseLogLine(line, containerName);
          if (logEntry) {
            this.logs.get(containerName)!.push(logEntry);
            this.emit('log', logEntry);
            this.emit(`log:${containerName}`, logEntry);
          }
        }
      });

      process.stderr.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const logEntry = this.parseLogLine(line, containerName, 'stderr');
          if (logEntry) {
            this.logs.get(containerName)!.push(logEntry);
            this.emit('log', logEntry);
            this.emit(`log:${containerName}`, logEntry);
          }
        }
      });

      process.on('error', (error) => {
        console.error(`Error monitoring ${containerName}:`, error);
        reject(error);
      });

      process.on('spawn', () => {
        console.log(`📝 Started monitoring logs for container: ${containerName}`);
        resolve();
      });
    });
  }

  /**
   * Parse Docker log line into structured format
   */
  private parseLogLine(line: string, containerName: string, source: 'stdout' | 'stderr' = 'stdout'): DockerLogEntry | null {
    // Docker log format: 2024-12-09T19:30:45.123456789Z actual log message
    const timestampRegex = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/;
    const match = line.match(timestampRegex);
    
    if (!match) {
      // Fallback for logs without timestamp
      return {
        timestamp: new Date(),
        level: source === 'stderr' ? 'ERROR' : 'INFO',
        message: line,
        container: containerName,
        raw: line
      };
    }

    const [, timestampStr, message] = match;
    const timestamp = new Date(timestampStr);
    
    // Try to extract log level from message
    const level = this.extractLogLevel(message);

    return {
      timestamp,
      level,
      message: message.trim(),
      container: containerName,
      raw: line
    };
  }

  /**
   * Extract log level from message content
   */
  private extractLogLevel(message: string): string {
    const levelRegex = /\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|TRACE)\b/i;
    const match = message.match(levelRegex);
    return match ? match[1].toUpperCase() : 'INFO';
  }

  /**
   * Get logs for a specific container
   */
  getLogs(containerName: string): DockerLogEntry[] {
    return this.logs.get(containerName) || [];
  }

  /**
   * Get recent logs (last N entries)
   */
  getRecentLogs(containerName: string, count: number = 50): DockerLogEntry[] {
    const logs = this.getLogs(containerName);
    return logs.slice(-count);
  }

  /**
   * Search logs for specific patterns
   */
  searchLogs(containerName: string, pattern: string | RegExp, since?: Date): DockerLogEntry[] {
    const logs = this.getLogs(containerName);
    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    
    return logs.filter(log => {
      const matchesPattern = regex.test(log.message) || regex.test(log.raw);
      const matchesTime = !since || log.timestamp >= since;
      return matchesPattern && matchesTime;
    });
  }

  /**
   * Wait for a specific log pattern to appear
   */
  async waitForLog(
    containerName: string, 
    pattern: string | RegExp, 
    timeout: number = 30000
  ): Promise<DockerLogEntry> {
    return new Promise((resolve, reject) => {
      const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
      const timeoutId = setTimeout(() => {
        this.off(`log:${containerName}`, logHandler);
        reject(new Error(`Timeout waiting for log pattern: ${pattern}`));
      }, timeout);

      const logHandler = (logEntry: DockerLogEntry) => {
        if (regex.test(logEntry.message) || regex.test(logEntry.raw)) {
          clearTimeout(timeoutId);
          this.off(`log:${containerName}`, logHandler);
          resolve(logEntry);
        }
      };

      this.on(`log:${containerName}`, logHandler);
    });
  }

  /**
   * Clear stored logs for a container
   */
  clearLogs(containerName: string) {
    this.logs.set(containerName, []);
  }

  /**
   * Stop monitoring all containers
   */
  async stopMonitoring() {
    if (!this.isMonitoring) {
      return;
    }

    for (const [containerName, process] of this.processes) {
      process.kill('SIGTERM');
      console.log(`🛑 Stopped monitoring logs for container: ${containerName}`);
    }

    this.processes.clear();
    this.isMonitoring = false;
    console.log('🔚 Docker log monitoring stopped');
  }

  /**
   * Get monitoring status
   */
  isActive(): boolean {
    return this.isMonitoring;
  }

  /**
   * Get list of monitored containers
   */
  getMonitoredContainers(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Print recent logs to console (useful for debugging)
   */
  printRecentLogs(containerName: string, count: number = 10) {
    const logs = this.getRecentLogs(containerName, count);
    console.log(`\n📋 Recent logs for ${containerName} (last ${count}):`);
    console.log('=' .repeat(80));
    
    for (const log of logs) {
      const timeStr = log.timestamp.toISOString();
      console.log(`[${timeStr}] ${log.level}: ${log.message}`);
    }
    
    console.log('=' .repeat(80));
  }
}

/**
 * Global singleton instance for easy usage across tests
 */
export const dockerLogMonitor = new DockerLogMonitor();