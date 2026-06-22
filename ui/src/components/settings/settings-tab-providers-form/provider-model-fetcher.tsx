import React from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Download } from 'lucide-react';

interface ModelFetcherProps {
  selectedProvider: string;
  modelsFetched: boolean;
  fetchedModels: Array<{
    id: string;
    name: string;
    model_type?: string;
    selected?: boolean;
  }>;
  loading: boolean;
  apiBase: string;
  apiKey: string;
  needsApiKey: () => boolean;
  needsEndpoint: () => boolean;
  onFetchModels: () => void;
}

export const ProviderModelFetcher: React.FC<ModelFetcherProps> = ({
  selectedProvider,
  modelsFetched,
  fetchedModels,
  loading,
  apiBase,
  apiKey,
  needsApiKey,
  needsEndpoint,
  onFetchModels,
}) => {
  const getSetupInstructions = () => {
    if (selectedProvider === 'ollama') {
      const isCloud = (apiBase || '').toLowerCase().includes('ollama.com');
      return {
        title: isCloud ? 'Ollama Cloud Setup:' : 'Ollama Setup:',
        items: isCloud
          ? [
            '• Create an API key at ollama.com/settings/keys',
            '• Enter your API key above, then fetch available cloud models',
          ]
          : [
            `• Ensure Ollama is running at ${apiBase || 'https://ollama.com'}`,
            '• At least one model should be pulled (e.g., ollama pull llama2)',
          ],
      };
    } else if (selectedProvider === 'vllm') {
      return {
        title: 'vLLM Setup:',
        items: [
          `• Ensure vLLM server is running at ${apiBase || 'http://localhost:8000'}`,
          '• Server should be started with at least one model loaded',
        ],
      };
    } else if (selectedProvider === 'lmstudio') {
      return {
        title: 'LM Studio Setup:',
        items: [
          `• Ensure LM Studio is running at ${apiBase || 'http://localhost:1234'}`,
          '• Load a model in LM Studio and start the local server',
          '• No API key required for local LM Studio instances',
        ],
      };
    } else if (needsApiKey() && !apiKey) {
      return {
        title: 'API Key Required',
        items: [
          `Please provide your ${selectedProvider} API key above to fetch models.`,
        ],
      };
    } else {
      return {
        title: 'Ready to Fetch',
        items: [
          `Click "Fetch Models" to retrieve available models from ${selectedProvider}.`,
        ],
      };
    }
  };

  const instructions = getSetupInstructions();

  return (
    <div className='border-t border-zinc-200 dark:border-zinc-800 pt-4'>
      <div className='flex items-center justify-between'>
        <div>
          <h3 className='text-sm font-medium text-zinc-800 dark:text-white'>
            Available Models
          </h3>
          <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-1'>
            {modelsFetched
              ? `${fetchedModels.length} models available`
              : 'Fetch models from your provider to configure them'}
          </p>
        </div>
        <Button
          type='button'
          onClick={onFetchModels}
          disabled={
            loading ||
            (needsApiKey() && !apiKey) ||
            (needsEndpoint() && !apiBase)
          }
          className='bg-primary hover:bg-primary/90 text-white flex items-center gap-2'
          size='sm'
          data-testid='provider-fetch-models-button'
        >
          <Download className='h-4 w-4' />
          {loading
            ? 'Fetching...'
            : modelsFetched
              ? 'Refresh Models'
              : 'Fetch Models'}
        </Button>
      </div>

      {/* Show helpful info based on provider */}
      {!modelsFetched && (
        <div className='mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-700 dark:text-blue-300'>
          <div>
            <p className='font-medium mb-1'>{instructions.title}</p>
            <ul className='text-xs space-y-1'>
              {instructions.items.map((item, index) => (
                <li key={index}>{item.startsWith('•') ? item : `• ${item}`}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
