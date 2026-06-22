import React, { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/providers/theme-provider';
import { AuthContext } from '@/contexts/auth-context';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Globe,
  GraduationCap,
  Layers,
  Mic,
  Network,
  ScanText,
  Search,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react';
import SharedHeader from '@/components/shared/header';
import {
  AnimatedCounter,
  AuroraBackground,
  BlurWords,
  LandingFooter,
  Marquee,
  SectionHeading,
  SpotlightCard,
} from '@/components/landing';

/* ------------------------------------------------------------------ */
/* Product window scenes — abstract, accent-aware previews             */
/* ------------------------------------------------------------------ */

const ChatScene: React.FC = () => (
  <div className='flex h-full w-full flex-col justify-center gap-3 px-8 py-6 sm:px-12'>
    {/* user bubble */}
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className='ml-auto max-w-[70%] border border-primary/30 bg-primary/10 px-4 py-2.5'
    >
      <div className='h-2 w-40 max-w-full bg-primary/40' />
      <div className='mt-1.5 h-2 w-24 bg-primary/25' />
    </motion.div>
    {/* assistant bubble */}
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35 }}
      className='max-w-[80%] border border-foreground/10 bg-foreground/5 px-4 py-3'
    >
      <div className='h-2 w-52 max-w-full bg-foreground/25' />
      <div className='mt-1.5 h-2 w-44 max-w-full bg-foreground/20' />
      <div className='mt-1.5 h-2 w-48 max-w-full bg-foreground/15' />
      {/* citation chips */}
      <div className='mt-3 flex gap-1.5'>
        <span className='flex items-center gap-1 border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary'>
          <FileText className='h-2.5 w-2.5' /> p. 64
        </span>
        <span className='flex items-center gap-1 border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary'>
          <FileText className='h-2.5 w-2.5' /> ch. 4
        </span>
      </div>
    </motion.div>
    {/* typing dots */}
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.6 }}
      className='flex w-14 items-center justify-center gap-1 border border-foreground/10 bg-foreground/5 px-3 py-2.5'
    >
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className='h-1.5 w-1.5 rounded-full bg-primary'
          style={{ animation: `dot-pulse 1.4s ${i * 0.2}s infinite ease-in-out` }}
        />
      ))}
    </motion.div>
  </div>
);

const GRAPH_NODES: { x: number; y: number; r: number; tone: 'a' | 'b' }[] = [
  { x: 70, y: 60, r: 13, tone: 'a' },
  { x: 190, y: 36, r: 9, tone: 'b' },
  { x: 300, y: 72, r: 11, tone: 'a' },
  { x: 130, y: 140, r: 8, tone: 'b' },
  { x: 250, y: 150, r: 12, tone: 'b' },
  { x: 350, y: 130, r: 7, tone: 'a' },
  { x: 40, y: 160, r: 6, tone: 'a' },
];

const GRAPH_EDGES: [number, number][] = [
  [0, 1], [1, 2], [0, 3], [3, 4], [2, 4], [4, 5], [3, 6], [0, 6], [1, 4],
];

const GraphScene: React.FC = () => (
  <div className='flex h-full w-full items-center justify-center'>
    <svg viewBox='0 0 400 200' className='h-full max-h-[230px] w-full max-w-md'>
      {GRAPH_EDGES.map(([a, b], i) => (
        <line
          key={i}
          x1={GRAPH_NODES[a].x}
          y1={GRAPH_NODES[a].y}
          x2={GRAPH_NODES[b].x}
          y2={GRAPH_NODES[b].y}
          stroke='hsl(var(--primary) / 0.35)'
          strokeWidth='1'
          strokeDasharray='4 4'
          style={{ animation: `landing-dash 1.6s linear infinite`, animationDelay: `${i * 0.15}s` }}
        />
      ))}
      {GRAPH_NODES.map((n, i) => (
        <g key={i}>
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r + 6}
            fill='none'
            stroke={n.tone === 'a' ? 'hsl(var(--primary) / 0.35)' : 'hsl(var(--glow-2) / 0.35)'}
            strokeWidth='1'
            style={{
              transformOrigin: `${n.x}px ${n.y}px`,
              animation: `landing-pulse-ring 2.6s ${i * 0.35}s ease-out infinite`,
            }}
          />
          <circle
            cx={n.x}
            cy={n.y}
            r={n.r}
            fill={n.tone === 'a' ? 'hsl(var(--primary) / 0.2)' : 'hsl(var(--glow-2) / 0.16)'}
            stroke={n.tone === 'a' ? 'hsl(var(--primary))' : 'hsl(var(--glow-2))'}
            strokeWidth='1.5'
          />
        </g>
      ))}
    </svg>
  </div>
);

