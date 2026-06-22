import React, { useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

import {
  Trash2,
  Plus,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  BrainCircuit,
  Loader2,
  ChevronUp,
  ChevronDown,
  MoreVertical,
  Pencil,
  Power,
  Server,
  MoreHorizontal,
  Edit,
  Download,
  Upload,
} from 'lucide-react';
import { toast } from '@/lib/toast-compat';
import { useTheme } from '@/providers/theme-provider';
import {
  SettingsRemoteProvidersTabProps,
  ProviderStatus,
  RemoteProvider,
} from '@/types/settings-types.ts';
import { isLocalProvider } from '@/lib/provider-utils';
import { getIconForProvider } from '@/lib/api-llm-inference';
import { useProviders } from '@/hooks/useProviders';
import { useAdminCheck } from '@/hooks/use-admin-check';
import { uiState } from '@/lib/storage-utils';
import { Lock } from 'lucide-react';
import {
  exportProviderConfigurations,
  importProviderConfigurations,
} from '@/lib/api-settings';
import { invalidateModelsCache, invalidateProvidersCache } from '@/lib/api-llm-inference';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Reusable component for provider status badges
const ProviderStatusBadges: React.FC<{
  provider: RemoteProvider;
  t: (key: string) => string;
}> = ({ provider, t }) => (
  <div className='flex items-center gap-2 flex-wrap'>
    <p className='font-medium text-zinc-800 dark:text-white'>
      {provider.name}
    </p>
    {!provider.has_api_key &&
      !['ollama', 'vllm'].includes(
        (provider.provider_type || '').toLowerCase()
      ) && (
        <span className='inline-flex items-center px-1.5 py-0.25 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300'>
          {t('settings.providersRemote.noApiKey')}
        </span>
      )}
    {provider.validation_status === 'invalid' && (
      <span className='inline-flex items-center px-1.5 py-0.25 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'>
        {t('settings.providersRemote.invalidToken')}
      </span>
    )}
    {provider.validation_status === 'valid' &&
      provider.has_api_key && (
        <span className='inline-flex items-center px-1.5 py-0.25 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'>
          {t('settings.providersRemote.validToken')}
        </span>
      )}
  </div>
);

export const SettingsRemoteProvidersTab: React.FC<
  SettingsRemoteProvidersTabProps
> = ({
  providers,
  loading = false,
  handleAddProvider,
  handleEditProvider,
  isMobile: _isMobile,
  updateProvider,
  deleteProvider,
  fetchProviders,
}) => {
    const { t } = useTranslation();
    const { accentColor } = useTheme();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { fetchProviders: hookFetchProviders } = useProviders();
    const [isRefreshing, setIsRefreshing] = useState(false);
    // The "Scrapalot AI" / system provider is rendered as a pinned card
    // above the table and its actions (edit / toggle / delete) are
    // gated to admins. Non-admins see a read-only card with a lock
    // affordance — they consume the system provider from chat but
    // cannot reconfigure or disable it.
    const isAdmin = useAdminCheck() === true;

    // State to track which providers have expanded model lists
    const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
      new Set()
    );

    // Sorting state
    const [sortField, setSortField] = useState<'name' | 'status' | null>(null);
    const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

    // Toggle expanded state for a provider's model list
    const toggleExpandProvider = (providerId: string) => {
      setExpandedProviders(prev => {
        const newSet = new Set(prev);
        if (newSet.has(providerId)) {
          newSet.delete(providerId);
        } else {
          newSet.add(providerId);
        }
        return newSet;
      });
    };

    // Handle sorting
    const handleSort = (field: 'name' | 'status') => {
      if (sortField === field) {
        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    };

    // Get sort icon for column headers
    const getSortIcon = (field: 'name' | 'status') => {
      if (sortField !== field) {
        return <ArrowUpDown className='w-4 h-4' />;
      }
      return sortDirection === 'asc' ? (
        <ArrowUp className='w-4 h-4' />
      ) : (
        <ArrowDown className='w-4 h-4' />
      );
    };

    // Handle toggling provider status (enable/disable)
    const handleToggleProviderStatus = async (provider: RemoteProvider) => {
      try {
        if (!provider || !provider.id) {
          console.error('❌ Invalid provider or missing ID', provider);
          toast({
            title: t('settings.providersRemote.statusToggleError'),
            description: t('settings.providersRemote.invalidProvider'),
            variant: 'destructive',
          });
          return;
        }

        // Check if API key is set when enabling a provider
        if (
          provider.status === ProviderStatus.DISABLED &&
          (!provider.apiKey || provider.apiKey.trim() === '')
        ) {
          console.warn(
            '⚠️ Attempting to enable provider without API key:',
            provider.name
          );
          toast({
            title: t('settings.providersRemote.apiKeyRequired'),
            description: t('settings.providersRemote.apiKeyRequiredDescription'),
            variant: 'destructive',
          });
          // Continue with the toggle anyway, but warn the user
        }

        // Get the new status (opposite of current)
        const newStatus =
          provider.status === ProviderStatus.ACTIVE
            ? ProviderStatus.DISABLED
            : ProviderStatus.ACTIVE;
        // Update the provider directly with the new status
        await updateProvider(provider.id, { status: newStatus });


        // Force a complete refresh of providers to ensure backend data is updated
        // Clear any potential caches and force a fresh fetch


        // Add a small delay to ensure backend has processed the update
        await new Promise(resolve => setTimeout(resolve, 200));

        // Force refresh providers data
        await fetchProviders();


        // Trigger ChatModelSelector refresh

        uiState.requestChatModelSelectorRefresh();

        // Show success toast with correct status message
        const statusText =
          newStatus === ProviderStatus.ACTIVE
            ? t('settings.providersRemote.statusActive')
            : t('settings.providersRemote.statusDisabled');


        toast({
          title: t('settings.providersRemote.statusToggleSuccess'),
          description: t('settings.providersRemote.statusToggleDescription', {
            name: provider.name,
            status: statusText,
          }),
          variant: 'default',
        });
      } catch (error) {
        console.error('❌ Failed to toggle provider status:', error);
        toast({
          title: t('settings.providersRemote.statusToggleError'),
          description: t('settings.providersRemote.statusToggleErrorDescription'),
          variant: 'destructive',
        });
      }
    };

    // Handle deleting a provider
    const handleDeleteProvider = async (provider: RemoteProvider) => {
      try {
        if (!provider || !provider.id) return;

        // Use the deleteProvider function from the hook which handles local state updates
        // This updates both local state and global cache immediately
        await deleteProvider(provider.id);

        // Trigger ChatModelSelector refresh after provider deletion
        uiState.requestChatModelSelectorRefresh();

        toast({
          title: t('settings.providersRemote.deleteProvider.success'),
          description: t(
            'settings.providersRemote.deleteProvider.successDescription',
            { name: provider.name }
          ),
          variant: 'default',
        });
      } catch (error) {
        console.error('Failed to delete provider:', error);
        toast({
          title: t('settings.providersRemote.deleteProvider.error'),
          description: t(
            'settings.providersRemote.deleteProvider.errorDescription'
          ),
          variant: 'destructive',
        });
      }
    };

    // Export providers configuration to JSON
    const handleExportConfiguration = async () => {
      try {
        const result = await exportProviderConfigurations();
        if (result.success) {
          const successTitle = t('settings.providersRemote.exportSuccess');
          const successDescription = t(
            'settings.providersRemote.exportSuccessDescription',
            { count: remoteProviders.length }
          );

          toast({
            title: String(successTitle),
            description: String(successDescription),
            variant: 'default',
          });
        }
      } catch (error: unknown) {
        console.error('Error exporting configuration:', error);
        const errorTitle = t('settings.providersRemote.exportError');
        const axiosErr = error as { response?: { data?: { detail?: string } }; message?: string };
        const errorDescription =
          axiosErr.response?.data?.detail ||
          axiosErr.message ||
          t('settings.providersRemote.exportErrorDescription');

        toast({
          title: String(errorTitle),
          description: String(errorDescription),
          variant: 'destructive',
        });
      }
    };

    // Import providers configuration from JSON
    const handleImportConfiguration = () => {
      fileInputRef.current?.click();
    };

    const handleFileSelect = async (
      event: React.ChangeEvent<HTMLInputElement>
    ) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        setIsRefreshing(true);
        const result = await importProviderConfigurations(file);

        // Invalidate all caches to ensure fresh data is loaded
        invalidateModelsCache();
        invalidateProvidersCache();

        // Refresh providers list with force refresh to bypass cache
        await hookFetchProviders(true);
        // Also call the prop function to update parent state
        await fetchProviders();

        // Force immediate table refresh by clearing expanded providers state
        setExpandedProviders(new Set());

        // Force ChatModelSelector to refresh immediately
        uiState.requestChatModelSelectorRefresh();

        // Show results based on backend response
        if (result.success_count > 0) {
          toast({
            title: t('settings.providersRemote.importSuccess'),
            description: t('settings.providersRemote.importSuccessDescription', {
              success: result.success_count,
              total: result.total_processed,
            }),
            variant: 'default',
          });

          // Reload providers screen after successful import with cache invalidation
          setTimeout(async () => {
            // Invalidate caches again to be sure
            invalidateModelsCache();
            invalidateProvidersCache();
            await hookFetchProviders(true);
            await fetchProviders();

            // Reset UI state to ensure clean table display
            setExpandedProviders(new Set());
            setSortField(null);
            setSortDirection('asc');

            // Force ChatModelSelector to refresh with new providers
            uiState.requestChatModelSelectorRefresh();
          }, 1000);
        }

        if (result.error_count > 0) {
          toast({
            title: t('settings.providersRemote.importPartialError'),
            description: t(
              'settings.providersRemote.importPartialErrorDescription',
              {
                errors: result.error_count,
                details:
                  result.errors?.slice(0, 3).join(', ') || 'See logs for details',
              }
            ),
            variant: 'destructive',
          });
        }
      } catch (error: unknown) {
        console.error('Error importing configuration:', error);
        const axiosErr = error as { response?: { data?: { detail?: string } }; message?: string };
        toast({
          title: t('settings.providersRemote.importError'),
          description:
            axiosErr.response?.data?.detail ||
            axiosErr.message ||
            t('settings.providersRemote.importErrorDescription'),
          variant: 'destructive',
        });
      } finally {
        // Reset file input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        setIsRefreshing(false);
      }
    };

    // Pull the system provider out of the table list — it's rendered
    // as a pinned card above the table. Local providers stay handled
    // in their own tab.
    const systemProvider = useMemo(() => {
      if (!Array.isArray(providers)) return null;
      return (
        providers.find(p => (p.provider_type || '').toLowerCase() === 'system') ||
        null
      );
    }, [providers]);

    // Filter out local providers AND the system provider (the latter
    // surfaces above the table)
    const remoteProviders = useMemo(() => {
      if (!Array.isArray(providers)) {
        return [];
      }

      // Filter out local providers but keep both active and inactive remote providers
      let filtered = providers.filter(provider => {
        return (
          !isLocalProvider(provider.provider_type) &&
          (provider.provider_type || '').toLowerCase() !== 'system'
        );
      });

      // Apply sorting if a sort field is selected
      if (sortField) {
        filtered = [...filtered].sort((a, b) => {
          let aValue, bValue;

          if (sortField === 'name') {
            aValue = a.name?.toLowerCase() || '';
            bValue = b.name?.toLowerCase() || '';
          } else if (sortField === 'status') {
            // Convert status to sortable values (active first, then disabled)
            aValue = a.status === ProviderStatus.ACTIVE ? 0 : 1;
            bValue = b.status === ProviderStatus.ACTIVE ? 0 : 1;
          }

          if (sortDirection === 'asc') {
            return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
          } else {
            return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
          }
        });
      }

      return filtered;
    }, [providers, sortField, sortDirection]);

    // Count of filtered local providers
    const localProvidersCount = useMemo(() => {
      return providers.filter(provider => isLocalProvider(provider.provider_type))
        .length;
    }, [providers]);

    return (
      <div className='h-full flex flex-col overflow-hidden'>
        {/* Unified Responsive Header */}
        <div className='sticky top-0 pt-0 pb-4 lg:pb-6 z-20 flex-shrink-0' style={{ position: 'sticky' }}>
          <div
            className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10'
            style={{ maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%)' }}
          />

          {/* Desktop Layout */}
          <div className='hidden lg:flex justify-between items-center'>
            <div>
              <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1'>
                {t('settings.providersRemote.title')}
              </h2>
              <p className='text-sm text-zinc-500 dark:text-zinc-400'>
                Manage remote AI model providers and their configurations
              </p>
            </div>
            <div className='flex items-center gap-3'>
              <Button
                data-testid="settings-provider-add-button"
                onClick={handleAddProvider}
                className='bg-primary hover:bg-primary/90 text-primary-foreground font-semibold'
                size='default'
              >
                <Plus className='h-4 w-4 mr-2' />
                {t('settings.providersRemote.addProviderDesktop')}
              </Button>
            </div>
          </div>

          {/* Mobile Layout */}
          <div className='lg:hidden'>
            <div className='flex items-center justify-between gap-3 mb-2'>
              <h2 className='text-xl font-bold text-zinc-900 dark:text-white'>
                {t('settings.providersRemote.title')}
              </h2>
              <Button
                onClick={handleAddProvider}
                className='bg-primary hover:bg-primary/90 text-primary-foreground flex-shrink-0'
                size='sm'
              >
                <Plus className='h-3 w-3 mr-1' />
                {t('general.add')}
              </Button>
            </div>
            <p className='text-xs text-zinc-500 dark:text-zinc-400'>
              Manage AI model providers
            </p>
          </div>
        </div>
        <div className='flex-1 overflow-hidden flex flex-col'>
          <div className='flex-shrink-0 space-y-6'>
            {/* Info message about filtered local providers — admin only,
                non-admins don't manage local providers */}
            {isAdmin && localProvidersCount > 0 && (
              <div className='bg-blue-50 dark:bg-blue-900/20 p-4 border border-blue-200 dark:border-blue-800 flex items-start space-x-3'>
                <BrainCircuit className='h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0' />
                <div>
                  <p className='text-sm text-blue-800 dark:text-blue-300'>
                    {t('settings.providersRemote.localProvidersFiltered', {
                      count: localProvidersCount,
                    })}
                  </p>
                </div>
              </div>
            )}

            {/* Pinned system provider — "Scrapalot AI". Rendered above
                the table and read-only for non-admins. Admins keep the
                same dropdown actions (edit / toggle / delete) as any
                other row, so behavior is identical from their POV. */}
            {systemProvider && (
              <div
                data-testid={`settings-system-provider-${systemProvider.name?.toLowerCase().replace(/\s+/g, '-')}`}
                className='border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-black px-4 py-3'
              >
                <div className='flex items-start gap-3'>
                  <div className='w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center overflow-hidden flex-shrink-0'>
                    <img
                      src={getIconForProvider(systemProvider.provider_type)}
                      alt={t('settings.providersRemote.providerIconAlt')}
                      className='w-6 h-6 object-contain'
                    />
                  </div>
                  <div className='flex-1 min-w-0'>
                    <div className='flex items-center gap-2 flex-wrap'>
                      <p className='font-medium text-zinc-800 dark:text-white'>
                        {systemProvider.name}
                      </p>
                      <span
                        className='inline-flex items-center px-1.5 py-0.25 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300'
                        title={t(
                          'settings.providersRemote.systemProviderHint',
                          'Built-in provider managed by the Scrapalot team'
                        )}
                      >
                        {t('settings.providersRemote.systemProviderBadge', 'System')}
                      </span>
                      {systemProvider.validation_status === 'valid' &&
                        systemProvider.has_api_key && (
                          <span className='inline-flex items-center px-1.5 py-0.25 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'>
                            {t('settings.providersRemote.validToken')}
                          </span>
                        )}
                      {systemProvider.validation_status === 'invalid' && (
                        <span className='inline-flex items-center px-1.5 py-0.25 rounded-full text-xs font-medium bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'>
                          {t('settings.providersRemote.invalidToken')}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          systemProvider.status === ProviderStatus.ACTIVE
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-400'
                            : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-400'
                        }`}
                      >
                        {systemProvider.status === ProviderStatus.ACTIVE
                          ? t('settings.providersRemote.statusActive')
                          : t('settings.providersRemote.statusDisabled')}
                      </span>
                    </div>
                    {/* API base and model count are confidential — only
                        admins see backend endpoint and configured model
                        count for the Scrapalot system provider. Regular
                        users only see the name + "System" badge above. */}
                    {isAdmin && (
                      <div className='space-y-0.5 mt-1'>
                        {systemProvider.api_base && (
                          <p className='text-xs text-zinc-500 dark:text-zinc-400 truncate'>
                            <span className='font-medium'>API Base:</span>{' '}
                            {systemProvider.api_base}
                          </p>
                        )}
                        <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                          {systemProvider.models?.length || 0}{' '}
                          {t('settings.providersRemote.tableHeaderModels').toLowerCase()}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className='flex-shrink-0 flex items-center'>
                    {isAdmin ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-8 w-8 p-0 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                          >
                            <MoreVertical className='h-4 w-4' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end' className='z-[1100]'>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleEditProvider(systemProvider);
                            }}
                            className='cursor-pointer flex items-center gap-2'
                            data-testid={`provider-edit-${systemProvider.provider_type}`}
                          >
                            <Pencil className='h-4 w-4' />
                            {t('settings.providersRemote.dropdownMenu.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void handleToggleProviderStatus(systemProvider);
                            }}
                            className='cursor-pointer flex items-center gap-2'
                          >
                            <Power className='h-4 w-4' />
                            {systemProvider.status === ProviderStatus.ACTIVE
                              ? t('settings.providersRemote.dropdownMenu.disable')
                              : t('settings.providersRemote.dropdownMenu.enable')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void handleDeleteProvider(systemProvider);
                            }}
                            className='cursor-pointer flex items-center gap-2 text-red-600 dark:text-red-400'
                            data-testid={`provider-delete-${systemProvider.provider_type}`}
                          >
                            <Trash2 className='h-4 w-4' />
                            {t('settings.providersRemote.dropdownMenu.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span
                        className='inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400'
                        title={t(
                          'settings.providersRemote.systemProviderLockedHint',
                          'Only an administrator can edit this provider'
                        )}
                      >
                        <Lock className='h-3.5 w-3.5' />
                        {t('settings.providersRemote.systemProviderLocked', 'Managed by admin')}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Providers Table - Now in flex-1 container */}
          {loading || isRefreshing ? (
            <div className='flex-1 flex items-center justify-center mt-6'>
              <div className='flex flex-col items-center gap-4'>
                <Loader2 className='h-8 w-8 animate-spin text-zinc-400 dark:text-zinc-600' />
                <p className='text-zinc-600 dark:text-zinc-400'>
                  {t('settings.providersRemote.loading')}
                </p>
              </div>
            </div>
          ) : remoteProviders.length > 0 ? (
            <div className='flex-1 flex flex-col min-h-0 mt-6'>
              <div data-testid="settings-providers-list" className='border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-black overflow-hidden flex flex-col flex-1 max-h-[60vh] md:max-h-[900px]'>
                <div className='bg-zinc-100 dark:bg-zinc-900 px-4 py-2 flex-shrink-0 hidden md:block'>
                  <div className='grid grid-cols-12 gap-4 text-sm font-medium text-zinc-600 dark:text-zinc-300'>
                    <div className='col-span-4'>
                      <button
                        onClick={() => handleSort('name')}
                        className='flex items-center gap-2 hover:text-zinc-800 dark:hover:text-zinc-100 transition-colors'
                      >
                        {t('settings.providersRemote.tableHeaderProvider')}
                        {getSortIcon('name')}
                      </button>
                    </div>
                    <div className='col-span-6'>
                      {t('settings.providersRemote.tableHeaderModels')}
                    </div>
                    <div className='col-span-1'>
                      <button
                        onClick={() => handleSort('status')}
                        className='flex items-center gap-2 hover:text-zinc-800 dark:hover:text-zinc-100 transition-colors'
                      >
                        {t('settings.providersRemote.tableHeaderStatus')}
                        {getSortIcon('status')}
                      </button>
                    </div>
                    <div className='col-span-1 text-right'>
                      {t('settings.providersRemote.tableHeaderAction')}
                    </div>
                  </div>
                </div>
                <div className='divide-y divide-zinc-300 dark:divide-zinc-700 flex-1 overflow-y-auto'>
                  {remoteProviders.map(provider => (
                    <div key={provider.id} data-testid={`settings-provider-item-${provider.name?.toLowerCase().replace(/\s+/g, '-')}`} className='px-4 py-1'>
                      {/* Desktop Layout */}
                      <div className='hidden md:grid grid-cols-12 gap-4 items-center'>
                        <div className='col-span-4'>
                          <div className='flex items-center gap-3'>
                            <div className='w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-100 flex items-center justify-center overflow-hidden'>
                              <img
                                src={getIconForProvider(provider.provider_type)}
                                alt={t(
                                  'settings.providersRemote.providerIconAlt'
                                )}
                                className='w-6 h-6 object-contain'
                                onError={() =>
                                  console.log(
                                    `Failed to load icon for ${provider.name}`
                                  )
                                }
                              />
                            </div>
                            <div className='flex-1 min-w-0'>
                              <ProviderStatusBadges provider={provider} t={t} />
                              <div className='space-y-1'>
                                {provider.api_base && (
                                  <p className='text-xs text-zinc-500 dark:text-zinc-400 truncate'>
                                    <span className='font-medium'>API Base:</span>{' '}
                                    {provider.api_base}
                                  </p>
                                )}
                                {provider.description && (
                                  <p className='text-xs text-zinc-500 dark:text-zinc-400 truncate'>
                                    {provider.description}
                                  </p>
                                )}
                                {provider.created_at && (
                                  <p className='text-xs text-zinc-400 dark:text-zinc-500'>
                                    Created:{' '}
                                    {new Date(
                                      provider.created_at
                                    ).toLocaleDateString()}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                        <div className='col-span-6'>
                          <div className='space-y-2'>
                            {provider.models && provider.models.length > 0 ? (
                              <>
                                <div className='flex flex-wrap gap-1 mb-2'>
                                  {(expandedProviders.has(provider.id)
                                    ? provider.models
                                    : provider.models.slice(0, 3)
                                  ).map((model, modelIndex) => {
                                    // Now models is always ProviderModel[], so we can access properties directly
                                    const modelName =
                              model.display_name ||
                              model.model_name ||
                              'Unknown model';
                              const modelType = model.model_type;
                              const contextWindow = model.context_window;
                              const dimensions = model.dimensions;

                              return (
                              <div
                                key={modelIndex}
                                className='group relative'
                              >
                                <div className='flex items-center gap-1 text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors'>
                                  <span className='font-medium'>
                                    {modelName}
                                  </span>
                                  {modelType &&
                                    modelType !== 'NORMAL' && (
                                      <>
                                        <span
                                          className={`px-1 py-0.5 rounded text-xs font-medium ${modelType === 'EMBEDDING'
                                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                                            : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300'
                                            }`}
                                        >
                                          {modelType}
                                        </span>
                                      </>
                                    )}
                                </div>
                                {/* Tooltip with additional model info */}
                                {(typeof contextWindow === 'number' && contextWindow > 0 || typeof dimensions === 'number' && dimensions > 0) && (
                                  <div className='absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-black text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-5'>
                                    {typeof contextWindow === 'number' && contextWindow > 0 && (
                                      <div>
                                        Context:{' '}
                                        {contextWindow.toLocaleString()}
                                      </div>
                                    )}
                                    {typeof dimensions === 'number' && dimensions > 0 && (
                                      <div>Dimensions: {dimensions}</div>
                                    )}
                                  </div>
                                )}
                              </div>
                              );
                                  })}
                              {provider.models.length > 3 && (
                                <button
                                  onClick={() =>
                                    toggleExpandProvider(provider.id)
                                  }
                                  className='flex items-center gap-1 text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors cursor-pointer'
                                >
                                  {expandedProviders.has(provider.id) ? (
                                    <>
                                      <ChevronUp className='w-3 h-3' />
                                      Show less
                                    </>
                                  ) : (
                                    <>
                                      <ChevronDown className='w-3 h-3' />+
                                      {provider.models.length - 3} more
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                            <div className='text-xs text-zinc-500 dark:text-zinc-400'>
                              {provider.pagination?.total_models ? (
                                <>
                                  {provider.pagination.total_models} model
                                  {provider.pagination.total_models !== 1 ? 's' : ''} available
                                  {provider.models.length < provider.pagination.total_models && (
                                    <span className='ml-1 text-zinc-400'>
                                      ({provider.models.length} loaded)
                                    </span>
                                  )}
                                </>
                              ) : (
                                <>
                                  {provider.models.length} model
                                  {provider.models.length !== 1 ? 's' : ''} available
                                </>
                              )}
                              {provider.models.some(
                                m => m.model_type === 'EMBEDDING'
                              ) && (
                                  <span className={`ml-2 ${accentColor === 'gray'
                                    ? 'text-zinc-600 dark:text-zinc-400'
                                    : accentColor === 'blue'
                                      ? 'text-blue-600 dark:text-blue-400'
                                      : accentColor === 'green'
                                        ? 'text-green-600 dark:text-green-400'
                                        : accentColor === 'red'
                                          ? 'text-red-600 dark:text-red-400'
                                          : accentColor === 'violet'
                                            ? 'text-purple-600 dark:text-purple-400'
                                            : 'text-purple-600 dark:text-purple-400'
                                    }`}
                                  >
                                    • Embeddings
                                  </span>
                                )}
                            </div>
                          </>
                          ) : (
                          <div className='text-xs text-zinc-500 dark:text-zinc-400'>
                            {t('settings.providersRemote.noModels')}
                          </div>
                            )}
                        </div>
                      </div>
                      <div className='col-span-1'>
                        <div className='flex items-center justify-center'>
                          <span
                            className={`px-2 py-1 rounded-full text-xs ${provider.status === 'active' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-400' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-400'}`}
                          >
                            {provider.status === 'active'
                              ? t('settings.providersRemote.statusActive')
                              : t('settings.providersRemote.statusDisabled')}
                          </span>
                        </div>
                      </div>
                      <div className='col-span-1 flex justify-end items-center'>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-8 w-8 p-0 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                            >
                              <MoreVertical className='h-4 w-4' />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='end' className='z-[1100]'>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleEditProvider(provider);
                              }}
                              className='cursor-pointer flex items-center gap-2'
                              data-testid={`provider-edit-${provider.provider_type}`}
                            >
                              <Pencil className='h-4 w-4' />
                              {t('settings.providersRemote.dropdownMenu.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                void handleToggleProviderStatus(provider);
                              }}
                              className='cursor-pointer flex items-center gap-2'
                            >
                              <Power className='h-4 w-4' />
                              {provider.status === ProviderStatus.ACTIVE
                                ? t(
                                  'settings.providersRemote.dropdownMenu.disable'
                                )
                                : t(
                                  'settings.providersRemote.dropdownMenu.enable'
                                )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void handleDeleteProvider(provider);
                              }}
                              className='cursor-pointer flex items-center gap-2 text-red-600 dark:text-red-400'
                              data-testid={`provider-delete-${provider.provider_type}`}
                            >
                              <Trash2 className='h-4 w-4' />
                              {t(
                                'settings.providersRemote.dropdownMenu.delete'
                              )}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                      {/* Mobile Layout */}
                      <div className='md:hidden space-y-3'>
                        <div className='flex items-center justify-between'>
                          <div className='flex items-center gap-3'>
                            <div className='w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-100 flex items-center justify-center overflow-hidden'>
                              <img
                                src={getIconForProvider(provider.provider_type)}
                                alt={t(
                                  'settings.providersRemote.providerIconAlt'
                                )}
                                className='w-6 h-6 object-contain'
                                onError={() =>
                                  console.log(
                                    `Failed to load icon for ${provider.name}`
                                  )
                                }
                              />
                            </div>
                            <div className='flex-1 min-w-0'>
                              <ProviderStatusBadges provider={provider} t={t} />
                            </div>
                          </div>
                          <div className='flex items-center gap-2'>
                            <span
                              className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${provider.status === ProviderStatus.ACTIVE
                                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                                : provider.status === ProviderStatus.DISABLED
                                  ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'
                                  : 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300'
                                }`}
                            >
                              {provider.status === ProviderStatus.ACTIVE
                                ? t('settings.providersRemote.statusActive')
                                : provider.status === ProviderStatus.DISABLED
                                  ? t('settings.providersRemote.statusDisabled')
                                  : t('settings.providersRemote.statusUnknown')}
                            </span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant='ghost' className='h-8 w-8 p-0'>
                                  <span className='sr-only'>Open menu</span>
                                  <MoreHorizontal className='h-4 w-4' />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align='end' className='z-[1100]'>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleEditProvider(provider);
                                  }}
                                >
                                  <Edit className='mr-2 h-4 w-4' />
                                  {t(
                                    'settings.providersRemote.dropdownMenu.edit'
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void handleDeleteProvider(provider);
                                  }}
                                  className='cursor-pointer flex items-center gap-2 text-red-600 dark:text-red-400'
                                >
                                  <Trash2 className='mr-2 h-4 w-4' />
                                  {t(
                                    'settings.providersRemote.dropdownMenu.delete'
                                  )}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
              </div>

                        {/* Mobile Details */}
                        <div className='space-y-1'>
                          {provider.api_base && (
                            <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                              <span className='font-medium'>API Base:</span>{' '}
                              {provider.api_base}
                            </p>
                          )}
                          {provider.description && (
                            <p className='text-xs text-zinc-500 dark:text-zinc-400'>
                              {provider.description}
                            </p>
                          )}
                          {provider.created_at && (
                            <p className='text-xs text-zinc-400 dark:text-zinc-500'>
                              Created:{' '}
                              {new Date(provider.created_at).toLocaleDateString()}
                            </p>
                          )}
                        </div>

              {/* Mobile Models */}
              <div className=''>
                <div className='text-xs text-zinc-500 dark:text-zinc-400 mb-1 font-medium'>
                  {t('settings.providersRemote.tableHeaderModels')}
                </div>
                <div className='flex flex-wrap gap-1'>
                  {provider.models && provider.models.length > 0 ? (
                    (expandedProviders.has(provider.id)
                      ? provider.models
                      : provider.models.slice(0, 3)
                    ).map((model, index) => (
                      <span
                        key={index}
                        className='inline-flex items-center px-2 py-1 text-xs font-medium bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300'
                      >
                        {typeof model === 'string'
                          ? model
                          : model.display_name ||
                          model.model_name ||
                          'Unknown'}
                      </span>
                    ))
                  ) : (
                    <span className='text-xs text-zinc-400 dark:text-zinc-500 italic'>
                      {t('settings.providersRemote.noModels')}
                    </span>
                  )}
                  {provider.models && provider.models.length > 3 && (
                    <button
                      onClick={() => toggleExpandProvider(provider.id)}
                      className='text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer'
                    >
                      {expandedProviders.has(provider.id)
                        ? 'Show less'
                        : `+${provider.models.length - 3} more`}
                    </button>
                  )}
                </div>
              </div>
            </div>
                    </div>
                  ))}
      </div>
              </div >
            </div >
          ) : (
            <div className='flex-1 flex items-center justify-center mt-6'>
              <div className='border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-8 flex flex-col items-center justify-center'>
                <Server className='h-10 w-10 text-zinc-400 dark:text-zinc-600 mb-4' />
                <p className='text-zinc-600 dark:text-zinc-400 mb-2'>
                  {t('settings.providersRemote.noProviders')}
                </p>
                <p className='text-sm text-zinc-500 dark:text-zinc-500 text-center mb-4'>
                  {t('settings.providersRemote.noProvidersDescription')}
                </p>
              </div>
            </div>
          )}

