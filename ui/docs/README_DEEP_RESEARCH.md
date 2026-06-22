# Deep Research System

**Last Updated**: March 2026

Frontend architecture for the 5-phase deep research system with real-time streaming packets.

## Overview

The deep research system processes 79 packet types across 5 phases, providing real-time progress updates via WebSocket (STOMP).

```
Backend (PacketEmitter) → STOMP → processPacket() → State → UI Components
```

## Core Files

| File | Size/Lines | Purpose |
|------|-------|---------|
| `src/hooks/use-deep-research-panel.tsx` | 40KB / 1,237 lines | Main hook with all state and packet processing |
| `src/contexts/deep-research-context.tsx` | 37KB / 1,170 lines | Alternative provider-based pattern (14th context) |
| `src/types/streaming-packets.ts` | 678 lines | Packet types and type guards (79 types) |
| `src/components/research/deep-research-panel.tsx` | 1,287 lines | Full slide-out panel UI with animations |
| `src/components/research/inline-research-progress.tsx` | 206 lines | Compact inline progress indicator |

**Total**: ~80KB across 5 core files, processing 79 distinct packet types

## State Management

### Panel Control
| State | Type | Purpose |
|-------|------|---------|
| `isOpen` | boolean | Panel visibility |
| `wasManuallyDismissed` | boolean | Shows inline progress if true |
| `isResearching` | boolean | Active research status |
| `currentStep` | string | Current step identifier |

### Phase 1: Research Planning
| State | Type | Purpose |
|-------|------|---------|
| `researchPlan` | ResearchPlan | Sections, methodology, complexity |
| `planningProgress` | PlanningProgress | Stage, progress (0.0-1.0), message |
| `smoothedProgress` | number | Animated progress (800ms ease-out) |

### Phase 2: Task Decomposition
| State | Type | Purpose |
|-------|------|---------|
| `taskDecomposition` | TaskDecomposition | Total tasks, parallel groups |
| `taskCoordination` | TaskCoordination | Active/completed/failed counts |

### Phase 3: Multi-Agent Coordination
| State | Type | Purpose |
|-------|------|---------|
| `coordinationPlan` | CoordinationPlan | Agent types, execution phases |
| `agentStatuses[]` | AgentStatus[] | Per-agent status (updated in-place) |

### Phase 4: Enhanced Search
| State | Type | Purpose |
|-------|------|---------|
| `searchStrategy` | SearchStrategy | Queries, providers, strategy type |
| `searchProgresses[]` | SearchProgress[] | Per-provider progress |

### Phase 5: Synthesis & QA
| State | Type | Purpose |
|-------|------|---------|
| `synthesisData` | SynthesisData | Status, content, progress |
| `validationData` | ValidationData | Reliability, contradictions |

## Progress Animation (Three-Tier)

```typescript
const progress = useMemo(() => {
  // Tier 1: Smoothed (800ms cubic ease-out animation)
  if (smoothedProgress !== undefined && smoothedProgress > 0) {
    return smoothedProgress;
  }
  // Tier 2: Backend direct
  if (typeof planningProgress?.progress === 'number') {
    return planningProgress.progress;
  }
  // Tier 3: Estimated from local state
  return 0.2 + (stepProgress * 0.6) + (sourceProgress * 0.2);
}, [smoothedProgress, planningProgress, stepCount, sourceCount]);
```

### Animation Formula
```typescript
// 800ms cubic ease-out: smooth deceleration
const easeOut = 1 - Math.pow(1 - progress, 3);
```

## Packet Types (79)

### Core Packets
- `MessageStartPacket`, `MessageDeltaPacket`, `StreamEndPacket`
- `StatusPacket`, `ErrorPacket`
- `ToolStartPacket`, `ToolDeltaPacket`

### Phase 1: Research Planning
- `ResearchPlanPacket` - Full plan with sections array
- `PlanningProgressPacket` - Progress 0.0-1.0, stage, message
- `ResearchSectionPacket` - Individual section status
- `ResearchThinkingPacket` - Model thinking with confidence

### Phase 2: Task Decomposition
- `TaskDecompositionPlanPacket` - Task structure
- `TaskExecutionPacket` - Individual task execution
- `ParallelGroupPacket` - Parallel execution group
- `QualityGatePacket` - Quality check with metrics
- `TaskCoordinationPacket` - Coordination status

### Phase 3: Multi-Agent Coordination
- `CoordinationPlanPacket` - Agent coordination plan
- `AgentStatusPacket` - Individual agent with progress
- `InterAgentCommunicationPacket` - Agent-to-agent messages
- `AgentPoolStatusPacket` - Pool utilization metrics

