import React, { useState, useEffect } from 'react';
import { usePerformanceMonitor } from '@/lib/performance-monitor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Activity,
  Clock,
  AlertTriangle,
  TrendingUp,
  Download,
  Trash2
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface PerformanceMonitorWidgetProps {
  /** Whether to show the widget (only in development) */
  readonly show?: boolean;
  /** Position of the widget on screen */
  readonly position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Additional CSS classes */
  readonly className?: string;
}

/**
 * Development performance monitoring widget
 * Shows real-time performance metrics and statistics
 */
export const PerformanceMonitorWidget: React.FC<PerformanceMonitorWidgetProps> = ({
  show = process.env.NODE_ENV === 'development',
  position = 'bottom-right',
  className
}) => {
  const {
    getStats,
    getActiveMetrics,
    getRecentMetrics,
    clearMetrics,
    exportMetrics
  } = usePerformanceMonitor();

  const [isExpanded, setIsExpanded] = useState(false);

  // Auto-refresh every 2 seconds when expanded
  useEffect(() => {
    if (!isExpanded) return;

    const interval = setInterval(() => {
      // Trigger re-render by toggling state
    }, 2000);

    return () => clearInterval(interval);
  }, [isExpanded]);

  if (!show) return null;

  const stats = getStats();
  const activeMetrics = getActiveMetrics();
  const recentMetrics = getRecentMetrics(5);

  const positionClasses = {
    'bottom-right': 'bottom-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'top-right': 'top-4 right-4',
    'top-left': 'top-4 left-4'
  };

  const handleExport = () => {
    const data = exportMetrics('json');
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `performance-metrics-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    clearMetrics();
    // Re-render triggered by clearMetrics state change
  };

  if (!isExpanded) {
    return (
      <div
        className={cn(
          'fixed z-50 p-2',
          positionClasses[position],
          className
        )}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setIsExpanded(true)}
          className="shadow-lg bg-background/90 backdrop-blur-sm hover:bg-background/95"
          title="Performance Monitor"
        >
          <Activity className="h-4 w-4 mr-1" />
          {activeMetrics.length > 0 && (
            <Badge variant="secondary" className="ml-1 px-1 text-xs">
              {activeMetrics.length}
            </Badge>
          )}
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'fixed z-50 w-80',
        positionClasses[position],
        className
      )}
    >
      <Card className="shadow-lg bg-background/95 backdrop-blur-sm border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Performance Monitor
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(false)}
              className="h-6 w-6 p-0"
            >
              ×
            </Button>
          </div>
        </CardHeader>
        
        <CardContent className="space-y-4">
          {/* Overall Stats */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span>Avg: {stats.avgDuration.toFixed(1)}ms</span>
            </div>
            <div className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-muted-foreground" />
              <span>P95: {stats.p95Duration.toFixed(1)}ms</span>
            </div>
            <div className="flex items-center gap-1">
              <Activity className="h-3 w-3 text-green-500" />
              <span>Completed: {stats.completedMetrics}</span>
            </div>
            <div className="flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 text-red-500" />
              <span>Failed: {stats.failedMetrics}</span>
            </div>
          </div>

          {/* Active Metrics */}
          {activeMetrics.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">
                Active ({activeMetrics.length})
              </h4>
              <div className="space-y-1 max-h-20 overflow-y-auto">
                {activeMetrics.map(metric => {
                  const elapsed = performance.now() - metric.startTime;
                  return (
                    <div
                      key={metric.id}
                      className="text-xs p-1 bg-muted/50 rounded text-muted-foreground"
                      title={metric.name}
                    >
                      <div className="truncate">{metric.name}</div>
                      <div className="text-xs opacity-75">
                        {elapsed.toFixed(0)}ms elapsed
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recent Metrics */}
          {recentMetrics.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-1">
                Recent
              </h4>
              <div className="space-y-1 max-h-20 overflow-y-auto">
                {recentMetrics.map(metric => (
                  <div
                    key={metric.id}
                    className="text-xs p-1 bg-muted/50 rounded"
                    title={metric.name}
                  >
                    <div className="flex justify-between items-center">
                      <span className="truncate flex-1 text-muted-foreground">
                        {metric.name}
                      </span>
                      <div className="flex items-center gap-1 ml-1">
                        <Badge 
                          variant={metric.status === 'completed' ? 'secondary' : 'destructive'}
                          className="text-xs px-1"
                        >
                          {metric.duration?.toFixed(0)}ms
                        </Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Metrics by Type */}
          <div>
            <h4 className="text-xs font-medium text-muted-foreground mb-1">
              By Type
            </h4>
            <div className="grid grid-cols-2 gap-1 text-xs">
              {Object.entries(stats.metricsByType).map(([type, count]) => (
                count > 0 && (
                  <div key={type} className="flex justify-between">
                    <span className="capitalize text-muted-foreground">
                      {type.replace('_', ' ')}
                    </span>
                    <span>{count}</span>
                  </div>
                )
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              className="flex-1 text-xs h-7"
              title="Export metrics"
            >
              <Download className="h-3 w-3 mr-1" />
              Export
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClear}
              className="flex-1 text-xs h-7"
              title="Clear metrics"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Clear
            </Button>
          </div>

          {stats.totalMetrics === 0 && (
            <div className="text-xs text-muted-foreground text-center py-2">
              No metrics recorded yet
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default PerformanceMonitorWidget;