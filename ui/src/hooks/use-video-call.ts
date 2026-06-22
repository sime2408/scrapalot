import { useState, useRef, useCallback, useEffect } from 'react';
import backendStompService from '@/lib/stomp-backend-service';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export type CallState = 'idle' | 'calling' | 'incoming' | 'connected';

export interface CallerInfo {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
  profilePicture: string;
}

interface UseVideoCallOptions {
  userId?: string;
  workspaceId?: string;
}

export function useVideoCall({ userId, workspaceId }: UseVideoCallOptions) {
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteUser, setRemoteUser] = useState<CallerInfo | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [callDuration, setCallDuration] = useState(0);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteUserRef = useRef<string | null>(null);

  const startTimer = useCallback(() => {
    setCallDuration(0);
    callTimerRef.current = setInterval(() => {
      setCallDuration(prev => prev + 1);
    }, 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    setCallDuration(0);
  }, []);

  const cleanup = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    remoteStreamRef.current = null;
    pendingCandidatesRef.current = [];
    remoteUserRef.current = null;
    stopTimer();
    setCallState('idle');
    setRemoteUser(null);
    setIsMuted(false);
    setIsVideoOff(false);
  }, [stopTimer]);

  const createPeerConnection = useCallback((targetUserId: string) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void backendStompService.send('/app/workspace.call.ice', {
          to_user_id: targetUserId,
          candidate: JSON.stringify(event.candidate.toJSON()),
        });
      }
    };

    pc.ontrack = (event) => {
      remoteStreamRef.current = event.streams[0];
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        cleanup();
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [cleanup]);

  const getLocalStream = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localStreamRef.current = stream;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }
    return stream;
  }, []);

  // Start a call to another user
  const startCall = useCallback(async (targetUser: CallerInfo) => {
    if (!userId || !workspaceId) return;

    try {
      setCallState('calling');
      setRemoteUser(targetUser);
      remoteUserRef.current = targetUser.userId;

      const stream = await getLocalStream();
      const pc = createPeerConnection(targetUser.userId);

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await backendStompService.send('/app/workspace.call.offer', {
        to_user_id: targetUser.userId,
        workspace_id: workspaceId,
        sdp: JSON.stringify(offer),
      });
    } catch (err) {
      console.error('[VideoCall] Failed to start call:', err);
      cleanup();
    }
  }, [userId, workspaceId, getLocalStream, createPeerConnection, cleanup]);

  // Accept an incoming call
  const acceptCall = useCallback(async () => {
    if (!remoteUser) return;

    try {
      const stream = await getLocalStream();
      const pc = peerConnectionRef.current;
      if (!pc) return;

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await backendStompService.send('/app/workspace.call.answer', {
        to_user_id: remoteUser.userId,
        sdp: JSON.stringify(answer),
      });

      // Process any pending ICE candidates
      for (const candidate of pendingCandidatesRef.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      pendingCandidatesRef.current = [];

      setCallState('connected');
      startTimer();
    } catch (err) {
      console.error('[VideoCall] Failed to accept call:', err);
      cleanup();
    }
  }, [remoteUser, getLocalStream, startTimer, cleanup]);

  // Reject or hang up
  const hangUp = useCallback(async () => {
    const targetId = remoteUserRef.current || remoteUser?.userId;
    if (targetId) {
      await backendStompService.send('/app/workspace.call.hangup', {
        to_user_id: targetId,
      });
    }
    cleanup();
  }, [remoteUser, cleanup]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach(t => { t.enabled = !t.enabled; });
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  // Toggle video
  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      videoTracks.forEach(t => { t.enabled = !t.enabled; });
      setIsVideoOff(!isVideoOff);
    }
  }, [isVideoOff]);

  // Subscribe to signaling messages
  useEffect(() => {
    if (!userId) return;

    const setupSignaling = async () => {
      unsubRef.current = await backendStompService.subscribe(
        `/user/queue/call`,
        async (data) => {
          const sigData = data as { type?: string; from_user_id?: string; from_username?: string; from_first_name?: string; from_last_name?: string; from_profile_picture?: string; sdp?: string; candidate?: string };
          switch (sigData.type) {
            case 'offer': {
              const caller: CallerInfo = {
                userId: sigData.from_user_id || '',
                username: sigData.from_username || '',
                firstName: sigData.from_first_name || '',
                lastName: sigData.from_last_name || '',
                profilePicture: sigData.from_profile_picture || '',
              };
              setRemoteUser(caller);
              remoteUserRef.current = sigData.from_user_id || '';

              const pc = createPeerConnection(sigData.from_user_id || '');
              const sdp = JSON.parse(sigData.sdp || '{}');
              await pc.setRemoteDescription(new RTCSessionDescription(sdp));

              setCallState('incoming');
              break;
            }
            case 'answer': {
              const pc = peerConnectionRef.current;
              if (pc) {
                const sdp = JSON.parse(sigData.sdp || '{}');
                await pc.setRemoteDescription(new RTCSessionDescription(sdp));

                // Process any pending ICE candidates
                for (const candidate of pendingCandidatesRef.current) {
                  await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }
                pendingCandidatesRef.current = [];

                setCallState('connected');
                startTimer();
              }
              break;
            }
            case 'ice-candidate': {
              const candidate = JSON.parse(sigData.candidate || '{}');
              const pc = peerConnectionRef.current;
              if (pc && pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } else {
                pendingCandidatesRef.current.push(candidate);
              }
              break;
            }
            case 'hangup': {
              cleanup();
              break;
            }
          }
        }
      );
    };

    void setupSignaling();

    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      cleanup();
    };
  }, [userId, createPeerConnection, startTimer, cleanup]);

  return {
    callState,
    remoteUser,
    isMuted,
    isVideoOff,
    callDuration,
    localVideoRef,
    remoteVideoRef,
    startCall,
    acceptCall,
    hangUp,
    toggleMute,
    toggleVideo,
  };
}
