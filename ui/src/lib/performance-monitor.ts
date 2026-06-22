/**
 * Performance Monitoring Service
 * Provides comprehensive performance tracking and analysis capabilities
 */

/** Performance metric types */
export type MetricType = 
  | 'api_request'
  | 'page_load'
  | 'component_render'
  | 'user_interaction'
  | 'stream_operation'
  | 'custom';

/** Performance metric entry */
export interface PerformanceMetric {
  readonly id: string;
  readonly type: MetricType;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly duration?: number;
  readonly metadata?: Record<string, unknown>;
  readonly tags?: readonly string[];
  readonly status: 'pending' | 'completed' | 'failed';
}

/** Aggregated performance statistics */
export interface PerformanceStats {
  readonly totalMetrics: number;
  readonly completedMetrics: number;
  readonly failedMetrics: number;
  readonly avgDuration: number;
  readonly minDuration: number;
  readonly maxDuration: number;
  readonly metricsByType: Record<MetricType, number>;
  readonly p95Duration: number;
  readonly p99Duration: number;
}

/** Performance threshold configuration */
interface PerformanceThresholds {
  readonly api_request: number;
  readonly page_load: number;
  readonly component_render: number;
  readonly user_interaction: number;
  readonly stream_operation: number;
  readonly custom: number;
}

/**
 * Centralized performance monitoring service
 * Tracks metrics, provides analytics, and alerts on performance issues
 */
class PerformanceMonitor {
  private readonly metrics = new Map<string, PerformanceMetric>();
  private readonly completedMetrics: PerformanceMetric[] = [];
  private metricCounter = 0;
  
  /** Performance thresholds in milliseconds */
  private readonly thresholds: PerformanceThresholds = {
    api_request: 5000,      // 5 seconds for API requests
    page_load: 3000,        // 3 seconds for page loads
    component_render: 100,   // 100ms for component renders
    user_interaction: 200,   // 200ms for user interactions
    stream_operation: 30000, // 30 seconds for streaming
    custom: 1000            // 1 second default for custom metrics
  };

  /** Maximum number of completed metrics to retain in memory */
  private readonly maxRetainedMetrics = 1000;

