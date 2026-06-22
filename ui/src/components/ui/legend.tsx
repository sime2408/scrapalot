import React from 'react';

interface LegendProps {
  text: string;
  className?: string;
}

/**
 * Legend component for form fieldsets
 * Used to display a title for a group of form fields
 */
export const Legend = ({ text, className = '' }: LegendProps) => {
  return (
    <legend
      className={`text-sm font-medium text-zinc-800 dark:text-white mb-2 ${className}`}
    >
      {text}
    </legend>
  );
};

export default Legend;
