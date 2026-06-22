/**
 * Custom hook for handling streaming chat with new packet system.
 * Integrates with existing Scrapalot-Chat UI components.
 */
import { useState, useCallback, useRef } from 'react';
import { PacketParser } from '@/lib/packet-parser';
import {
  StreamPacket,
  isMessageDelta,
  isCitationInfo,
  isReasoningStart,
  isReasoningDelta,
  isSectionEnd,
  isStreamEnd,
  isStatus,
  isError,
  isSuggestion,
} from '@/types/streaming-packets';

interface Citation {
  id: number;
  citation_id: number;
  citation_num: number;
  source: string;
  document_title?: string;
  document_id?: string;
  page?: number;
  url?: string;
  file_path?: string;
  score?: number;
  text?: string;
  chunk_index?: number;
  // Smart Citations (Scite)
  stance?: 'supporting' | 'contrasting' | 'mentioning';
  stance_confidence?: number;
  stance_rationale?: string;
}

interface UseStreamingChatOptions {
  onComplete?: (content: string, citations: Citation[]) => void;
  onError?: (error: string) => void;
}

export function useStreamingChat(options: UseStreamingChatOptions = {}) {
  const [messageContent, setMessageContent] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [thinkContent, setThinkContent] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const thinkingStartTime = useRef<number>(0);
  const thinkingTimeMs = useRef<number>(0);

  const processPacket = useCallback((packet: StreamPacket) => {
    // Handle different packet types
    if (isMessageDelta(packet)) {
      // Append content to message
      setMessageContent(prev => prev + packet.obj.content);
    } else if (isCitationInfo(packet)) {
      // Store citation in format compatible with existing UI.
      // Smart Citations: a second packet with the same citation_num arrives
      // after stance classification — merge into the existing entry so the
      // chip upgrades in place rather than duplicating.
      const incoming: Citation = {
        id: packet.obj.citation_num,
        citation_id: packet.obj.citation_num,
        citation_num: packet.obj.citation_num,
        source: packet.obj.document_title,
        document_title: packet.obj.document_title,
        document_id: packet.obj.document_id,
        page: packet.obj.page,
        url: packet.obj.url,
        file_path: packet.obj.url,
        score: packet.obj.score,
        text: packet.obj.text,
        chunk_index: packet.obj.chunk_index,
        stance: packet.obj.stance,
        stance_confidence: packet.obj.stance_confidence,
        stance_rationale: packet.obj.stance_rationale,
      };
      setCitations(prev => {
        const idx = prev.findIndex(c => c.citation_num === incoming.citation_num);
        if (idx === -1) return [...prev, incoming];
        const next = [...prev];
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
    } else if (isReasoningStart(packet)) {
      // Start thinking section
      console.log('[useStreamingChat] reasoning_start packet received');
      setIsThinking(true);
      // Clear message content when thinking starts to prevent showing old content
      setMessageContent('');
      // Don't clear thinkContent - allow multiple reasoning sections to accumulate
      // This supports strategies like HyDE that generate multiple hypothetical documents
      if (thinkingStartTime.current === 0) {
        thinkingStartTime.current = Date.now();
      }
    } else if (isReasoningDelta(packet)) {
      // Append thinking content
      console.log('[useStreamingChat] reasoning_delta packet:', packet.obj.reasoning?.substring(0, 50));
      setThinkContent(prev => prev + packet.obj.reasoning);
    } else if (isSectionEnd(packet)) {
      // End thinking section (keep content visible, just mark as complete)
      setIsThinking(false);
      if (thinkingStartTime.current > 0) {
        thinkingTimeMs.current = Date.now() - thinkingStartTime.current;
      }
    } else if (isStatus(packet)) {
      // Update status
      setStatus(packet.obj.content);
    } else if (isError(packet)) {
      // Handle error
      setError(packet.obj.content);
      options.onError?.(packet.obj.content);
    } else if (isSuggestion(packet)) {
      // Store follow-up suggestions
      setSuggestions(packet.obj.questions || []);
    } else if (isStreamEnd(packet)) {
      // Stream complete
      setIsStreaming(false);
      setIsThinking(false);

      if (thinkingStartTime.current > 0) {
        thinkingTimeMs.current = Date.now() - thinkingStartTime.current;
      }

      // Use functional state updates to get final values for callback
      setMessageContent(finalContent => {
        setCitations(finalCitations => {
          options.onComplete?.(finalContent, finalCitations);
          return finalCitations;
        });
        return finalContent;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [options.onComplete, options.onError]);

  const processLine = useCallback((line: string) => {
    const packet = PacketParser.parseLine(line);
    if (packet) {
      processPacket(packet);
    }
  }, [processPacket]);

  const reset = useCallback(() => {
    setMessageContent('');
    setCitations([]);
    setThinkContent('');
    setIsThinking(false);
    setIsStreaming(false);
    setStatus('');
    setError('');
    setSuggestions([]);
    thinkingStartTime.current = 0;
    thinkingTimeMs.current = 0;
  }, []);

  const startStreaming = useCallback(() => {
    reset();
    setIsStreaming(true);
  }, [reset]);

  return {
    // State - compatible with existing UI
    messageContent,
    citations,
    thinkContent,
    isThinking,
    isStreaming,
    status,
    error,
    thinkingTimeMs: thinkingTimeMs.current,
    suggestions,

    // Actions
    processLine,
    processPacket,
    startStreaming,
    reset,
  };
}
