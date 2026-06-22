import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ShieldCheck, Sparkles, ChevronDown } from 'lucide-react';
import { toast } from '@/lib/toast-compat';
import { acceptLicenseAgreement } from '@/lib/api-users';

interface LicenseAgreementModalProps {
  open: boolean;
  onAccepted: () => void;
}

export const LicenseAgreementModal: React.FC<LicenseAgreementModalProps> = ({ open, onAccepted }) => {
  const { t } = useTranslation();
  const [licenseAgreement, setLicenseAgreement] = useState(false);
  const [contentSharing, setContentSharing] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [licenseExpanded, setLicenseExpanded] = useState(false);
  const [contentSharingExpanded, setContentSharingExpanded] = useState(false);

  const handleAccept = async () => {
    if (!licenseAgreement) {
      toast.error(t('auth.license.mustAgree'));
      return;
    }

    setIsSubmitting(true);
    try {
      await acceptLicenseAgreement(contentSharing);
      toast.success(t('auth.licenseAccepted'));
      onAccepted();
    } catch (error) {
      console.error('Failed to accept license agreement:', error);
      toast.error(t('auth.licenseAcceptFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={() => {}}>
        <DialogContent
          data-testid="auth-license-modal"
          className='max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden z-[10010]'
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          hideCloseButton={true}
          overlayZIndex='10005'
        >
          <DialogHeader>
            <DialogTitle className='text-2xl'>{t('auth.license.welcome')}</DialogTitle>
            <DialogDescription>
              {t('auth.license.reviewPrompt')}
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-6 py-4'>
            {/* License Agreement Section */}
            <div className='space-y-3'>
              <div className='flex items-start gap-3'>
                <Checkbox
                  data-testid="auth-license-checkbox"
                  id='license-agreement-modal'
                  checked={licenseAgreement}
                  onCheckedChange={(checked) => setLicenseAgreement(checked as boolean)}
                  className='mt-1 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600'
                />
                <div className='flex-1'>
                  <div className='flex items-center gap-2 mb-1'>
                    <ShieldCheck className='w-4 h-4 text-blue-600 dark:text-blue-400' />
                    <Label
                      htmlFor='license-agreement-modal'
                      className='text-base font-semibold text-gray-900 dark:text-white cursor-pointer'
                    >
                      {t('auth.license.title')} <span className='text-red-500'>*</span>
                    </Label>
                  </div>
                  <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>
                    {t('auth.license.agreeTerms')}
                  </p>
                  <button
                    data-testid="auth-license-details-toggle"
                    type='button'
                    onClick={() => setLicenseExpanded(!licenseExpanded)}
                    className='text-sm text-blue-600 dark:text-blue-400 hover:underline transition-colors flex items-center gap-1'
                  >
                    <ChevronDown className={`w-4 h-4 transition-transform ${licenseExpanded ? 'rotate-180' : ''}`} />
                    {licenseExpanded ? t('common.hideDetails') : t('common.showDetails')}
                  </button>

                  {licenseExpanded && (
                    <div className='mt-3 p-4 bg-gray-50 dark:bg-zinc-800 rounded-lg text-sm text-gray-700 dark:text-gray-300 space-y-2 max-h-60 overflow-y-auto'>
                      <p className='font-semibold'>{t('auth.license.agreementTitle')}</p>
                      <p>{t('auth.license.agreementIntro')}</p>
                      <p><strong>{t('auth.license.permittedUses')}:</strong> {t('auth.license.permittedUsesDesc')}</p>
                      <p><strong>{t('auth.license.prohibitedUses')}:</strong> {t('auth.license.prohibitedUsesDesc')}</p>
                      <p><strong>{t('auth.license.dataPrivacy')}:</strong> {t('auth.license.dataPrivacyDesc')}</p>
                      <p><strong>{t('auth.license.disclaimer')}:</strong> {t('auth.license.disclaimerDesc')}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Content Sharing Section */}
            <div className='space-y-3'>
              <div className='flex items-start gap-3'>
                <Checkbox
                  data-testid="auth-content-sharing-checkbox"
                  id='content-sharing-modal'
                  checked={contentSharing}
                  onCheckedChange={(checked) => setContentSharing(checked as boolean)}
                  className='mt-1 data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600'
                />
                <div className='flex-1'>
                  <div className='flex items-center gap-2 mb-1'>
                    <Sparkles className='w-4 h-4 text-green-600 dark:text-green-400' />
                    <Label
                      htmlFor='content-sharing-modal'
                      className='text-base font-semibold text-gray-900 dark:text-white cursor-pointer'
                    >
                      {t('auth.license.helpImprove')}
                    </Label>
                  </div>
                  <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>
                    {t('auth.license.shareUsageData')}
                  </p>
                  <button
                    data-testid="auth-content-sharing-details-toggle"
                    type='button'
                    onClick={() => setContentSharingExpanded(!contentSharingExpanded)}
                    className='text-sm text-green-600 dark:text-green-400 hover:underline transition-colors flex items-center gap-1'
                  >
                    <ChevronDown className={`w-4 h-4 transition-transform ${contentSharingExpanded ? 'rotate-180' : ''}`} />
                    {contentSharingExpanded ? t('common.hideDetails') : t('common.showDetails')}
                  </button>

                  {contentSharingExpanded && (
                    <div className='mt-3 p-4 bg-gray-50 dark:bg-zinc-800 rounded-lg text-sm text-gray-700 dark:text-gray-300 space-y-2'>
                      <p className='font-semibold'>{t('auth.license.whatWeCollect')}</p>
                      <p>{t('auth.license.whatWeCollectDesc')}</p>
                      <p><strong>{t('auth.license.whatWeDontCollect')}:</strong> {t('auth.license.whatWeDontCollectDesc')}</p>
                      <p><strong>{t('auth.license.purpose')}:</strong> {t('auth.license.purposeDesc')}</p>
                      <p className='text-xs text-gray-500 dark:text-gray-400'>{t('auth.license.changeInSettings')}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className='flex justify-end gap-3 pt-4 border-t'>
            <Button
              data-testid="auth-license-accept-button"
              onClick={handleAccept}
              disabled={!licenseAgreement || isSubmitting}
              className='bg-blue-600 hover:bg-blue-700 text-white disabled:bg-gray-400 disabled:cursor-not-allowed'
            >
              {isSubmitting ? t('auth.license.accepting') : t('auth.license.acceptAndContinue')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
