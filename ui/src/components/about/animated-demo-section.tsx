import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Play, CheckCircle } from 'lucide-react';

interface AnimatedDemoSectionProps {
  accentColor: string;
  getAccentClasses: (color: string) => string;
  openModal: () => void;
}

export const AnimatedDemoSection: React.FC<AnimatedDemoSectionProps> = ({
  accentColor,
  getAccentClasses,
  openModal,
}) => {
  const [isHovering, setIsHovering] = useState(false);

  const demoFeatures = [
    'Document Upload & Processing',
    'AI Model Selection',
    'Knowledge Stack Management',
    'Advanced Search & RAG',
  ];

  return (
    <section className='relative overflow-hidden px-4 pb-16 pt-24 sm:px-6 lg:px-8'>
      <div className='landing-hairline absolute inset-x-0 top-0 mx-auto max-w-5xl' />
      <div className='mx-auto max-w-6xl'>
        {/* Animated Header */}
        <motion.div
          className='mb-12 text-center'
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        >
          <motion.div
            className='mb-6 inline-flex items-center gap-2 border border-primary/25 bg-primary/5 px-4 py-1.5 backdrop-blur-sm'
            initial={{ scale: 0.8, opacity: 0 }}
            whileInView={{ scale: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <motion.div
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ duration: 2, repeat: Infinity, repeatDelay: 3 }}
            >
              <Sparkles className={`h-4 w-4 ${getAccentClasses(accentColor)}`} />
            </motion.div>
            <span className='landing-eyebrow !tracking-[0.14em] text-primary'>
              Interactive demo
            </span>
          </motion.div>

          <motion.h2
            className='font-display text-4xl font-medium leading-[1.08] tracking-tight sm:text-5xl'
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            See Scrapalot <span className='landing-gradient-text italic'>in action</span>
          </motion.h2>

          <motion.p
            className='mx-auto mt-5 max-w-3xl text-base leading-relaxed opacity-70 sm:text-lg'
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.4 }}
          >
            Experience how Scrapalot transforms your documents into intelligent knowledge bases.
          </motion.p>
        </motion.div>

        {/* Animated Demo Player */}
        <motion.div
          className='mx-auto max-w-5xl'
          initial={{ opacity: 0, y: 50, scale: 0.95 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.7, delay: 0.2, ease: 'easeOut' }}
        >
          <motion.div
            className='landing-glass relative overflow-hidden'
            whileHover={{ scale: 1.01 }}
            transition={{ duration: 0.3 }}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
          >
            {/* Browser Frame Header */}
            <motion.div
              className='flex items-center justify-between border-b border-foreground/10 px-4 py-2.5'
              initial={{ opacity: 0, y: -20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.4 }}
            >
              <div className='flex items-center gap-1.5'>
                {['bg-red-400/90', 'bg-amber-400/90', 'bg-emerald-400/90'].map((color, i) => (
                  <motion.div
                    key={i}
                    className={`h-2.5 w-2.5 ${color} rounded-full`}
                    whileHover={{ scale: 1.3 }}
                    transition={{ duration: 0.2 }}
                  />
                ))}
              </div>
              <motion.div
                className='flex items-center gap-2 border border-foreground/10 bg-foreground/5 px-3 py-1 font-mono text-[10px] tracking-wider opacity-70'
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 0.7 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.5 }}
              >
                <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
                scrapalot.app/dashboard
              </motion.div>
              <div className='w-16'></div>
            </motion.div>

            {/* Demo Content — live screenshot of the current workspace */}
            <div className='relative aspect-[16/10]'>
              <motion.img
                src='/product/dashboard/chat-conversation.png'
                alt='Scrapalot Dashboard Demo'
                className='h-full w-full object-cover object-top'
                initial={{ opacity: 0, scale: 1.1 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8, delay: 0.3 }}
              />

              {/* Animated Hotspot */}
              <motion.div
                className='absolute cursor-pointer'
                style={{ left: '55%', top: '86%', transform: 'translate(-50%, -50%)' }}
                onClick={openModal}
                initial={{ scale: 0, opacity: 0 }}
                whileInView={{ scale: 1, opacity: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: 0.8 }}
              >
                {/* Pulsing Beacon */}
                <motion.div className='relative'>
                  <motion.div
                    className='absolute inset-0 rounded-full bg-primary'
                    animate={{ scale: [1, 2, 2], opacity: [0.7, 0, 0] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                  <motion.div
                    className='h-4 w-4 rounded-full bg-primary'
                    whileHover={{ scale: 1.3 }}
                    transition={{ duration: 0.2 }}
                  />
                </motion.div>

                {/* Animated Tooltip */}
                <motion.div
                  className='absolute left-6 top-1/2 z-20 min-w-[320px] -translate-y-1/2 transform border-2 border-slate-600 bg-slate-900 px-4 py-3 text-white shadow-2xl'
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: 1 }}
                  whileHover={{ scale: 1.05 }}
                >
                  <div className='absolute left-0 top-1/2 -translate-x-full -translate-y-1/2 transform'>
                    <div className='h-0 w-0 border-b-[10px] border-r-[12px] border-t-[10px] border-transparent border-r-slate-900'></div>
                  </div>
                  <div className='flex items-start space-x-3'>
                    <motion.div
                      className='flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary font-mono text-sm font-bold text-primary-foreground'
                      animate={{ rotate: 360 }}
                      transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
                    >
                      1
                    </motion.div>
                    <div className='flex-1'>
                      <h4 className='mb-1 text-sm font-semibold text-white'>
                        Ask Your Library Anything
                      </h4>
                      <p className='text-xs leading-relaxed text-gray-300'>
                        Agentic RAG with cited answers
                      </p>
                      <motion.div
                        className='mt-2 font-mono text-[11px] font-medium tracking-wide text-primary brightness-150'
                        animate={{ x: [0, 5, 0] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                      >
                        Click to start interactive demo →
                      </motion.div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>

              {/* Play Button Overlay */}
              <AnimatePresence>
                <motion.div
                  className='absolute inset-0 flex items-center justify-center bg-black bg-opacity-20'
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  whileHover={{ backgroundColor: 'rgba(0, 0, 0, 0.3)' }}
                  transition={{ duration: 0.3 }}
                >
                  <motion.button
                    className='landing-btn-primary flex items-center space-x-2 px-8 py-4 text-lg font-semibold'
                    onClick={openModal}
                    initial={{ scale: 0, opacity: 0 }}
                    whileInView={{ scale: 1, opacity: 1 }}
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.95 }}
                    transition={{ duration: 0.3 }}
                  >
                    <motion.div
                      animate={isHovering ? { x: [0, 5, 0] } : {}}
                      transition={{ duration: 0.5, repeat: isHovering ? Infinity : 0 }}
                    >
                      <Play className='h-6 w-6' />
                    </motion.div>
                    <span>VIEW INTERACTIVE DEMO</span>
                  </motion.button>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Demo Features */}
            <motion.div
              className='border-t border-foreground/10 px-3 py-2 md:px-6 md:py-4'
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.6 }}
            >
              <div className='flex flex-wrap items-center justify-center gap-3 text-xs opacity-70 md:gap-6 md:text-sm'>
                {demoFeatures.map((feature, index) => (
                  <motion.div
                    key={index}
                    className='flex items-center space-x-1 md:space-x-2'
                    initial={{ opacity: 0, x: -20 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.4, delay: 0.7 + index * 0.1 }}
                    whileHover={{ scale: 1.05 }}
                  >
                    <CheckCircle className='h-3 w-3 text-primary md:h-4 md:w-4' />
                    <span>{feature}</span>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
};
