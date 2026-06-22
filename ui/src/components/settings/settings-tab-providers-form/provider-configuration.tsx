import React, { useState } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';

interface ProviderConfigurationProps {
  selectedProvider: string;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  apiBase: string;
  onApiBaseChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  name: string;
  onNameChange: (value: string) => void;
  saveKeySecurely: boolean;
  onSaveKeySecurelyChange: (value: boolean) => void;
  showApiKey: boolean;
  onToggleApiKeyVisibility: () => void;
  connectionTestStatus: 'idle' | 'testing' | 'success' | 'error';
  connectionTestMessage: string;
  onTestConnection: () => void;
  needsApiKey: () => boolean;
  needsEndpoint: () => boolean;
  isEditMode: boolean;
  hasStoredApiKey?: boolean;
}

export const ProviderConfiguration: React.FC<ProviderConfigurationProps> = ({
  selectedProvider,
  apiKey,
  onApiKeyChange,
  apiBase,
  onApiBaseChange,
  description,
  onDescriptionChange,
  name,
  onNameChange,
  saveKeySecurely,
  onSaveKeySecurelyChange,
  showApiKey,
  onToggleApiKeyVisibility,
  connectionTestStatus,
  connectionTestMessage,
  onTestConnection,
  needsApiKey,
  needsEndpoint,
  isEditMode,
  hasStoredApiKey,
}) => {
  const [changingApiKey, setChangingApiKey] = useState(false);

  return (
    <div className='space-y-4'>
      {/* Name field for edit mode */}
      {isEditMode && (
        <div className='space-y-2'>
          <Label className='text-sm font-medium text-zinc-800 dark:text-white'>
            Provider Name
          </Label>
          <Input
            value={name}
            onChange={e => onNameChange(e.target.value)}
            className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
            placeholder='Enter provider name'
            data-testid='provider-name-input'
            required
          />
        </div>
      )}

      {/* API Key field — hidden in edit mode when key is already stored in DB (unless user clicks "Change key") */}
      {needsApiKey() && !(isEditMode && hasStoredApiKey && !apiKey && !changingApiKey) && (
        <div className='space-y-2'>
          <Label className='text-sm font-medium text-zinc-800 dark:text-white'>
            API Key
          </Label>
          <div className='relative'>
            <Input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => onApiKeyChange(e.target.value)}
              className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 w-full pr-10'
              placeholder={`Your ${selectedProvider} API key`}
              data-testid='provider-api-key-input'
              required={needsApiKey()}
            />
            <button
              type='button'
              onClick={onToggleApiKeyVisibility}
              className='absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
            >
              {showApiKey ? (
                <svg
                  xmlns='http://www.w3.org/2000/svg'
                  className='h-5 w-5'
                  viewBox='0 0 20 20'
                  fill='currentColor'
                >
                  <path
                    fillRule='evenodd'
                    d='M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z'
                    clipRule='evenodd'
                  />
                  <path d='M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z' />
                </svg>
              ) : (
                <svg
                  xmlns='http://www.w3.org/2000/svg'
                  className='h-5 w-5'
                  viewBox='0 0 20 20'
                  fill='currentColor'
                >
                  <path d='M10 12a2 2 0 100-4 2 2 0 000 4z' />
                  <path
                    fillRule='evenodd'
                    d='M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z'
                    clipRule='evenodd'
                  />
                </svg>
              )}
            </button>
          </div>
          <div className='flex items-center space-x-2'>
            <Checkbox
              id='saveKeySecurely'
              checked={saveKeySecurely}
              onCheckedChange={onSaveKeySecurelyChange}
            />
            <Label
              htmlFor='saveKeySecurely'
              className='text-sm text-zinc-600 dark:text-zinc-400'
            >
              Save API key securely
            </Label>
          </div>
        </div>
      )}

      {/* Stored API key indicator — shown in edit mode when key exists in DB and user hasn't clicked "Change key" */}
      {needsApiKey() && isEditMode && hasStoredApiKey && !apiKey && !changingApiKey && (
        <div className='p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-300 flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <svg xmlns='http://www.w3.org/2000/svg' className='h-4 w-4 flex-shrink-0' viewBox='0 0 20 20' fill='currentColor'>
              <path fillRule='evenodd' d='M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z' clipRule='evenodd' />
            </svg>
            <span>API key is securely stored.</span>
          </div>
          <button
            type='button'
            onClick={() => setChangingApiKey(true)}
            className='text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-200 underline'
          >
            Change key
          </button>
        </div>
      )}

      {/* Endpoint field for local providers */}
      {needsEndpoint() && (
        <div className='space-y-2'>
          <Label className='text-sm font-medium text-zinc-800 dark:text-white'>
            Remote Endpoint URL
          </Label>
          {selectedProvider === 'ollama' ? (
            <>
              <div className='relative'>
                <Input
                  value={apiBase}
                  onChange={e => {
                    onApiBaseChange(e.target.value);
                  }}
                  className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 w-full pr-10'
                  placeholder='https://ollama.com'
                  required={needsEndpoint()}
                />
                <button
                  type='button'
                  onClick={onTestConnection}
                  disabled={connectionTestStatus === 'testing'}
                  className='absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                  title='Test Connection'
                >
                  {connectionTestStatus === 'testing' ? (
                    <svg
                      className='animate-spin h-5 w-5 text-primary'
                      xmlns='http://www.w3.org/2000/svg'
                      fill='none'
                      viewBox='0 0 24 24'
                    >
                      <circle
                        className='opacity-25'
                        cx='12'
                        cy='12'
                        r='10'
                        stroke='currentColor'
                        strokeWidth='4'
                      ></circle>
                      <path
                        className='opacity-75'
                        fill='currentColor'
                        d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                      ></path>
                    </svg>
                  ) : (
                    <svg
                      xmlns='http://www.w3.org/2000/svg'
                      className='h-5 w-5'
                      viewBox='0 0 20 20'
                      fill='currentColor'
                    >
                      <path
                        fillRule='evenodd'
                        d='M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V8c0 .853-.12 1.658-.344 2.384l.147.146a1 1 0 01.293.708V12a1 1 0 01-.4.8l-.9.675a1 1 0 00-.4.8V15a1 1 0 01-1 1h-2a1 1 0 01-1-1v-1.525a1 1 0 00-.4-.8L2.6 12.8a1 1 0 01-.4-.8v-.77a1 1 0 01.293-.708l.147-.146A10.318 10.318 0 012 8c0-1.06.328-2.313.832-3.61a.5.5 0 01.51-.365 6.772 6.772 0 01.99.003zm5.335 0c.34.008.66.022.98.041a6.014 6.014 0 011.912 2.706c.384-.391.846-.661 1.371-.661A1.5 1.5 0 0118 7.5V8c0 .853-.12 1.658-.344 2.384l.147.146a1 1 0 01.293.708V12a1 1 0 01-.4.8l-.9.675a1 1 0 00-.4.8V15a1 1 0 01-1 1h-2a1 1 0 01-1-1v-1.525a1 1 0 00-.4-.8L11.6 12.8a1 1 0 01-.4-.8v-.77a1 1 0 01.293-.708l.147-.146A10.318 10.318 0 0111 8c0-1.06.328-2.313.832-3.61a.5.5 0 01.51-.365c.34.008.66.022.98.041z'
                        clipRule='evenodd'
                      />
                    </svg>
                  )}
                </button>
              </div>
              {connectionTestStatus !== 'idle' && (
                <div
                  className={`mt-2 p-2 rounded text-sm ${
                    connectionTestStatus === 'success'
                      ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                      : connectionTestStatus === 'error'
                        ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  }`}
                >
                  <div className='flex items-start'>
                    {connectionTestStatus === 'success' && (
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        className='h-5 w-5 mr-2 flex-shrink-0'
                        viewBox='0 0 20 20'
                        fill='currentColor'
                      >
                        <path
                          fillRule='evenodd'
                          d='M10 18a8 8 0 100-16 8 8 0 000 16zM3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z'
                          clipRule='evenodd'
                        />
                      </svg>
                    )}
                    {connectionTestStatus === 'error' && (
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        className='h-5 w-5 mr-2 flex-shrink-0'
                        viewBox='0 0 20 20'
                        fill='currentColor'
                      >
                        <path
                          fillRule='evenodd'
                          d='M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z'
                          clipRule='evenodd'
                        />
                      </svg>
                    )}
                    <span style={{ whiteSpace: 'pre-line' }}>
                      {connectionTestMessage}
                    </span>
                  </div>
                </div>
              )}
              <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-2'>
                Enter the URL of your Ollama server. Use <span className='font-medium'>https://ollama.com</span> for Ollama Cloud.
              </p>

              {/* Ollama Cloud section — shown only when using ollama.com */}
              {(apiBase || '').toLowerCase().includes('ollama.com') && (
                <div className='mt-3 space-y-3'>
                  {/* Cloud setup info */}
                  <div className='p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-xs space-y-2'>
                    <p className='font-medium text-blue-800 dark:text-blue-300'>Ollama Cloud Setup</p>
                    <ol className='list-decimal list-inside space-y-1 text-blue-700 dark:text-blue-400'>
                      <li>Sign up or log in at <span className='font-medium'>ollama.com</span></li>
                      <li>Go to <span className='font-medium'>ollama.com/settings/keys</span> to create an API key</li>
                      <li>Paste the key below, then fetch available cloud models</li>
                    </ol>
                    <div className='pt-1 border-t border-blue-200 dark:border-blue-700 space-y-1 text-blue-600 dark:text-blue-400'>
                      <p><span className='font-medium'>Available models:</span> qwen3-coder:480b, gpt-oss:120b, gpt-oss:20b, deepseek-v3.1:671b</p>
                      <p><span className='font-medium'>Free tier:</span> 1 concurrent model, light usage (resets every 5h/7d)</p>
                      <p><span className='font-medium'>Pro ($20/mo):</span> 3 concurrent, 50x more usage</p>
                      <p><span className='font-medium'>Max ($100/mo):</span> 10 concurrent, 250x more usage</p>
                      <p className='italic'>Usage is measured by GPU time, not tokens. Data is never logged or trained on.</p>
                    </div>
                  </div>

                  {/* API Key input */}
                  <div className='space-y-2'>
                    <Label className='text-sm font-medium text-zinc-800 dark:text-white'>
                      Ollama Cloud API Key
                    </Label>
                    <div className='relative'>
                      <Input
                        type={showApiKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={e => onApiKeyChange(e.target.value)}
                        className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 w-full pr-10'
                        placeholder='Your Ollama Cloud API key'
                        data-testid='provider-api-key-input'
                        required
                      />
                      <button
                        type='button'
                        onClick={onToggleApiKeyVisibility}
                        className='absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                      >
                        {showApiKey ? (
                          <svg xmlns='http://www.w3.org/2000/svg' className='h-5 w-5' viewBox='0 0 20 20' fill='currentColor'>
                            <path fillRule='evenodd' d='M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z' clipRule='evenodd' />
                            <path d='M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z' />
                          </svg>
                        ) : (
                          <svg xmlns='http://www.w3.org/2000/svg' className='h-5 w-5' viewBox='0 0 20 20' fill='currentColor'>
                            <path d='M10 12a2 2 0 100-4 2 2 0 000 4z' />
                            <path fillRule='evenodd' d='M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z' clipRule='evenodd' />
                          </svg>
                        )}
                      </button>
                    </div>
                    <div className='flex items-center space-x-2'>
                      <Checkbox
                        id='saveKeySecurely'
                        checked={saveKeySecurely}
                        onCheckedChange={onSaveKeySecurelyChange}
                      />
                      <Label htmlFor='saveKeySecurely' className='text-sm text-zinc-600 dark:text-zinc-400'>
                        Save API key securely
                      </Label>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : selectedProvider === 'lmstudio' ? (
            <>
              <div className='relative'>
                <Input
                  value={apiBase}
                  onChange={e => {
                    onApiBaseChange(e.target.value);
                  }}
                  className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700 w-full pr-10'
                  placeholder='http://localhost:1234/v1'
                  required={needsEndpoint()}
                />
                <button
                  type='button'
                  onClick={onTestConnection}
                  disabled={connectionTestStatus === 'testing'}
                  className='absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'
                  title='Test Connection'
                >
                  {connectionTestStatus === 'testing' ? (
                    <svg
                      className='animate-spin h-5 w-5 text-primary'
                      xmlns='http://www.w3.org/2000/svg'
                      fill='none'
                      viewBox='0 0 24 24'
                    >
                      <circle
                        className='opacity-25'
                        cx='12'
                        cy='12'
                        r='10'
                        stroke='currentColor'
                        strokeWidth='4'
                      ></circle>
                      <path
                        className='opacity-75'
                        fill='currentColor'
                        d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                      ></path>
                    </svg>
                  ) : (
                    <svg
                      xmlns='http://www.w3.org/2000/svg'
                      className='h-5 w-5'
                      viewBox='0 0 20 20'
                      fill='currentColor'
                    >
                      <path
                        fillRule='evenodd'
                        d='M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V8c0 .853-.12 1.658-.344 2.384l.147.146a1 1 0 01.293.708V12a1 1 0 01-.4.8l-.9.675a1 1 0 00-.4.8V15a1 1 0 01-1 1h-2a1 1 0 01-1-1v-1.525a1 1 0 00-.4-.8L2.6 12.8a1 1 0 01-.4-.8v-.77a1 1 0 01.293-.708l.147-.146A10.318 10.318 0 012 8c0-1.06.328-2.313.832-3.61a.5.5 0 01.51-.365 6.772 6.772 0 01.99.003zm5.335 0c.34.008.66.022.98.041a6.014 6.014 0 011.912 2.706c.384-.391.846-.661 1.371-.661A1.5 1.5 0 0118 7.5V8c0 .853-.12 1.658-.344 2.384l.147.146a1 1 0 01.293.708V12a1 1 0 01-.4.8l-.9.675a1 1 0 00-.4.8V15a1 1 0 01-1 1h-2a1 1 0 01-1-1v-1.525a1 1 0 00-.4-.8L11.6 12.8a1 1 0 01-.4-.8v-.77a1 1 0 01.293-.708l.147-.146A10.318 10.318 0 0111 8c0-1.06.328-2.313.832-3.61a.5.5 0 01.51-.365c.34.008.66.022.98.041z'
                        clipRule='evenodd'
                      />
                    </svg>
                  )}
                </button>
              </div>
              {connectionTestStatus !== 'idle' && (
                <div
                  className={`mt-2 p-2 rounded text-sm ${
                    connectionTestStatus === 'success'
                      ? 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                      : connectionTestStatus === 'error'
                        ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  }`}
                >
                  <div className='flex items-start'>
                    {connectionTestStatus === 'success' && (
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        className='h-5 w-5 mr-2 flex-shrink-0'
                        viewBox='0 0 20 20'
                        fill='currentColor'
                      >
                        <path
                          fillRule='evenodd'
                          d='M10 18a8 8 0 100-16 8 8 0 000 16zM3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z'
                          clipRule='evenodd'
                        />
                      </svg>
                    )}
                    {connectionTestStatus === 'error' && (
                      <svg
                        xmlns='http://www.w3.org/2000/svg'
                        className='h-5 w-5 mr-2 flex-shrink-0'
                        viewBox='0 0 20 20'
                        fill='currentColor'
                      >
                        <path
                          fillRule='evenodd'
                          d='M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z'
                          clipRule='evenodd'
                        />
                      </svg>
                    )}
                    <span style={{ whiteSpace: 'pre-line' }}>
                      {connectionTestMessage}
                    </span>
                  </div>
                </div>
              )}
              <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-2'>
                Enter the URL of your LM Studio server. No API key required.
              </p>
            </>
          ) : (
            <>
              <Input
                value={apiBase}
                onChange={e => onApiBaseChange(e.target.value)}
                className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                placeholder='http://localhost:8000'
                required={needsEndpoint()}
              />
              <p className='text-xs text-zinc-500 dark:text-zinc-400 mt-2'>
                Enter the URL of your remote vLLM server.
              </p>
            </>
          )}
        </div>
      )}

      {/* Description field */}
      <div className='space-y-2'>
        <Label className='text-sm font-medium text-zinc-800 dark:text-white'>
          Description {isEditMode ? '' : '(Optional)'}
        </Label>
        <Input
          value={description}
          onChange={e => onDescriptionChange(e.target.value)}
          className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
          data-testid='provider-description-input'
          placeholder={
            isEditMode
              ? ''
              : `My ${selectedProvider.charAt(0).toUpperCase() + selectedProvider.slice(1)} Instance`
          }
        />
      </div>
    </div>
  );
};
