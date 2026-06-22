/**
 * Tutor curriculum API client.
 *
 * The actual chat dispatch goes through the OpenAI-compat
 * /v1/chat/completions endpoint with `scrapalot.mode = "tutor"` plus a
 * single `collection_ids` entry; the Kotlin shim upgrades that to
 * GenerateChatTutor on the Python side. This file only exposes the
 * read-only progress query that powers the lesson tree / current-lesson
 * badge.
 */

import { apiClient, authState } from '@/lib/api';

export interface TutorLesson {
  lesson_ord: number;
  title: string;
  summary: string;
  level: number;
  completed: boolean;
}

export interface TutorProgress {
  curriculum_ready: boolean;
  curriculum_status: 'building' | 'ready' | 'failed' | 'missing';
  current_lesson_ord: number;
  current_state: 'lesson_intro' | 'check_understanding' | 'drill_in' | 'quiz' | 'lesson_recap';
  lesson_count: number;
  lessons: TutorLesson[];
  error?: string;
}

export async function getTutorProgress(collectionId: string): Promise<TutorProgress> {
  await authState.waitForAuthReady();
  const { data } = await apiClient.get<TutorProgress>(
    '/chat/tutor/progress',
    { params: { collection_id: collectionId } },
  );
  return data;
}
