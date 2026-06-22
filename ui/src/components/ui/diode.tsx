import React from 'react';
import { cn } from '@/lib/utils';

export interface DiodeProps {
  /** The color variant of the diode */
  variant?: 'green' | 'red' | 'blue' | 'yellow' | 'orange' | 'purple' | 'gray';
  /** The size of the diode */
  size?: 'sm' | 'md' | 'lg';
  /** Whether the diode should have a pulsing animation */
  pulse?: boolean;
  /** Whether the diode should have a stronger glow effect */
  intense?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Accessibility label */
  'aria-label'?: string;
}

const diodeVariants = {
  green: {
    base: 'bg-green-500',
    glow: 'shadow-green-500/50',
    ring: 'ring-green-500/30',
  },
  red: {
    base: 'bg-red-500',
    glow: 'shadow-red-500/50',
    ring: 'ring-red-500/30',
  },
  blue: {
    base: 'bg-blue-500',
    glow: 'shadow-blue-500/50',
    ring: 'ring-blue-500/30',
  },
  yellow: {
    base: 'bg-yellow-500',
    glow: 'shadow-yellow-500/50',
    ring: 'ring-yellow-500/30',
  },
  orange: {
    base: 'bg-orange-500',
    glow: 'shadow-orange-500/50',
    ring: 'ring-orange-500/30',
  },
  purple: {
    base: 'bg-purple-500',
    glow: 'shadow-purple-500/50',
    ring: 'ring-purple-500/30',
  },
  gray: {
    base: 'bg-gray-500',
    glow: 'shadow-gray-500/50',
    ring: 'ring-gray-500/30',
  },
};

const diodeSizes = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
  lg: 'h-3 w-3',
};

/**
 * A glowing diode component that can be used as a status indicator
 * 
 * @example
 * // Basic usage
 * <Diode variant="green" />
 * 
 * @example
 * // Pulsing notification indicator
 * <Diode variant="red" pulse={true} size="sm" />
 * 
 * @example
 * // Intense glow for important status
 * <Diode variant="blue" intense={true} size="lg" />
 */
export const Diode: React.FC<DiodeProps> = ({
  variant = 'green',
  size = 'md',
  pulse = false,
  intense = false,
  className,
  'aria-label': ariaLabel,
}) => {
  const colors = diodeVariants[variant];
  const sizeClass = diodeSizes[size];

  return (
    <div
      className={cn(
        // Base styling
        'rounded-full relative inline-block',
        sizeClass,
        colors.base,
        
        // Glow effects
        'shadow-lg',
        colors.glow,
        
        // Ring effect for more realistic diode look
        'ring-2 ring-offset-1',
        colors.ring,
        'ring-offset-transparent',
        
        // Intense glow variation
        intense && [
          'shadow-xl',
          'ring-4',
          'ring-offset-2',
        ],
        
        // Pulse animation
        pulse && 'animate-pulse',
        
        // Custom classes
        className
      )}
      aria-label={ariaLabel}
      role="status"
    >
      {/* Inner highlight for 3D effect */}
      <div
        className={cn(
          'absolute inset-0 rounded-full',
          'bg-gradient-to-tr from-white/40 to-transparent',
          'pointer-events-none'
        )}
      />
      
      {/* Outer glow ring for enhanced effect */}
      <div
        className={cn(
          'absolute inset-0 rounded-full',
          'ring-1 ring-white/20',
          'pointer-events-none'
        )}
      />
    </div>
  );
};

export default Diode;
