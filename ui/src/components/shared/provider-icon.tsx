import React from 'react';

// Mono-color SVGs. Rendering them as <img> on a dark theme leaves them
// invisible (currentColor → default black) or hardcoded dark grey, so we
// render them as a CSS mask filled by a theme-aware bg. Multi-color logos
// (Anthropic, OpenAI, Google, etc.) keep their palette via <img>.
const MONO_LOGO_FILES = new Set([
  'baai.svg',
  'grok.svg',
  'groq.svg',
  'moonshot.svg',
  'ollama.svg',
  'openai-gpt4.svg',
  'openrouter.svg',
  'xai.svg',
]);

export const isMonoProviderLogo = (iconSrc?: string | null): boolean => {
  if (!iconSrc) return false;
  const file = iconSrc.split('/').pop() ?? '';
  return MONO_LOGO_FILES.has(file);
};

interface ProviderIconProps {
  src: string;
  alt: string;
  className?: string;
  onError?: React.ReactEventHandler<HTMLImageElement>;
}

export const ProviderIcon: React.FC<ProviderIconProps> = ({
  src,
  alt,
  className,
  onError,
}) => {
  if (isMonoProviderLogo(src)) {
    return (
      <div
        role='img'
        aria-label={alt}
        className={`${className ?? ''} bg-zinc-900 dark:bg-zinc-100`}
        style={{
          WebkitMaskImage: `url(${src})`,
          maskImage: `url(${src})`,
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
        }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className={`${className ?? ''} object-contain`}
      onError={onError}
    />
  );
};