{/* Show message if all providers are filtered out but there are local providers — admin only */ }
{
  isAdmin && remoteProviders.length === 0 && providers.length > 0 && (
    <div className='flex-shrink-0 mt-4 p-4 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800'>
      <p className='text-sm text-zinc-600 dark:text-zinc-400'>
        {t(
          'settings.providersRemote.localProvidersFiltered',
          'Local AI providers are managed in the Local AI tab.'
        )}
      </p>
    </div>
  )
}

{/* Provider API Keys section */ }
<div className='flex-shrink-0 lg:mt-8'>
  <h3 className='text-lg font-semibold text-zinc-800 dark:text-white pt-3 mb-2 hidden md:block'>
    {t('settings.providersRemote.apiKeysTitle')}
  </h3>
  <p className='text-sm text-zinc-600 dark:text-zinc-400 mb-4 hidden md:block'>
    {t('settings.providersRemote.apiKeysDescription')}
  </p>

  <div className='flex flex-row gap-2 mt-4'>
    <Button
      onClick={handleImportConfiguration}
      variant='outline'
      className='flex-1 flex items-center justify-center gap-2 border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
      disabled={isRefreshing}
    >
      {isRefreshing ? (
        <Loader2 className='h-4 w-4 animate-spin' />
      ) : (
        <Upload className='h-4 w-4' />
      )}
      <span className='hidden sm:inline'>
        {isRefreshing
          ? t('settings.providersRemote.importingConfig', 'Importing...')
          : t('settings.providersRemote.importConfigButton')
        }
      </span>
      <span className='sm:hidden'>
        {isRefreshing ? t('general.importing', 'Importing...') : t('general.import', 'Import')}
      </span>
    </Button>
    <Button
      onClick={handleExportConfiguration}
      variant='outline'
      className='flex-1 flex items-center justify-center gap-2 border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
    >
      <Download className='h-4 w-4' />
      <span className='hidden sm:inline'>{t('settings.providersRemote.exportConfigButton', 'Export Configuration')}</span>
      <span className='sm:hidden'>{t('general.export', 'Export')}</span>
    </Button>
  </div>
</div>
        </div >

  {/* Hidden file input for importing configuration */ }
  < input
ref = { fileInputRef }
type = "file"
accept = ".json"
style = {{ display: 'none' }}
onChange = { handleFileSelect }
  />
      </div >
    );
};
