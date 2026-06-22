/**
 * Admin API Client
 * API functions for admin operations
 */

export interface AutofixRequest {
  browser_errors: string;
  error_context?: string;
}

export interface AutofixResponse {
  success: boolean;
  branch_name?: string;
  message: string;
}

export interface DebugLogsResponse {
  success: boolean;
  backend_logs: string;
  frontend_logs?: string;
  message: string;
}

