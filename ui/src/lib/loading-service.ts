/**
 * Centralized Loading Service
 * Manages all loading states across the application with HTTP request tracking
 * 
 * @fileoverview Provides a singleton service to track loading operations globally,
 * eliminating duplicate loading indicators and providing a consistent UX.
 */
import { useState, useEffect } from 'react';

/** Supported loading operation types */
type LoadingOperationType = 'http' | 'stream' | 'upload' | 'custom';

/** Callback function type for loading state subscribers */
type LoadingSubscriber = (isLoading: boolean, count: number) => void;

/** Configuration for a loading operation */
interface LoadingState {
  /** Unique identifier for the loading operation */
  readonly id: string;
  /** Type of operation being tracked */
  readonly type: LoadingOperationType;
  /** Optional human-readable description */
  readonly description?: string;
  /** Timestamp when the operation started */
  readonly startTime: number;
}

/** Performance metrics for loading operations */
interface LoadingMetrics {
  /** Total operations started */
  totalOperations: number;
  /** Currently active operations */
  activeOperations: number;
  /** Average duration of completed operations (ms) */
  averageDuration: number;
  /** Longest operation duration (ms) */
  longestDuration: number;
  /** Operations by type */
  operationsByType: Record<LoadingOperationType, number>;
}

/**
 * Centralized loading service that tracks all loading operations globally
 * Uses the observer pattern to notify subscribers of state changes
 */
class LoadingService {
  private readonly activeLoaders = new Map<string, LoadingState>();
  private readonly subscribers = new Set<LoadingSubscriber>();
  
  /** Counter for generating unique HTTP request IDs */
  private httpRequestCounter = 0;
  
  /** Performance tracking */
  private metrics = {
    totalOperations: 0,
    completedOperations: 0,
    totalDuration: 0,
    longestDuration: 0,
    operationsByType: {
      http: 0,
      stream: 0,
      upload: 0,
      custom: 0
    } as Record<LoadingOperationType, number>
  };
  
  /**
   * Subscribe to loading state changes
   * 
   * @param callback Function to call when loading state changes
   * @returns Unsubscribe function
   * @example
   * const unsubscribe = loadingService.subscribe((isLoading, count) => {
   *   console.log(`Loading: ${isLoading}, Active: ${count}`);
   * });
   * 
   * // Later...
   * unsubscribe();
   */
  subscribe(callback: LoadingSubscriber): () => void {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    this.subscribers.add(callback);
    
    // Immediately notify with current state
    try {
      callback(this.isLoading(), this.activeLoaders.size);
    } catch (error) {
      console.error('Error in initial loading service callback:', error);
    }
    
    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }
  
  /**
   * Check if any loading is active
   * @returns True if any operations are currently loading
   */
  isLoading(): boolean {
    return this.activeLoaders.size > 0;
  }
  
  /**
   * Start a loading operation
   * 
   * @param id Unique identifier for the operation
   * @param type Type of loading operation
   * @param description Optional human-readable description
   * @returns The same ID passed in for convenience
   * @throws Error if ID is empty or already exists
   */
  startLoading(
    id: string, 
    type: LoadingOperationType = 'custom', 
    description?: string
  ): string {
    if (!id || typeof id !== 'string') {
      throw new Error('Loading ID must be a non-empty string');
    }
    
    if (this.activeLoaders.has(id)) {
      console.warn(`Loading operation with ID "${id}" already exists, skipping`);
      return id;
    }
    
    const loadingState: LoadingState = {
      id,
      type,
      description,
      startTime: Date.now()
    };
    
    this.activeLoaders.set(id, loadingState);
    
    // Track metrics
    this.metrics.totalOperations++;
    this.metrics.operationsByType[type]++;
    
    this.notifySubscribers();
    
    return id;
  }
  
  /**
   * Stop a loading operation
   * 
   * @param id The ID of the operation to stop
   * @returns True if the operation existed and was stopped, false otherwise
   */
  stopLoading(id: string): boolean {
    if (!id || typeof id !== 'string') {
      console.warn('Invalid loading ID provided to stopLoading:', id);
      return false;
    }
    
    const loadingState = this.activeLoaders.get(id);
    const existed = this.activeLoaders.delete(id);
    
    if (existed && loadingState) {
      // Track performance metrics
      const duration = Date.now() - loadingState.startTime;
      this.metrics.completedOperations++;
      this.metrics.totalDuration += duration;
      this.metrics.longestDuration = Math.max(this.metrics.longestDuration, duration);
      
      this.notifySubscribers();
    } else {
      // Only warn in development to avoid log spam
      if (process.env.NODE_ENV === 'development') {
        console.debug(`Attempted to stop non-existent loading operation: ${id}`);
      }
    }
    
    return existed;
  }
  
  /**
   * Start HTTP request loading (auto-generates ID)
   * 
   * @param url The URL being requested (for debugging)
   * @returns Unique ID for the HTTP request
   */
  startHttpRequest(url: string): string {
    this.httpRequestCounter++;
    const id = `http-${this.httpRequestCounter}-${Date.now()}`;
    const cleanUrl = url ? String(url).substring(0, 100) : 'unknown'; // Limit length
    return this.startLoading(id, 'http', `HTTP: ${cleanUrl}`);
  }
  
  /**
   * Stop HTTP request loading
   * 
   * @param id The ID returned by startHttpRequest
   * @returns True if the operation existed and was stopped
   */
  stopHttpRequest(id: string): boolean {
    return this.stopLoading(id);
  }
  