const RESEARCH_PHASES = ['Plan', 'Search', 'Read', 'Verify', 'Write'];

const ResearchScene: React.FC = () => (
  <div className='flex h-full w-full flex-col justify-center gap-4 px-8 sm:px-14'>
    {RESEARCH_PHASES.map((phase, i) => (
      <motion.div
        key={phase}
        className='flex items-center gap-4'
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.1 + i * 0.12 }}
      >
        <span className='font-mono text-[10px] tracking-widest text-primary'>
          0{i + 1}
        </span>
        <span className='w-14 text-xs font-medium opacity-80'>{phase}</span>
        <div className='relative h-1.5 flex-1 overflow-hidden bg-foreground/10'>
          <motion.div
            className='h-full'
            style={{
              background: 'linear-gradient(90deg, hsl(var(--primary)), hsl(var(--glow-2)))',
            }}
            initial={{ width: '0%' }}
            animate={{ width: `${100 - i * 16}%` }}
            transition={{ delay: 0.3 + i * 0.12, duration: 0.9, ease: 'easeOut' }}
          />
        </div>
      </motion.div>
    ))}
  </div>
);

const ViewerScene: React.FC = () => (
  <div className='flex h-full w-full'>
    {/* TOC rail */}
    <div className='hidden w-40 shrink-0 flex-col gap-2.5 border-r border-foreground/10 p-5 sm:flex'>
      <div className='mb-2 h-2.5 w-20 bg-primary/40' />
      {[60, 84, 72, 90, 66, 78].map((w, i) => (
        <div key={i} className='h-2 bg-foreground/15' style={{ width: `${w}px` }} />
      ))}
    </div>
    {/* page */}
    <div className='relative flex-1 px-6 py-5 sm:px-10'>
      <div className='mx-auto max-w-md space-y-2.5'>
        <div className='mb-3 h-3 w-2/3 bg-foreground/25' />
        {[100, 92, 96].map((w, i) => (
          <div key={i} className='h-2 bg-foreground/10' style={{ width: `${w}%` }} />
        ))}
        {/* highlighted passage with annotation chip */}
        <div className='relative h-2 w-[95%]'>
          <div className='absolute inset-0 bg-primary/30' />
          <motion.div
            className='absolute -right-2 -top-9 flex items-center gap-1.5 border border-primary/40 bg-background px-2 py-1'
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
          >
            <span className='h-2.5 w-2.5 rounded-full bg-amber-400' />
            <span className='h-2.5 w-2.5 rounded-full bg-emerald-400' />
            <span className='h-2.5 w-2.5 rounded-full bg-primary' />
            <span className='font-mono text-[8px] uppercase tracking-wider opacity-60'>
              highlight · note · chat
            </span>
          </motion.div>
        </div>
        {[90, 97, 85, 70].map((w, i) => (
          <div key={i} className='h-2 bg-foreground/10' style={{ width: `${w}%` }} />
        ))}
      </div>
      {/* page nav */}
      <div className='absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-3 border border-foreground/10 bg-foreground/5 px-3 py-1 font-mono text-[10px] opacity-70'>
        <span>‹</span> 64 / 312 <span>›</span>
      </div>
    </div>
  </div>
);

