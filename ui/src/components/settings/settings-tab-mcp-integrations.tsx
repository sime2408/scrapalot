import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle2,
  Edit2,
  Loader2,
  Lock,
  Plug,
  Plus,
  Power,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/lib/toast-compat';
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  testMcpConnection,
  updateMcpServer,
  type McpServer,
  type McpTestResult,
  type McpTransport,
} from '@/lib/api-mcp';

const EMPTY_FORM = {
  name: '',
  transport: 'http' as McpTransport,
  url: '',
  authToken: '',
  description: '',
  enabled: true,
};

export const SettingsMcpIntegrationsTab: React.FC = () => {
  const { t } = useTranslation();

  const [servers, setServers] = useState<McpServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  const [deleteTarget, setDeleteTarget] = useState<McpServer | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const load = async () => {
    setIsLoading(true);
    try {
      setServers(await listMcpServers());
    } catch (err) {
      console.error('Failed to load MCP integrations:', err);
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.loadFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAdd = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setTestResult(null);
    setDialogOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditing(server);
    setForm({
      name: server.name,
      transport: server.transport,
      url: server.url,
      authToken: '',
      description: server.description ?? '',
      enabled: server.enabled,
    });
    setTestResult(null);
    setDialogOpen(true);
  };

  const handleTest = async () => {
    const url = form.url.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.invalidUrl'),
        variant: 'destructive',
      });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await testMcpConnection({
          transport: form.transport,
          url,
          auth_token: form.authToken.trim() || null,
          // When editing without a new token, test with the saved (stored) token.
          server_id: editing?.id ?? null,
        })
      );
    } catch (err) {
      console.error('MCP test connection failed:', err);
      setTestResult({ ok: false, error: t('settings.mcp.errors.testFailed'), tools: [] });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const name = form.name.trim();
    const url = form.url.trim();
    if (!name || !url) {
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.nameUrlRequired'),
        variant: 'destructive',
      });
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.invalidUrl'),
        variant: 'destructive',
      });
      return;
    }

    setIsSaving(true);
    try {
      const token = form.authToken.trim();
      if (editing) {
        await updateMcpServer(editing.id, {
          name,
          transport: form.transport,
          url,
          description: form.description.trim() || null,
          enabled: form.enabled,
          // Omit auth_token when left blank → keep the existing one.
          ...(token ? { auth_token: token } : {}),
        });
        toast({ title: t('settings.mcp.updated') });
      } else {
        await createMcpServer({
          name,
          transport: form.transport,
          url,
          description: form.description.trim() || null,
          enabled: form.enabled,
          ...(token ? { auth_token: token } : {}),
        });
        toast({ title: t('settings.mcp.created') });
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      console.error('Failed to save MCP integration:', err);
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.saveFailed'),
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggle = async (server: McpServer, enabled: boolean) => {
    // Optimistic update, revert on failure.
    setServers(prev => prev.map(s => (s.id === server.id ? { ...s, enabled } : s)));
    try {
      await updateMcpServer(server.id, { enabled });
    } catch (err) {
      console.error('Failed to toggle MCP integration:', err);
      setServers(prev => prev.map(s => (s.id === server.id ? { ...s, enabled: !enabled } : s)));
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.toggleFailed'),
        variant: 'destructive',
      });
    }
  };

  // Header status toggle (edit mode) — persists immediately, like the providers form.
  const handleStatusToggle = async () => {
    if (!editing) return;
    const next = !form.enabled;
    setForm(f => ({ ...f, enabled: next }));
    setServers(prev => prev.map(s => (s.id === editing.id ? { ...s, enabled: next } : s)));
    setEditing(prev => (prev ? { ...prev, enabled: next } : prev));
    try {
      await updateMcpServer(editing.id, { enabled: next });
    } catch (err) {
      console.error('Failed to toggle MCP integration:', err);
      setForm(f => ({ ...f, enabled: !next }));
      setServers(prev => prev.map(s => (s.id === editing.id ? { ...s, enabled: !next } : s)));
      setEditing(prev => (prev ? { ...prev, enabled: !next } : prev));
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.toggleFailed'),
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMcpServer(deleteTarget.id);
      setServers(prev => prev.filter(s => s.id !== deleteTarget.id));
      toast({ title: t('settings.mcp.deleted') });
    } catch (err) {
      console.error('Failed to delete MCP integration:', err);
      toast({
        title: t('general.error'),
        description: t('settings.mcp.errors.deleteFailed'),
        variant: 'destructive',
      });
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <div className='sticky top-0 pt-0 pb-6 z-20'>
        <div className='absolute inset-0 bg-white/50 dark:bg-zinc-900/50 backdrop-blur-xl -z-10' />
        <div className='flex items-start justify-between gap-4'>
          <div>
            <h2 className='text-2xl font-bold text-zinc-900 dark:text-white mb-1 flex items-center gap-2'>
              <Plug className='w-5 h-5' />
              {t('settings.tabs.mcpIntegrations')}
            </h2>
            <p className='text-sm text-zinc-500 dark:text-zinc-400 max-w-xl'>
              {t('settings.mcp.description')}
            </p>
          </div>
          <Button
            onClick={openAdd}
            onMouseDown={e => e.preventDefault()}
            className='gap-2 shrink-0'
            data-testid='settings-mcp-add-button'
          >
            <Plus className='w-4 h-4' />
            {t('settings.mcp.add')}
          </Button>
        </div>
      </div>

      <div className='space-y-3'>
        {isLoading ? (
          <div className='text-center py-12 text-sm text-zinc-500 dark:text-zinc-400'>
            {t('general.loading')}
          </div>
        ) : servers.length === 0 ? (
          <div
            className='border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center'
            data-testid='settings-mcp-empty'
          >
            <Plug className='w-8 h-8 mx-auto mb-3 text-zinc-400 dark:text-zinc-600' />
            <p className='text-sm font-medium text-zinc-700 dark:text-zinc-300'>
              {t('settings.mcp.emptyTitle')}
            </p>
            <p className='text-sm text-zinc-500 dark:text-zinc-400 mt-1'>
              {t('settings.mcp.emptyHint')}
            </p>
          </div>
        ) : (
          servers.map(server => (
            <div
              key={server.id}
              className='flex items-center gap-4 bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-4'
              data-testid={`settings-mcp-item-${server.id}`}
            >
              <div className='min-w-0 flex-1'>
                <div className='flex items-center gap-2'>
                  <span
                    className='font-semibold text-zinc-900 dark:text-white truncate'
                    data-testid='settings-mcp-item-name'
                  >
                    {server.name}
                  </span>
                  <span className='text-[10px] uppercase tracking-wide px-1.5 py-0.5 border border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'>
                    {server.transport}
                  </span>
                  {server.has_auth_token && (
                    <Lock className='w-3 h-3 text-zinc-400 dark:text-zinc-500' aria-label={t('settings.mcp.tokenStored')} />
                  )}
                </div>
                <p className='text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5'>
                  {server.url}
                </p>
                {server.last_error && (
                  <p className='text-xs text-red-600 dark:text-red-400 truncate mt-0.5 flex items-center gap-1'>
                    <AlertCircle className='w-3 h-3 shrink-0' />
                    {server.last_error}
                  </p>
                )}
              </div>
              <Switch
                checked={server.enabled}
                onCheckedChange={v => handleToggle(server, v)}
                aria-label={t('settings.mcp.enabledLabel')}
                data-testid={`settings-mcp-toggle-${server.id}`}
              />
              <Button
                variant='ghost'
                size='icon'
                onClick={() => openEdit(server)}
                onMouseDown={e => e.preventDefault()}
                aria-label={t('general.edit')}
                data-testid={`settings-mcp-edit-${server.id}`}
              >
                <Edit2 className='w-4 h-4' />
              </Button>
              <Button
                variant='ghost'
                size='icon'
                onClick={() => setDeleteTarget(server)}
                onMouseDown={e => e.preventDefault()}
                className='text-red-600 dark:text-red-400 hover:text-red-700'
                aria-label={t('general.delete')}
                data-testid={`settings-mcp-delete-${server.id}`}
              >
                <Trash2 className='w-4 h-4' />
              </Button>
            </div>
          ))
        )}
      </div>

      {/* Add / Edit form — right-side sheet, matching settings-tab-providers-form */}
      <Sheet open={dialogOpen} onOpenChange={setDialogOpen} modal={true}>
        <SheetContent
          side='right'
          className='bg-white/70 dark:bg-zinc-900/60 border-zinc-200/50 dark:border-zinc-700/50 p-0 w-[500px] max-w-full flex flex-col h-full overflow-hidden overflow-x-hidden z-[10000]'
          hideCloseButton={true}
          overlayClassName='bg-black/40 z-[9999]'
          style={{ pointerEvents: 'auto' }}
          onFocusOutside={e => e.preventDefault()}
        >
          <SheetHeader className='px-6 py-6 border-b border-border dark:border-zinc-800 flex-shrink-0'>
            <div className='flex items-center justify-between'>
              <div className='flex-1'>
                <SheetTitle className='text-xl font-semibold text-zinc-800 dark:text-white'>
                  {editing ? t('settings.mcp.editTitle') : t('settings.mcp.addTitle')}
                </SheetTitle>
                <SheetDescription className='text-sm text-zinc-600 dark:text-zinc-400 mt-1'>
                  {t('settings.mcp.formHint')}
                </SheetDescription>
              </div>
              {editing && (
                <div className='flex items-center space-x-3'>
                  <span
                    className={`text-sm font-medium ${
                      form.enabled
                        ? 'text-green-600 dark:text-green-500'
                        : 'text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    {form.enabled
                      ? t('settings.mcp.statusEnabled')
                      : t('settings.mcp.statusDisabled')}
                  </span>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={handleStatusToggle}
                    onMouseDown={e => e.preventDefault()}
                    className='h-8 w-8 p-0'
                    aria-label={t('settings.mcp.enabledLabel')}
                    data-testid='settings-mcp-status-toggle'
                  >
                    <Power
                      className={`h-4 w-4 ${form.enabled ? 'text-red-500' : 'text-green-500'}`}
                    />
                  </Button>
                </div>
              )}
            </div>
          </SheetHeader>

          <div className='h-full flex flex-col overflow-hidden'>
            <div
              className='flex-1 overflow-y-auto'
              style={{ pointerEvents: 'auto' }}
              onWheel={e => e.stopPropagation()}
            >
              <div className='p-6'>
                <form
                  id='mcp-form'
                  data-testid='settings-mcp-form'
                  onSubmit={e => {
                    e.preventDefault();
                    void handleSave();
                  }}
                >
                  <div className='space-y-6'>
                    <div className='space-y-2'>
                      <Label htmlFor='mcp-name' className='text-zinc-600 dark:text-white/70'>
                        {t('settings.mcp.fields.name')}
                      </Label>
                      <Input
                        id='mcp-name'
                        value={form.name}
                        onChange={e => setForm({ ...form, name: e.target.value })}
                        placeholder={t('settings.mcp.fields.namePlaceholder')}
                        className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                        data-testid='settings-mcp-name-input'
                      />
                    </div>

                    <div className='grid grid-cols-3 gap-3'>
                      <div className='space-y-2'>
                        <Label
                          htmlFor='mcp-transport'
                          className='text-zinc-600 dark:text-white/70'
                        >
                          {t('settings.mcp.fields.transport')}
                        </Label>
                        <Select
                          value={form.transport}
                          onValueChange={(v: McpTransport) => setForm({ ...form, transport: v })}
                        >
                          <SelectTrigger
                            id='mcp-transport'
                            className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className='z-[10001]'>
                            <SelectItem value='http'>HTTP</SelectItem>
                            <SelectItem value='sse'>SSE</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className='col-span-2 space-y-2'>
                        <Label htmlFor='mcp-url' className='text-zinc-600 dark:text-white/70'>
                          {t('settings.mcp.fields.url')}
                        </Label>
                        <Input
                          id='mcp-url'
                          value={form.url}
                          onChange={e => setForm({ ...form, url: e.target.value })}
                          placeholder='https://example.com/mcp'
                          className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                          data-testid='settings-mcp-url-input'
                        />
                      </div>
                    </div>

                    <div className='space-y-2'>
                      <Label htmlFor='mcp-token' className='text-zinc-600 dark:text-white/70'>
                        {t('settings.mcp.fields.authToken')}
                      </Label>
                      <Input
                        id='mcp-token'
                        type='password'
                        autoComplete='new-password'
                        value={form.authToken}
                        onChange={e => setForm({ ...form, authToken: e.target.value })}
                        placeholder={
                          editing && editing.has_auth_token
                            ? t('settings.mcp.fields.authTokenKeep')
                            : t('settings.mcp.fields.authTokenPlaceholder')
                        }
                        className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                      />
                    </div>

                    <div className='space-y-2'>
                      <Label htmlFor='mcp-desc' className='text-zinc-600 dark:text-white/70'>
                        {t('settings.mcp.fields.description')}
                      </Label>
                      <Textarea
                        id='mcp-desc'
                        rows={2}
                        value={form.description}
                        onChange={e => setForm({ ...form, description: e.target.value })}
                        placeholder={t('settings.mcp.fields.descriptionPlaceholder')}
                        className='bg-zinc-50 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700'
                      />
                    </div>

                    {!editing && (
                      <div className='flex items-center gap-2'>
                        <Switch
                          id='mcp-enabled'
                          checked={form.enabled}
                          onCheckedChange={v => setForm({ ...form, enabled: v })}
                        />
                        <Label htmlFor='mcp-enabled' className='text-zinc-600 dark:text-white/70'>
                          {t('settings.mcp.fields.enabled')}
                        </Label>
                      </div>
                    )}

                    {/* Test connection */}
                    <div className='border-t border-zinc-200 dark:border-zinc-800 pt-4 space-y-2'>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={handleTest}
                        disabled={testing}
                        onMouseDown={e => e.preventDefault()}
                        data-testid='settings-mcp-test-button'
                        className='gap-2'
                      >
                        {testing ? (
                          <Loader2 className='w-4 h-4 animate-spin' />
                        ) : (
                          <Plug className='w-4 h-4' />
                        )}
                        {t('settings.mcp.test')}
                      </Button>
                      {testResult && (
                        <div data-testid='settings-mcp-test-result' className='text-sm'>
                          {testResult.ok ? (
                            <div className='text-green-600 dark:text-green-400'>
                              <div className='flex items-center gap-1.5 font-medium'>
                                <CheckCircle2 className='w-4 h-4' />
                                {t('settings.mcp.testOk', { count: testResult.tools.length })}
                              </div>
                              {testResult.tools.length > 0 && (
                                <div className='mt-1.5 flex flex-wrap gap-1.5'>
                                  {testResult.tools.map(tool => (
                                    <span
                                      key={tool.name}
                                      title={tool.description}
                                      className='text-xs px-1.5 py-0.5 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300'
                                    >
                                      {tool.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className='flex items-start gap-1.5 text-red-600 dark:text-red-400'>
                              <AlertCircle className='w-4 h-4 mt-0.5 shrink-0' />
                              <span className='break-words'>
                                {testResult.error || t('settings.mcp.errors.testFailed')}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </form>
              </div>
            </div>

            {/* Footer - fixed */}
            <div className='border-t border-zinc-300 dark:border-zinc-800 py-4 px-6 flex justify-end gap-2 flex-shrink-0'>
              <Button
                type='button'
                variant='outline'
                onClick={() => setDialogOpen(false)}
                onMouseDown={e => e.preventDefault()}
                className='border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
              >
                {t('general.cancel')}
              </Button>
              <Button
                type='submit'
                form='mcp-form'
                disabled={isSaving}
                onMouseDown={e => e.preventDefault()}
                className='bg-primary text-primary-foreground px-8'
                data-testid='settings-mcp-save-button'
              >
                {isSaving
                  ? t('general.saving')
                  : editing
                    ? t('general.save')
                    : t('settings.mcp.add')}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='flex items-center gap-2'>
              <Trash2 className='w-5 h-5 text-red-600' />
              {t('settings.mcp.deleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.mcp.deleteConfirm', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('general.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className='bg-red-600 hover:bg-red-700'
              data-testid='settings-mcp-delete-confirm'
            >
              {t('general.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
