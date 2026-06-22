/**
 * Reads the workspace's annotation color → label map (admin-configured)
 * and exposes a memoised lookup for swatch tooltips. Falls back to the
 * built-in `label` field on the palette when a workspace label is unset.
 */

import { useEffect, useState, useCallback } from 'react';
import { authState } from '@/lib/api';
import { useWorkspace } from '@/hooks/use-workspace';
import {
  getAnnotationColorSemantics,
  updateAnnotationColorSemantics,
} from '@/lib/api-annotations';

export function useAnnotationColorSemantics() {
  const { currentWorkspace } = useWorkspace();
  const [map, setMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!currentWorkspace?.id) return;
    setLoading(true);
    try {
      await authState.waitForAuthReady();
      setMap(await getAnnotationColorSemantics(currentWorkspace.id));
    } catch (e) {
      console.warn('Failed to load annotation color semantics:', e);
      setMap({});
    } finally {
      setLoading(false);
    }
  }, [currentWorkspace?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: Record<string, string>) => {
      if (!currentWorkspace?.id) return;
      const updated = await updateAnnotationColorSemantics(currentWorkspace.id, next);
      setMap(updated);
    },
    [currentWorkspace?.id],
  );

  const labelFor = useCallback(
    (hex: string, fallback?: string) => map[hex.toLowerCase()] || map[hex] || fallback || '',
    [map],
  );

  return { map, labelFor, loading, reload: load, save };
}
