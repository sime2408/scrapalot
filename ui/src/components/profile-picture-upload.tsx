import React, { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Cropper, { Area } from 'react-easy-crop';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import { uploadProfilePicture, type User } from '@/lib/api-users';

interface ProfilePictureUploadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploadSuccess?: (user: User) => void;
}

const createImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', (error) => reject(error));
    image.src = url;
  });

async function getCroppedImg(imageSrc: string, pixelCrop: Area): Promise<Blob> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('No 2d context');
  }

  // Set canvas size to the crop size
  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;

  // Draw the cropped image
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height
  );

  // Convert canvas to blob
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Canvas is empty'));
        return;
      }
      resolve(blob);
    }, 'image/jpeg', 0.95);
  });
}

export const ProfilePictureUpload: React.FC<ProfilePictureUploadProps> = ({
  open,
  onOpenChange,
  onUploadSuccess,
}) => {
  const { t } = useTranslation();
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const onCropComplete = useCallback((croppedArea: Area, croppedAreaPixels: Area) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      
      // Validate file size (4MB max)
      const maxSize = 4 * 1024 * 1024; // 4MB in bytes
      if (file.size > maxSize) {
        alert(t('common.fileSizeTooLarge'));
        return;
      }
      
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        setImageSrc(reader.result as string);
      });
      reader.readAsDataURL(file);
    }
  };

  const handleUpload = async () => {
    if (!imageSrc || !croppedAreaPixels) return;

    try {
      setIsUploading(true);
      const croppedImage = await getCroppedImg(imageSrc, croppedAreaPixels);
      const file = new File([croppedImage], 'profile-picture.jpg', {
        type: 'image/jpeg',
      });

      const updatedUser = await uploadProfilePicture(file);

      // Reset state and close dialog
      setImageSrc(null);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      onOpenChange(false);

      if (onUploadSuccess && updatedUser) {
        onUploadSuccess(updatedUser);
      }
    } catch (error) {
      console.error('Error uploading profile picture:', error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleCancel = () => {
    setImageSrc(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    onOpenChange(false);
  };

  const handleSelectFile = () => {
    fileInputRef.current?.click();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[500px]' overlayZIndex='1051'>
        <DialogHeader>
          <DialogTitle>
            Upload Profile Picture
          </DialogTitle>
        </DialogHeader>

        <div className='space-y-4'>
          {!imageSrc ? (
            <div
              onClick={handleSelectFile}
              className='border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-12 flex flex-col items-center justify-center cursor-pointer hover:border-blue-500 dark:hover:border-blue-400 transition-colors'
            >
              <Upload className='w-12 h-12 text-zinc-400 dark:text-zinc-600 mb-4' />
              <p className='text-sm text-zinc-600 dark:text-zinc-400 mb-2'>
                Click to select an image
              </p>
              <p className='text-xs text-zinc-500 dark:text-zinc-500'>
                Supports JPG, PNG (max 2MB)
              </p>
              <input
                ref={fileInputRef}
                type='file'
                accept='image/*'
                onChange={handleFileChange}
                className='hidden'
              />
            </div>
          ) : (
            <>
              <div className='relative w-full h-64 bg-zinc-100 dark:bg-zinc-800 rounded-lg overflow-hidden'>
                <Cropper
                  image={imageSrc}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  cropShape='round'
                  showGrid={false}
                  onCropChange={setCrop}
                  onCropComplete={onCropComplete}
                  onZoomChange={setZoom}
                />
              </div>

              <div className='space-y-2'>
                <div className='flex items-center gap-3'>
                  <ZoomOut className='w-4 h-4 text-zinc-600 dark:text-zinc-400' />
                  <Slider
                    value={[zoom]}
                    onValueChange={([value]) => setZoom(value)}
                    min={1}
                    max={3}
                    step={0.1}
                    className='flex-1'
                  />
                  <ZoomIn className='w-4 h-4 text-zinc-600 dark:text-zinc-400' />
                </div>
                <p className='text-xs text-zinc-500 dark:text-zinc-500 text-center'>
                  Drag to reposition, scroll or use slider to zoom
                </p>
              </div>

              <Button
                variant='outline'
                onClick={handleSelectFile}
                className='w-full'
              >
                Choose Different Image
              </Button>
            </>
          )}
        </div>

        <DialogFooter className='flex-row justify-between items-center gap-2'>
          <Button
            variant='outline'
            onClick={handleCancel}
            disabled={isUploading}
            className='flex-1'
          >
            <X className='w-4 h-4 mr-2' />
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={!imageSrc || isUploading}
            className='flex-1'
          >
            {isUploading ? (
              <>
                <span className='animate-spin mr-2'>⏳</span>
                Uploading...
              </>
            ) : (
              <>
                <Upload className='w-4 h-4 mr-2' />
                Upload
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
