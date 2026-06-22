/**
 * Resolve a document's file type (`pdf` / `epub` / `docx`) from whatever
 * fields a citation / library row happens to carry. Tries explicit
 * ``file_type`` first, then scans every plausible string field for an
 * extension. Returns ``'pdf'`` as a last resort so legacy callers that
 * pre-date the multi-format pipeline still work.
 *
 * The previous heuristic (`title.match(/\\.(epub|docx|pdf)$/i)`)
 * misfired when the backend stripped the extension off the title or
 * appended a citation page number ("EXO-VATICANA.epub p.14") — the
 * end-of-string anchor refused to match. We now look at every field
 * we know about and use a word-boundary anchor so the extension can
 * sit anywhere in the string.
 */
export type ResolvedFileType = 'pdf' | 'epub' | 'docx';

interface FileTypeSource {
  file_type?: string | null;
  filename?: string | null;
  title?: string | null;
  document_title?: string | null;
  source?: string | null;
  url?: string | null;
}

const EXT_RE = /\.(epub|docx|pdf)(?:$|[^a-zA-Z0-9])/i;

export function resolveFileType(source: FileTypeSource): ResolvedFileType {
  const explicit = source.file_type?.toString().toLowerCase().trim();
  if (explicit === 'epub' || explicit === 'docx' || explicit === 'pdf') {
    return explicit;
  }
  const candidates = [
    source.filename,
    source.title,
    source.document_title,
    source.source,
    source.url,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const m = EXT_RE.exec(candidate);
    if (m) {
      const ext = m[1].toLowerCase();
      if (ext === 'epub' || ext === 'docx' || ext === 'pdf') return ext;
    }
  }
  return 'pdf';
}
