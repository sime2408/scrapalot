// Types related to file attachments, uploads, and document management

// Enum for document processing status
export enum ProcessingStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  // Upload classifier (backend) decided this file is heavy (>20 MB or
  // PDF with no text layer → needs Docling OCR). Processing is skipped
  // at upload time until the user explicitly confirms via the banner
  // in the knowledge library.
  DEFERRED = 'deferred',
}

// Enum for job status
export enum JobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

// View mode types for document display (similar to Windows 11 File Explorer)
export type ViewMode = 'list' | 'details' | 'thumbnails';

// Sorting types for document list
export type SortField = 'name' | 'date' | 'size' | 'type' | 'status';
export type SortDirection = 'asc' | 'desc';

// Thumbnail information returned from the API
export interface ThumbnailInfo {
  has_thumbnail: boolean;
  has_custom: boolean;
  sizes?: string[];
  url_large?: string; // Only large size is supported
}

export type AttachmentType = 'document' | 'image' | 'youtube';

export interface ChatAttachment {
  type: AttachmentType;
  filename: string;
  content: string;      // extracted text, base64, or YouTube URL
  mimeType: string;
}

export interface PopoverFileAttachmentProps {
  onClose: () => void;
  disableBlur?: boolean;
  fillHeight?: boolean;
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
}

export interface KnowledgeFileUploaderProps {
  collectionId: string;
  onUploadComplete?: () => void;
  onUploadStatusChange?: (
    uploading: boolean,
    isActuallyUploading?: boolean
  ) => void;
  className?: string;
  existingDocuments?: ExistingDocument[]; // List of documents already uploaded
  isLoading?: boolean; // Whether documents are loading
  onDeleteDocument?: (documentId: string) => Promise<void>; // Function to delete a document
  hasMore?: boolean; // Whether there are more documents to load
  onLoadMore?: () => void; // Function to load more documents
  isLoadingMore?: boolean; // Whether more documents are being loaded
  onDocumentClick?: (documentId: string) => void; // Function to handle document click
  ongoingJobs?: {
    jobId: string;
    documentId: string;
    filename: string;
    progress?: number;
    status?: string;
  }[]; // Jobs identified as ongoing on load (from /jobs/active API)
  ongoingJobsLoaded?: boolean; // Whether ongoing jobs have been loaded (prevents race condition)
  onSelectionChange?: (selectedIds: string[]) => void; // Called when pending doc selection changes
  readOnly?: boolean; // When true, hide upload/delete actions (viewer role)
}

// Define the ref type interface
export interface KnowledgeFileUploaderRef {
  uploadFiles: () => Promise<void>;
  abortUpload: () => void;
  refreshUploads: () => void;
  hasUnprocessedFiles: () => boolean; // Method to check if there are unprocessed files
  focusUploadButton: () => void; // Method to focus the upload button
  getSelectedDocumentIds: () => string[]; // Returns currently selected pending document IDs
  clearSelection: () => void; // Resets selection state (called after Compose)
}

// Interface for existing document
export interface ExistingDocument {
  id: string;
  filename: string;
  file_path: string;
  title?: string; // Document title (for books, articles, etc.)
  doc_metadata?: Record<string, unknown>;
  file_metadata?: {
    cover_url?: string;
    book_source?: string;
    book_id?: string;
    author?: string;
    year?: string;
    downloaded_at?: string;
  };
  collection_id: string;
  created_at: string;
  updated_at?: string;
  processing_status?: ProcessingStatus; // Document processing status
  processing_error?: string; // Human-readable error reason when processing_status is 'failed'
  job_status?: JobStatus; // Job status from jobs table
  job_progress?: number; // Job progress percentage
  job_message?: string; // Job status message
  job_errors?: string; // Job error information
  job_id?: string; // Job ID for tracking
  // Additional fields for view modes
  file_size?: number; // File size in bytes
  file_type?: string; // MIME type
  thumbnail?: ThumbnailInfo; // Thumbnail information
  file_stored?: boolean; // false = memory-only doc (embeddings exist, physical file discarded)
  graph_status?: 'pending' | 'hierarchy_done' | 'entity_running' | 'completed' | 'failed' | null;
  has_summary?: boolean;
  // Populated by the backend upload classifier when a document is
  // deferred (processing_status === 'deferred'). The reason code is
  // machine-readable ('scanned_pdf_no_text_layer', 'file_size_over_20mb')
  // and drives the confirmation banner + status badge.
  processing_stats?: {
    deferral_reason?: string;
    file_size_bytes?: number;
    deferred_at?: string;
  };
}

// Interface for upload progress tracking
export interface FileUploadProgress {
  progress: number;
  message: string;
  isComplete?: boolean;
}

export interface KnowledgeStacksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCollectionChange?: (newCollectionId?: string) => void; // Called when a collection is created/updated, optionally with the new collection ID for auto-selection
  defaultTab?: 'upload' | 'library' | 'connectors'; // Tab to activate when opened (e.g. 'library' for share deep-links). Defaults to 'upload'.
}
