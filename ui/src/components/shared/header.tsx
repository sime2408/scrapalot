import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Github,
  Star,
  Sun,
  Moon,
  Palette,
  LogIn,
  Menu,
  X,
  ShoppingCart,
  ArrowRight,
} from 'lucide-react';
import { useTheme } from '@/providers/theme-provider';
import { useAuth } from '@/hooks/use-auth';
import { useCart } from '@/contexts/cart-context';
import { CartPanel } from '@/components/cart/cart-panel';
import LoginPopover from '@/components/login-popover';
import { useDesktopMode } from '@/hooks/use-desktop-mode';
import { cn } from '@/lib/utils';

const NAV_ITEMS: { label: string; path: string; testId: string; className?: string }[] = [
  { label: 'About', path: '/about', testId: 'shared-header-nav-about' },
  { label: 'Apps', path: '/desktop', testId: 'shared-header-nav-desktop', className: 'hidden-below-1080' },
  { label: 'Shop', path: '/shop', testId: 'shared-header-nav-shop' },
  { label: 'Pricing', path: '/pricing', testId: 'shared-header-nav-pricing' },
];

// Shared Header Component — floating glass nav for all public pages
const SharedHeader: React.FC<{ isDarkMode: boolean; accentColor: string }> = ({
  isDarkMode,
  accentColor,
}) => {
  const [starCount, setStarCount] = useState<number | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme, setAccentColor } = useTheme();
  const { isAuthenticated } = useAuth();
  const { totalItems } = useCart();
  const { isDesktop } = useDesktopMode();
  const [currentAccentColor, setCurrentAccentColor] = useState(accentColor);
  const [isCartOpen, setIsCartOpen] = useState(false);

  useEffect(() => {
    const fetchStarCount = async () => {
      try {
        const cached = localStorage.getItem('github_stars_cache');
        if (cached) {
          setStarCount(parseInt(cached));
        } else {
          setStarCount(0);
        }
      } catch (error) {
        console.error('Failed to fetch GitHub stars:', error);
        setStarCount(0);
      }
    };
    void fetchStarCount();
  }, []);

  useEffect(() => {
    setCurrentAccentColor(accentColor);
  }, [accentColor]);

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
  };

  const cycleAccentColor = () => {
    const colors = ['violet', 'blue', 'green', 'red', 'orange', 'gray'];
    const currentIndex = colors.indexOf(currentAccentColor);
    const nextIndex = (currentIndex + 1) % colors.length;
    const nextColor = colors[nextIndex];
    setCurrentAccentColor(nextColor);

    // Use theme provider's setAccentColor to ensure backend saving
    setAccentColor(nextColor as 'gray' | 'blue' | 'green' | 'red' | 'violet' | 'orange');

    // Also dispatch event for immediate UI updates
    window.dispatchEvent(
      new CustomEvent('accentColorChange', { detail: nextColor })
    );
  };

  const isLoginPage = location.pathname === '/login';

  const iconButtonClasses =
    'relative flex h-9 w-9 items-center justify-center p-0 border border-transparent ' +
    'opacity-70 transition-all hover:opacity-100 hover:border-foreground/10 hover:bg-foreground/5';

  return (
    <header
      data-testid='shared-header'
      className='fixed top-0 left-0 right-0 z-[40] px-3 pt-3 sm:px-4'
    >
      <div className='landing-glass-nav mx-auto flex h-14 max-w-6xl items-center justify-between pl-4 pr-2'>
        {/* Left - Logo */}
        <div className='flex items-center gap-2'>
          <div
            className='group flex cursor-pointer items-center gap-2.5'
            onClick={() => navigate('/')}
            data-testid='shared-header-logo'
          >
            <img
              src='/logo512.png'
              alt='Scrapalot Logo'
              className='h-7 w-7 object-contain transition-transform duration-300 group-hover:rotate-[15deg] dark:invert'
            />
            <span className='font-display text-xl font-medium tracking-tight'>
              Scrapalot
            </span>
          </div>

          {/* Mobile Menu Toggle */}
          <Button
            variant='ghost'
            size='sm'
            className='p-2 opacity-70 hover:opacity-100 md:hidden'
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            data-testid='shared-header-mobile-menu-toggle'
          >
            {isMobileMenuOpen ? (
              <X className='h-5 w-5' />
            ) : (
              <Menu className='h-5 w-5' />
            )}
          </Button>
        </div>

        {/* Center - Navigation */}
        <nav
          data-testid='shared-header-nav'
          className='absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 md:flex'
        >
          {NAV_ITEMS.map(item => {
            const active = location.pathname === item.path;
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={cn(
                  'relative px-3.5 py-1.5 text-sm font-medium transition-colors',
                  item.className,
                  active ? 'text-primary' : 'opacity-70 hover:opacity-100 hover:text-primary'
                )}
                data-testid={item.testId}
              >
                {item.label}
                {active && (
                  <span className='absolute inset-x-3 -bottom-0.5 h-px bg-gradient-to-r from-transparent via-primary to-transparent' />
                )}
              </button>
            );
          })}
          <button
            onClick={() => window.open('https://docs.scrapalot.app', '_blank')}
            className='px-3.5 py-1.5 text-sm font-medium opacity-70 transition-colors hover:text-primary hover:opacity-100'
            data-testid='shared-header-nav-docs'
          >
            Docs
          </button>
        </nav>

        {/* Right - Actions */}
        <div className='flex items-center gap-1'>
          {/* Theme Switcher */}
          <button
            className={cn(iconButtonClasses, 'hidden sm:flex')}
            onClick={toggleTheme}
            data-testid='shared-header-theme-toggle'
            aria-label='Toggle theme'
          >
            {isDarkMode ? <Sun className='h-4 w-4' /> : <Moon className='h-4 w-4' />}
          </button>

          {/* Accent Color Switcher */}
          <button
            className={cn(iconButtonClasses, 'hidden text-primary sm:flex')}
            onClick={cycleAccentColor}
            data-testid='shared-header-accent-toggle'
            aria-label='Cycle accent color'
          >
            <Palette className='h-4 w-4' />
          </button>

          {/* Cart Button */}
          <button
            className={cn(iconButtonClasses, 'hidden sm:flex')}
            onClick={() => setIsCartOpen(true)}
            title={`Cart (${totalItems} items)`}
            data-testid='shared-header-cart-button'
          >
            <ShoppingCart className='h-4 w-4' />
            {totalItems > 0 && (
              <span className='absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground'>
                {totalItems > 99 ? '99+' : totalItems}
              </span>
            )}
          </button>

          {/* GitHub Star Button */}
          <button
            className={cn(iconButtonClasses, 'hidden sm:flex')}
            onClick={() =>
              window.open('https://github.com/sime2408/scrapalot', '_blank')
            }
            title={`GitHub Repository (${starCount !== null ? starCount : '0'} stars)`}
            data-testid='shared-header-github-button'
          >
            <Github className='h-4 w-4' />
            {starCount !== null && starCount > 0 && (
              <span className='absolute -right-1.5 -top-1.5 flex h-4 items-center gap-0.5 rounded-full bg-amber-400 px-1 text-[9px] font-bold text-black'>
                <Star className='h-2 w-2 fill-current' />
                {starCount > 99 ? '99+' : starCount}
              </span>
            )}
          </button>

          <div className='mx-1 hidden h-5 w-px bg-foreground/10 sm:block' />

          {/* Login/Dashboard Button - Hide in desktop mode */}
          {!isDesktop && (
            <>
              {isLoginPage ? (
                <Button
                  size='sm'
                  variant='ghost'
                  className='landing-btn-ghost h-9 px-4 text-sm'
                  onClick={() => navigate('/')}
                  data-testid='shared-header-back-button'
                >
                  Back to Home
                </Button>
              ) : isAuthenticated ? (
                <Button
                  size='sm'
                  className='landing-btn-primary h-9 px-4 text-sm font-medium'
                  onClick={() => navigate('/dashboard')}
                  data-testid='shared-header-dashboard-button'
                >
                  Dashboard
                  <ArrowRight className='ml-1.5 h-3.5 w-3.5' />
                </Button>
              ) : (
                <LoginPopover>
                  <Button
                    size='sm'
                    className='landing-btn-primary h-9 px-4 text-sm font-medium'
                    data-testid='shared-header-login-button'
                  >
                    <LogIn className='mr-1.5 h-3.5 w-3.5' />
                    Login
                  </Button>
                </LoginPopover>
              )}
            </>
          )}
        </div>
      </div>

      {/* Mobile Menu Dropdown */}
      {isMobileMenuOpen && (
        <div
          data-testid='shared-header-mobile-menu'
          className='landing-glass-nav mx-auto mt-2 max-w-6xl md:hidden'
        >
          <div className='space-y-3 px-4 py-4'>
            {/* Navigation Links */}
            <div className='space-y-1'>
              {/* /desktop was historically hidden on mobile — it now hosts the
                  Android APK download, so phones need it most */}
              {NAV_ITEMS.map(item => (
                <button
                  key={item.path}
                  onClick={() => {
                    navigate(item.path);
                    setIsMobileMenuOpen(false);
                  }}
                  className={cn(
                    'block w-full px-3 py-2.5 text-left text-sm font-medium transition-colors',
                    location.pathname === item.path
                      ? 'border-l-2 border-primary bg-primary/5 text-primary'
                      : 'opacity-70 hover:opacity-100'
                  )}
                >
                  {item.label}
                </button>
              ))}
              <button
                onClick={() => {
                  window.open('https://docs.scrapalot.app', '_blank');
                  setIsMobileMenuOpen(false);
                }}
                className='block w-full px-3 py-2.5 text-left text-sm font-medium opacity-70 transition-colors hover:opacity-100'
              >
                Docs
              </button>
            </div>

            {/* Mobile Actions */}
            <div className='space-y-3 border-t border-foreground/10 pt-3'>
              {/* Theme & Accent Controls */}
              <div className='grid grid-cols-2 gap-2'>
                <Button
                  variant='ghost'
                  size='sm'
                  className='landing-btn-ghost h-10 justify-center gap-2'
                  onClick={toggleTheme}
                >
                  {isDarkMode ? <Sun className='h-4 w-4' /> : <Moon className='h-4 w-4' />}
                  <span className='text-xs'>{isDarkMode ? 'Light' : 'Dark'}</span>
                </Button>
                <Button
                  variant='ghost'
                  size='sm'
                  className='landing-btn-ghost h-10 justify-center gap-2 text-primary'
                  onClick={cycleAccentColor}
                >
                  <Palette className='h-4 w-4' />
                  <span className='text-xs'>Colors</span>
                </Button>
              </div>

              {/* Cart & GitHub Buttons Row */}
              <div className='grid grid-cols-2 gap-2'>
                <Button
                  variant='ghost'
                  size='sm'
                  className='landing-btn-ghost relative h-10 w-full justify-center'
                  onClick={() => {
                    setIsCartOpen(true);
                    setIsMobileMenuOpen(false);
                  }}
                  title={`Cart (${totalItems} items)`}
                >
                  <ShoppingCart className='h-4 w-4' />
                  {totalItems > 0 && (
                    <span className='absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground'>
                      {totalItems > 99 ? '99+' : totalItems}
                    </span>
                  )}
                </Button>
                <Button
                  variant='ghost'
                  size='sm'
                  className='landing-btn-ghost relative h-10 w-full justify-center'
                  onClick={() => {
                    window.open('https://github.com/sime2408/scrapalot', '_blank');
                    setIsMobileMenuOpen(false);
                  }}
                  title={`GitHub Repository (${starCount !== null ? starCount : '0'} stars)`}
                >
                  <Github className='h-4 w-4' />
                  {starCount !== null && starCount > 0 && (
                    <span className='absolute -right-1.5 -top-1.5 flex h-4 items-center gap-0.5 rounded-full bg-amber-400 px-1 text-[9px] font-bold text-black'>
                      <Star className='h-2 w-2 fill-current' />
                      {starCount > 99 ? '99+' : starCount}
                    </span>
                  )}
                </Button>
              </div>

              {/* Login/Dashboard Button - Hide in desktop mode */}
              {!isDesktop && (
                <>
                  {isLoginPage ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='landing-btn-ghost h-10 w-full'
                      onClick={() => {
                        navigate('/');
                        setIsMobileMenuOpen(false);
                      }}
                    >
                      Back to Home
                    </Button>
                  ) : isAuthenticated ? (
                    <Button
                      size='sm'
                      className='landing-btn-primary h-10 w-full font-medium'
                      onClick={() => {
                        navigate('/dashboard');
                        setIsMobileMenuOpen(false);
                      }}
                    >
                      Dashboard
                      <ArrowRight className='ml-1.5 h-3.5 w-3.5' />
                    </Button>
                  ) : (
                    <Button
                      size='sm'
                      className='landing-btn-primary h-10 w-full font-medium'
                      onClick={() => {
                        setIsMobileMenuOpen(false);
                        navigate('/login');
                      }}
                    >
                      <LogIn className='mr-1.5 h-3.5 w-3.5' />
                      Login
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Cart Panel */}
      <CartPanel open={isCartOpen} onOpenChange={setIsCartOpen} />
    </header>
  );
};

export default SharedHeader;
