import { useEffect, useRef, useState } from 'react';

import { getMyActiveJobs } from '@/lib/api-documents';

import { CompactJobIndicator } from './compact-job-indicator';

interface ActiveJob {
  progress?: number;
  collection_name?: string;
  job_type?: string;
  filename?: string;
  document_id?: string;
}

// The gRPC JobInfo message has no job_type field, so the REST round-trip drops
// it — identify a research run by the backend-controlled job name instead (it
// sets job_name="Deep research: …"). Keep the job_type check as a defensive OR
// in case the field is ever wired through.
function isResearchJob(job: ActiveJob): boolean {
  if (job?.job_type === 'deep_research') return true;
  return (job?.filename || '').toLowerCase().startsWith('deep research');
}

/**
 * Live progress indicator for background deep-research runs, shown in the chat
 * header. Autonomous research is a durable Celery job that survives a browser
 * close, so the chat needs a place to show it is still working. This polls the
 * active-jobs endpoint and surfaces ONLY deep-research jobs — document
 * processing already has its own indicator in the Knowledge / Library views.
 *
 * It owns a small independent poll (cache-skipped server-side) so it discovers
 * a run that STARTS while the user is sitting on this page, then drops the bar
 * when the run finishes or the row goes stale.
 */
export function HeaderJobIndicator() {
  const [jobs, setJobs] = useState<Record<string, ActiveJob>>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchJobs = async () => {
      try {
        const data = (await getMyActiveJobs(true)) as { active_jobs?: Record<string, ActiveJob> };
        if (cancelled) return;
        const all = data.active_jobs || {};
        const research: Record<string, ActiveJob> = {};
        for (const [id, job] of Object.entries(all)) {
          if (isResearchJob(job)) research[id] = job;
        }
        setJobs(research);
      } catch {
        // Keep the last known state on a transient failure — don't flicker.
      }
    };

    void fetchJobs();
    intervalRef.current = setInterval(fetchJobs, 8000);
    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return <CompactJobIndicator activeJobsCount={Object.keys(jobs).length} activeJobs={jobs} />;
}
