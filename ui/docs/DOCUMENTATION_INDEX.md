# Scrapalot UI - Documentation Index

**Last Updated**: March 2026

This index provides an overview of all documentation files in the `docs/` folder and quick access to key information.

---

## Documentation Files

### 📚 Project Documentation (7 files, ~152KB)

#### 1. [Component Architecture](./README_COMPONENT_ARCHITECTURE.md)
- **Size**: 16KB
- **Topics**: Component hierarchy, data flow, provider nesting, hooks
- **Key Stats**: 198 TSX components, 14 contexts, 16 hooks
- **Includes**: Mermaid diagrams for visual architecture

#### 2. [API Layer](./README_API_LAYER.md)
- **Size**: 7.4KB
- **Topics**: API modules, auth flow, caching, WebSocket (STOMP)
- **Key Files**: 20 API modules (~220KB total)
- **Features**: Request deduplication, response caching, timeout handling

#### 3. [State Management](./README_STATE_MANAGEMENT.md)
- **Size**: 9.9KB
- **Topics**: 14 React Context providers, event coordination, localStorage
- **Total Code**: 4,333 lines across all providers
- **Key Contexts**: Auth (1,274 lines), Deep Research (1,170 lines)

#### 4. [Deep Research System](./README_DEEP_RESEARCH.md)
- **Size**: 8.8KB
- **Topics**: 5-phase research, packet processing, progress animation
- **Core Files**: Hook (1,237 lines), Context (1,170 lines)
- **Features**: 49 packet types, real-time streaming via STOMP

#### 5. [Notes Editor](./README_NOTES_EDITOR.md)
- **Size**: 28KB
- **Topics**: TipTap editor, collaboration (Y.js), auto-save, Markdown paste
- **Components**: 30 notes components
- **Features**: Real-time collaboration, mobile floating toolbar, portal rendering

#### 6. [Style Guide](./README_STYLE.md)
- **Size**: 57KB
- **Topics**: Design system, colors, spacing, component patterns
- **Version**: 2.1.1
- **Principles**: Sharp corners, semantic colors, 4px spacing, borders over shadows

#### 7. [Cloud Deployment](./README_CLOUD_DEPLOYMENT.md)
- **Size**: 25KB
- **Topics**: Docker deployment, CI/CD, GitHub Actions, architecture
- **Version**: 3.2
- **Infrastructure**: Hetzner Cloud CX33, Ubuntu 24.04 LTS, API Gateway

---

### 📖 Library References (2 files, ~2.3MB)

#### 8. [TipTap Documentation](./README_TIPTAP.md)
- **Size**: 2.0MB (54,531 lines)
- **Type**: Scraped external documentation
- **Source**: https://tiptap.dev/
- **Purpose**: TipTap editor library reference

#### 9. [PDF Viewer Documentation](./README_PDF_VIEWER.md)
- **Size**: 329KB (12,213 lines)
- **Type**: Scraped external documentation
- **Source**: https://react-pdf-viewer.dev/
- **Purpose**: React PDF Viewer library reference

---

## Quick Statistics

### Frontend Codebase Overview

| Metric | Count |
|--------|-------|
| TSX Components | 198 |
| Context Providers | 14 (4,333 lines) |
| Custom Hooks | 16 (5,702 lines) |
| API Modules | 20 (~220KB) |
| Pages | 10 |
| Component Categories | 14 |

### Technology Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 18.3.1 | UI framework |
| TypeScript | 5.9.3 | Type safety |
| Vite | 5.4.1 | Build tool |
| TipTap | 2.27.1 | Rich text editor |
| Framer Motion | 12.23.24 | Animations |
| Radix UI | Various | UI primitives |
| Tailwind CSS | Latest | Styling |
| i18next | Latest | Internationalization (en, hr) |

### Component Breakdown

| Category | Count | Examples |
|----------|-------|----------|
| UI Primitives | 56 | Button, Dialog, Sheet, Popover |
| Notes Components | 30 | TipTap editor, toolbars, comments |
| Settings Components | 25 | Tabs, provider config, model settings |
| Knowledge Components | 22 | File uploader, library, viewers |
| Chat Components | 18 | Messages, toolbar, input |
| Layout Components | 10 | Sidebar, header, navigation |
| Research Components | 2 | Deep research panel, inline progress |
| Other Components | 45 | Auth, cart, workspace, tour, pricing |

### Context Providers (14)

| Provider | Lines | Purpose |
|----------|-------|---------|
| AuthContext | 1,274 | Authentication, user session, tokens |
| DeepResearchContext | 1,170 | Research state, 49 packet types |
| TourContext | 349 | Onboarding tour, 5-step tutorial |
| WorkspaceContext | 341 | Workspace management |
| CollectionsContext | 243 | Document collections |
| SidebarContext | 167 | Sidebar state, width |
| PDFViewerContext | 130 | PDF viewer, reading position |
| LoadingContext | 110 | Loading states, progress |
| EpubViewerContext | 109 | EPUB reader state |
| DocxViewerContext | 101 | DOCX viewer state |
| ModelsContext | 100 | LLM model configuration |
| CartContext | 96 | Shopping cart |
| ApiClientContext | 77 | Axios client, auth sync |
| FontSettingsContext | 66 | Typography, code theme |

### API Modules (20)

