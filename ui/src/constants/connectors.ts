import { Connector, ConnectorStatus, ConnectorCategory } from '@/types/connectors';

/**
 * Available connectors for the knowledge stack
 * This list is extensible - new connectors can be added by:
 * 1. Adding the connector definition here
 * 2. Implementing the backend connector following the plug-and-play pattern
 * 3. Adding the icon SVG to public/connectors/
 */
export const AVAILABLE_CONNECTORS: Connector[] = [
  // ===== CLOUD STORAGE =====
  {
    id: 'google_drive',
    name: 'Google Drive',
    description: 'Sync documents, presentations, and spreadsheets from Google Drive',
    icon: '/connectors/google-drive.svg',
    status: ConnectorStatus.ACTIVE,
    category: ConnectorCategory.CLOUD_STORAGE,
    requiresAuth: true,
    supportedFormats: ['docs', 'sheets', 'slides', 'pdf'],
    features: ['Real-time sync', 'Folder monitoring', 'Shared drive support'],
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    description: 'Connect to Dropbox for seamless file synchronization',
    icon: '/connectors/dropbox.svg',
    status: ConnectorStatus.ACTIVE,
    category: ConnectorCategory.CLOUD_STORAGE,
    requiresAuth: true,
    supportedFormats: ['pdf', 'docs', 'txt', 'md'],
    features: ['Auto-sync', 'Selective folder sync', 'Version history'],
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    description: 'Sync files from Microsoft OneDrive and OneDrive for Business',
    icon: '/connectors/onedrive.svg',
    status: ConnectorStatus.ACTIVE,
    category: ConnectorCategory.CLOUD_STORAGE,
    requiresAuth: true,
    supportedFormats: ['docs', 'xlsx', 'pptx', 'pdf'],
    features: ['Microsoft 365 integration', 'SharePoint support', 'Real-time sync'],
  },

  // ===== PRODUCTIVITY & COLLABORATION =====
  {
    id: 'notion',
    name: 'Notion',
    description: 'Sync pages and databases from your Notion workspace',
    icon: '/connectors/notion.svg',
    status: ConnectorStatus.ACTIVE,
    category: ConnectorCategory.PRODUCTIVITY,
    requiresAuth: true,
    supportedFormats: ['markdown', 'databases', 'pages'],
    features: ['Page sync', 'Database queries', 'Block-level import'],
  },
  {
    id: 'confluence',
    name: 'Confluence',
    description: 'Import documentation and wiki pages from Atlassian Confluence',
    icon: '/connectors/confluence.svg',
    status: ConnectorStatus.ACTIVE,
    category: ConnectorCategory.PRODUCTIVITY,
    requiresAuth: true,
    supportedFormats: ['wiki', 'pages', 'attachments'],
    features: ['Space sync', 'Page hierarchy', 'Attachment import'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Access messages, threads, and files from Slack channels',
    icon: '/connectors/slack.svg',
    status: ConnectorStatus.ACTIVE,
    category: ConnectorCategory.PRODUCTIVITY,
    requiresAuth: true,
    supportedFormats: ['messages', 'threads', 'files'],
    features: ['Channel sync', 'Thread preservation', 'Message cleaning'],
  },

  // ===== NOTE-TAKING =====
  {
    id: 'onenote',
    name: 'OneNote',
    description: 'Sync notebooks and sections from Microsoft OneNote',
    icon: '/connectors/onenote.svg',
    status: ConnectorStatus.COMING_SOON,
    category: ConnectorCategory.PRODUCTIVITY,
    requiresAuth: true,
    supportedFormats: ['notes', 'notebooks', 'sections'],
    features: ['Notebook sync', 'Section hierarchy', 'Drawing import'],
  },

  // ===== ACADEMIC / RESEARCH =====
  {
    id: 'zotero',
    name: 'Zotero',
    description: 'Sync your personal research library — papers, annotations, notes, and PDFs',
    icon: '/connectors/zotero.svg',
    status: ConnectorStatus.ACTIVE,
    category: ConnectorCategory.ACADEMIC,
    requiresAuth: true,
    supportedFormats: ['pdf', 'papers', 'annotations', 'notes'],
    features: ['Library sync', 'PDF full-text', 'Highlights & annotations', 'Collection mapping'],
  },

  // ===== OTHER =====
  {
    id: 'youtube',
    name: 'YouTube',
    description: 'Import video transcripts and metadata from YouTube',
    icon: '/connectors/youtube.svg',
    status: ConnectorStatus.COMING_SOON,
    category: ConnectorCategory.PRODUCTIVITY,
    requiresAuth: true,
    supportedFormats: ['transcripts', 'captions', 'metadata'],
    features: ['Transcript extraction', 'Video metadata', 'Playlist support'],
  },
  // MCP integrations are NOT a workspace data connector — they are per-user agent
  // tool servers managed in Settings → Integrations. Intentionally not listed here.
];

/**
 * Get connectors by category
 */
export const getConnectorsByCategory = (category: ConnectorCategory): Connector[] => {
  return AVAILABLE_CONNECTORS.filter(c => c.category === category);
};

/**
 * Get connector by ID
 */
export const getConnectorById = (id: string): Connector | undefined => {
  return AVAILABLE_CONNECTORS.find(c => c.id === id);
};
