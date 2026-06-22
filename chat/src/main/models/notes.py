"""Database models for notes collaboration system.

Note, NoteShare, NoteVersion, and NoteComment tables have been removed —
Kotlin backend owns these. Python only stores Y.js CRDT state in the
yjs_collaboration_state table (see python_only_models.py).
"""