const VoiceScene: React.FC = () => (
  <div className='flex h-full w-full flex-col items-center justify-center gap-6'>
    <div className='relative flex h-16 w-16 items-center justify-center rounded-full border border-primary/40 bg-primary/10'>
      <span
        className='absolute inset-0 rounded-full border border-primary/40'
        style={{ animation: 'landing-pulse-ring 2.4s ease-out infinite' }}
      />
      <Mic className='h-7 w-7 text-primary' />
    </div>
    <div className='flex items-end gap-1'>
      {[12, 22, 34, 26, 42, 30, 46, 24, 36, 18, 30, 14].map((h, i) => (
        <span
          key={i}
          className='w-1.5 bg-primary/70'
          style={{
            height: `${h}px`,
            animation: `voice-bar 1.1s ease-in-out ${i * 0.09}s infinite`,
            transformOrigin: 'bottom',
          }}
        />
      ))}
    </div>
    <div className='px-4 text-center font-mono text-[10px] uppercase tracking-[0.18em] opacity-50'>
      Push to talk · live transcript · spoken answers
    </div>
  </div>
);

const COLLAB_USERS = [
  { initials: 'AK', offset: 0 },
  { initials: 'MR', offset: 1 },
  { initials: 'JS', offset: 2 },
];

const CollabScene: React.FC = () => (
  <div className='relative flex h-full w-full flex-col items-center justify-center gap-5'>
    <div className='flex -space-x-2.5'>
      {COLLAB_USERS.map((u, i) => (
        <motion.div
          key={u.initials}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.15 + i * 0.12, type: 'spring', stiffness: 220 }}
          className='flex h-11 w-11 items-center justify-center rounded-full border-2 border-background bg-primary/15 font-mono text-[11px] font-semibold text-primary'
          style={{ zIndex: 3 - i }}
        >
          {u.initials}
        </motion.div>
      ))}
      <motion.div
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.55 }}
        className='flex h-11 w-11 items-center justify-center rounded-full border-2 border-dashed border-foreground/25 font-mono text-[11px] opacity-60'
      >
        +9
      </motion.div>
    </div>
    <motion.div
      className='w-2/3 space-y-2'
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.5 }}
    >
      <div className='h-2 w-full bg-foreground/15' />
      <div className='h-2 w-5/6 bg-foreground/10' />
      <div className='relative h-2 w-2/3 bg-foreground/10'>
        {/* live cursor */}
        <motion.div
          className='absolute -top-3 left-0 flex items-center gap-1'
          animate={{ left: ['0%', '85%', '30%', '60%'] }}
          transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
        >
          <div className='h-3 w-3 rotate-12' style={{ background: 'hsl(var(--glow-2))', clipPath: 'polygon(0 0, 100% 35%, 40% 50%, 55% 100%)' }} />
          <span className='px-1 font-mono text-[8px] text-white' style={{ background: 'hsl(var(--glow-2))' }}>
            Maya
          </span>
        </motion.div>
      </div>
    </motion.div>
  </div>
);

/* ------------------------------------------------------------------ */
/* Hero product window with scene carousel                             */
/* ------------------------------------------------------------------ */

const SCENES = [
  { key: 'chat', label: 'Talk to documents', caption: 'Ask your library anything — every answer cites its sources.', Scene: ChatScene },
  { key: 'graph', label: 'Knowledge graph', caption: 'Entities and ideas linked across every book you own.', Scene: GraphScene },
  { key: 'research', label: 'Deep research', caption: 'Five-phase autonomous research with verified findings.', Scene: ResearchScene },
  { key: 'viewer', label: 'PDF · EPUB · DOCX', caption: 'Read with highlights, margin notes and one-click chat about any passage.', Scene: ViewerScene },
  { key: 'voice', label: 'Voice chat', caption: 'Talk to your library hands-free — transcription in, spoken answers out.', Scene: VoiceScene },
  { key: 'collab', label: 'Collaboration', caption: 'Shared workspaces, notes and live co-editing for teams.', Scene: CollabScene },
];

