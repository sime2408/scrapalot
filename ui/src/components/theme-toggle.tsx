import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../providers/theme-provider';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className='w-full h-full flex items-center justify-center'
      aria-label='Toggle theme'
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? (
        <Sun className='h-4 w-4 text-white/70 hover:text-white' />
      ) : (
        <Moon className='h-4 w-4 text-zinc-600 hover:text-zinc-800' />
      )}
    </button>
  );
}
