/**
 * Document annotation types for PDF and EPUB viewers.
 *
 * Annotation types: highlight (1), note (2), underline (3)
 * Viewer types: "pdf" (percentage-based rects) or "epub" (CFI string)
 * Colors: 8-color Zotero-inspired palette
 */

export const ANNOTATION_TYPES = {
  HIGHLIGHT: 1 as const,
  NOTE: 2 as const,
  UNDERLINE: 3 as const,
  AREA_CAPTURE: 4 as const,
  STRIKETHROUGH: 5 as const,
};

export type AnnotationType = 1 | 2 | 3 | 4 | 5;

export type ViewerType = 'pdf' | 'epub';

/** 8-color annotation palette */
export const ANNOTATION_COLORS = [
  { hex: '#ffd400', name: 'Yellow', label: 'General (1.2x RAG boost)' },
  { hex: '#ff6666', name: 'Red', label: 'Important (1.5x RAG boost)' },
  { hex: '#5fb236', name: 'Green', label: 'Methodology (1.1x)' },
  { hex: '#2ea8e5', name: 'Blue', label: 'Definition (1.1x)' },
  { hex: '#a28ae5', name: 'Purple', label: 'Question' },
  { hex: '#e56eee', name: 'Magenta', label: 'Interesting' },
  { hex: '#f19837', name: 'Orange', label: 'Revisit' },
  { hex: '#aaaaaa', name: 'Gray', label: 'Low priority (0.8x)' },
] as const;

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]['hex'];

/** PDF position — percentage-based rects relative to page dimensions */
export interface PdfAnnotationPosition {
  type: 'pdf';
  page_index: number;
  rects: Array<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>;
}

/** EPUB position — Canonical Fragment Identifier */
export interface EpubAnnotationPosition {
  type: 'epub';
  cfi: string;
  section_index?: number;
}

export type AnnotationPosition = PdfAnnotationPosition | EpubAnnotationPosition;

/** Annotation response from API */
export interface Annotation {
  id: string;
  user_id: string;
  document_id: string;
  collection_id: string;
  session_id?: string | null;
  annotation_type: AnnotationType;
  selected_text?: string | null;
  comment?: string | null;
  color: string;
  page_label?: string | null;
  sort_index?: string | null;
  position_json: string;
  viewer_type: ViewerType;
  tag_ids?: string[] | null;
  is_external?: boolean;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

/** Parsed annotation with deserialized position */
export interface ParsedAnnotation extends Omit<Annotation, 'position_json'> {
  position: AnnotationPosition;
}

/** Create annotation request */
export interface CreateAnnotationRequest {
  document_id: string;
  collection_id: string;
  session_id?: string;
  annotation_type?: AnnotationType;
  selected_text?: string;
  comment?: string;
  color?: string;
  page_label?: string;
  sort_index?: string;
  position_json: string;
  viewer_type?: ViewerType;
  tag_ids?: string[];
}

/** Update annotation request */
export interface UpdateAnnotationRequest {
  comment?: string;
  color?: string;
  is_pinned?: boolean;
  tag_ids?: string[];
}

/** Parse position_json string to typed position object */
export function parseAnnotationPosition(positionJson: string): AnnotationPosition | null {
  try {
    return JSON.parse(positionJson) as AnnotationPosition;
  } catch {
    return null;
  }
}

/** Parse annotation with position */
export function parseAnnotation(annotation: Annotation): ParsedAnnotation | null {
  const position = parseAnnotationPosition(annotation.position_json);
  if (!position) return null;
  const { position_json, ...rest } = annotation;
  return { ...rest, position };
}