### Phase 4: Enhanced Search
- `SearchStrategyPacket` - Search plan
- `SourceEvaluationPacket` - Credibility/bias scoring
- `SearchProgressPacket` - Per-provider progress
- `ContentExtractionPacket` - Extraction progress
- `SearchFusionPacket` - Result deduplication
- `ResultRankingPacket` - Ranking progress

### Phase 5: Synthesis & QA
- `SynthesisStartPacket`, `SynthesisDeltaPacket` - Synthesis streaming
- `ValidationStartPacket`, `ValidationResultPacket` - Validation metrics
- `QualityCheckPacket`, `QualityResultPacket` - Quality assessment
- `ResearchCitationPacket` - Citation formatting
- `ReportGenerationPacket` - Report progress

## Type Guards

All packets have type guard functions in `streaming-packets.ts`:

```typescript
import { isPlanningProgress, isAgentStatus } from '@/types/streaming-packets';

if (isPlanningProgress(packet)) {
  // TypeScript knows packet.obj is PlanningProgressPacket
  setProgress(packet.obj.progress);
}
```

## processPacket() Flow

```typescript
const processPacket = useCallback((packet: StreamPacket) => {
  // Phase 1
  if (isResearchPlan(packet)) {
    setResearchPlan(packet.obj);
  } else if (isPlanningProgress(packet)) {
    setPlanningProgress(packet.obj);  // Triggers smoothed animation
  }
  // Phase 2
  else if (isTaskDecompositionPlan(packet)) {
    setTaskDecomposition(packet.obj);
  }
  // Phase 3 - Agent status uses array update pattern
  else if (isAgentStatus(packet)) {
    setAgentStatuses(prev => {
      const idx = prev.findIndex(a => a.agent_id === packet.obj.agent_id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = packet.obj;
        return updated;
      }
      return [...prev, packet.obj];
    });
  }
  // ... 79 packet handlers
}, []);
```

## UI Components

### DeepResearchPanel (1,287 lines)

Full-featured slide-out panel:

```
┌─ Header (Brain icon, title, elapsed timer, buttons) ──┐
├─ Stats Bar (Steps, Sources, Sections, Timer) ─────────┤
├─ Scrollable Content Area ──────────────────────────────┤
│  ├─ Saved Research Report (if loaded from DB)         │
│  ├─ Research Plan (collapsible with sections)         │
│  ├─ Active Progress Card (during research)            │
│  ├─ Research Steps (collapsible, last 3 visible)      │
│  └─ Sources (collapsible, clickable cards)            │
└────────────────────────────────────────────────────────┘
```

**Features**:
- Responsive: 50% width desktop, 100% mobile
- Maximizable to full screen
- Framer Motion animations (50ms stagger)
- Markdown rendering for saved reports

### InlineResearchProgress (206 lines)

Compact indicator shown when panel dismissed:

```
┌─ Header (Brain icon, title, open button) ─────────────┐
├─ Progress Bar with % (if researching) ────────────────┤
├─ Current Activity (latest step content) ──────────────┤
└─ Stats (steps, sources) ──────────────────────────────┘
```

## Usage Pattern

```typescript
import { useDeepResearchPanel } from '@/hooks/use-deep-research-panel';
import stompService from '@/lib/stomp-service';

function ResearchComponent() {
  const research = useDeepResearchPanel();

  // Subscribe to packets
  useEffect(() => {
    const unsubscribe = stompService.subscribeToMessages((packet) => {
      research.processPacket(packet);
    });
    return unsubscribe;
  }, [research]);

  return (
    <>
      <DeepResearchPanel {...research} onClose={research.closePanel} />
      <InlineResearchProgress
        {...research}
        onOpenPanel={research.openPanel}
      />
    </>
  );
}
```

## Actions

| Action | Purpose |
|--------|---------|
| `openPanel()` | Show panel, reset dismiss flag |
| `closePanel()` | Hide panel, reset dismiss flag |
| `dismissPanel()` | Hide panel, set wasManuallyDismissed=true |
| `addStep(step)` | Create ResearchStep with auto-ID |
| `addSource(source)` | Add source with duplicate check |
| `processPacket(packet)` | Handle typed StreamPacket |
| `loadSavedResearch(planId)` | Fetch from database |
| `clearResearch()` | Full state reset |

## Critical Rules

1. **Progress Range**: Always 0.0-1.0 (not 0-100)
2. **Numeric Checks**: Use `typeof value === 'number'`, not truthiness (0 is falsy)
3. **Array Updates**: Agent/search status uses find-and-update pattern to prevent duplicates
4. **Smoothed Animation**: Only animates if diff > 0.01 (prevents jitter)

---

*See backend docs: `scrapalot-chat/docs/README_DEEP_RESEARCH.md`*