  /**
   * Start tracking a performance metric
   * 
   * @param type Type of metric being tracked
   * @param name Descriptive name for the metric
   * @param metadata Optional metadata to associate with the metric
   * @param tags Optional tags for categorization
   * @returns Unique metric ID
   */
  startMetric(
    type: MetricType,
    name: string,
    metadata?: Record<string, unknown>,
    tags?: readonly string[]
  ): string {
    const id = `${type}_${++this.metricCounter}_${Date.now()}`;
    
    const metric: PerformanceMetric = {
      id,
      type,
      name,
      startTime: performance.now(),
      metadata,
      tags,
      status: 'pending'
    };

    this.metrics.set(id, metric);
    
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[Performance] Started metric: ${name} (${id})`);
    }

    return id;
  }

  /**
   * Complete a performance metric
   * 
   * @param id Metric ID returned by startMetric
   * @param status Completion status
   * @param additionalMetadata Additional metadata to merge
   * @returns True if metric was found and completed
   */
  completeMetric(
    id: string,
    status: 'completed' | 'failed' = 'completed',
    additionalMetadata?: Record<string, unknown>
  ): boolean {
    const metric = this.metrics.get(id);
    
    if (!metric) {
      console.warn(`[Performance] Attempted to complete non-existent metric: ${id}`);
      return false;
    }

    const endTime = performance.now();
    const duration = endTime - metric.startTime;

    const completedMetric: PerformanceMetric = {
      ...metric,
      endTime,
      duration,
      status,
      metadata: additionalMetadata 
        ? { ...metric.metadata, ...additionalMetadata }
        : metric.metadata
    };

    // Remove from active metrics
    this.metrics.delete(id);

    // Add to completed metrics with memory management
    this.completedMetrics.push(completedMetric);
    if (this.completedMetrics.length > this.maxRetainedMetrics) {
      this.completedMetrics.shift(); // Remove oldest metric
    }

    // Check for performance threshold violations
    this.checkThreshold(completedMetric);

    if (process.env.NODE_ENV === 'development') {
      console.debug(`[Performance] Completed metric: ${metric.name} (${duration.toFixed(2)}ms)`);
    }

    return true;
  }

  /**
   * Get current performance statistics
   * 
   * @param type Optional filter by metric type
   * @returns Aggregated performance statistics
   */
  getStats(type?: MetricType): PerformanceStats {
    const relevantMetrics = type 
      ? this.completedMetrics.filter(m => m.type === type)
      : this.completedMetrics;

    if (relevantMetrics.length === 0) {
      return {
        totalMetrics: 0,
        completedMetrics: 0,
        failedMetrics: 0,
        avgDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        metricsByType: {
          api_request: 0,
          page_load: 0,
          component_render: 0,
          user_interaction: 0,
          stream_operation: 0,
          custom: 0
        },
        p95Duration: 0,
        p99Duration: 0
      };
    }

    const durations = relevantMetrics
      .filter(m => typeof m.duration === 'number')
      .map(m => m.duration!)
      .sort((a, b) => a - b);

    const completedCount = relevantMetrics.filter(m => m.status === 'completed').length;
    const failedCount = relevantMetrics.filter(m => m.status === 'failed').length;

    const avgDuration = durations.length > 0 
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length 
      : 0;

    const p95Index = Math.floor(durations.length * 0.95);
    const p99Index = Math.floor(durations.length * 0.99);

    const metricsByType = this.completedMetrics.reduce((acc, metric) => {
      acc[metric.type] = (acc[metric.type] || 0) + 1;
      return acc;
    }, {} as Record<MetricType, number>);

    // Ensure all types are present
    Object.keys(this.thresholds).forEach(type => {
      if (!(type in metricsByType)) {
        metricsByType[type as MetricType] = 0;
      }
    });

    return {
      totalMetrics: relevantMetrics.length,
      completedMetrics: completedCount,
      failedMetrics: failedCount,
      avgDuration: Math.round(avgDuration * 100) / 100,
      minDuration: durations.length > 0 ? durations[0] : 0,
      maxDuration: durations.length > 0 ? durations[durations.length - 1] : 0,
      metricsByType: metricsByType as Record<MetricType, number>,
      p95Duration: durations.length > 0 ? durations[p95Index] || 0 : 0,
      p99Duration: durations.length > 0 ? durations[p99Index] || 0 : 0
    };
  }

  /**
   * Get active (pending) metrics
   * 
   * @returns Array of currently active metrics
   */
  getActiveMetrics(): readonly PerformanceMetric[] {
    return Object.freeze(Array.from(this.metrics.values()));
  }

  /**
   * Get recent completed metrics
   * 
   * @param limit Maximum number of metrics to return
   * @param type Optional filter by metric type
   * @returns Array of recent completed metrics
   */
  getRecentMetrics(limit = 10, type?: MetricType): readonly PerformanceMetric[] {
    let metrics = [...this.completedMetrics];
    
    if (type) {
      metrics = metrics.filter(m => m.type === type);
    }

    return Object.freeze(
      metrics
        .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
        .slice(0, limit)
    );
  }

  /**
   * Clear all completed metrics (useful for testing or memory management)
   */
  clearMetrics(): void {
    this.completedMetrics.length = 0;
    console.debug('[Performance] Cleared all completed metrics');
  }

  /**
   * Set performance threshold for a specific metric type
   * 
   * @param type Metric type
   * @param threshold Threshold in milliseconds
   */
  setThreshold(type: MetricType, threshold: number): void {
    if (threshold <= 0) {
      throw new Error('Threshold must be a positive number');
    }
    
    (this.thresholds as Record<MetricType, number>)[type] = threshold;
    
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[Performance] Updated threshold for ${type}: ${threshold}ms`);
    }
  }

  /**
   * Get current threshold for a metric type
   * 
   * @param type Metric type
   * @returns Threshold in milliseconds
   */
  getThreshold(type: MetricType): number {
    return this.thresholds[type];
  }

  /**
   * Check if a metric exceeds its performance threshold
   * 
   * @param metric The metric to check
   */
  private checkThreshold(metric: PerformanceMetric): void {
    if (!metric.duration) return;

    const threshold = this.thresholds[metric.type];
    
    if (metric.duration > threshold) {
      console.warn(
        `[Performance] Threshold violation: ${metric.name} took ${metric.duration.toFixed(2)}ms ` +
        `(threshold: ${threshold}ms, type: ${metric.type})`
      );

      // In development, provide additional debugging information
      if (process.env.NODE_ENV === 'development') {
        console.group('[Performance] Threshold Violation Details');
        console.log('Metric ID:', metric.id);
        console.log('Type:', metric.type);
        console.log('Name:', metric.name);
        console.log('Duration:', `${metric.duration.toFixed(2)}ms`);
        console.log('Threshold:', `${threshold}ms`);
        console.log('Excess:', `${(metric.duration - threshold).toFixed(2)}ms`);
        if (metric.metadata) {
          console.log('Metadata:', metric.metadata);
        }
        if (metric.tags) {
          console.log('Tags:', metric.tags);
        }
        console.groupEnd();
      }
    }
  }

  /**
   * Export metrics data for analysis
   * 
   * @param format Export format
   * @returns Formatted metrics data
   */
  exportMetrics(format: 'json' | 'csv' = 'json'): string {
    const data = this.completedMetrics.map(metric => ({
      id: metric.id,
      type: metric.type,
      name: metric.name,
      startTime: metric.startTime,
      endTime: metric.endTime,
      duration: metric.duration,
      status: metric.status,
      metadata: JSON.stringify(metric.metadata || {}),
      tags: (metric.tags || []).join(',')
    }));

    if (format === 'csv') {
      if (data.length === 0) return 'No metrics to export';

      const headers = Object.keys(data[0]).join(',');
      const rows = data.map(row => 
        Object.values(row).map(value => 
          typeof value === 'string' && value.includes(',') 
            ? `"${value}"` 
            : value
        ).join(',')
      );
      
      return [headers, ...rows].join('\n');
    }

    return JSON.stringify(data, null, 2);
  }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();

