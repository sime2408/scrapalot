// (CE) Deep Research is a hosted-only feature. This is an inert stub so the Community
// Edition UI compiles and runs: the provider is a pass-through and the hook reports an
// always-inactive state. Components that gate on research state simply see "nothing
// running" and render their normal (non-research) UI.
import type { ReactNode } from 'react';

export interface CouncilMemberState { [k: string]: unknown }
export interface CouncilSynthesisState { [k: string]: unknown }
export interface CouncilState { [k: string]: unknown }
export interface DiscoveryItem { [k: string]: unknown }
export type DeepResearchContextType = Record<string, unknown>;

const INACTIVE = new Proxy(
  {
    // Common flags consumers gate on — all inactive in CE.
    isPanelOpen: false,
    isResearchActive: false,
    isObservingRemote: false,
    researchActive: false,
    panelOpen: false,
    session: null,
    sessionId: null,
    packets: [],
    messages: [],
  } as Record<string, unknown>,
  {
    // Any field a consumer reads that we didn't enumerate resolves to a safe no-op/false,
    // so destructuring never throws and gates default to "off".
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && prop.startsWith('set')) return () => {};
      return undefined;
    },
  },
);

export function DeepResearchProvider({ children }: { children: ReactNode }) {
  return children as JSX.Element;
}

export function useDeepResearchPanel(): DeepResearchContextType {
  return INACTIVE;
}