  /**
   * Start streaming operation
   * 
   * @param sessionId The session ID for the streaming operation
   * @returns Unique ID for the streaming operation
   */
  startStreaming(sessionId: string): string {
    if (!sessionId) {
      throw new Error('Session ID is required for streaming operations');
    }
    
    const cleanSessionId = String(sessionId).substring(0, 50); // Limit length
    const id = `stream-${cleanSessionId}-${Date.now()}`;
    return this.startLoading(id, 'stream', `Streaming session: ${cleanSessionId}`);
  }
  
  /**
   * Stop streaming operation
   * 
   * @param id The ID returned by startStreaming
   * @returns True if the operation existed and was stopped
   */
  stopStreaming(id: string): boolean {
    return this.stopLoading(id);
  }
  
  /**
   * Start file upload operation
   * 
   * @param fileName Name of the file being uploaded
   * @returns Unique ID for the upload operation
   */
  startUpload(fileName: string): string {
    if (!fileName) {
      throw new Error('File name is required for upload operations');
    }
    
    const cleanFileName = String(fileName).substring(0, 50); // Limit length
    const id = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    return this.startLoading(id, 'upload', `Uploading: ${cleanFileName}`);
  }
  
  /**
   * Stop file upload operation
   * 
   * @param id The ID returned by startUpload
   * @returns True if the operation existed and was stopped
   */
  stopUpload(id: string): boolean {
    return this.stopLoading(id);
  }
  
  /**
   * Clear all loading states (emergency reset)
   * Use with caution - this will stop tracking ALL operations
   * 
   * @param reason Optional reason for clearing (for debugging)
   */
  clearAll(reason = 'Manual clear'): void {
    const count = this.activeLoaders.size;
    
    if (count > 0) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`Clearing ${count} loading operations. Reason: ${reason}`);
      }
      
      this.activeLoaders.clear();
      this.notifySubscribers();
    }
  }
  
  /**
   * Get debug information about all active operations
   * 
   * @returns Array of all active loading states
   */
  getDebugInfo(): readonly LoadingState[] {
    return Object.freeze(Array.from(this.activeLoaders.values()));
  }
  
  /**
   * Get performance metrics for loading operations
   * 
   * @returns Performance metrics object
   */
  getMetrics(): LoadingMetrics {
    const averageDuration = this.metrics.completedOperations > 0 
      ? this.metrics.totalDuration / this.metrics.completedOperations 
      : 0;
      
    return {
      totalOperations: this.metrics.totalOperations,
      activeOperations: this.activeLoaders.size,
      averageDuration: Math.round(averageDuration * 100) / 100, // Round to 2 decimal places
      longestDuration: this.metrics.longestDuration,
      operationsByType: { ...this.metrics.operationsByType }
    };
  }
  
  /**
   * Reset performance metrics (useful for testing or analytics)
   */
  resetMetrics(): void {
    this.metrics = {
      totalOperations: 0,
      completedOperations: 0,
      totalDuration: 0,
      longestDuration: 0,
      operationsByType: {
        http: 0,
        stream: 0,
        upload: 0,
        custom: 0
      }
    };
  }
  
  private notifySubscribers(): void {
    const isLoading = this.isLoading();
    const count = this.activeLoaders.size;
    
    this.subscribers.forEach(callback => {
      try {
        callback(isLoading, count);
      } catch (error) {
        console.error('Error in loading service subscriber:', error);
      }
    });
  }
}

// Export singleton instance
export const loadingService = new LoadingService();

// React hook for using the loading service

/**
 * Hook to access the centralized loading service
 * 
 * @returns Object containing loading state and service methods
 * @example
 * ```tsx
 * const { isLoading, activeCount, startLoading, stopLoading } = useLoadingService();
 * 
 * const handleAction = async () => {
 *   const id = startLoading('my-operation', 'custom', 'Processing data');
 *   try {
 *     await performAction();
 *   } finally {
 *     stopLoading(id);
 *   }
 * };
 * ```
 */
export function useLoadingService() {
  const [isLoading, setIsLoading] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  
  useEffect(() => {
    return loadingService.subscribe((loading, count) => {
      setIsLoading(loading);
      setActiveCount(count);
    });
  }, []);
  
  // Stable references to prevent unnecessary re-renders
  return {
    /** Whether any loading operations are active */
    isLoading,
    /** Number of active loading operations */
    activeCount,
    /** Start a custom loading operation */
    startLoading: loadingService.startLoading.bind(loadingService),
    /** Stop a loading operation */
    stopLoading: loadingService.stopLoading.bind(loadingService),
    /** Start HTTP request tracking */
    startHttpRequest: loadingService.startHttpRequest.bind(loadingService),
    /** Stop HTTP request tracking */
    stopHttpRequest: loadingService.stopHttpRequest.bind(loadingService),
    /** Start streaming operation tracking */
    startStreaming: loadingService.startStreaming.bind(loadingService),
    /** Stop streaming operation tracking */
    stopStreaming: loadingService.stopStreaming.bind(loadingService),
    /** Start file upload tracking */
    startUpload: loadingService.startUpload.bind(loadingService),
    /** Stop file upload tracking */
    stopUpload: loadingService.stopUpload.bind(loadingService),
    /** Clear all loading operations (emergency reset) */
    clearAll: loadingService.clearAll.bind(loadingService),
    /** Get debug information about active operations */
    getDebugInfo: loadingService.getDebugInfo.bind(loadingService),
    /** Get performance metrics */
    getMetrics: loadingService.getMetrics.bind(loadingService),
    /** Reset performance metrics */
    resetMetrics: loadingService.resetMetrics.bind(loadingService)
  } as const;
}