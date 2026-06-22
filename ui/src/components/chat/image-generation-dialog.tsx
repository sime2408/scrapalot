/**
 * Image Generation composer + viewer.
 *
 * One Radix Dialog that contains both the composer (prompt + size + count)
 * and the result tiles. Streams ``image_attached`` packets via the NDJSON
 * client and renders a placeholder card with a spinner until the first tile
 * arrives, then swaps to the real image with the upstream-revised prompt
 * captioned beneath.
 */
import { Download, ImagePlus, Loader2, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import {
  generateImage,
  imageStorageUrl,
  type GenerateImageInput,
} from '@/lib/api-image-generation';
import type { ImageAttachedPacket } from '@/types/streaming-packets';

const SIZES: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: '1024x1024', labelKey: 'imageGeneration.size.square' },
  { value: '1024x1792', labelKey: 'imageGeneration.size.portrait' },
  { value: '1792x1024', labelKey: 'imageGeneration.size.landscape' },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string;
  sessionId?: string;
}

export function ImageGenerationDialog({ open, onOpenChange, workspaceId, sessionId }: Props) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<string>('1024x1024');
  const [n, setN] = useState<number>(1);
  const [generating, setGenerating] = useState(false);
  const [images, setImages] = useState<ImageAttachedPacket[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setImages([]);
    setError(null);
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) {
        // Wipe results so the next open is fresh — keep the last prompt so the
        // user can tweak and regenerate without retyping.
        reset();
        setGenerating(false);
      }
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handleGenerate = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;

    reset();
    setGenerating(true);

    const messageId = crypto.randomUUID();
    const input: GenerateImageInput = {
      prompt: trimmed,
      message_id: messageId,
      size,
      n,
      workspace_id: workspaceId,
      session_id: sessionId,
    };

    try {
      await generateImage(input, {
        onImage: (packet) => {
          setImages((prev) => [...prev, packet]);
        },
        onError: (packet) => {
          setError(packet.content);
        },
        onEnd: () => {
          setGenerating(false);
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGenerating(false);
    }
  }, [prompt, generating, size, n, workspaceId, sessionId, reset]);

  const showPlaceholders = generating && images.length < n;
  const placeholderCount = Math.max(0, n - images.length);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className='max-w-3xl' disableFullscreenOnMobile={false}>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Sparkles className='h-4 w-4' aria-hidden='true' />
            {t('imageGeneration.title')}
          </DialogTitle>
          <DialogDescription>{t('imageGeneration.description')}</DialogDescription>
        </DialogHeader>

        <div className='flex flex-col gap-4'>
          <div>
            <label className='mb-1 block text-sm font-medium' htmlFor='img-gen-prompt'>
              {t('imageGeneration.prompt')}
            </label>
            <Textarea
              id='img-gen-prompt'
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('imageGeneration.promptPlaceholder')}
              rows={3}
              maxLength={4000}
              disabled={generating}
            />
          </div>

          <div className='grid grid-cols-2 gap-4'>
            <div>
              <label className='mb-1 block text-sm font-medium' htmlFor='img-gen-size'>
                {t('imageGeneration.size.label')}
              </label>
              <Select value={size} onValueChange={setSize} disabled={generating}>
                <SelectTrigger id='img-gen-size'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {t(s.labelKey)} — {s.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className='mb-1 block text-sm font-medium' htmlFor='img-gen-count'>
                {t('imageGeneration.count', { count: n })}
              </label>
              <Slider
                id='img-gen-count'
                min={1}
                max={4}
                step={1}
                value={[n]}
                onValueChange={(v) => setN(v[0] ?? 1)}
                disabled={generating}
              />
            </div>
          </div>

          {error && (
            <div className='border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive'>
              {error}
            </div>
          )}

          {(images.length > 0 || showPlaceholders) && (
            <div className='grid grid-cols-2 gap-3' data-testid='image-generation-results'>
              {images.map((img) => (
                <ImageTile key={`${img.message_id}-${img.idx}`} packet={img} />
              ))}
              {Array.from({ length: placeholderCount }).map((_, i) => (
                <PlaceholderTile key={`pending-${i}`} />
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant='outline' onClick={() => handleClose(false)} disabled={generating}>
            {t('common.close')}
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
            data-testid='image-generation-submit'
          >
            {generating ? (
              <>
                <Loader2 className='mr-2 h-4 w-4 animate-spin' aria-hidden='true' />
                {t('imageGeneration.generating')}
              </>
            ) : (
              <>
                <ImagePlus className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('imageGeneration.generate')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlaceholderTile() {
  const { t } = useTranslation();
  return (
    <div className='flex aspect-square items-center justify-center border border-border bg-muted/30 text-muted-foreground'>
      <div className='flex flex-col items-center gap-2 text-sm'>
        <Loader2 className='h-6 w-6 animate-spin' aria-hidden='true' />
        <span>{t('imageGeneration.generating')}</span>
      </div>
    </div>
  );
}

function ImageTile({ packet }: { packet: ImageAttachedPacket }) {
  const { t } = useTranslation();
  const url = imageStorageUrl(packet.storage_path);
  const filename = packet.storage_path.split('/').pop() ?? 'image.png';

  return (
    <div className='flex flex-col gap-2 border border-border p-2'>
      <img
        src={url}
        alt={packet.prompt ?? t('imageGeneration.title')}
        className='aspect-square w-full object-cover'
        loading='lazy'
      />
      {packet.revised_prompt && packet.revised_prompt !== packet.prompt && (
        <p className='line-clamp-3 text-xs text-muted-foreground'>
          <span className='font-medium'>{t('imageGeneration.revisedPrompt')}: </span>
          {packet.revised_prompt}
        </p>
      )}
      <div className='flex items-center justify-between text-xs text-muted-foreground'>
        <span>
          {packet.width}×{packet.height} · {packet.model_name ?? ''}
        </span>
        <a
          href={url}
          download={filename}
          className='inline-flex items-center gap-1 text-primary hover:underline'
        >
          <Download className='h-3 w-3' aria-hidden='true' />
          {t('common.download')}
        </a>
      </div>
    </div>
  );
}
