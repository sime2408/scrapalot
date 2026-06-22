import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen,
  Bot,
  Laptop,
  MessageSquare,
  Network,
  NotebookPen,
  Server,
  Terminal,
  Users,
} from 'lucide-react';
import { SectionHeading } from '@/components/landing';

/* ------------------------------------------------------------------ */
/* Showcase data — real, privacy-sanitized dashboard screenshots       */
/* ------------------------------------------------------------------ */

interface ShowcaseItem {
  key: string;
  icon: React.ElementType;
  label: string;
  blurb: string;
  image: string;
}

const ITEMS: ShowcaseItem[] = [
  {
    key: 'chat',
    icon: Bot,
    label: 'Agentic chat',
    blurb: 'Ask your whole library anything. Agentic RAG picks the retrieval strategy and every answer cites its sources.',
    image: '/product/dashboard/chat-conversation.png',
  },
  {
    key: 'library',
    icon: BookOpen,
    label: 'Library',
    blurb: 'Collections, covers, ratings, processing status and graph health for every book and paper you own.',
    image: '/product/dashboard/knowledge-library.png',
  },
  {
    key: 'notes',
    icon: NotebookPen,
    label: 'Notes editor',
    blurb: 'A full document editor with AI assist, suggested titles, citations-to-note and real-time collaboration.',
    image: '/product/dashboard/notes-editor.png',
  },
  {
    key: 'providers',
    icon: Server,
    label: 'AI providers',
    blurb: 'Bring your own keys: Anthropic, DeepSeek, Groq, OpenRouter, LM Studio and more — switch models per chat.',
    image: '/product/dashboard/settings-providers.png',
  },
  {
    key: 'local-ai',
    icon: Laptop,
    label: 'Local AI',
    blurb: 'Run GGUF models on your own hardware with llama.cpp — private inference, no cloud required.',
    image: '/product/dashboard/settings-local-ai.png',
  },
  {
    key: 'prompts',
    icon: MessageSquare,
    label: 'Prompt library',
    blurb: 'System prompts, custom templates and research templates — tuned once, reused everywhere.',
    image: '/product/dashboard/settings-prompts.png',
  },
  {
    key: 'team',
    icon: Users,
    label: 'Team chat',
    blurb: 'A real-time team panel with presence, DMs and file sharing — right next to your research.',
    image: '/product/dashboard/team-chat.png',
  },
  {
    key: 'palette',
    icon: Terminal,
    label: 'Command palette',
    blurb: 'Ctrl+K to jump anywhere — workspaces, collections, notes and actions in one keystroke.',
    image: '/product/dashboard/command-palette.png',
  },
  {
    key: 'inspector',
    icon: Network,
    label: 'Data inspector',
    blurb: 'For admins: 378K-node knowledge graph health, RAG traces, costs and housekeeping — fully transparent.',
    image: '/product/dashboard/admin-housekeeping.png',
  },
];

const ROTATE_MS = 6500;

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export const WorkspaceShowcase: React.FC = () => {
  const [activeIdx, setActiveIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  const select = useCallback((idx: number) => {
    setActiveIdx(idx);
    setPaused(true); // user took control — stop auto-rotation
  }, []);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setActiveIdx(prev => (prev + 1) % ITEMS.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [paused]);

  const active = ITEMS[activeIdx];

  return (
    <section className='relative py-24'>
      <div className='landing-hairline absolute inset-x-0 top-0 mx-auto max-w-5xl' />
      <div className='mx-auto max-w-7xl px-4 sm:px-6 lg:px-8'>
        <SectionHeading
          eyebrow='Inside the workspace'
          title={
            <>
              Every tool, <span className='landing-gradient-text italic'>one quiet surface</span>
            </>
          }
          subtitle='The quick-tools rail keeps the whole research stack one click away — here is what each button opens.'
        />

        <div
          className='mt-12 grid gap-6 lg:grid-cols-[280px_1fr]'
          onMouseEnter={() => setPaused(true)}
        >
          {/* Tool list — vertical on desktop, chip scroll on mobile */}
          <div className='flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0'>
            {ITEMS.map((item, idx) => {
              const isActive = idx === activeIdx;
              return (
                <button
                  key={item.key}
                  onClick={() => select(idx)}
                  data-testid={`about-showcase-tab-${item.key}`}
                  className={`group relative flex shrink-0 items-center gap-3 border px-4 py-2.5 text-left transition-all lg:w-full ${
                    isActive
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-foreground/10 bg-foreground/[0.03] opacity-70 hover:border-primary/25 hover:opacity-100'
                  }`}
                >
                  <item.icon
                    className={`h-4 w-4 shrink-0 ${isActive ? 'text-primary' : 'opacity-60'}`}
                  />
                  <span className='whitespace-nowrap text-sm font-medium lg:whitespace-normal'>
                    {item.label}
                  </span>
                  {isActive && !paused && (
                    <motion.span
                      key={`progress-${activeIdx}`}
                      className='absolute bottom-0 left-0 h-0.5 bg-primary/60'
                      initial={{ width: '0%' }}
                      animate={{ width: '100%' }}
                      transition={{ duration: ROTATE_MS / 1000, ease: 'linear' }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Preview window */}
          <div className='min-w-0'>
            <div className='landing-glass relative overflow-hidden'>
              {/* window chrome */}
              <div className='flex items-center gap-3 border-b border-foreground/10 px-4 py-2.5'>
                <div className='flex gap-1.5'>
                  <span className='h-2.5 w-2.5 rounded-full bg-red-400/90' />
                  <span className='h-2.5 w-2.5 rounded-full bg-amber-400/90' />
                  <span className='h-2.5 w-2.5 rounded-full bg-emerald-400/90' />
                </div>
                <div className='flex flex-1 justify-center'>
                  <AnimatePresence mode='wait'>
                    <motion.div
                      key={active.key}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.2 }}
                      className='flex items-center gap-2 border border-foreground/10 bg-foreground/5 px-3 py-1 font-mono text-[10px] tracking-wider opacity-70'
                    >
                      <active.icon className='h-3 w-3 text-primary' />
                      scrapalot.app · {active.label.toLowerCase()}
                    </motion.div>
                  </AnimatePresence>
                </div>
                <div className='w-12' />
              </div>

              {/* viewport */}
              <div className='relative aspect-[16/10] w-full'>
                <AnimatePresence mode='wait'>
                  <motion.img
                    key={active.key}
                    src={active.image}
                    alt={`Scrapalot — ${active.label}`}
                    loading='lazy'
                    className='absolute inset-0 h-full w-full object-cover object-top'
                    initial={{ opacity: 0, scale: 0.99 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.99 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                  />
                </AnimatePresence>
              </div>
            </div>

            {/* caption */}
            <AnimatePresence mode='wait'>
              <motion.p
                key={active.key}
                className='mt-4 text-sm leading-relaxed opacity-70'
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 0.7, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25 }}
              >
                {active.blurb}
              </motion.p>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
};

export default WorkspaceShowcase;