const ProductWindow: React.FC = () => {
  const [current, setCurrent] = useState(0);
  const [isHovered, setIsHovered] = useState(false);

  const nextSlide = useCallback(
    () => setCurrent(prev => (prev + 1) % SCENES.length),
    []
  );
  const prevSlide = useCallback(
    () => setCurrent(prev => (prev - 1 + SCENES.length) % SCENES.length),
    []
  );

  useEffect(() => {
    if (isHovered) return;
    const interval = setInterval(nextSlide, 6000);
    return () => clearInterval(interval);
  }, [isHovered, nextSlide]);

  const { Scene, caption, label } = SCENES[current];

  return (
    <motion.div
      className='relative mx-auto w-full max-w-4xl'
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.5, ease: 'easeOut' }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* glow under the window */}
      <div
        aria-hidden='true'
        className='absolute -inset-x-8 -bottom-10 top-1/3 -z-[1]'
        style={{
          background:
            'radial-gradient(60% 70% at 50% 100%, hsl(var(--primary) / 0.25), transparent 70%)',
          filter: 'blur(24px)',
        }}
      />

      <div className='landing-glass relative overflow-hidden'>
        {/* window chrome */}
        <div className='flex items-center gap-3 border-b border-foreground/10 px-4 py-2.5'>
          <div className='flex gap-1.5'>
            <span className='h-2.5 w-2.5 rounded-full bg-red-400/90' />
            <span className='h-2.5 w-2.5 rounded-full bg-amber-400/90' />
            <span className='h-2.5 w-2.5 rounded-full bg-emerald-400/90' />
          </div>
          <div className='flex flex-1 justify-center'>
            <div className='flex items-center gap-2 border border-foreground/10 bg-foreground/5 px-3 py-1 font-mono text-[10px] tracking-wider opacity-70'>
              <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
              scrapalot.app/dashboard
            </div>
          </div>
          <div className='w-12' />
        </div>

        {/* scene viewport */}
        <div className='relative h-[300px] sm:h-[340px]'>
          <AnimatePresence mode='wait'>
            <motion.div
              key={current}
              className='absolute inset-0'
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.985 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              <Scene />
            </motion.div>
          </AnimatePresence>

          {/* nav buttons */}
          <motion.button
            data-testid='home-carousel-prev-button'
            onClick={prevSlide}
            className='landing-glass absolute left-3 top-1/2 z-[1] flex h-9 w-9 -translate-y-1/2 items-center justify-center opacity-70 transition-opacity hover:opacity-100'
            whileHover={{ scale: 1.08, x: -2 }}
            whileTap={{ scale: 0.92 }}
            aria-label='Previous preview'
          >
            <ChevronLeft className='h-4 w-4' />
          </motion.button>
          <motion.button
            data-testid='home-carousel-next-button'
            onClick={nextSlide}
            className='landing-glass absolute right-3 top-1/2 z-[1] flex h-9 w-9 -translate-y-1/2 items-center justify-center opacity-70 transition-opacity hover:opacity-100'
            whileHover={{ scale: 1.08, x: 2 }}
            whileTap={{ scale: 0.92 }}
            aria-label='Next preview'
          >
            <ChevronRight className='h-4 w-4' />
          </motion.button>
        </div>

        {/* caption + dots */}
        <div className='flex flex-col gap-2 border-t border-foreground/10 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between'>
          <AnimatePresence mode='wait'>
            <motion.div
              key={current}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
              className='min-w-0'
            >
              <span className='font-mono text-[10px] uppercase tracking-[0.18em] text-primary'>
                {label}
              </span>
              <p className='truncate text-xs opacity-60'>{caption}</p>
            </motion.div>
          </AnimatePresence>
          <div className='flex shrink-0 items-center gap-2'>
            {SCENES.map((s, index) => (
              <button
                key={s.key}
                onClick={() => setCurrent(index)}
                aria-label={`Show ${s.label}`}
                className='group flex h-4 items-center'
              >
                <span
                  className={`h-1 transition-all duration-300 ${
                    index === current
                      ? 'w-7 bg-primary'
                      : 'w-3 bg-foreground/20 group-hover:bg-foreground/40'
                  }`}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* floating status chips */}
      <motion.div
        className='landing-glass landing-float absolute -right-3 -top-5 hidden items-center gap-2 px-3 py-2 sm:flex'
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.1, duration: 0.5 }}
      >
        <span className='relative flex h-2 w-2'>
          <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60' />
          <span className='relative inline-flex h-2 w-2 rounded-full bg-emerald-500' />
        </span>
        <span className='font-mono text-[10px] tracking-wider opacity-80'>
          AI RESEARCH ACTIVE
        </span>
      </motion.div>

      <motion.div
        className='landing-glass landing-float absolute -bottom-5 -left-3 hidden items-center gap-2 px-3 py-2 sm:flex'
        style={{ animationDelay: '1.4s' }}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.3, duration: 0.5 }}
      >
        <Users className='h-3.5 w-3.5 text-primary' />
        <span className='font-mono text-[10px] tracking-wider opacity-80'>
          TEAM COLLABORATION
        </span>
      </motion.div>
    </motion.div>
  );
};

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

