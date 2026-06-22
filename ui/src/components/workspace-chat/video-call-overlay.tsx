import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CallState, CallerInfo } from '@/hooks/use-video-call';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { profilePicSources } from '@/lib/profile-picture';

function getInitials(firstName?: string, lastName?: string, username?: string): string {
  if (firstName && lastName) return `${firstName[0]}${lastName[0]}`.toUpperCase();
  if (firstName) return firstName[0].toUpperCase();
  if (username) return username[0].toUpperCase();
  return '?';
}

function getDisplayName(firstName?: string, lastName?: string, username?: string): string {
  if (firstName && lastName) return `${firstName} ${lastName}`;
  if (firstName) return firstName;
  return username || 'Unknown';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

interface VideoCallOverlayProps {
  callState: CallState;
  remoteUser: CallerInfo | null;
  isMuted: boolean;
  isVideoOff: boolean;
  callDuration: number;
  localVideoRef: React.RefObject<HTMLVideoElement | null>;
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>;
  onAccept: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleVideo: () => void;
}

export function VideoCallOverlay({
  callState,
  remoteUser,
  isMuted,
  isVideoOff,
  callDuration,
  localVideoRef,
  remoteVideoRef,
  onAccept,
  onHangUp,
  onToggleMute,
  onToggleVideo,
}: VideoCallOverlayProps) {
  const { t } = useTranslation();

  // Play ringtone effect for incoming calls
  useEffect(() => {
    if (callState !== 'incoming') return;
    // Could add audio ringtone here
  }, [callState]);

  if (callState === 'idle') return null;

  // Incoming call notification
  if (callState === 'incoming') {
    return (
      <div data-testid="workspace-chat-incoming-call-overlay" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
        <div data-testid="workspace-chat-incoming-call-card" className="bg-background border border-border p-8 shadow-2xl w-[320px] text-center space-y-6 animate-in zoom-in-95 duration-300">
          <div className="space-y-3">
            <div className="relative mx-auto w-20 h-20">
              <Avatar className="h-20 w-20 ring-4 ring-green-500/30 animate-pulse">
                <AvatarImage {...profilePicSources(remoteUser?.profilePicture)} />
                <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                  {getInitials(remoteUser?.firstName, remoteUser?.lastName, remoteUser?.username)}
                </AvatarFallback>
              </Avatar>
            </div>
            <div>
              <h3 className="text-lg font-semibold">
                {getDisplayName(remoteUser?.firstName, remoteUser?.lastName, remoteUser?.username)}
              </h3>
              <p className="text-sm text-muted-foreground animate-pulse">
                {t('videoCall.incoming', 'Incoming video call...')}
              </p>
            </div>
          </div>
          <div className="flex justify-center gap-8">
            <button
              onClick={onHangUp}
              className="h-14 w-14 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-all hover:scale-105 active:scale-95"
              title={t('videoCall.decline', 'Decline')}
              data-testid="workspace-chat-call-decline-button"
            >
              <PhoneOff className="h-6 w-6" />
            </button>
            <button
              onClick={onAccept}
              className="h-14 w-14 rounded-full bg-green-500 hover:bg-green-600 text-white flex items-center justify-center transition-all hover:scale-105 active:scale-95"
              title={t('videoCall.accept', 'Accept')}
              data-testid="workspace-chat-call-accept-button"
            >
              <Phone className="h-6 w-6" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Calling / Connected state — full screen video
  return (
    <div data-testid="workspace-chat-call-overlay" className="fixed inset-0 z-[100] bg-zinc-950 flex flex-col">
      {/* Remote video (full screen) */}
      <div className="flex-1 relative overflow-hidden">
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="w-full h-full object-cover"
        />

        {/* Fallback when no remote video yet */}
        {callState === 'calling' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900">
            <Avatar className="h-24 w-24 mb-4">
              <AvatarImage {...profilePicSources(remoteUser?.profilePicture)} />
              <AvatarFallback className="text-3xl bg-zinc-800 text-white">
                {getInitials(remoteUser?.firstName, remoteUser?.lastName, remoteUser?.username)}
              </AvatarFallback>
            </Avatar>
            <h2 className="text-xl font-semibold text-white mb-1">
              {getDisplayName(remoteUser?.firstName, remoteUser?.lastName, remoteUser?.username)}
            </h2>
            <p className="text-sm text-zinc-400 animate-pulse">
              {t('videoCall.calling', 'Calling...')}
            </p>
          </div>
        )}

        {/* Top bar — user info + duration */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/50 to-transparent flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Avatar className="h-9 w-9 border-2 border-white/20">
              <AvatarImage {...profilePicSources(remoteUser?.profilePicture)} />
              <AvatarFallback className="text-xs bg-zinc-800 text-white">
                {getInitials(remoteUser?.firstName, remoteUser?.lastName, remoteUser?.username)}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-white text-sm font-medium">
                {getDisplayName(remoteUser?.firstName, remoteUser?.lastName, remoteUser?.username)}
              </p>
              {callState === 'connected' && (
                <p className="text-white/60 text-xs">{formatDuration(callDuration)}</p>
              )}
            </div>
          </div>
        </div>

        {/* Local video (picture-in-picture, bottom right) */}
        <div className="absolute bottom-24 right-4 w-[140px] h-[190px] bg-zinc-800 border-2 border-zinc-700 overflow-hidden shadow-xl">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={cn('w-full h-full object-cover', isVideoOff && 'hidden')}
          />
          {isVideoOff && (
            <div className="w-full h-full flex items-center justify-center bg-zinc-800">
              <VideoOff className="h-8 w-8 text-zinc-500" />
            </div>
          )}
        </div>
      </div>

      {/* Bottom controls */}
      <div className="bg-zinc-900 px-6 py-5 flex items-center justify-center gap-5">
        <button
          onClick={onToggleMute}
          className={cn(
            'h-12 w-12 rounded-full flex items-center justify-center transition-all',
            isMuted
              ? 'bg-white text-zinc-900'
              : 'bg-zinc-700 text-white hover:bg-zinc-600'
          )}
          title={isMuted ? t('videoCall.unmute', 'Unmute') : t('videoCall.mute', 'Mute')}
          data-testid="workspace-chat-call-mute-button"
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>

        <button
          onClick={onToggleVideo}
          className={cn(
            'h-12 w-12 rounded-full flex items-center justify-center transition-all',
            isVideoOff
              ? 'bg-white text-zinc-900'
              : 'bg-zinc-700 text-white hover:bg-zinc-600'
          )}
          title={isVideoOff ? t('videoCall.videoOn', 'Turn on camera') : t('videoCall.videoOff', 'Turn off camera')}
          data-testid="workspace-chat-call-video-button"
        >
          {isVideoOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
        </button>

        <button
          onClick={onHangUp}
          className="h-14 w-14 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-all hover:scale-105 active:scale-95"
          title={t('videoCall.hangUp', 'Hang up')}
          data-testid="workspace-chat-call-hangup-button"
        >
          <PhoneOff className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}