| Module | Size | Purpose |
|--------|------|---------|
| api.ts | 57KB | Base client, auth, streaming |
| api-llm-inference.ts | 45KB | LLM providers, inference |
| api-documents.ts | 39KB | Document processing, jobs |
| api-settings.ts | 37KB | User/system settings |
| api-sessions.ts | 13KB | Chat sessions |
| api-workspace.ts | 12KB | Workspace management |
| api-connectors.ts | 12KB | External connectors |
| api-users.ts | 11KB | User profile, auth |
| api-collections.ts | 7.4KB | Collections |
| api-utils.ts | 7.2KB | Caching utilities |
| api-notes.ts | 6.9KB | Notes, autosave |
| api-external-books.ts | 6.3KB | Book sources |
| api-subscriptions.ts | 5.8KB | Billing |
| api-messages.ts | 5.6KB | Message CRUD |
| api-tts.ts | 3.4KB | Text-to-speech |
| api-research.ts | 3.4KB | Deep research |
| api-stripe.ts | 2.8KB | Stripe payments |
| api-storage.ts | 2.6KB | Storage quota |
| api-admin.ts | 2.5KB | Admin operations |
| api-local-ai.ts | 634B | Local LLM |

---

## Architecture Highlights

### System Flow

```
User → Nginx (443) → Scrapalot UI (3000)
                          ↓
                    API Gateway (8080)
                          ↓
        ┌─────────────────┴─────────────────┐
        ↓                                   ↓
scrapalot-backend (8091)        scrapalot-chat (8090)
- CRUD operations               - AI/RAG operations
- User management               - Deep research (5 phases)
- PostgreSQL + Neo4j            - Document processing
                                - LLM inference
                                - WebSocket (STOMP)
```

### Deep Research Flow

```
Backend (PacketEmitter) 
    ↓
STOMP WebSocket 
    ↓
Frontend (processPacket)
    ↓
State Update (Hook/Context)
    ↓
UI Components (Panel/Inline Progress)
```

### Data Flow Pattern

```
Component → Hook → API Client → Backend
    ↓        ↓         ↓            ↓
UI Update  State   HTTP/WS    PacketEmitter
         (Context) (Axios/STOMP)
```

---

## Recent Updates (March 2026)

All 7 project-specific documentation files have been updated with:

**Accurate Statistics**
- Current line counts and file sizes
- Updated component counts (186 TSX components)
- Correct context provider statistics (4,333 total lines)
- API module sizes (~220KB total)

**Current Versions**
- React 18.3.1 + TypeScript 5.9.3 + Vite 5.4.1
- TipTap 2.27.1
- Framer Motion 12.23.24

**Architecture Details**
- Gateway-based microservices (UI → Gateway → Backend/Chat)
- Hetzner Cloud specs (CX33: 4 vCPUs, 16GB RAM, 80GB SSD)
- Ubuntu 24.04 LTS environment
- Docker deployment with CI/CD

**Feature Documentation**
- Deep research system (5 phases, 49 packet types)
- Notes editor (TipTap, Y.js collaboration, Markdown paste)
- State management (14 contexts, event coordination)
- API layer (20 modules, caching, WebSocket)

---

## Quick Navigation

### By Topic

**Architecture & Structure**
- [Component Architecture](./README_COMPONENT_ARCHITECTURE.md) - Hierarchy, data flow, statistics
- [State Management](./README_STATE_MANAGEMENT.md) - 14 contexts, event coordination
- [API Layer](./README_API_LAYER.md) - 20 API modules, auth, caching

**Core Features**
- [Deep Research](./README_DEEP_RESEARCH.md) - 5-phase system, packet processing
- [Notes Editor](./README_NOTES_EDITOR.md) - TipTap, collaboration, auto-save

**Design & Deployment**
- [Style Guide](./README_STYLE.md) - Design system, colors, patterns
- [Cloud Deployment](./README_CLOUD_DEPLOYMENT.md) - Docker, CI/CD, architecture

**Library References**
- [TipTap Docs](./README_TIPTAP.md) - Editor library reference
- [PDF Viewer Docs](./README_PDF_VIEWER.md) - PDF library reference

### By Role

**Developers**
- Start with: [Component Architecture](./README_COMPONENT_ARCHITECTURE.md)
- Then read: [State Management](./README_STATE_MANAGEMENT.md), [API Layer](./README_API_LAYER.md)

**Designers**
- Essential: [Style Guide](./README_STYLE.md)
- Reference: [Component Architecture](./README_COMPONENT_ARCHITECTURE.md)

**DevOps**
- Primary: [Cloud Deployment](./README_CLOUD_DEPLOYMENT.md)
- Architecture: [Component Architecture](./README_COMPONENT_ARCHITECTURE.md)

**Feature Developers**
- Deep Research: [Deep Research](./README_DEEP_RESEARCH.md)
- Notes/Editor: [Notes Editor](./README_NOTES_EDITOR.md)
- Custom UI: [Style Guide](./README_STYLE.md)

---

## Contributing to Documentation

When updating documentation:

1. **Update the "Last Updated" date** at the top of each file
2. **Verify statistics** by analyzing the actual codebase
3. **Update version numbers** (React, TypeScript, TipTap, etc.)
4. **Include code examples** where appropriate
5. **Update this index** if adding new documentation files

### Documentation Standards

- Use clear headings and table of contents
- Include file sizes and line counts for key files
- Provide code examples with syntax highlighting
- Use Mermaid diagrams for architecture visualization
- Keep external references (TipTap, PDF Viewer) separate

---

**For main project documentation, see**: `../CLAUDE.md` (workspace guidance)

**For backend documentation, see**: `../../scrapalot-chat/docs/` (backend architecture)
