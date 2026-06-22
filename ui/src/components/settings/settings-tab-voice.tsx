import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Mic } from 'lucide-react';

import { NoAutofillInput } from '@/components/ui/no-autofill-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAdminCheck } from '@/hooks/use-admin-check';
import { getSpeechConfig, saveSpeechConfig, SpeechConfig } from '@/lib/api-settings';
import { toast } from '@/lib/toast-compat';

interface SettingsVoiceTabProps {
  voiceOpenaiApiKey: string;
  setVoiceOpenaiApiKey: (value: string) => void;
}

export const SettingsVoiceTab: React.FC<SettingsVoiceTabProps> = ({
  voiceOpenaiApiKey,
  setVoiceOpenaiApiKey,
}) => {
  const { t } = useTranslation();
  const isAdmin = useAdminCheck();

  const [speechConfig, setSpeechConfig] = useState<SpeechConfig>({
    stt_provider: 'openai',
    stt_model: 'whisper-1',
    tts_provider: 'edge',
    tts_default_voice: '',
    has_stt_api_key: false,
    has_elevenlabs_key: false,
  });
  const [sttApiKey, setSttApiKey] = useState('');
  const [elevenlabsApiKey, setElevenlabsApiKey] = useState('');
  const [speechConfigLoading, setSpeechConfigLoading] = useState(false);
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const hasLoadedRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    setSpeechConfigLoading(true);
    hasLoadedRef.current = false;
    getSpeechConfig()
      .then((config) => {
        setSpeechConfig(config);
        hasLoadedRef.current = true;
      })
      .catch((err) => console.error('Failed to load speech config:', err))
      .finally(() => setSpeechConfigLoading(false));
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || !hasLoadedRef.current) return;

    const handle = setTimeout(async () => {
      setAutoSaveState('saving');
      try {
        await saveSpeechConfig({
          ...speechConfig,
          stt_api_key: sttApiKey || undefined,
          elevenlabs_api_key: elevenlabsApiKey || undefined,
        });
        if (sttApiKey || elevenlabsApiKey) {
          setSttApiKey('');
          setElevenlabsApiKey('');
          const updated = await getSpeechConfig();
          setSpeechConfig(updated);
        }
        setAutoSaveState('saved');
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => setAutoSaveState('idle'), 2000);
      } catch (err) {
        console.error('Failed to save speech config:', err);
        setAutoSaveState('idle');
        toast({
          title: t('general.error'),
          description: t('settings.speech.saveError', 'Failed to save speech config.'),
          variant: 'destructive',
        });
      }
    }, 800);

    return () => clearTimeout(handle);
  }, [isAdmin, speechConfig, sttApiKey, elevenlabsApiKey, t]);

  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  return (
    <>
      <div className='sticky top-0 pt-0 pb-6 z-20' style={{ position: 'sticky' }}>
        <div
          className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10'
          style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
        />
        <div className='flex items-center justify-between'>
          <div>
            <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
              {t('settings.tabs.voice', 'Voice')}
            </h2>
            <p className='text-sm text-zinc-500 dark:text-zinc-400'>
              {t('settings.voice.description', 'Voice assistant: wake word, your Whisper key, and (admin) speech provider configuration.')}
            </p>
          </div>
        </div>
      </div>

      <div className='space-y-6'>
        {/* BYOK Whisper key — same per-user setting as before, just relocated
            here so all voice knobs live together. */}
        <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
          <div className='flex items-start gap-3 mb-4'>
            <div className='w-10 h-10 flex items-center justify-center mt-1'>
              <Mic className='w-5 h-5 text-rose-600 dark:text-rose-400' />
            </div>
            <div className='flex-1'>
              <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                {t('settings.general.voiceMode.title', 'Voice mode (BYOK)')}
              </h3>
              <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                {t('settings.general.voiceMode.description', 'Provide your own OpenAI key for the live voice conversation transcription. Leave empty to use the system key.')}
              </p>
            </div>
          </div>
          <div className='pl-13 space-y-2'>
            <label className='text-xs font-medium text-zinc-700 dark:text-zinc-300 block'>
              {t('settings.general.voiceMode.apiKeyLabel', 'OpenAI API key')}
            </label>
            {/*
              NoAutofillInput, not a plain field: Chrome's password manager
              autofilled the saved login password here ("admin123") and its
              native profile autofill dropped the account email ("admin@test.com")
              — both then persisted by settings auto-save as the voice API key
              → 401 on every voice turn. See the component for the two-layer
              guard. The key is shown only while typing; backend never echoes it.
            */}
            <NoAutofillInput
              data-testid='settings-voice-openai-key'
              value={voiceOpenaiApiKey}
              onChange={(e) => setVoiceOpenaiApiKey(e.target.value)}
              placeholder='sk-…'
              className='max-w-md font-mono text-xs'
              name='voice-openai-key'
            />
            <p className='text-[11px] text-zinc-500 dark:text-zinc-400'>
              {t('settings.general.voiceMode.apiKeyHint', 'Used only for /voice/transcribe. Stored per-user, never echoed back in clear.')}
            </p>
          </div>
        </div>

        {/* Speech Services Configuration (Admin Only) */}
        {isAdmin && (
          <div className='relative overflow-hidden bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4 shadow-sm'>
            <div className='flex items-start gap-3 mb-5'>
              <div className='w-10 h-10 flex items-center justify-center mt-1'>
                <Mic className='w-5 h-5 text-sky-600 dark:text-sky-400' />
              </div>
              <div className='flex-1'>
                <h3 className='text-lg font-semibold text-zinc-900 dark:text-white'>
                  {t('settings.speech.title', 'Speech Services')}
                </h3>
                <p className='text-sm text-zinc-600 dark:text-zinc-400'>
                  {t('settings.speech.description', 'Configure Speech-to-Text (STT) and Text-to-Speech (TTS) providers.')}
                </p>
              </div>
            </div>

            {speechConfigLoading ? (
              <div className='pl-13 text-sm text-zinc-500'>{t('general.loading')}...</div>
            ) : (
              <div className='pl-13 space-y-4'>
                <div className='grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-4'>
                  <div className='space-y-4'>
                    <p className='text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500'>
                      {t('settings.speech.sttSection', 'Speech-to-Text')}
                    </p>

                    <div>
                      <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                        {t('settings.speech.sttProvider', 'STT Provider')}
                      </label>
                      <Select
                        value={speechConfig.stt_provider}
                        onValueChange={(value) => setSpeechConfig({ ...speechConfig, stt_provider: value })}
                      >
                        <SelectTrigger className='w-full border-zinc-300 dark:border-zinc-700'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className='z-[1100]'>
                          <SelectItem value='openai'>OpenAI Whisper</SelectItem>
                          <SelectItem value='faster_whisper'>Faster Whisper (local)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div>
                      <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                        {t('settings.speech.sttModel', 'STT Model')}
                      </label>
                      <Select
                        value={speechConfig.stt_model}
                        onValueChange={(value) => setSpeechConfig({ ...speechConfig, stt_model: value })}
                      >
                        <SelectTrigger className='w-full border-zinc-300 dark:border-zinc-700'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className='z-[1100]'>
                          {speechConfig.stt_provider === 'openai' ? (
                            <>
                              <SelectItem value='whisper-1'>whisper-1</SelectItem>
                              <SelectItem value='gpt-4o-mini-transcribe'>gpt-4o-mini-transcribe</SelectItem>
                              <SelectItem value='gpt-4o-transcribe'>gpt-4o-transcribe</SelectItem>
                            </>
                          ) : (
                            <>
                              <SelectItem value='tiny'>tiny</SelectItem>
                              <SelectItem value='base'>base</SelectItem>
                              <SelectItem value='small'>small</SelectItem>
                              <SelectItem value='medium'>medium</SelectItem>
                              <SelectItem value='large-v3'>large-v3</SelectItem>
                            </>
                          )}
                        </SelectContent>
                      </Select>
                    </div>

                    {speechConfig.stt_provider === 'openai' && (
                      <div>
                        <div className='flex items-center gap-2 mb-1.5'>
                          <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                            {t('settings.speech.sttApiKey', 'OpenAI API Key (for STT)')}
                          </label>
                          {speechConfig.has_stt_api_key ? (
                            <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border border-green-300 dark:border-green-700'>
                              ✓ {t('settings.speech.keyConfigured', 'Configured')}
                            </span>
                          ) : (
                            <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700'>
                              ⚠ {t('settings.speech.keyNotSet', 'Not set')}
                            </span>
                          )}
                        </div>
                        {/*
                          NoAutofillInput: Chrome autofilled the admin's saved
                          login password here and the auto-save persisted it as
                          the STT key (observed in DB: stt_api_key = "admin123")
                          → 401 on every Whisper call. Shown only while typing;
                          backend never echoes it (has_stt_api_key bool only).
                        */}
                        <NoAutofillInput
                          data-testid='settings-stt-openai-key'
                          value={sttApiKey}
                          onChange={(e) => setSttApiKey(e.target.value)}
                          placeholder={speechConfig.has_stt_api_key ? '••••••••' : 'sk-...'}
                          className='w-full border-zinc-300 dark:border-zinc-700 font-mono text-xs'
                          name='stt-openai-key'
                        />
                      </div>
                    )}
                  </div>

                  <div className='space-y-4'>
                    <p className='text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500'>
                      {t('settings.speech.ttsSection', 'Text-to-Speech')}
                    </p>

                    <div>
                      <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5 block'>
                        {t('settings.speech.ttsProvider', 'TTS Provider')}
                      </label>
                      <Select
                        value={speechConfig.tts_provider}
                        onValueChange={(value) => setSpeechConfig({ ...speechConfig, tts_provider: value })}
                      >
                        <SelectTrigger className='w-full border-zinc-300 dark:border-zinc-700'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className='z-[1100]'>
                          <SelectItem value='edge'>Edge TTS (free)</SelectItem>
                          <SelectItem value='google'>Google TTS (free)</SelectItem>
                          <SelectItem value='elevenlabs'>ElevenLabs</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {speechConfig.tts_provider === 'elevenlabs' && (
                      <div>
                        <div className='flex items-center gap-2 mb-1.5'>
                          <label className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
                            {t('settings.speech.elevenlabsKey', 'ElevenLabs API Key')}
                          </label>
                          {speechConfig.has_elevenlabs_key ? (
                            <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 border border-green-300 dark:border-green-700'>
                              ✓ {t('settings.speech.keyConfigured', 'Configured')}
                            </span>
                          ) : (
                            <span className='inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-300 dark:border-amber-700'>
                              ⚠ {t('settings.speech.keyNotSet', 'Not set')}
                            </span>
                          )}
                        </div>
                        {/* Same Chrome-autofill guard as the STT key above. */}
                        <NoAutofillInput
                          data-testid='settings-elevenlabs-key'
                          value={elevenlabsApiKey}
                          onChange={(e) => setElevenlabsApiKey(e.target.value)}
                          placeholder={speechConfig.has_elevenlabs_key ? '••••••••' : 'xi-...'}
                          className='w-full border-zinc-300 dark:border-zinc-700 font-mono text-xs'
                          name='elevenlabs-key'
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className='p-3 bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800/50 text-sm text-sky-700 dark:text-sky-300'>
                  <p>{t('settings.speech.info', 'STT enables voice input in chat. TTS enables text-to-speech for messages and document reading.')}</p>
                </div>

                <div className='flex items-center gap-2 h-5 text-xs text-zinc-500 dark:text-zinc-400'>
                  {autoSaveState === 'saving' && (
                    <>
                      <Loader2 className='w-3.5 h-3.5 animate-spin' />
                      <span>{t('settings.speech.autoSaving', 'Auto-saving…')}</span>
                    </>
                  )}
                  {autoSaveState === 'saved' && (
                    <>
                      <Check className='w-3.5 h-3.5 text-emerald-500' />
                      <span>{t('settings.speech.autoSaved', 'Saved automatically')}</span>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
};
