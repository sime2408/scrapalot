import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspace } from '@/hooks/use-workspace';
import { useWorkspaceChat } from '@/hooks/use-workspace-chat';
import { useVideoCall } from '@/hooks/use-video-call';
import { useAdminCheck } from '@/hooks/use-admin-check';
import { useNotificationSound } from '@/hooks/use-notification-sound';
import { profilePicSources } from '@/lib/profile-picture';
import { VideoCallOverlay } from '@/components/workspace-chat/video-call-overlay';
import { useDirectMessages } from '@/hooks/use-direct-messages';
import { cn } from '@/lib/utils';
import { NotificationBell } from '@/components/notifications/notification-bell';
import {
  MessageCircle, MessageSquare, Bug, Github, Volume2, VolumeX,
  ChevronLeft, ChevronRight, X, Send, Users, ArrowLeft,
  Maximize2, Minimize2, Smile, Paperclip, Mic, Video,
  Check, CheckCheck, MousePointer2, Copy, Trash2, Undo2, Eraser,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { userPrefs } from '@/lib/storage-utils';
import { useFloatingWindowManager } from '@/contexts/floating-window-context';
import { WindowPinMenu } from '@/components/ui/window-pin-menu';
import type { WindowMode } from '@/types/floating-window';
import { EDGE_SNAP_THRESHOLD } from '@/types/floating-window';

// ─── Pure helpers (no imports, no side effects) ─────────────

function getInitials(a?: string | null, b?: string | null, c?: string | null) {
  if (a && b) return `${a[0]}${b[0]}`.toUpperCase();
  if (a) return a[0].toUpperCase();
  if (c) return c[0].toUpperCase();
  return '?';
}

function getDisplayName(a?: string | null, b?: string | null, c?: string | null) {
  if (a && b) return `${a} ${b}`;
  if (a) return a;
  return c || 'Unknown';
}

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateSeparator(msgs: { created_at: string }[], i: number): string | null {
  const fmt = (d: string) => {
    const date = new Date(d);
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  if (i === 0) return fmt(msgs[0].created_at);
  if (new Date(msgs[i - 1].created_at).toDateString() !== new Date(msgs[i].created_at).toDateString()) return fmt(msgs[i].created_at);
  return null;
}

type UStatus = 'online' | 'dnd' | 'appear_offline';

function statusDot(s: UStatus | boolean) {
  if (s === 'dnd') return 'bg-amber-500';
  if (s === 'appear_offline' || s === false) return 'bg-muted-foreground/30';
  return 'bg-green-500';
}

// ─── Main Component ─────────────────────────────────────────

export function ToolDock() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { currentWorkspace } = useWorkspace();
  const isAdmin = useAdminCheck();

  const [isMobile, setIsMobile] = useState(false);
  const [isDockOpen, setIsDockOpen] = useState(true);
  const [hoverVisible, setHoverVisible] = useState(false);
  const [activePanel, setActivePanel] = useState<'chat' | null>(null);
  const [chatTab, setChatTab] = useState<'team' | 'dm'>('team');
  const [dmRecipient, setDmRecipient] = useState<{ id: string; username: string | null; firstName: string | null; lastName: string | null; profilePicture: string | null } | null>(null);
  const [dmInputValue, setDmInputValue] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [chatMode, setChatModeState] = useState<WindowMode>(() => userPrefs.getChatPanelMode());
  const [userStatus, setUserStatus] = useState<UStatus>('online');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [isPickerActive, setIsPickerActive] = useState(false);
  const [chatWidth, setChatWidth] = useState<number>(() => userPrefs.getChatPanelWidth());
  const [chatHeight, setChatHeight] = useState<number | null>(() => userPrefs.getChatPanelHeight());
  const [membersPanelWidth, setMembersPanelWidth] = useState<number>(() => userPrefs.getChatMembersPanelWidth());
  const [chatPos, setChatPos] = useState<{ left: number; top: number } | null>(() => {
    const l = userPrefs.getChatPanelLeft();
    const tp = userPrefs.getChatPanelTop();
    return l !== null && tp !== null ? { left: l, top: tp } : null;
  });

  const floatingMgr = useFloatingWindowManager();
  const setChatMode = useCallback((m: WindowMode) => {
    setChatModeState(m);
    userPrefs.setChatPanelMode(m);
  }, []);

  const isMaximized = chatMode === 'maximized';
  const isPinnedLeft = chatMode === 'pinned-left';
  const isPinnedRight = chatMode === 'pinned-right';
  const isPinned = isPinnedLeft || isPinnedRight;
  const isFloating = chatMode === 'floating';

  const fwRegister = floatingMgr.registerWindow;
  const fwUnregister = floatingMgr.unregisterWindow;
  const fwBringToFront = floatingMgr.bringToFront;
  useEffect(() => {
    fwRegister('chat');
    return () => fwUnregister('chat');
  }, [fwRegister, fwUnregister]);

  const focusPanel = useCallback(() => fwBringToFront('chat'), [fwBringToFront]);

  useEffect(() => {
    if (!isAdmin) return;
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    import('@/lib/admin-debug-standalone').then(m => {
      if (cancelled) return;
      setIsPickerActive(m.isReactElementPickerActive());
      unsubscribe = m.onElementPickerStateChange(setIsPickerActive);
    }).catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isAdmin]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dmInputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const dmEndRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dmTypingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const prevMsgCount = useRef(0);

  // Responsive
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 1080);
    h();
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  // Hooks
  const isChatOpen = activePanel === 'chat';
  const {
    messages, members, typingUsers, access, isLoading,
    unreadCount, sendMessage, setTyping, markAsRead,
    deleteMessage, rollbackFromMessage, clearConversation,
  } = useWorkspaceChat(currentWorkspace?.id, user?.id, isChatOpen);
  const canModerate = access?.canModerate === true || isAdmin === true;
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);

  const copyMessageText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
  }, []);

  const confirmAndClear = useCallback(() => {
    if (!canModerate) return;
    if (typeof window !== 'undefined' && !window.confirm(t('workspaceChat.clearConfirm', 'Obrisati cijeli razgovor? Ova radnja je trajna.'))) return;
    void clearConversation();
  }, [canModerate, clearConversation, t]);

  const confirmAndRollback = useCallback((id: string) => {
    if (!canModerate) return;
    if (typeof window !== 'undefined' && !window.confirm(t('workspaceChat.rollbackConfirm', 'Vratiti razgovor na ovu točku? Sve poruke od ove pa nadalje bit će izbrisane.'))) return;
    void rollbackFromMessage(id);
  }, [canModerate, rollbackFromMessage, t]);

  const confirmAndDelete = useCallback((id: string) => {
    if (typeof window !== 'undefined' && !window.confirm(t('workspaceChat.deleteConfirm', 'Obrisati ovu poruku?'))) return;
    void deleteMessage(id);
  }, [deleteMessage, t]);

  const videoCall = useVideoCall({ userId: user?.id, workspaceId: currentWorkspace?.id });
  const dm = useDirectMessages({ userId: user?.id, workspaceId: currentWorkspace?.id });
  const { playMessageSound, playCallSound, isSoundEnabled, toggleSound } = useNotificationSound();

  const canChat = !isLoading && access?.canChat === true;
  const onlineCount = members.filter(m => m.is_online).length;
  const isWide = !isMobile && (isMaximized || isPinned);

  // Status change
  const handleStatusChange = useCallback((s: UStatus) => {
    setUserStatus(s);
    if (!currentWorkspace?.id) return;
    import('@/lib/stomp-backend-service').then(({ default: stomp }) => {
      if (s === 'appear_offline') stomp.send('/app/workspace.chat.leave', { workspace_id: currentWorkspace!.id }).catch(() => {});
      else stomp.send('/app/workspace.chat.join', { workspace_id: currentWorkspace!.id }).catch(() => {});
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally limited
  }, [currentWorkspace?.id]);

  // Sounds (muted in DND)
  useEffect(() => {
    if (userStatus === 'dnd') return;
    if (messages.length > prevMsgCount.current && prevMsgCount.current > 0) {
      const last = messages[messages.length - 1];
      if (last && last.sender_id !== user?.id && !isChatOpen) playMessageSound();
    }
    prevMsgCount.current = messages.length;
  }, [messages, user?.id, isChatOpen, playMessageSound, userStatus]);

  useEffect(() => {
    if (videoCall.callState === 'incoming') playCallSound();
  }, [videoCall.callState, playCallSound]);

  // Chat lifecycle
  useEffect(() => { if (isChatOpen) markAsRead(); }, [isChatOpen, markAsRead]);
  useEffect(() => {
    if (isChatOpen) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isChatOpen]);
  useEffect(() => {
    if (isChatOpen && chatTab === 'dm') dmEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [dm.messages, isChatOpen, chatTab]);
  useEffect(() => {
    if (isChatOpen && isMobile && panelRef.current) {
      panelRef.current.style.height = '';
      panelRef.current.style.top = '';
    }
    if (isChatOpen && !showMembers) setTimeout(() => inputRef.current?.focus(), 150);
  }, [isChatOpen, showMembers, isMobile]);

  // Mobile keyboard
  useEffect(() => {
    if (!isMobile || !isChatOpen) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const h = () => {
      if (!panelRef.current) return;
      if (vv.height < window.innerHeight * 0.75) {
        panelRef.current.style.height = `${vv.height}px`;
        panelRef.current.style.top = `${vv.offsetTop}px`;
      } else {
        panelRef.current.style.height = '';
        panelRef.current.style.top = '';
      }
    };
    vv.addEventListener('resize', h);
    vv.addEventListener('scroll', h);
    return () => { vv.removeEventListener('resize', h); vv.removeEventListener('scroll', h); };
  }, [isMobile, isChatOpen]);

  // Emoji outside click
  useEffect(() => {
    if (!showEmoji) return;
    const h = (e: MouseEvent) => { if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) setShowEmoji(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showEmoji]);

  // Close per-message action toolbar on outside click / scroll
  useEffect(() => {
    if (!activeMessageId) return;
    const close = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) { setActiveMessageId(null); return; }
      if (target.closest(`[data-testid="tool-dock-msg-actions-${activeMessageId}"]`)) return;
      if (target.closest('.cursor-pointer')) return;
      setActiveMessageId(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close, { passive: true });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
    };
  }, [activeMessageId]);

  // Legacy event
  useEffect(() => {
    const h = () => { setActivePanel(p => p === 'chat' ? null : 'chat'); if (isMobile) setMobileOpen(false); };
    window.addEventListener('toggle-workspace-chat', h);
    return () => window.removeEventListener('toggle-workspace-chat', h);
  }, [isMobile]);

  // ─── Handlers ─────────────────────────────────────────────

  const handleSend = useCallback(() => {
    if (!inputValue.trim()) return;
    sendMessage(inputValue);
    setInputValue('');
    setTyping(false);
    if (typingRef.current) { clearTimeout(typingRef.current); typingRef.current = null; }
  }, [inputValue, sendMessage, setTyping]);

  const handleInput = useCallback((v: string) => {
    setInputValue(v);
    setTyping(true);
    if (typingRef.current) clearTimeout(typingRef.current);
    typingRef.current = setTimeout(() => { setTyping(false); typingRef.current = null; }, 2000);
  }, [setTyping]);

  const emojis = [
    ['😀','😂','🤣','😊','😍','🥰','😘','😎','🤔','😅','😢','😭','😤','🥳','🤩','😱','🙄','😴','🤗','🤫'],
    ['👍','👎','👏','🙏','🤝','✌️','🤞','💪','👋','🖐️','✋','🫶','❤️','🔥','⭐','💯','✅','❌','⚡','🎉'],
  ];

  const handleVoice = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Web Speech API types not in standard lib
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setInputValue(p => p + '🎤 '); return; }
    if (isRecording && recRef.current) { recRef.current.stop(); setIsRecording(false); return; }
    const r = new SR();
    r.lang = document.documentElement.lang === 'hr' ? 'hr-HR' : 'en-US';
    r.interimResults = false;
    r.onresult = (e: { results: { 0: { 0: { transcript: string } } } }) => { setInputValue(p => p + (p ? ' ' : '') + e.results[0][0].transcript); setIsRecording(false); };
    r.onerror = () => setIsRecording(false);
    r.onend = () => setIsRecording(false);
    recRef.current = r; r.start(); setIsRecording(true);
  }, [isRecording]);

  const beginResize = useCallback((dir: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw') => (e: React.MouseEvent) => {
    if (!panelRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = panelRef.current.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = rect.width;
    const startH = rect.height;
    const startL = rect.left;
    const startT = rect.top;
    const free = chatPos !== null;
    let lastW = startW;
    let lastH = startH;
    let lastL = startL;
    let lastT = startT;

    const cursorMap: Record<typeof dir, string> = {
      n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
      nw: 'nwse-resize', se: 'nwse-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
    };

    const onMove = (ev: MouseEvent) => {
      if (dir.includes('w')) {
        const dx = startX - ev.clientX;
        lastW = Math.min(Math.max(startW + dx, 280), window.innerWidth - 80);
        setChatWidth(lastW);
        if (free) {
          lastL = Math.max(startL - (lastW - startW), 0);
          setChatPos(p => (p ? { ...p, left: lastL } : p));
        }
      } else if (dir.includes('e')) {
        const dx = ev.clientX - startX;
        lastW = Math.min(Math.max(startW + dx, 280), window.innerWidth - startL - 8);
        setChatWidth(lastW);
        // No left change on east drag.
      }
      if (dir.includes('n')) {
        const dy = startY - ev.clientY;
        lastH = Math.min(Math.max(startH + dy, 320), window.innerHeight - 80);
        setChatHeight(lastH);
        if (free) {
          lastT = Math.max(startT - (lastH - startH), 0);
          setChatPos(p => (p ? { ...p, top: lastT } : p));
        }
      } else if (dir.includes('s')) {
        const dy = ev.clientY - startY;
        lastH = Math.min(Math.max(startH + dy, 320), window.innerHeight - startT - 8);
        setChatHeight(lastH);
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const movedW = dir.includes('w') || dir.includes('e');
      const movedH = dir.includes('n') || dir.includes('s');
      if (movedW) userPrefs.setChatPanelWidth(lastW);
      if (movedH) userPrefs.setChatPanelHeight(lastH);
      if (free) {
        userPrefs.setChatPanelLeft(lastL);
        userPrefs.setChatPanelTop(lastT);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = cursorMap[dir];
    document.body.style.userSelect = 'none';
  }, [chatPos]);

  const beginMembersResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = membersPanelWidth;
    let lastW = startW;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      lastW = Math.min(Math.max(startW + dx, 210), 310);
      setMembersPanelWidth(lastW);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      userPrefs.setChatMembersPanelWidth(lastW);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [membersPanelWidth]);

  const beginDrag = useCallback((e: React.MouseEvent) => {
    if (!panelRef.current) return;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, select, input, textarea')) return;
    e.preventDefault();
    floatingMgr.bringToFront('chat');
    const rect = panelRef.current.getBoundingClientRect();
    const wasPinned = chatMode !== 'floating';

    let w = rect.width;
    let h = rect.height;
    let offX = e.clientX - rect.left;
    let offY = e.clientY - rect.top;
    if (wasPinned) {
      // Tear-off: shrink to a floating size and re-center under cursor.
      w = Math.min(rect.width, 480);
      h = Math.min(rect.height, window.innerHeight - 100);
      offX = w / 2;
      offY = 20;
      setChatMode('floating');
    }

    setChatWidth(w);
    setChatHeight(h);
    setChatPos({ left: e.clientX - offX, top: e.clientY - offY });
    let lastL = e.clientX - offX;
    let lastT = e.clientY - offY;
    let snapZone: 'left' | 'right' | null = null;

    floatingMgr.startEdgeSnap();

    const onMove = (ev: MouseEvent) => {
      lastL = Math.min(Math.max(ev.clientX - offX, 0), Math.max(window.innerWidth - w, 0));
      lastT = Math.min(Math.max(ev.clientY - offY, 0), Math.max(window.innerHeight - h, 0));
      setChatPos({ left: lastL, top: lastT });

      const px = ev.clientX;
      const vw = window.innerWidth;
      if (px < EDGE_SNAP_THRESHOLD) snapZone = 'left';
      else if (px > vw - EDGE_SNAP_THRESHOLD) snapZone = 'right';
      else snapZone = null;
      floatingMgr.setEdgeSnapZone(snapZone);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      floatingMgr.endEdgeSnap();

      if (snapZone) {
        setChatMode(snapZone === 'left' ? 'pinned-left' : 'pinned-right');
      } else {
        userPrefs.setChatPanelLeft(lastL);
        userPrefs.setChatPanelTop(lastT);
        userPrefs.setChatPanelWidth(w);
        userPrefs.setChatPanelHeight(h);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, [chatMode, floatingMgr, setChatMode]);

  const toolClick = useCallback((t: string) => {
    if (t === 'chat') { if (!canChat) return; setActivePanel(p => p === 'chat' ? null : 'chat'); setShowMembers(false); if (isMobile) setMobileOpen(false); }
    else if (t === 'debug') { import('@/lib/admin-debug-standalone').then(m => m.showAdminDebugModal()).catch(() => {}); if (isMobile) setMobileOpen(false); }
    else if (t === 'picker') { import('@/lib/admin-debug-standalone').then(m => m.toggleReactElementPicker()).catch(() => {}); if (isMobile) setMobileOpen(false); }
    else if (t === 'github') { window.open('https://github.com/sime2408', '_blank', 'noopener,noreferrer'); if (isMobile) setMobileOpen(false); }
    else if (t === 'sound') { toggleSound(); }
  }, [isMobile, toggleSound, canChat]);

  // ─── Status labels ────────────────────────────────────────

  const statusLabels: Record<UStatus, string> = {
    online: t('workspaceChat.statusOnline', 'Online'),
    dnd: t('workspaceChat.statusDnd', 'Do Not Disturb'),
    appear_offline: t('workspaceChat.statusOffline', 'Appear Offline'),
  };

  // ─── Dock button helper ───────────────────────────────────

  const dockBtn = (icon: React.ReactNode, label: string, onClick: () => void, badge?: number, active?: boolean, dim?: boolean, testId?: string) => (
    <div className={cn(dim && 'opacity-40 pointer-events-none')}>
      <button
        type="button" onClick={onClick} title={label}
        data-testid={testId}
        className={cn(
          'relative flex items-center justify-center w-10 h-10 transition-all opacity-50 hover:opacity-100',
          active ? 'bg-primary/10 text-primary !opacity-100' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        )}
      >
        {icon}
        {typeof badge === 'number' && badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-destructive text-destructive-foreground text-[9px] font-bold h-4 min-w-[16px] flex items-center justify-center px-0.5">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
    </div>
  );

  // ─── Dock buttons ─────────────────────────────────────────

  const buttons = (
    <div data-testid="tool-dock-buttons" className="flex flex-col items-center gap-1 py-2">
      {dockBtn(<MessageCircle className="h-4 w-4" />, canChat ? t('chat.actions.teamChat', 'Team Chat') : '...', () => toolClick('chat'), (unreadCount || 0) + dm.totalUnread, isChatOpen, !canChat, 'tool-dock-chat-button')}
      <NotificationBell />
      {dockBtn(<Bug className="h-4 w-4" />, t('bugTracker.openTitle', 'Report Bug'), () => toolClick('debug'), undefined, undefined, undefined, 'tool-dock-debug-button')}
      {isAdmin && dockBtn(<MousePointer2 className="h-4 w-4" />, isPickerActive ? 'Cancel element picker (Esc)' : 'Pick React element → copy @path:line', () => toolClick('picker'), undefined, isPickerActive, undefined, 'tool-dock-picker-button')}
      {dockBtn(<Github className="h-4 w-4" />, 'GitHub', () => toolClick('github'), undefined, undefined, undefined, 'tool-dock-github-button')}
      <div className="border-t border-border w-6 my-1" />
      {dockBtn(isSoundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />, isSoundEnabled ? 'Sound On' : 'Sound Off', () => toolClick('sound'), undefined, undefined, undefined, 'tool-dock-sound-button')}
    </div>
  );

  // ─── Members sidebar (WhatsApp style) ─────────────────────

  const membersList = (
    <div data-testid="tool-dock-members-list" className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Avatar className="h-8 w-8">
              <AvatarImage {...profilePicSources(user?.profile_picture)} />
              <AvatarFallback className="text-[10px]">{getInitials(user?.first_name, user?.last_name, user?.username)}</AvatarFallback>
            </Avatar>
            <div className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background', statusDot(userStatus))} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{getDisplayName(user?.first_name, user?.last_name, user?.username)}</div>
            <select
              value={userStatus}
              onChange={e => handleStatusChange(e.target.value as UStatus)}
              className="text-[11px] text-muted-foreground bg-transparent border-none outline-none cursor-pointer p-0"
              data-testid="tool-dock-status-select"
            >
              {(['online', 'dnd', 'appear_offline'] as UStatus[]).map(s => (
                <option key={s} value={s}>{statusLabels[s]}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wider flex-shrink-0">
        {t('workspaceChat.workspaceMembers', 'Members')} ({members.length})
      </div>
      <ScrollArea className="flex-1">
        <div className="px-1 pb-2">
          {[...members].sort((a, b) => (b.is_online ? 1 : 0) - (a.is_online ? 1 : 0)).map(m => (
            <button key={m.user_id} type="button"
              onClick={() => {
                if (m.user_id === user?.id) {
                  setSelectedMemberId(p => p === m.user_id ? null : m.user_id);
                  return;
                }
                setChatTab('dm');
                setDmRecipient({ id: m.user_id, username: m.username, firstName: m.first_name, lastName: m.last_name, profilePicture: m.profile_picture });
                setShowMembers(false);
                const existing = dm.conversations.find(c => c.other_user_id === m.user_id);
                if (existing) void dm.openConversation(existing.id);
              }}
              data-testid={`tool-dock-member-${m.user_id}`}
              className={cn('w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 transition-colors text-left', selectedMemberId === m.user_id && 'bg-muted/30')}>
              <div className="relative flex-shrink-0">
                <Avatar className="h-8 w-8">
                  <AvatarImage {...profilePicSources(m.profile_picture)} />
                  <AvatarFallback className="text-[10px]">{getInitials(m.first_name, m.last_name, m.username)}</AvatarFallback>
                </Avatar>
                <div className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background', m.is_online ? 'bg-green-500' : 'bg-muted-foreground/30')} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{getDisplayName(m.first_name, m.last_name, m.username)}</div>
                <div className="text-[10px] text-muted-foreground">{m.is_online ? t('workspaceChat.online', 'online') : t('workspaceChat.offline', 'offline')}</div>
              </div>
              {m.user_id !== user?.id && (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <div onClick={e => { e.stopPropagation(); setChatTab('dm'); setDmRecipient({ id: m.user_id, username: m.username, firstName: m.first_name, lastName: m.last_name, profilePicture: m.profile_picture }); setShowMembers(false); const existing = dm.conversations.find(c => c.other_user_id === m.user_id); if (existing) void dm.openConversation(existing.id); }}
                    data-testid={`tool-dock-member-dm-${m.user_id}`}
                    className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-primary transition-colors hover:bg-primary/10">
                    <MessageSquare className="h-3.5 w-3.5" />
                  </div>
                  {m.is_online && (
                    <div onClick={e => { e.stopPropagation(); void videoCall.startCall({ userId: m.user_id, username: m.username || '', firstName: m.first_name || '', lastName: m.last_name || '', profilePicture: m.profile_picture || '' }); }}
                      data-testid={`tool-dock-member-call-${m.user_id}`}
                      className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-green-500 transition-colors hover:bg-green-500/10">
                      <Video className="h-3.5 w-3.5" />
                    </div>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );

  // ─── Chat panel ───────────────────────────────────────────

  const isResizable = !isMobile && isFloating;
  const computeFloatingStyle = (): React.CSSProperties =>
    chatPos
      ? {
          left: chatPos.left,
          top: chatPos.top,
          width: chatWidth,
          height: chatHeight ?? Math.max(window.innerHeight - chatPos.top - 16, 320),
        }
      : {
          width: chatWidth,
          right: 52,
          ...(chatHeight ? { bottom: 64, height: chatHeight } : { top: 64, bottom: 64 }),
        };

  const dockedStyle: React.CSSProperties | undefined = isMobile || isMaximized
    ? undefined
    : isPinnedLeft
      ? { left: 0, top: 0, bottom: 0, width: '50vw' }
      : isPinnedRight
        ? { right: 0, top: 0, bottom: 0, width: '50vw' }
        : computeFloatingStyle();

  const panelStyle: React.CSSProperties = {
    ...(dockedStyle ?? {}),
    zIndex: floatingMgr.isTopFocused('chat') ? 9999 : floatingMgr.getZIndex('chat'),
  };

  const chatContent = isChatOpen && canChat && (
    <div ref={panelRef}
      data-testid="tool-dock-chat-panel"
      style={panelStyle}
      onMouseDownCapture={focusPanel}
      className={cn(
        'fixed border border-border flex overflow-hidden isolate',
        isMobile ? 'inset-0 !border-0 bg-background flex-col'
          : isMaximized ? 'inset-0 !border-0 bg-background flex-row'
          : isPinnedLeft || isPinnedRight ? 'bg-background flex-row'
          : 'bg-background/75 backdrop-blur-md shadow-lg flex-col'
      )}>
      {isResizable && (
        <>
          <div onMouseDown={beginResize('w')} data-testid="tool-dock-chat-resize-w" title={t('workspaceChat.resizeWidth', 'Drag to resize width')} className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-primary/40 transition-colors" />
          <div onMouseDown={beginResize('e')} data-testid="tool-dock-chat-resize-e" title={t('workspaceChat.resizeWidth', 'Drag to resize width')} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-primary/40 transition-colors" />
          <div onMouseDown={beginResize('n')} data-testid="tool-dock-chat-resize-n" title={t('workspaceChat.resizeHeight', 'Drag to resize height')} className="absolute left-0 right-0 top-0 h-1.5 cursor-ns-resize z-20 hover:bg-primary/40 transition-colors" />
          <div onMouseDown={beginResize('s')} data-testid="tool-dock-chat-resize-s" title={t('workspaceChat.resizeHeight', 'Drag to resize height')} className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize z-20 hover:bg-primary/40 transition-colors" />
          <div onMouseDown={beginResize('nw')} data-testid="tool-dock-chat-resize-nw" title={t('workspaceChat.resizeCorner', 'Drag to resize')} className="absolute left-0 top-0 w-3 h-3 cursor-nwse-resize z-30 hover:bg-primary/40 transition-colors" />
          <div onMouseDown={beginResize('ne')} data-testid="tool-dock-chat-resize-ne" title={t('workspaceChat.resizeCorner', 'Drag to resize')} className="absolute right-0 top-0 w-3 h-3 cursor-nesw-resize z-30 hover:bg-primary/40 transition-colors" />
          <div onMouseDown={beginResize('sw')} data-testid="tool-dock-chat-resize-sw" title={t('workspaceChat.resizeCorner', 'Drag to resize')} className="absolute left-0 bottom-0 w-3 h-3 cursor-nesw-resize z-30 hover:bg-primary/40 transition-colors" />
          <div onMouseDown={beginResize('se')} data-testid="tool-dock-chat-resize-se" title={t('workspaceChat.resizeCorner', 'Drag to resize')} className="absolute right-0 bottom-0 w-3 h-3 cursor-nwse-resize z-30 hover:bg-primary/40 transition-colors" />
        </>
      )}
      {isWide && (
        <div
          style={{ width: membersPanelWidth }}
          className="relative border-r border-border flex-shrink-0 bg-muted/20 flex flex-col"
        >
          {membersList}
          <div
            onMouseDown={beginMembersResize}
            data-testid="tool-dock-members-resize"
            title={t('workspaceChat.resizeWidth', 'Drag to resize width')}
            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-primary/40 transition-colors"
          />
        </div>
      )}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <div
          onMouseDown={!isMobile ? beginDrag : undefined}
          className={cn('flex items-center justify-between px-3 py-2 border-b border-border bg-muted/50 select-none flex-shrink-0', isMobile && 'py-3 px-4 bg-background', !isMobile && 'cursor-grab active:cursor-grabbing')}
        >
          <div className="flex items-center gap-2">
            {chatTab === 'dm' && dmRecipient ? (
              <>
                <button type="button" onClick={() => { setDmRecipient(null); dm.setActiveConversationId(null); }} className="h-5 w-5 flex items-center justify-center hover:bg-accent transition-colors"><ArrowLeft className="h-3.5 w-3.5" /></button>
                <span className="text-sm font-medium truncate max-w-[160px]">{getDisplayName(dmRecipient.firstName, dmRecipient.lastName, dmRecipient.username)}</span>
              </>
            ) : (
              <>
                <MessageCircle className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium truncate max-w-[140px]">{currentWorkspace?.name}</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{onlineCount} {t('workspaceChat.online', 'online')}</Badge>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {chatTab === 'team' && canModerate && messages.length > 0 && (
              <TooltipProvider delayDuration={250}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn('h-6 w-6 text-muted-foreground hover:text-destructive hover:bg-destructive/10', isMobile && 'h-8 w-8')}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={confirmAndClear}
                      data-testid="tool-dock-chat-clear-button"
                      aria-label={t('workspaceChat.clearConversation', 'Obriši razgovor')}
                    >
                      <Eraser className={cn('h-3.5 w-3.5', isMobile && 'h-4.5 w-4.5')} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4} className="text-[11px] py-1 px-2">{t('workspaceChat.clearConversation', 'Obriši razgovor')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {!isWide && chatTab === 'team' && <Button variant="ghost" size="icon" className={cn('h-6 w-6', isMobile && 'h-8 w-8')} onClick={() => setShowMembers(!showMembers)} data-testid="tool-dock-chat-members-button"><Users className={cn('h-3.5 w-3.5', isMobile && 'h-4.5 w-4.5')} /></Button>}
            {!isMobile && (
              <WindowPinMenu
                mode={chatMode}
                onSetMode={setChatMode}
                showMaximize={false}
                testId="tool-dock-chat-pin-menu"
              />
            )}
            {!isMobile && <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setChatMode(isMaximized ? 'floating' : 'maximized')} data-testid="tool-dock-chat-maximize-button">{isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</Button>}
            <Button variant="ghost" size="icon" className={cn('h-6 w-6', isMobile && 'h-8 w-8')} onClick={() => { setActivePanel(null); setChatMode('floating'); setChatTab('team'); setDmRecipient(null); }} data-testid="tool-dock-chat-close-button"><X className={cn('h-3.5 w-3.5', isMobile && 'h-4.5 w-4.5')} /></Button>
          </div>
        </div>

        {/* Tabs: Team / Privatno */}
        {!(chatTab === 'dm' && dmRecipient) && (
          <div className="flex border-b border-border flex-shrink-0">
            <button type="button" onClick={() => { setChatTab('team'); setDmRecipient(null); setShowMembers(false); }}
              className={cn('flex-1 py-2 text-xs font-medium text-center transition-colors', chatTab === 'team' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground')}
              data-testid="tool-dock-chat-tab-team"
            >
              {t('chat.tabs.team', 'Team')}
              {unreadCount > 0 && <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 bg-primary text-primary-foreground text-[9px] font-bold rounded-full">{unreadCount}</span>}
            </button>
            <button type="button" onClick={() => { setChatTab('dm'); setShowMembers(false); void dm.loadConversations(); }}
              className={cn('flex-1 py-2 text-xs font-medium text-center transition-colors', chatTab === 'dm' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground')}
              data-testid="tool-dock-chat-tab-dm"
            >
              {t('dm.title', 'Poruke')}
              {dm.totalUnread > 0 && <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-[16px] px-1 bg-primary text-primary-foreground text-[9px] font-bold rounded-full">{dm.totalUnread}</span>}
            </button>
          </div>
        )}

        {showMembers && !isWide && chatTab === 'team' ? <div className="flex-1 overflow-hidden">{membersList}</div> : chatTab === 'dm' ? (
          /* ─── DM View ─── */
          dmRecipient ? (
            /* DM Chat with specific user */
            <>
              <ScrollArea className="flex-1 relative">
                <div className="p-3 space-y-0.5 relative">
                  {dm.isLoading ? (
                    <div className="flex items-center justify-center py-14">
                      <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : dm.messages.length === 0 ? (
                    <div className="text-center py-14 space-y-3">
                      <div className="w-12 h-12 mx-auto bg-primary/8 flex items-center justify-center border border-primary/10">
                        <MessageSquare className="h-6 w-6 text-primary/30" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground/60">{t('dm.startTyping', 'Send a message to start the conversation')}</p>
                      </div>
                    </div>
                  ) : (
                    dm.messages.map((msg, i) => {
                      const own = msg.sender_id === user?.id;
                      const showAv = i === 0 || dm.messages[i - 1].sender_id !== msg.sender_id;
                      const sep = dateSeparator(dm.messages, i);
                      return (
                        <div key={msg.id}>
                          {sep && (
                            <div className="flex items-center gap-3 py-2 my-1">
                              <div className="flex-1 h-px bg-border" />
                              <span className="text-[9px] text-muted-foreground/50 font-medium uppercase tracking-wider">{sep}</span>
                              <div className="flex-1 h-px bg-border" />
                            </div>
                          )}
                          <div className={cn('flex gap-2 py-0.5', own ? 'flex-row-reverse' : 'flex-row')}>
                            {!own && showAv ? <Avatar className="h-6 w-6 mt-0.5 flex-shrink-0"><AvatarImage {...profilePicSources(dmRecipient.profilePicture)} /><AvatarFallback className="text-[9px] bg-muted">{getInitials(dmRecipient.firstName, dmRecipient.lastName, dmRecipient.username)}</AvatarFallback></Avatar>
                              : !own ? <div className="w-6 flex-shrink-0" /> : null}
                            <div className={cn('max-w-[78%] flex flex-col', own ? 'items-end' : 'items-start')}>
                              <div className={cn('px-2.5 py-1.5 text-[13px] leading-relaxed break-words', own ? 'bg-primary text-primary-foreground' : 'bg-muted/60 dark:bg-zinc-800/60 border border-border/40')}>
                                {msg.content}
                                <span className={cn('text-[9px] float-right mt-0.5 ml-2 tabular-nums select-none inline-flex items-center gap-0.5', own ? 'text-primary-foreground/50' : 'text-muted-foreground/50')}>
                                  {formatTime(msg.created_at)}
                                  {own && (msg.read_at ? <CheckCheck className="h-2.5 w-2.5" /> : <Check className="h-2.5 w-2.5 opacity-50" />)}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  {dm.typingUser && (
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1">
                      <span className="flex gap-[3px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                      <span className="font-medium">{dm.typingUser.username}</span> {t('dm.isTyping', 'tipka...')}
                    </div>
                  )}
                  <div ref={dmEndRef} />
                </div>
              </ScrollArea>
              <div className="relative px-3 py-2.5 flex items-center gap-2 border-t border-border bg-background flex-shrink-0">
                <input ref={dmInputRef} type="text" value={dmInputValue}
                  onChange={e => {
                    setDmInputValue(e.target.value);
                    if (dm.activeConversationId) {
                      dm.sendTyping(dm.activeConversationId, true);
                      if (dmTypingRef.current) clearTimeout(dmTypingRef.current);
                      dmTypingRef.current = setTimeout(() => { if (dm.activeConversationId) dm.sendTyping(dm.activeConversationId, false); }, 2000);
                    }
                  }}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && dmInputValue.trim()) { e.preventDefault(); void dm.sendMessage(dmRecipient.id, dmInputValue); setDmInputValue(''); } }}
                  placeholder={t('dm.placeholder', 'Upišite poruku...')}
                  className="flex-1 h-[40px] px-3 text-sm bg-muted/30 dark:bg-zinc-800/30 border border-border outline-none focus:ring-1 focus:ring-primary"
                  maxLength={4000}
                  data-testid="tool-dock-dm-input"
                />
                <button type="button"
                  onClick={() => { if (dmInputValue.trim()) { void dm.sendMessage(dmRecipient.id, dmInputValue); setDmInputValue(''); } }}
                  className={cn('flex-shrink-0 flex items-center justify-center transition-all duration-200', dmInputValue.trim() ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}
                  style={{ width: 40, height: 40 }}
                  data-testid="tool-dock-dm-send-button"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </>
          ) : (
            /* DM Conversation list */
            <ScrollArea className="flex-1">
              <div className="p-1">
                {dm.conversations.length === 0 ? (
                  <div className="text-center py-14 space-y-3">
                    <div className="w-12 h-12 mx-auto bg-primary/8 flex items-center justify-center border border-primary/10">
                      <MessageSquare className="h-6 w-6 text-primary/30" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground/60">{t('dm.noConversations', 'Još nema poruka')}</p>
                      <p className="text-[11px] text-muted-foreground/50 mt-0.5">{t('dm.startConversation', 'Započnite razgovor')}</p>
                    </div>
                  </div>
                ) : (
                  dm.conversations.map(conv => (
                    <button key={conv.id} type="button"
                      onClick={() => {
                        setDmRecipient({ id: conv.other_user_id, username: conv.other_username, firstName: conv.other_first_name, lastName: conv.other_last_name, profilePicture: conv.other_profile_picture });
                        void dm.openConversation(conv.id);
                      }}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/50 transition-colors text-left"
                      data-testid={`tool-dock-dm-conv-${conv.id}`}
                    >
                      <Avatar className="h-8 w-8 flex-shrink-0">
                        <AvatarImage {...profilePicSources(conv.other_profile_picture)} />
                        <AvatarFallback className="text-[10px] bg-primary/10 text-primary">{getInitials(conv.other_first_name, conv.other_last_name, conv.other_username)}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className={cn('text-xs truncate', conv.unread_count > 0 && 'font-semibold')}>{getDisplayName(conv.other_first_name, conv.other_last_name, conv.other_username)}</span>
                          {conv.last_message_at && <span className="text-[9px] text-muted-foreground/50 ml-2 flex-shrink-0">{formatTime(conv.last_message_at)}</span>}
                        </div>
                        <div className="flex items-center justify-between mt-0.5">
                          <span className="text-[11px] text-muted-foreground truncate">{conv.last_message || ''}</span>
                          {conv.unread_count > 0 && <span className="ml-1.5 flex-shrink-0 h-4 min-w-[16px] px-1 flex items-center justify-center bg-primary text-primary-foreground text-[9px] font-bold rounded-full">{conv.unread_count}</span>}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          )
        ) : showMembers && !isWide ? <div className="flex-1 overflow-hidden">{membersList}</div> : (
        <>
          <ScrollArea className="flex-1 relative">
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-[0.03]" aria-hidden="true"><img src="/providers/scrapalot.png" alt="" className="w-24 h-24" /></div>
            <div className="p-3 space-y-0.5 relative">
              {messages.length === 0 && (
                <div data-testid="tool-dock-chat-empty-state" className="text-center py-14 space-y-3">
                  <div className="w-12 h-12 mx-auto bg-primary/8 flex items-center justify-center border border-primary/10">
                    <MessageCircle className="h-6 w-6 text-primary/30" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground/60">{t('workspaceChat.noMessages', 'No messages yet')}</p>
                    <p className="text-[11px] text-muted-foreground/50 mt-0.5">{t('workspaceChat.sayHello', 'Say hello to your team!')}</p>
                  </div>
                </div>
              )}
              {messages.map((msg, i) => {
                const own = msg.sender_id === user?.id;
                const showAv = i === 0 || messages[i - 1].sender_id !== msg.sender_id;
                const sep = dateSeparator(messages, i);
                const canDelete = own || canModerate;
                const isActive = activeMessageId === msg.id;
                return (
                  <div key={msg.id}>
                    {sep && (
                      <div className="flex items-center gap-3 py-2 my-1">
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-[9px] text-muted-foreground/50 font-medium uppercase tracking-wider">{sep}</span>
                        <div className="flex-1 h-px bg-border" />
                      </div>
                    )}
                    <div className={cn('flex gap-2 py-0.5', own ? 'flex-row-reverse' : 'flex-row')}>
                      {!own && showAv ? <Avatar className="h-6 w-6 mt-0.5 flex-shrink-0"><AvatarImage {...profilePicSources(msg.sender_profile_picture)} /><AvatarFallback className="text-[9px] bg-muted">{getInitials(msg.sender_first_name, msg.sender_last_name, msg.sender_username)}</AvatarFallback></Avatar>
                        : !own ? <div className="w-6 flex-shrink-0" /> : null}
                      <div className={cn('max-w-[78%] flex flex-col group relative', own ? 'items-end' : 'items-start')}>
                        {!own && showAv && <div className="text-[10px] text-muted-foreground font-medium mb-0.5 px-1">{getDisplayName(msg.sender_first_name, msg.sender_last_name, msg.sender_username)}</div>}
                        <div
                          onClick={() => setActiveMessageId(p => p === msg.id ? null : msg.id)}
                          className={cn('px-2.5 py-1.5 text-[13px] leading-relaxed break-words cursor-pointer', own ? 'bg-primary text-primary-foreground' : 'bg-muted/60 dark:bg-zinc-800/60 border border-border/40')}
                        >
                          {msg.content}
                          <span className={cn('text-[9px] float-right mt-0.5 ml-2 tabular-nums select-none', own ? 'text-primary-foreground/50' : 'text-muted-foreground/50')}>{formatTime(msg.created_at)}</span>
                        </div>
                        <TooltipProvider delayDuration={250}>
                          <div
                            data-testid={`tool-dock-msg-actions-${msg.id}`}
                            className={cn(
                              'absolute -top-3 z-10 flex items-center gap-0.5 bg-popover border border-border shadow-sm px-0.5 py-0.5 transition-opacity',
                              own ? 'right-1' : 'left-1',
                              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                            )}
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button type="button"
                                  onClick={e => { e.stopPropagation(); void copyMessageText(msg.content); setActiveMessageId(null); }}
                                  data-testid={`tool-dock-msg-copy-${msg.id}`}
                                  className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                                  aria-label={t('workspaceChat.actions.copy', 'Kopiraj')}
                                >
                                  <Copy className="h-3 w-3" />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom" sideOffset={4} className="text-[11px] py-1 px-2">{t('workspaceChat.actions.copy', 'Kopiraj')}</TooltipContent>
                            </Tooltip>
                            {canDelete && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button type="button"
                                    onClick={e => { e.stopPropagation(); confirmAndDelete(msg.id); setActiveMessageId(null); }}
                                    data-testid={`tool-dock-msg-delete-${msg.id}`}
                                    className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                                    aria-label={t('workspaceChat.actions.delete', 'Obriši')}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" sideOffset={4} className="text-[11px] py-1 px-2">{t('workspaceChat.actions.delete', 'Obriši')}</TooltipContent>
                              </Tooltip>
                            )}
                            {canModerate && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button type="button"
                                    onClick={e => { e.stopPropagation(); confirmAndRollback(msg.id); setActiveMessageId(null); }}
                                    data-testid={`tool-dock-msg-rollback-${msg.id}`}
                                    className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-amber-600 hover:bg-amber-500/10 transition-colors"
                                    aria-label={t('workspaceChat.actions.rollback', 'Vrati razgovor na ovu točku')}
                                  >
                                    <Undo2 className="h-3 w-3" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" sideOffset={4} className="text-[11px] py-1 px-2">{t('workspaceChat.actions.rollback', 'Vrati razgovor na ovu točku')}</TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                        </TooltipProvider>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          </ScrollArea>

          {typingUsers.length > 0 && (
            <div className="px-4 py-1.5 text-[11px] text-muted-foreground flex items-center gap-2 border-t border-border/50">
              <span className="flex gap-[3px]">
                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-primary/40 animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
              <span><span className="font-medium">{typingUsers.map(u => u.username).join(', ')}</span> {typingUsers.length === 1 ? t('workspaceChat.isTyping', 'is typing...') : t('workspaceChat.areTyping', 'are typing...')}</span>
            </div>
          )}

          <div className="relative px-3 py-2.5 flex items-end gap-2 border-t border-border bg-background flex-shrink-0">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={e => { const f = e.target.files; if (f?.length) sendMessage(`📎 ${Array.from(f).map(x => x.name).join(', ')}`); e.target.value = ''; }} />
            {showEmoji && (
              <div ref={emojiRef} className={cn('absolute bottom-full mb-1 bg-background border border-border shadow-lg p-2.5 z-10', isMobile ? 'left-0 right-0 mx-2' : 'left-3 w-[260px]')}>
                {emojis.map((row, gi) => (
                  <div key={gi} className={gi > 0 ? 'mt-2 pt-2 border-t border-border' : ''}>
                    <div className={cn('grid gap-0.5', isMobile ? 'grid-cols-8' : 'grid-cols-10')}>
                      {row.map((e, ei) => <button key={ei} type="button" onMouseDown={ev => { ev.preventDefault(); setInputValue(p => p + e); setShowEmoji(false); inputRef.current?.focus(); }} onTouchEnd={ev => { ev.preventDefault(); setInputValue(p => p + e); setShowEmoji(false); inputRef.current?.focus(); }} className={cn('flex items-center justify-center hover:bg-primary/10 active:scale-90 transition-all', isMobile ? 'h-10 w-10 text-xl' : 'h-8 w-8 text-base')}>{e}</button>)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex-1 flex items-end gap-1 bg-muted/30 dark:bg-zinc-800/30 border border-border px-2 py-1 min-h-[40px]">
              <button type="button" onClick={() => setShowEmoji(!showEmoji)} className={cn('flex-shrink-0 h-8 w-8 flex items-center justify-center transition-colors', showEmoji ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground')} data-testid="tool-dock-chat-emoji-button"><Smile className="h-[18px] w-[18px]" /></button>
              <textarea ref={inputRef} value={inputValue} onChange={e => { handleInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px'; }}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); if (inputRef.current) inputRef.current.style.height = 'auto'; } }}
                placeholder={t('workspaceChat.typeMessage', 'Type a message...')} className="flex-1 bg-transparent text-sm border-none outline-none resize-none placeholder:text-muted-foreground/40 py-1.5 max-h-[100px] leading-normal" maxLength={4000} rows={1} data-testid="tool-dock-chat-input" />
              <button type="button" onClick={() => fileRef.current?.click()} className="flex-shrink-0 h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors" data-testid="tool-dock-chat-attach-button"><Paperclip className="h-[18px] w-[18px]" /></button>
            </div>
            <button type="button" onClick={() => { if (inputValue.trim()) { handleSend(); if (inputRef.current) inputRef.current.style.height = 'auto'; } else handleVoice(); }}
              data-testid="tool-dock-chat-send-button"
              className={cn('flex-shrink-0 flex items-center justify-center transition-all duration-200', isRecording ? 'bg-destructive text-destructive-foreground animate-pulse' : inputValue.trim() ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')} style={{ width: 40, height: 40 }}>
              {inputValue.trim() ? <Send className="h-4 w-4" /> : <Mic className="h-[18px] w-[18px]" />}
            </button>
          </div>
        </>
        )}
      </div>
    </div>
  );

  // ─── Render ───────────────────────────────────────────────

  return (
    <>
      {!isMobile && (
        <>
          {!isDockOpen && <div data-tool-dock className="fixed right-0 top-0 bottom-0 w-2 z-[2147483646] pointer-events-auto" style={{ pointerEvents: 'auto' }} onMouseEnter={() => setHoverVisible(true)} />}
          {(hoverVisible || isDockOpen) && (
            <div data-tool-dock className={cn('fixed right-0 lg:-right-1 top-1/2 -translate-y-1/2 z-[2147483647] flex items-center transition-all duration-200 pointer-events-auto')}
              style={{ pointerEvents: 'auto' }}
              onMouseLeave={() => { if (!isDockOpen) setHoverVisible(false); }}>
              {isDockOpen && <div data-testid="tool-dock-container" className="bg-background/90 backdrop-blur-md border-l border-y border-border shadow-lg flex flex-col items-center opacity-50 hover:opacity-100 transition-opacity duration-200">{buttons}</div>}
              <button type="button" onClick={() => setIsDockOpen(p => !p)}
                data-testid="tool-dock-toggle"
                className={cn('flex items-center justify-center bg-background/80 backdrop-blur-sm border border-border border-r-0 shadow-sm text-muted-foreground hover:text-foreground hover:bg-muted/50', isDockOpen ? 'w-5 h-10' : 'w-6 h-12')}>
                {isDockOpen ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3.5 w-3.5" />}
                {!isDockOpen && unreadCount > 0 && <span className="absolute -top-1 -left-1 bg-destructive text-destructive-foreground text-[8px] font-bold h-3.5 min-w-[14px] flex items-center justify-center px-0.5">{unreadCount > 99 ? '99+' : unreadCount}</span>}
              </button>
            </div>
          )}
        </>
      )}

      {isMobile && (
        <>
          {!mobileOpen && !isChatOpen && (
            <div data-tool-dock className="fixed right-0 top-1/2 -translate-y-1/2 z-[2147483647] w-8 h-20 flex items-center justify-center pointer-events-auto"
              style={{ pointerEvents: 'auto' }}
              onClick={() => setMobileOpen(true)}>
              {/* Visible bar (12px wide) */}
              <span className="absolute right-0 top-0 bottom-0 w-3 bg-muted/60 border-l border-y border-border flex items-center justify-center">
                <ChevronLeft className="h-3 w-3 text-muted-foreground" />
              </span>
              {unreadCount > 0 && <span className="absolute -top-1 -left-2 bg-destructive text-destructive-foreground text-[8px] font-bold h-3.5 min-w-[14px] flex items-center justify-center px-0.5">{unreadCount > 99 ? '99+' : unreadCount}</span>}
            </div>
          )}
          {mobileOpen && (
            <>
              <div data-tool-dock className="fixed inset-0 z-[2147483646] bg-black/30 pointer-events-auto" style={{ pointerEvents: 'auto' }} onClick={() => setMobileOpen(false)} />
              <div data-tool-dock className="fixed right-0 top-1/2 -translate-y-1/2 z-[2147483647] bg-background border-l border-border shadow-lg pointer-events-auto" style={{ pointerEvents: 'auto' }}>{buttons}</div>
            </>
          )}
        </>
      )}

      {chatContent}

      <VideoCallOverlay
        callState={videoCall.callState} remoteUser={videoCall.remoteUser}
        isMuted={videoCall.isMuted} isVideoOff={videoCall.isVideoOff}
        callDuration={videoCall.callDuration} localVideoRef={videoCall.localVideoRef}
        remoteVideoRef={videoCall.remoteVideoRef} onAccept={videoCall.acceptCall}
        onHangUp={videoCall.hangUp} onToggleMute={videoCall.toggleMute} onToggleVideo={videoCall.toggleVideo}
      />
    </>
  );
}