const HERO_STATS = [
  { value: 50, suffix: 'K+', label: 'Documents analyzed' },
  { value: 99.9, suffix: '%', decimals: 1, label: 'Citation accuracy' },
  { value: 1, suffix: 'K+', label: 'Research teams' },
];

const HeroSection: React.FC = () => {
  const navigate = useNavigate();

  return (
    <section className='relative overflow-hidden'>
      <AuroraBackground variant='hero' />

      <div className='relative mx-auto max-w-7xl px-4 pb-20 pt-36 sm:px-6 sm:pt-40 lg:px-8'>
        <div className='mx-auto max-w-3xl text-center'>
          {/* badge */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className='mb-7 inline-flex items-center gap-2.5 border border-primary/25 bg-primary/5 py-1.5 pl-2 pr-3.5 backdrop-blur-sm'
          >
            <span className='flex items-center gap-1.5 bg-primary/15 px-2 py-0.5'>
              <Sparkles className='h-3 w-3 text-primary' />
              <span className='font-mono text-[10px] font-semibold tracking-wider text-primary'>NEW</span>
            </span>
            <span className='landing-eyebrow !tracking-[0.14em] text-foreground/70'>
              AI Scientist · Deep Research · Knowledge Graphs
            </span>
          </motion.div>

          {/* headline — word-by-word blur reveal */}
          <h1 className='font-display text-5xl font-medium leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl'>
            <BlurWords text='Turn every document' delay={0.12} />
            <br />
            <BlurWords text='into' delay={0.42} />{' '}
            <BlurWords
              text='a discovery.'
              delay={0.54}
              wordClassName='landing-gradient-text italic'
            />
          </h1>

          {/* subline */}
          <motion.p
            className='mx-auto mt-6 max-w-2xl text-base leading-relaxed opacity-70 sm:text-lg'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.25, ease: 'easeOut' }}
          >
            Scrapalot is your AI research assistant — chat with PDFs and books,
            run five-phase deep research, and map ideas across your whole library
            with knowledge graphs.
          </motion.p>

          {/* CTAs */}
          <motion.div
            className='mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row'
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.38, ease: 'easeOut' }}
          >
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                data-testid='home-get-started-button'
                size='lg'
                className='landing-btn-primary h-12 px-8 text-base font-medium'
                onClick={() => navigate('/dashboard')}
              >
                Start researching — free
                <ArrowRight className='ml-2 h-4 w-4' />
              </Button>
            </motion.div>
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                data-testid='home-view-docs-button'
                size='lg'
                variant='outline'
                className='landing-btn-ghost h-12 border-0 px-8 text-base font-medium'
                onClick={() => window.open('https://docs.scrapalot.app', '_blank')}
              >
                <BookOpen className='mr-2 h-4 w-4' />
                View Docs
              </Button>
            </motion.div>
          </motion.div>

          {/* stats */}
          <motion.div
            className='mx-auto mt-12 flex max-w-xl items-stretch justify-center divide-x divide-foreground/10'
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.55 }}
          >
            {HERO_STATS.map(stat => (
              <div key={stat.label} className='flex-1 px-4 sm:px-8'>
                <div className='font-display text-2xl font-medium text-foreground sm:text-3xl'>
                  <AnimatedCounter
                    value={stat.value}
                    suffix={stat.suffix}
                    decimals={stat.decimals ?? 0}
                  />
                </div>
                <div className='mt-1 font-mono text-[10px] uppercase tracking-[0.14em] opacity-50'>
                  {stat.label}
                </div>
              </div>
            ))}
          </motion.div>
        </div>

        {/* product preview */}
        <div className='mt-16 sm:mt-20'>
          <ProductWindow />
        </div>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------ */
/* Capability marquee                                                  */
/* ------------------------------------------------------------------ */

