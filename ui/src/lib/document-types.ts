/**
 * Document type definitions for structured bibliographic item types.
 * Centralized type → icon/color/label mapping used by thumbnail, filter, and edit UI.
 */

import {
  FileText,
  BookOpen,
  BookMarked,
  Presentation,
  FileClock,
  GraduationCap,
  FileBarChart,
  Shield,
  type LucideIcon,
} from 'lucide-react';

export interface DocumentTypeInfo {
  id: string;
  label: string;
  labelHr: string;
  icon: LucideIcon;
  bgColor: string;
  textColor: string;
}

export const DOCUMENT_TYPES: DocumentTypeInfo[] = [
  { id: 'journal_article', label: 'Journal Article', labelHr: 'Članak iz časopisa', icon: FileText, bgColor: 'bg-blue-500', textColor: 'text-blue-500' },
  { id: 'book', label: 'Book', labelHr: 'Knjiga', icon: BookOpen, bgColor: 'bg-green-600', textColor: 'text-green-600' },
  { id: 'book_section', label: 'Book Section', labelHr: 'Poglavlje knjige', icon: BookMarked, bgColor: 'bg-teal-500', textColor: 'text-teal-500' },
  { id: 'conference_paper', label: 'Conference Paper', labelHr: 'Konferencijski rad', icon: Presentation, bgColor: 'bg-purple-500', textColor: 'text-purple-500' },
  { id: 'preprint', label: 'Preprint', labelHr: 'Pretisak', icon: FileClock, bgColor: 'bg-orange-500', textColor: 'text-orange-500' },
  { id: 'thesis', label: 'Thesis', labelHr: 'Disertacija', icon: GraduationCap, bgColor: 'bg-indigo-500', textColor: 'text-indigo-500' },
  { id: 'report', label: 'Report', labelHr: 'Izvještaj', icon: FileBarChart, bgColor: 'bg-gray-500', textColor: 'text-gray-500' },
  { id: 'patent', label: 'Patent', labelHr: 'Patent', icon: Shield, bgColor: 'bg-amber-500', textColor: 'text-amber-500' },
];

/** Get type info by document_type string. Returns undefined for null/unknown types. */
export function getDocumentTypeInfo(type?: string | null): DocumentTypeInfo | undefined {
  if (!type) return undefined;
  return DOCUMENT_TYPES.find(t => t.id === type);
}
