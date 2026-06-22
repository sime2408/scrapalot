import React from 'react';
import { Label } from '@/components/ui/label.tsx';
import { ProviderIcon } from '@/components/shared/provider-icon.tsx';

interface ProviderOption {
  id: string;
  name: string;
  icon: string;
}

interface ProviderSelectorProps {
  selectedProvider: string;
  onProviderSelect: (providerId: string) => void;
  configuredProviders?: string[]; // Array of provider_type values that are already configured
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: 'openai',
    name: 'Open AI',
    icon: '/providers/openai.svg',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    icon: '/providers/google.svg',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '/providers/openrouter.svg',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: '/providers/anthropic.svg',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    icon: '/providers/lmstudio.svg',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '/providers/deepseek.svg',
  },
  {
    id: 'groq',
    name: 'Groq',
    icon: '/providers/groq.svg',
  },
  {
    id: 'vllm',
    name: 'Remote vLLM',
    icon: '/providers/vllm.svg',
  },
  {
    id: 'ollama',
    name: 'Remote Ollama',
    icon: '/providers/ollama.svg',
  },
];

export const ProviderSelector: React.FC<ProviderSelectorProps> = ({
  selectedProvider,
  onProviderSelect,
  configuredProviders = [],
}) => {
  return (
    <div className='space-y-2'>
      <Label className='text-sm font-medium text-zinc-800 dark:text-white'>
        Provider Type
      </Label>
      <div className='grid grid-cols-3 gap-2'>
        {PROVIDER_OPTIONS.map(provider => {
          const isConfigured = configuredProviders.includes(provider.id);
          const isDisabled = isConfigured;

          return (
            <button
              key={provider.id}
              type='button'
              disabled={isDisabled}
              data-testid={`provider-select-${provider.id}`}
              className={`p-4 border flex flex-col items-center gap-2 transition-colors relative ${isDisabled
                ? 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 opacity-50 cursor-not-allowed'
                : selectedProvider === provider.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                  : 'border-zinc-300 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-900'
                }`}
              onClick={() => !isDisabled && onProviderSelect(provider.id)}
            >
              {isConfigured && (
                <div className='absolute top-1 right-1 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center'>
                  <span className='text-white text-xs'>✓</span>
                </div>
              )}
              <div className='w-8 h-8 overflow-hidden rounded'>
                <ProviderIcon
                  src={provider.icon}
                  alt={provider.name}
                  className='w-full h-full'
                />
              </div>
              <div className='text-xs font-medium text-center text-zinc-800 dark:text-white'>
                {provider.name}
                {isConfigured && (
                  <div className='text-xs text-green-600 dark:text-green-400 mt-1'>
                    Already configured
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