const CAPABILITIES = [
  { icon: Bot, label: 'AI Scientist' },
  { icon: Search, label: 'Deep Research' },
  { icon: Network, label: 'Knowledge Graphs' },
  { icon: Layers, label: '22 RAG Strategies' },
  { icon: FileText, label: 'Talk to PDFs' },
  { icon: ScanText, label: 'Built-in OCR' },
  { icon: GraduationCap, label: 'Research Papers' },
  { icon: Mic, label: 'Voice Chat' },
  { icon: Globe, label: 'Web Intelligence' },
  { icon: Workflow, label: 'Multi-Agent Pipelines' },
];

const CapabilityMarquee: React.FC = () => (
  <section className='relative py-10'>
    <div className='landing-hairline mx-auto mb-10 max-w-5xl' />
    <Marquee
      className='mx-auto max-w-6xl'
      items={CAPABILITIES.map(cap => (
        <div
          key={cap.label}
          className='flex items-center gap-2.5 border border-foreground/10 bg-foreground/[0.03] px-4 py-2.5 transition-colors hover:border-primary/30'
        >
          <cap.icon className='h-4 w-4 text-primary' />
          <span className='whitespace-nowrap font-mono text-xs tracking-wide opacity-75'>
            {cap.label}
          </span>
        </div>
      ))}
    />
  </section>
);

/* ------------------------------------------------------------------ */
/* Features bento                                                      */
/* ------------------------------------------------------------------ */

const MiniBars: React.FC = () => (
  <div className='mt-6 flex items-end gap-1.5 opacity-80'>
    {[34, 58, 42, 72, 50, 88, 64, 96, 70, 100, 80, 60].map((h, i) => (
      <motion.div
        key={i}
        className='w-2.5'
        style={{
          background: i % 3 === 0 ? 'hsl(var(--glow-2) / 0.7)' : 'hsl(var(--primary) / 0.55)',
        }}
        initial={{ height: 0 }}
        whileInView={{ height: `${h * 0.5}px` }}
        viewport={{ once: true }}
        transition={{ delay: 0.2 + i * 0.05, duration: 0.5, ease: 'easeOut' }}
      />
    ))}
  </div>
);

const MiniGraph: React.FC = () => (
  <svg viewBox='0 0 220 90' className='mt-5 w-full opacity-90'>
    {[[20, 60, 90, 25], [90, 25, 170, 50], [90, 25, 60, 75], [170, 50, 205, 22]].map(
      ([x1, y1, x2, y2], i) => (
        <line
          key={i}
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke='hsl(var(--primary) / 0.4)'
          strokeWidth='1'
          strokeDasharray='3 3'
          style={{ animation: 'landing-dash 1.8s linear infinite' }}
        />
      )
    )}
    {[[20, 60, 7], [90, 25, 9], [170, 50, 7], [60, 75, 5], [205, 22, 5]].map(([cx, cy, r], i) => (
      <circle
        key={i}
        cx={cx} cy={cy} r={r}
        fill={i % 2 ? 'hsl(var(--glow-2) / 0.2)' : 'hsl(var(--primary) / 0.2)'}
        stroke={i % 2 ? 'hsl(var(--glow-2))' : 'hsl(var(--primary))'}
        strokeWidth='1.2'
      />
    ))}
  </svg>
);

interface FeatureCardData {
  icon: React.ElementType;
  title: string;
  description: string;
  className: string;
  visual?: React.ReactNode;
}

const FEATURES: FeatureCardData[] = [
  {
    icon: Bot,
    title: 'AI Scientist',
    description:
      'An autonomous research agent that plans, searches, reads, verifies and writes — producing cited reports and full scientific papers from your sources.',
    className: 'md:col-span-4',
    visual: <MiniBars />,
  },
  {
    icon: FileText,
    title: 'Talk to Documents',
    description:
      'Upload PDFs, EPUBs and papers, then ask questions in plain language. Every answer carries page-level citations.',
    className: 'md:col-span-2',
  },
  {
    icon: Network,
    title: 'Knowledge Graphs',
    description:
      'Entities, concepts and their relationships extracted automatically and linked across your entire library.',
    className: 'md:col-span-2',
    visual: <MiniGraph />,
  },
  {
    icon: Users,
    title: 'Team Collaboration',
    description:
      'Shared workspaces, real-time notes and granular permissions for research groups.',
    className: 'md:col-span-2',
  },
  {
    icon: GraduationCap,
    title: 'Research Paper Integration',
    description:
      'Pull in academic papers and citations from scholarly databases for complete literature reviews.',
    className: 'md:col-span-2',
  },
  {
    icon: Globe,
    title: 'Web Intelligence',
    description:
      'AI-powered scraping that extracts and analyzes content from any website, feed or video transcript — straight into your library.',
    className: 'md:col-span-6 md:flex-row md:items-center md:gap-10',
  },
];

