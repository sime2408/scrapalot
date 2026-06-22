import React, { useState, useRef } from 'react';
import { FileText, Image, Video, Upload, Loader2, X, CheckCircle, ExternalLink } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PopoverFileAttachmentProps, ChatAttachment } from '@/types/file-attachments';
import { useTranslation } from 'react-i18next';
import { extractTextFromFile, imageToBase64, isValidYoutubeUrl, extractYoutubeVideoId, getYoutubeUrlType, getYoutubeThumbnailUrl, YoutubeUrlType } from '@/lib/file-extractor';
import { apiClient } from '@/lib/api';
import { transcribeAudioFile } from '@/lib/api-stt';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
// Inline transcription is synchronous (gateway round-trip) — cap it to short
// clips so we never hit a proxy timeout. Larger media belongs in a Knowledge
// collection, which transcribes asynchronously as a permanent document.
const MAX_MEDIA_SIZE = 25 * 1024 * 1024; // 25MB

export function PopoverFileAttachment({
  onClose,
  fillHeight = false,
  onAttachmentsChange,
}: PopoverFileAttachmentProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string>('documents');
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeTranscript, setYoutubeTranscript] = useState('');
  const [showPasteFallback, setShowPasteFallback] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [youtubeUrlType, setYoutubeUrlType] = useState<YoutubeUrlType>(null);
  const [youtubeThumbnail, setYoutubeThumbnail] = useState<string | null>(null);
  const [youtubeLanguage, setYoutubeLanguage] = useState('en');
  const [youtubeIncludeTimestamps, setYoutubeIncludeTimestamps] = useState(true);
  const [youtubeIncludeMetadata, setYoutubeIncludeMetadata] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  // Chat attachments are extracted to text in the browser (see file-extractor.ts),
  // so this list is limited to formats that can be parsed client-side. Ebook
  // formats (epub) and rtf are supported by the knowledge uploader (raw upload →
  // server-side parser) but not here.
  const supportedDocTypes = ['.pdf', '.docx', '.txt', '.md', '.csv', '.tsv', '.xlsx', '.xls'];
  const supportedImageTypes = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
  const supportedMediaTypes = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.aac', '.mp4', '.mov', '.mkv', '.avi', '.m4v'];

  const addAttachments = (newAttachments: ChatAttachment[]) => {
    const updated = [...pendingAttachments, ...newAttachments];
    setPendingAttachments(updated);
    onAttachmentsChange?.(updated);
  };

  const removeAttachment = (index: number) => {
    const updated = pendingAttachments.filter((_, i) => i !== index);
    setPendingAttachments(updated);
    onAttachmentsChange?.(updated);
  };

  // Document handling
  const handleDocumentFiles = async (files: FileList) => {
    setError(null);
    setIsProcessing(true);
    const newAttachments: ChatAttachment[] = [];

    for (const file of Array.from(files)) {
      try {
        const text = await extractTextFromFile(file);
        newAttachments.push({
          type: 'document',
          filename: file.name,
          content: text,
          mimeType: file.type || 'application/octet-stream',
        });
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : 'extraction failed'}`);
      }
    }

    if (newAttachments.length > 0) {
      addAttachments(newAttachments);
    }
    setIsProcessing(false);
  };

  // Image handling
  const handleImageFiles = async (files: FileList) => {
    setError(null);
    setIsProcessing(true);
    const newAttachments: ChatAttachment[] = [];

    for (const file of Array.from(files)) {
      if (file.size > MAX_IMAGE_SIZE) {
        setError(`${file.name}: ${t('popovers.fileAttachment.imageSizeLimit')}`);
        continue;
      }
      try {
        const base64 = await imageToBase64(file);
        newAttachments.push({
          type: 'image',
          filename: file.name,
          content: base64,
          mimeType: file.type,
        });
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : 'read failed'}`);
      }
    }

    if (newAttachments.length > 0) {
      addAttachments(newAttachments);
    }
    setIsProcessing(false);
  };

  const handleYoutubeUrlChange = (value: string) => {
    setYoutubeUrl(value);
    setFetchError(null);
    const urlType = getYoutubeUrlType(value);
    setYoutubeUrlType(urlType);
    if (urlType === 'video') {
      const videoId = extractYoutubeVideoId(value);
      setYoutubeThumbnail(videoId ? getYoutubeThumbnailUrl(videoId) : null);
    } else {
      setYoutubeThumbnail(null);
    }
  };

  // YouTube handling — try auto-fetch first, fallback to paste
  const handleFetchTranscript = async () => {
    setError(null);
    setFetchError(null);
    const url = youtubeUrl.trim();
    if (!url) return;
    if (!isValidYoutubeUrl(url)) {
      setError(t('popovers.fileAttachment.invalidYoutubeUrl'));
      return;
    }

    setIsProcessing(true);
    try {
      const resp = await apiClient.get('/youtube/transcript', {
        params: { url, language: youtubeLanguage, include_timestamps: youtubeIncludeTimestamps, include_metadata: youtubeIncludeMetadata },
      });
      const transcript = resp.data?.transcript;
      if (transcript) {
        addAttachments([{
          type: 'youtube',
          filename: url,
          content: transcript,
          mimeType: 'text/plain',
        }]);
        setYoutubeUrl('');
        setShowPasteFallback(false);
      } else {
        setFetchError(t('popovers.fileAttachment.fetchFailed'));
        setShowPasteFallback(true);
      }
    } catch {
      setFetchError(t('popovers.fileAttachment.fetchFailed'));
      setShowPasteFallback(true);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddPastedTranscript = () => {
    setError(null);
    const transcript = youtubeTranscript.trim();
    if (!transcript) {
      setError(t('popovers.fileAttachment.pasteTranscriptFirst'));
      return;
    }
    const label = youtubeUrl.trim() && isValidYoutubeUrl(youtubeUrl) ? youtubeUrl.trim() : 'YouTube transcript';
    addAttachments([{
      type: 'youtube',
      filename: label,
      content: transcript,
      mimeType: 'text/plain',
    }]);
    setYoutubeUrl('');
    setYoutubeTranscript('');
    setShowPasteFallback(false);
  };

  // Audio/video → transcribe inline (Whisper) and attach the transcript as a
  // document for this message. Works for any media, not just YouTube.
  const handleMediaFiles = async (files: FileList) => {
    setError(null);
    setFetchError(null);
    setIsProcessing(true);
    for (const file of Array.from(files)) {
      if (file.size > MAX_MEDIA_SIZE) {
        setError(t('popovers.fileAttachment.mediaSizeLimit'));
        continue;
      }
      try {
        const result = await transcribeAudioFile(file, youtubeLanguage);
        const text = (result?.text || '').trim();
        if (!text) {
          setError(`${file.name}: ${t('popovers.fileAttachment.mediaNoSpeech')}`);
          continue;
        }
        addAttachments([{
          type: 'document',
          filename: file.name,
          content: text,
          mimeType: 'text/plain',
        }]);
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : t('popovers.fileAttachment.mediaTranscribeFailed')}`);
      }
    }
    setIsProcessing(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDocumentDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) void handleDocumentFiles(e.dataTransfer.files);
  };

  const handleImageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) void handleImageFiles(e.dataTransfer.files);
  };

  const currentTabAttachments = pendingAttachments.filter(a => {
    if (activeTab === 'documents') return a.type === 'document';
    if (activeTab === 'images') return a.type === 'image';
    if (activeTab === 'youtube') return a.type === 'youtube';
    return false;
  });

  return (
    <div data-testid="chat-file-attachment" className={`w-full text-sm ${fillHeight ? 'flex flex-col h-full' : ''}`}>
      <Tabs value={activeTab} onValueChange={setActiveTab} className={`w-full ${fillHeight ? 'flex flex-col flex-1 min-h-0' : ''}`}>
        <TabsList className='w-full grid grid-cols-3 bg-zinc-100 dark:bg-zinc-900 p-0.5 gap-0.5 rounded-md overflow-hidden flex-shrink-0'>
          <TabsTrigger data-testid="chat-file-tab-images" value='images' className='flex items-center gap-2 text-sm font-semibold py-2 px-3'>
            <Image className='h-4 w-4' />
            <span>{t('popovers.fileAttachment.images')}</span>
            {pendingAttachments.filter(a => a.type === 'image').length > 0 && (
              <span className='bg-primary text-white text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center'>
                {pendingAttachments.filter(a => a.type === 'image').length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger data-testid="chat-file-tab-documents" value='documents' className='flex items-center gap-2 text-sm font-semibold py-2 px-3'>
            <FileText className='h-4 w-4' />
            <span>{t('popovers.fileAttachment.documents')}</span>
            {pendingAttachments.filter(a => a.type === 'document').length > 0 && (
              <span className='bg-primary text-white text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center'>
                {pendingAttachments.filter(a => a.type === 'document').length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger data-testid="chat-file-tab-youtube" value='youtube' className='flex items-center gap-2 text-sm font-semibold py-2 px-3'>
            <Video className='h-4 w-4' />
            <span>{t('popovers.fileAttachment.media')}</span>
            {pendingAttachments.filter(a => a.type === 'youtube').length > 0 && (
              <span className='bg-primary text-white text-[10px] font-bold rounded-full h-4 w-4 flex items-center justify-center'>
                {pendingAttachments.filter(a => a.type === 'youtube').length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <div className={`mt-0 relative ${fillHeight ? 'flex-1 min-h-0 flex flex-col' : 'h-[450px]'}`}>
          {/* Error message */}
          {error && (
            <div className='mx-2 mt-2 p-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 flex items-start gap-2'>
              <span className='flex-1'>{error}</span>
              <button onClick={() => setError(null)} className='flex-shrink-0'><X className='h-3 w-3' /></button>
            </div>
          )}

          {/* Attached items for current tab */}
          {currentTabAttachments.length > 0 && (
            <div className='mx-2 mt-2 space-y-1'>
              {currentTabAttachments.map((att, i) => {
                const globalIndex = pendingAttachments.indexOf(att);
                return (
                  <div key={i} className='flex items-center gap-2 px-2 py-1.5 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800'>
                    <CheckCircle className='h-3.5 w-3.5 text-green-500 flex-shrink-0' />
                    <span className='flex-1 truncate text-xs text-zinc-700 dark:text-zinc-300'>
                      {att.filename}
                    </span>
                    {att.type === 'document' && (
                      <span className='text-[10px] text-zinc-400'>{Math.round(att.content.length / 1000)}k chars</span>
                    )}
                    <button onClick={() => removeAttachment(globalIndex)} className='flex-shrink-0 text-zinc-400 hover:text-red-500'>
                      <X className='h-3 w-3' />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Documents tab */}
          {activeTab === 'documents' && (
            <TabsContent value='documents' forceMount className={`${fillHeight ? 'flex-1' : 'absolute inset-0'} p-2 ${currentTabAttachments.length > 0 ? '' : 'pt-2'}`}>
              <div
                className='border border-dashed p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors h-full space-y-3'
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDocumentDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  borderColor: isDragging ? 'var(--primary)' : '',
                  backgroundColor: isDragging ? 'rgba(59, 130, 246, 0.05)' : '',
                }}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className='h-10 w-10 text-zinc-400 animate-spin' />
                    <p className='text-zinc-500 text-sm'>{t('popovers.fileAttachment.extracting')}</p>
                  </>
                ) : (
                  <>
                    <Upload className='h-10 w-10 text-zinc-400' />
                    <p className='text-zinc-800 dark:text-zinc-200 text-sm font-semibold'>
                      {t('popovers.fileAttachment.uploadDocuments')}
                    </p>
                    <p className='text-zinc-500 dark:text-zinc-400 text-xs'>
                      {t('popovers.fileAttachment.dragAndDrop')}
                    </p>
                    <div className='text-[11px] text-zinc-400 px-2'>
                      {supportedDocTypes.join(', ')}
                    </div>
                  </>
                )}
                <input
                  type='file'
                  ref={fileInputRef}
                  className='hidden'
                  onChange={(e) => e.target.files?.length && handleDocumentFiles(e.target.files)}
                  accept={supportedDocTypes.join(',')}
                  multiple
                />
              </div>
            </TabsContent>
          )}

          {/* Images tab */}
          {activeTab === 'images' && (
            <TabsContent value='images' forceMount className={`${fillHeight ? 'flex-1' : 'absolute inset-0'} p-2`}>
              <div
                className='border border-dashed p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors h-full space-y-3'
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleImageDrop}
                onClick={() => imageInputRef.current?.click()}
                style={{
                  borderColor: isDragging ? 'var(--primary)' : '',
                  backgroundColor: isDragging ? 'rgba(59, 130, 246, 0.05)' : '',
                }}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className='h-10 w-10 text-zinc-400 animate-spin' />
                    <p className='text-zinc-500 text-sm'>{t('popovers.fileAttachment.extracting')}</p>
                  </>
                ) : (
                  <>
                    <Image className='h-10 w-10 text-zinc-400' />
                    <p className='text-zinc-800 dark:text-zinc-200 text-sm font-semibold'>
                      {t('popovers.fileAttachment.uploadImages')}
                    </p>
                    <p className='text-zinc-500 dark:text-zinc-400 text-xs'>
                      {t('popovers.fileAttachment.dragAndDrop')}
                    </p>
                    <div className='text-[11px] text-zinc-400 px-2'>
                      {supportedImageTypes.join(', ')} ({t('popovers.fileAttachment.maxSize', { size: '5MB' })})
                    </div>
                    <p className='text-zinc-400 text-[11px] italic'>
                      {t('popovers.fileAttachment.visionModelNeeded')}
                    </p>
                  </>
                )}
                <input
                  type='file'
                  ref={imageInputRef}
                  className='hidden'
                  onChange={(e) => e.target.files?.length && handleImageFiles(e.target.files)}
                  accept={supportedImageTypes.map(t => t.replace('.', 'image/')).join(',')}
                  multiple
                />
              </div>
            </TabsContent>
          )}

          {/* YouTube tab */}
          {activeTab === 'youtube' && (
            <TabsContent value='youtube' forceMount className={`${fillHeight ? 'flex-1' : 'absolute inset-0'} p-3 flex flex-col overflow-y-auto`}>
              <div className='flex-1 flex flex-col space-y-2'>
                {!showPasteFallback ? (
                  /* Step 1: media upload (any audio/video) + YouTube URL captions */
                  <>
                    {/* Upload audio/video to transcribe — general media, not just YouTube.
                        flex-1 so it fills the top space and pushes the YouTube
                        section + action buttons flush to the bottom of the popover. */}
                    <div
                      data-testid="media-upload-dropzone"
                      onClick={() => !isProcessing && mediaInputRef.current?.click()}
                      className='flex-1 min-h-[140px] border border-dashed p-4 flex flex-col items-center justify-center text-center cursor-pointer space-y-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors'
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className='h-7 w-7 text-zinc-400 animate-spin' />
                          <p className='text-zinc-500 text-xs'>{t('popovers.fileAttachment.mediaTranscribing')}</p>
                        </>
                      ) : (
                        <>
                          <Upload className='h-7 w-7 text-zinc-400' />
                          <p className='text-zinc-800 dark:text-zinc-200 text-sm font-semibold'>
                            {t('popovers.fileAttachment.mediaUpload')}
                          </p>
                          <p className='text-[11px] text-zinc-400 px-2'>
                            {t('popovers.fileAttachment.mediaUploadHint')}
                          </p>
                        </>
                      )}
                      <input
                        type='file'
                        ref={mediaInputRef}
                        className='hidden'
                        onChange={(e) => e.target.files?.length && handleMediaFiles(e.target.files)}
                        accept={[...supportedMediaTypes, 'audio/*', 'video/*'].join(',')}
                      />
                    </div>

                    {/* Divider */}
                    <div className='flex items-center gap-2 py-0.5'>
                      <span className='flex-1 h-px bg-zinc-200 dark:bg-zinc-800' />
                      <span className='text-[10px] uppercase tracking-wide text-zinc-400'>{t('popovers.fileAttachment.or')}</span>
                      <span className='flex-1 h-px bg-zinc-200 dark:bg-zinc-800' />
                    </div>

                    <p className='text-zinc-800 dark:text-zinc-200 text-sm font-semibold'>
                      {t('popovers.fileAttachment.youtubeTranscribe')}
                    </p>
                    <p className='text-zinc-500 dark:text-zinc-400 text-xs'>
                      {t('popovers.fileAttachment.youtubeDescription')}
                    </p>

                    {/* URL input with type badge */}
                    <div className='relative'>
                      <input
                        data-testid="youtube-url-input"
                        type='text'
                        value={youtubeUrl}
                        onChange={(e) => handleYoutubeUrlChange(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && youtubeUrlType === 'video' && handleFetchTranscript()}
                        placeholder='https://www.youtube.com/watch?v=...'
                        className='w-full h-9 px-3 pr-20 border text-sm focus:outline-none focus:ring-1 focus:ring-primary dark:bg-zinc-800 dark:border-zinc-700 dark:text-white'
                      />
                      {youtubeUrlType && (
                        <span data-testid="youtube-url-type-badge" className={`absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold px-1.5 py-0.5 ${
                          youtubeUrlType === 'video' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400' :
                          youtubeUrlType === 'playlist' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400' :
                          'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400'
                        }`}>
                          {t(`popovers.fileAttachment.youtubeType.${youtubeUrlType}`)}
                        </span>
                      )}
                      {youtubeUrl.trim() && !youtubeUrlType && (
                        <span className='absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-red-500 font-medium'>
                          {t('popovers.fileAttachment.youtubeInvalidUrl')}
                        </span>
                      )}
                    </div>

                    {/* Thumbnail preview for video URLs */}
                    {youtubeThumbnail && (
                      <div data-testid="youtube-thumbnail-preview" className='relative border border-zinc-200 dark:border-zinc-700 overflow-hidden'>
                        <img
                          src={youtubeThumbnail}
                          alt='Video thumbnail'
                          className='w-full h-auto object-cover'
                          onError={() => setYoutubeThumbnail(null)}
                        />
                        {youtubeUrl.trim() && (
                          <a
                            href={youtubeUrl.trim()}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='absolute bottom-1.5 right-1.5 flex items-center gap-1 text-[10px] bg-black/70 text-white px-1.5 py-0.5 hover:bg-black/90 transition-colors'
                          >
                            <ExternalLink className='h-2.5 w-2.5' />
                            {t('popovers.fileAttachment.openOnYoutube')}
                          </a>
                        )}
                      </div>
                    )}

                    {/* Playlist/Channel info */}
                    {youtubeUrlType && youtubeUrlType !== 'video' && (
                      <div className='p-2 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-500 dark:text-zinc-400'>
                        {t('popovers.fileAttachment.youtubeNotSupported')}
                      </div>
                    )}

                    {/* Language selector + options */}
                    {youtubeUrlType === 'video' && (
                      <div className='space-y-2'>
                        {/* Language selector */}
                        <div className='flex items-center gap-2'>
                          <label className='text-xs text-zinc-600 dark:text-zinc-400 whitespace-nowrap'>
                            {t('popovers.fileAttachment.youtubeLanguage')}
                          </label>
                          <select
                            data-testid="youtube-language-select"
                            value={youtubeLanguage}
                            onChange={(e) => setYoutubeLanguage(e.target.value)}
                            className='flex-1 h-7 px-2 text-xs border bg-white dark:bg-zinc-800 dark:border-zinc-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary'
                          >
                            <option value='en'>English</option>
                            <option value='hr'>Hrvatski</option>
                            <option value='de'>Deutsch</option>
                            <option value='fr'>Fran&#231;ais</option>
                            <option value='es'>Espa&#241;ol</option>
                            <option value='it'>Italiano</option>
                            <option value='pt'>Portugu&#234;s</option>
                            <option value='ru'>&#1056;&#1091;&#1089;&#1089;&#1082;&#1080;&#1081;</option>
                            <option value='ja'>&#26085;&#26412;&#35486;</option>
                            <option value='ko'>&#54620;&#44397;&#50612;</option>
                            <option value='zh'>&#20013;&#25991;</option>
                            <option value='ar'>&#1575;&#1604;&#1593;&#1585;&#1576;&#1610;&#1577;</option>
                            <option value='hi'>&#2361;&#2367;&#2344;&#2381;&#2342;&#2368;</option>
                          </select>
                        </div>

                        {/* Metadata toggles */}
                        <div className='flex flex-wrap gap-x-4 gap-y-1'>
                          <label className='flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer'>
                            <input
                              type='checkbox'
                              checked={youtubeIncludeTimestamps}
                              onChange={(e) => setYoutubeIncludeTimestamps(e.target.checked)}
                              className='h-3.5 w-3.5 accent-primary'
                            />
                            {t('popovers.fileAttachment.youtubeTimestamps')}
                          </label>
                          <label className='flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer'>
                            <input
                              type='checkbox'
                              checked={youtubeIncludeMetadata}
                              onChange={(e) => setYoutubeIncludeMetadata(e.target.checked)}
                              className='h-3.5 w-3.5 accent-primary'
                            />
                            {t('popovers.fileAttachment.youtubeMetadata')}
                          </label>
                        </div>
                      </div>
                    )}

                    {/* Fetch + Paste manually in one row */}
                    <div className='flex items-center gap-2'>
                      <button
                        data-testid="youtube-fetch-button"
                        onClick={handleFetchTranscript}
                        disabled={youtubeUrlType !== 'video' || isProcessing}
                        className='flex-1 h-9 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white px-4 text-sm transition-colors font-semibold flex items-center justify-center gap-2'
                      >
                        {isProcessing ? (
                          <>
                            <Loader2 className='h-4 w-4 animate-spin' />
                            {t('popovers.fileAttachment.extracting')}
                          </>
                        ) : (
                          t('popovers.fileAttachment.fetchTranscript')
                        )}
                      </button>
                      <button
                        onClick={() => setShowPasteFallback(true)}
                        className='h-9 px-3 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap'
                      >
                        {t('popovers.fileAttachment.pasteManually')}
                      </button>
                    </div>

                    {fetchError && (
                      <p className='text-xs text-zinc-500 dark:text-zinc-400 text-center'>
                        {fetchError}
                      </p>
                    )}
                  </>
                ) : (
                  /* Step 2: Paste fallback */
                  <>
                    <div className='flex items-center justify-between'>
                      <p className='text-zinc-800 dark:text-zinc-200 text-sm font-semibold'>
                        {t('popovers.fileAttachment.pasteTranscript')}
                      </p>
                      {youtubeUrl.trim() && isValidYoutubeUrl(youtubeUrl) && (
                        <a
                          href={youtubeUrl.trim()}
                          target='_blank'
                          rel='noopener noreferrer'
                          className='flex items-center gap-1 text-xs text-primary hover:underline'
                        >
                          <ExternalLink className='h-3 w-3' />
                          {t('popovers.fileAttachment.openOnYoutube')}
                        </a>
                      )}
                    </div>
                    <p className='text-zinc-500 dark:text-zinc-400 text-xs'>
                      {t('popovers.fileAttachment.youtubeDescriptionPaste')}
                    </p>
                    <textarea
                      value={youtubeTranscript}
                      onChange={(e) => setYoutubeTranscript(e.target.value)}
                      placeholder={t('popovers.fileAttachment.pasteTranscriptHere')}
                      className='w-full flex-1 min-h-[120px] p-2 border text-xs focus:outline-none focus:ring-1 focus:ring-primary dark:bg-zinc-800 dark:border-zinc-700 dark:text-white resize-none'
                      autoFocus
                    />
                    <div className='flex gap-2'>
                      <button
                        onClick={() => { setShowPasteFallback(false); setFetchError(null); }}
                        className='h-9 px-4 border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors'
                      >
                        {t('general.cancel')}
                      </button>
                      <button
                        onClick={handleAddPastedTranscript}
                        disabled={!youtubeTranscript.trim()}
                        className='flex-1 h-9 bg-primary hover:bg-primary/90 disabled:opacity-50 text-white px-4 text-sm transition-colors font-semibold'
                      >
                        {t('popovers.fileAttachment.addTranscript')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </TabsContent>
          )}
        </div>
      </Tabs>

      {/* Done button */}
      {pendingAttachments.length > 0 && (
        <div className='p-2 border-t border-zinc-200 dark:border-zinc-800 flex-shrink-0'>
          <button
            onClick={onClose}
            className='w-full h-9 bg-primary hover:bg-primary/90 text-white text-sm font-semibold transition-colors'
          >
            {t('popovers.fileAttachment.done', { count: pendingAttachments.length })}
          </button>
        </div>
      )}
    </div>
  );
}
