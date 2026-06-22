import React from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export interface DataContainerProps {
  loading: boolean;
  error?: string | null;
  /** Treated as empty when true — shows emptyMessage instead of children. */
  empty?: boolean;
  emptyMessage?: string;
  /** Custom skeleton shown while loading. Falls back to a centered spinner. */
  skeleton?: React.ReactNode;
  /** Custom error renderer. Falls back to an Alert. */
  errorRenderer?: (error: string) => React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * Standardizes loading / error / empty / data rendering.
 *
 * Note: React evaluates children before this component runs, so guards inside
 * children (e.g. `{data && <Foo data={data} />}`) are still required for type safety.
 *
 * Usage:
 *   <DataContainer loading={loading} error={error} empty={!items.length}
 *     emptyMessage="No documents found" skeleton={<SkeletonList />}>
 *     {items.map(item => <Row key={item.id} item={item} />)}
 *   </DataContainer>
 */
export function DataContainer({
  loading,
  error,
  empty = false,
  emptyMessage = 'No data',
  skeleton,
  errorRenderer,
  children,
  className,
}: DataContainerProps) {
  if (loading) {
    return skeleton ? (
      <>{skeleton}</>
    ) : (
      <div className={`flex items-center justify-center p-8 ${className ?? ''}`}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return errorRenderer ? (
      <>{errorRenderer(error)}</>
    ) : (
      <Alert variant="destructive" className={className}>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (empty) {
    return (
      <div className={`flex items-center justify-center p-8 text-sm text-muted-foreground ${className ?? ''}`}>
        {emptyMessage}
      </div>
    );
  }

  return <>{children}</>;
}