const FeaturesSection: React.FC = () => (
  <section id='features' className='relative py-24'>
    <div className='mx-auto max-w-7xl px-4 sm:px-6 lg:px-8'>
      <SectionHeading
        eyebrow='Capabilities'
        title={
          <>
            A complete <span className='landing-gradient-text italic'>research instrument</span>
          </>
        }
        subtitle='Everything you need to interrogate documents, verify claims and connect ideas — in one workspace.'
      />

      <div className='mt-14 grid gap-4 md:grid-cols-6'>
        {FEATURES.map((feature, index) => (
          <motion.div
            key={feature.title}
            className={feature.className}
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, delay: (index % 3) * 0.1, ease: 'easeOut' }}
          >
            <SpotlightCard className={`flex h-full flex-col p-7 ${feature.className.includes('flex-row') ? 'md:flex-row md:items-center md:gap-10' : ''}`}>
              <div>
                <div className='inline-flex h-11 w-11 items-center justify-center border border-primary/25 bg-primary/10'>
                  <feature.icon className='h-5 w-5 text-primary' />
                </div>
                <h3 className='mt-5 text-lg font-semibold tracking-tight'>{feature.title}</h3>
                <p className='mt-2 text-sm leading-relaxed opacity-65'>{feature.description}</p>
              </div>
              {feature.visual}
            </SpotlightCard>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

/* ------------------------------------------------------------------ */
/* Workflow                                                            */
/* ------------------------------------------------------------------ */

const WORKFLOW_STEPS = [
  {
    title: 'Build your library',
    description:
      'Drop in PDFs, books, papers, websites or videos. Scrapalot parses, OCRs and indexes everything automatically.',
  },
  {
    title: 'Ask in plain language',
    description:
      'Chat with one document or your whole collection. Agentic RAG picks the right retrieval strategy for each question.',
  },
  {
    title: 'Go deeper',
    description:
      'Launch deep research, explore the knowledge graph, and turn findings into notes, reports or full papers.',
  },
];

const WorkflowSection: React.FC = () => (
  <section className='relative overflow-hidden py-24'>
    <AuroraBackground variant='panel' className='opacity-60' />
    <div className='relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8'>
      <SectionHeading
        eyebrow='How it works'
        title={
          <>
            From upload to <span className='landing-gradient-text italic'>insight</span> in minutes
          </>
        }
      />

      <div className='relative mt-14 grid gap-4 md:grid-cols-3'>
        {/* connecting line */}
        <div className='landing-hairline absolute -top-2 left-[16%] right-[16%] hidden md:block' />

        {WORKFLOW_STEPS.map((step, index) => (
          <motion.div
            key={step.title}
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, delay: index * 0.12, ease: 'easeOut' }}
          >
            <SpotlightCard className='h-full p-7'>
              <div className='font-display text-5xl font-light italic text-primary/80'>
                0{index + 1}
              </div>
              <h3 className='mt-4 text-lg font-semibold tracking-tight'>{step.title}</h3>
              <p className='mt-2 text-sm leading-relaxed opacity-65'>{step.description}</p>
            </SpotlightCard>
          </motion.div>
        ))}
      </div>
    </div>
  </section>
);

/* ------------------------------------------------------------------ */
/* CTA                                                                 */
/* ------------------------------------------------------------------ */