/**
 * React hook for performance monitoring
 * 
 * @returns Performance monitoring utilities
 */
export function usePerformanceMonitor() {
  const startMetric = (
    type: MetricType,
    name: string,
    metadata?: Record<string, unknown>,
    tags?: readonly string[]
  ) => performanceMonitor.startMetric(type, name, metadata, tags);

  const completeMetric = (
    id: string,
    status: 'completed' | 'failed' = 'completed',
    additionalMetadata?: Record<string, unknown>
  ) => performanceMonitor.completeMetric(id, status, additionalMetadata);

  return {
    /** Start tracking a performance metric */
    startMetric,
    /** Complete a performance metric */
    completeMetric,
    /** Get performance statistics */
    getStats: performanceMonitor.getStats.bind(performanceMonitor),
    /** Get active metrics */
    getActiveMetrics: performanceMonitor.getActiveMetrics.bind(performanceMonitor),
    /** Get recent metrics */
    getRecentMetrics: performanceMonitor.getRecentMetrics.bind(performanceMonitor),
    /** Clear all metrics */
    clearMetrics: performanceMonitor.clearMetrics.bind(performanceMonitor),
    /** Set performance threshold */
    setThreshold: performanceMonitor.setThreshold.bind(performanceMonitor),
    /** Get performance threshold */
    getThreshold: performanceMonitor.getThreshold.bind(performanceMonitor),
    /** Export metrics */
    exportMetrics: performanceMonitor.exportMetrics.bind(performanceMonitor)
  } as const;
}

