import React, { useState, useEffect } from 'react';
import {
  motion,
  useTransform,
  AnimatePresence,
  useMotionValue,
  useSpring,
} from 'framer-motion';
import { cn } from '@/lib/utils';

export interface AnimatedTooltipItem {
  id: string | number;
  name: string;
  designation?: string;
  image?: string;
  /** Fallback image source tried when `image` fails to load (e.g. local-first profile picture → production). */
  imageFallback?: string;
}

interface AnimatedTooltipProps {
  items: AnimatedTooltipItem[];
  className?: string;
  size?: 'sm' | 'md';
}

// Tooltip avatar <img> that swaps to a fallback source on load error — used so
// a local-first profile picture falls back to the production host when absent
// locally. Kept generic: callers supply both resolved URLs.
function TooltipImage({
  src,
  fallbackSrc,
  alt,
  className,
}: {
  src?: string;
  fallbackSrc?: string;
  alt: string;
  className: string;
}) {
  const [active, setActive] = useState(src);
  useEffect(() => setActive(src), [src]);
  return (
    <img
      src={active}
      alt={alt}
      className={className}
      onError={() => {
        if (fallbackSrc && active !== fallbackSrc) setActive(fallbackSrc);
      }}
    />
  );
}

export function AnimatedTooltip({ items, className, size = 'md' }: AnimatedTooltipProps) {
  const [hoveredIndex, setHoveredIndex] = useState<string | number | null>(null);
  const springConfig = { stiffness: 100, damping: 5 };
  const x = useMotionValue(0);

  const rotate = useSpring(
    useTransform(x, [-100, 100], [-45, 45]),
    springConfig
  );
  const translateX = useSpring(
    useTransform(x, [-100, 100], [-50, 50]),
    springConfig
  );

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const halfWidth = (event.target as HTMLElement).offsetWidth / 2;
    x.set(event.nativeEvent.offsetX - halfWidth);
  };

  const sizeClasses = size === 'sm'
    ? 'h-7 w-7 -mr-2'
    : 'h-8 w-8 -mr-2.5';

  const getInitials = (name: string) => {
    if (!name) return '?';
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  // Color palette for initials-based avatars
  const colors = [
    'bg-blue-500', 'bg-emerald-500', 'bg-violet-500',
    'bg-amber-500', 'bg-rose-500', 'bg-cyan-500',
    'bg-indigo-500', 'bg-teal-500',
  ];

  const getColor = (id: string | number) => {
    const hash = String(id).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return colors[hash % colors.length];
  };

  return (
    <div className={cn('flex items-center', className)}>
      {items.map((item) => (
        <div
          key={item.id}
          className={cn('relative group', sizeClasses)}
          onMouseEnter={() => setHoveredIndex(item.id)}
          onMouseLeave={() => setHoveredIndex(null)}
          onMouseMove={handleMouseMove}
        >
          <AnimatePresence mode="popLayout">
            {hoveredIndex === item.id && (
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.6 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  transition: { type: 'spring', stiffness: 260, damping: 10 },
                }}
                exit={{ opacity: 0, y: 20, scale: 0.6 }}
                style={{ translateX: translateX, rotate: rotate, whiteSpace: 'nowrap' }}
                className="absolute -top-12 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center bg-black dark:bg-white px-3 py-1.5 z-50 shadow-xl"
              >
                <div className="absolute inset-x-4 -bottom-px z-30 bg-gradient-to-r from-transparent via-emerald-500 to-transparent h-px" />
                <div className="absolute left-4 -bottom-px z-30 bg-gradient-to-r from-transparent via-sky-500 to-transparent w-2/5 h-px" />
                <p className="text-white dark:text-black font-bold text-xs">
                  {item.name}
                </p>
                {item.designation && (
                  <p className="text-white/80 dark:text-black/80 text-[10px]">
                    {item.designation}
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {item.image ? (
            <TooltipImage
              src={item.image}
              fallbackSrc={item.imageFallback}
              alt={item.name}
              className={cn(
                'object-cover !m-0 !p-0 rounded-full border-2 border-white dark:border-zinc-900 relative transition-transform duration-200 group-hover:scale-105 group-hover:z-30',
                size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'
              )}
            />
          ) : (
            <div
              className={cn(
                'rounded-full border-2 border-white dark:border-zinc-900 flex items-center justify-center text-white font-medium relative transition-transform duration-200 group-hover:scale-105 group-hover:z-30',
                size === 'sm' ? 'h-7 w-7 text-[10px]' : 'h-8 w-8 text-xs',
                getColor(item.id)
              )}
            >
              {getInitials(item.name)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
