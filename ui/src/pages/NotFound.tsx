import { useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import { AuroraBackground } from '@/components/landing';

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error(
      '404 Error: User attempted to access non-existent route:',
      location.pathname
    );
  }, [location.pathname]);

  return (
    <div
      data-testid='page-not-found-container'
      className='landing-page relative flex min-h-screen items-center justify-center'
    >
      <AuroraBackground variant='hero' />

      <motion.div
        className='relative max-w-md px-6 text-center'
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <div className='landing-eyebrow mb-6 flex items-center justify-center gap-2 text-primary'>
          <FileQuestion className='h-3.5 w-3.5' />
          Page not found
        </div>

        <h1
          data-testid='not-found-title'
          className='font-display text-8xl font-medium leading-none tracking-tight sm:text-9xl'
        >
          4<span className='landing-gradient-text italic'>0</span>4
        </h1>

        <p className='mt-6 text-base leading-relaxed opacity-70'>
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>

        <div className='mt-9'>
          <Link
            to='/'
            data-testid='not-found-home-link'
            className='landing-btn-primary inline-flex h-11 items-center px-7 text-sm font-medium'
          >
            <ArrowLeft className='mr-2 h-4 w-4' />
            Return to Home
          </Link>
        </div>

        <p className='mt-8 font-mono text-[11px] tracking-wide opacity-40'>
          {location.pathname}
        </p>
      </motion.div>
    </div>
  );
};

export default NotFound;
