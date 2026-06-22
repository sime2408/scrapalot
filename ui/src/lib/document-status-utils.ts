/**
 * Utility functions for document processing and graph status color mappings.
 * Centralizes the Tailwind class logic used by document status indicator dots.
 */

/**
 * Returns the Tailwind CSS class for a document processing status indicator dot.
 */
export function getProcessingStatusColor(status: string): string {
  switch (status) {
    case 'failed':
      return 'bg-red-400';
    case 'processing':
      return 'bg-orange-400 animate-pulse';
    case 'pending':
      return 'bg-yellow-400';
    default:
      return 'bg-green-400';
  }
}

/**
 * Returns the Tailwind CSS class for a document graph status indicator dot.
 */
export function getGraphStatusColor(status: string | null | undefined): string {
  switch (status) {
    case 'completed':
      return 'bg-green-400';
    case 'entity_running':
      return 'bg-orange-400 animate-pulse';
    case 'hierarchy_done':
      return 'bg-yellow-400';
    case 'failed':
      return 'bg-red-400';
    default:
      return 'bg-zinc-500';
  }
}
