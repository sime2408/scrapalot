"""
Text utilities sub-package.

Plain-text formatting, markdown post-processing, and Tiptap JSON
helpers. None of these depend on the database, an LLM, or the wider
application — they are pure string transforms.

Modules:
    formatting - title-case, word-boundary truncation, HTML stripping,
                 conversation summary fallback
    markdown   - publisher-specific boilerplate strippers for extracted
                 markdown bodies (open-access footers, running headers)
    tiptap     - Tiptap JSON → plain text + validation
"""
