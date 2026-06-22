/**
 * Connector types and interfaces
 */

export enum ConnectorStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  COMING_SOON = 'coming_soon',
  BETA = 'beta',
}

export enum ConnectorCategory {
  CLOUD_STORAGE = 'cloud_storage',
  ACADEMIC = 'academic',
  PRODUCTIVITY = 'productivity',
}

/**
 * Base connector interface
 */
export interface Connector {
  id: string;
  name: string;
  description: string;
  icon: string; // Path to SVG icon
  status: ConnectorStatus;
  category: ConnectorCategory;
  requiresAuth: boolean;
  supportedFormats?: string[];
  features?: string[];
  // API connector fields
  source?: string;
  enabled?: boolean;
  documents_synced?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Connector configuration
 * Used for storing user-specific connector settings
 */
export interface ConnectorConfig {
  connectorId: string;
  enabled: boolean;
  credentials?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  lastSync?: string;
}

/**
 * Connector action callback type
 */
export type ConnectorAction = (connector: Connector) => void;