const CTASection: React.FC = () => {
  const navigate = useNavigate();

  return (
    <section className='relative py-24'>
      <div className='mx-auto max-w-5xl px-4 sm:px-6 lg:px-8'>
        <motion.div
          className='landing-glass relative overflow-hidden px-6 py-16 text-center sm:px-16'
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
        >
          <AuroraBackground variant='panel' />

          <div className='relative'>
            <div className='landing-eyebrow mb-4 text-primary'>Start today</div>
            <h2 className='font-display text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl'>
              Ready to research
              <br />
              <span className='landing-gradient-text italic'>at full depth?</span>
            </h2>
            <p className='mx-auto mt-5 max-w-xl text-base leading-relaxed opacity-70'>
              Join thousands of researchers and teams who trust Scrapalot with their
              libraries. Free Researcher plan — no credit card required.
            </p>

            <div className='mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row'>
              <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
                <Button
                  data-testid='home-cta-start-button'
                  size='lg'
                  className='landing-btn-primary h-12 px-8 text-base font-medium'
                  onClick={() => navigate('/dashboard')}
                >
                  Start Researcher plan
                  <ArrowUpRight className='ml-2 h-4 w-4' />
                </Button>
              </motion.div>

              <div className='relative'>
                <Button
                  data-testid='home-desktop-app-button'
                  size='lg'
                  variant='outline'
                  disabled
                  className='landing-btn-ghost h-12 cursor-not-allowed border-0 px-8 text-base font-medium opacity-50'
                >
                  <Download className='mr-2 h-4 w-4' />
                  Desktop App
                </Button>
                <span className='absolute -right-2 -top-2 bg-foreground/80 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-background'>
                  Coming soon
                </span>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const HomePage: React.FC = () => {
  const { theme, accentColor } = useTheme();
  const [isLoading, setIsLoading] = useState(false);
  const isDarkMode = theme === 'dark';

  // Use useContext directly to avoid the error thrown by useAuth
  const authContext = useContext(AuthContext);

  // If auth context is not available, provide default values
  const isAuthenticated = authContext?.isAuthenticated || false;
  const authLoading = authContext?.isLoading || false;

  const navigate = useNavigate();

  // Handle login redirect loading state
  useEffect(() => {
    const justLoggedIn = sessionStorage.getItem('just_logged_in') === 'true';
    const justLoggedOut = sessionStorage.getItem('just_logged_out') === 'true';
    const modelsPreloaded =
      sessionStorage.getItem('models_preloaded') === 'true';

    // Don't auto-login if user explicitly logged out
    if (justLoggedOut) {
      return;
    }

    if (isAuthenticated && justLoggedIn && !modelsPreloaded) {
      // User just logged in and models are still being preloaded
      setIsLoading(true);

      // Set a timeout to redirect to dashboard if models take too long
      const redirectTimeout = setTimeout(() => {
        navigate('/dashboard', { replace: true });
        setIsLoading(false);
      }, 5000); // 5 second timeout

      // Check for models preloaded completion
      const checkModelsInterval = setInterval(() => {
        const nowPreloaded =
          sessionStorage.getItem('models_preloaded') === 'true';
        if (nowPreloaded) {
          clearInterval(checkModelsInterval);
          clearTimeout(redirectTimeout);
          navigate('/dashboard', { replace: true });
          setIsLoading(false);
        }
      }, 100); // Check every 100ms

      return () => {
        clearTimeout(redirectTimeout);
        clearInterval(checkModelsInterval);
        setIsLoading(false);
      };
    } else if (isAuthenticated && justLoggedIn && modelsPreloaded) {
      // User just logged in and models are ready, redirect immediately
      navigate('/dashboard', { replace: true });
    } else if (isAuthenticated && !authLoading) {
      // User is already authenticated (via auto-login/session cookie), redirect to dashboard
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, setIsLoading]);

  // Show loading overlay during login redirect (spinner handled by global loading)
  if (isLoading) {
    return (
      <div className='landing-page relative flex min-h-screen items-center justify-center'>
        <AuroraBackground variant='panel' />
        <div className='relative text-center'>
          <h2 className='font-display text-2xl font-medium tracking-tight'>
            Setting up your dashboard…
          </h2>
          <p className='mt-2 text-sm opacity-60'>
            Please wait while we prepare your workspace
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid='page-home-container' className='landing-page min-h-screen'>
      <SharedHeader isDarkMode={isDarkMode} accentColor={accentColor} />
      <HeroSection />
      <CapabilityMarquee />
      <FeaturesSection />
      <WorkflowSection />
      <CTASection />
      <LandingFooter testId='home-footer' />
    </div>
  );
};

export default HomePage;
