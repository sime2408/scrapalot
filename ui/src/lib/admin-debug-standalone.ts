/**
 * Standalone Admin Debug Button
 *
 * This creates a debug button completely OUTSIDE of React's control.
 * It uses vanilla JS and survives any React crash, error boundary, or black screen.
 *
 * The button is created at the DOM level before React even starts.
 */

import { consoleErrorCapture } from './console-error-capture';
import i18n from '@/i18n';
import hljs from 'highlight.js/lib/core';
import kotlin from 'highlight.js/lib/languages/kotlin';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import yaml from 'highlight.js/lib/languages/yaml';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import properties from 'highlight.js/lib/languages/properties';
import gradle from 'highlight.js/lib/languages/gradle';
import javascript from 'highlight.js/lib/languages/javascript';
import scss from 'highlight.js/lib/languages/scss';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('properties', properties);
hljs.registerLanguage('gradle', gradle);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('markdown', markdown);

// Mobile detection helper
const isMobile = (): boolean => window.innerWidth < 768;

// Docker container interfaces
interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: 'RUNNING' | 'STOPPED' | 'PAUSED' | 'RESTARTING' | 'DEAD';
  ports: Array<{ containerPort: number; hostPort: number; type: string }>;
  created: string;
  networks: string[];
}

interface CommitInfo {
  sha: string;
  message: string | null;
  author: string | null;
  date: string | null;
}

interface ContainerGitInfo {
  container_id: string;
  container_name: string;
  repo_name: string | null;
  deployed_commit: string | null;
  recent_commits: CommitInfo[];
  is_up_to_date: boolean;
  error: string | null;
}

interface FileDiff {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

interface GitCompareResponse {
  totalCommits: number;
  aheadBy: number;
  behindBy: number;
  files: FileDiff[];
  error: string | null;
}

interface FileDiffResponse {
  patch: string | null;
  error: string | null;
}

const patchCache = new Map<string, string>();

interface NetworkAnalysis {
  activeConnections: Array<{
    protocol: string;
    localAddress: string;
    remoteAddress: string;
    state: string;
    pid: number | null;
    program: string | null;
  }>;
  containerNetworks: Record<string, {
    containerId: string;
    containerName: string;
    ipAddress: string;
    gateway: string;
    macAddress: string;
    networkName: string;
  }>;
  listenPorts: Array<{
    port: number;
    protocol: string;
    address: string;
    program: string | null;
    containerId: string | null;
  }>;
}

// Styles for the button (inline to avoid CSS loading issues)
const BUTTON_STYLES = `
  position: fixed;
  bottom: 200px;
  right: 16px;
  z-index: 2147483647;
  width: 48px;
  height: 48px;
  border-radius: 0;
  background-color: #dc2626;
  border: none;
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  opacity: 0.5;
  transition: transform 0.1s, background-color 0.2s, opacity 0.2s;
  touch-action: none;
  user-select: none;
  pointer-events: auto;
  isolation: isolate;
`;

const BUTTON_HOVER_BG = '#b91c1c';
const BUTTON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`;

interface ModalPalette {
  isDark: boolean;
  backdrop: string;
  surface: string;          // modal background
  surfaceMuted: string;     // section background (controls bar)
  surfaceCode: string;      // log content background
  surfaceInput: string;     // input/select background
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;        // helper text
  textSubtle: string;       // dim labels
  tabActiveBg: string;
  tabActiveText: string;
  tabIdleText: string;
  cancelGradient: string;
  cancelGradientHover: string;
  cancelText: string;
  cancelBorder: string;
  cancelBorderHover: string;
  shadow: string;
}

function detectIsDarkTheme(): boolean {
  const html = document.documentElement;
  if (html.classList.contains('dark')) return true;
  if (html.classList.contains('light')) return false;
  if (html.dataset.theme === 'dark') return true;
  if (html.dataset.theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getModalPalette(): ModalPalette {
  const isDark = detectIsDarkTheme();
  if (isDark) {
    return {
      isDark: true,
      backdrop: 'rgba(0, 0, 0, 0.8)',
      surface: '#1a1a1a',
      surfaceMuted: '#0f0f0f',
      surfaceCode: '#0a0a0a',
      surfaceInput: '#1a1a1a',
      border: '#222',
      borderStrong: '#404040',
      text: '#e5e7eb',
      textMuted: '#9ca3af',
      textSubtle: '#666',
      tabActiveBg: '#1e3a5f',
      tabActiveText: '#60a5fa',
      tabIdleText: '#888',
      cancelGradient: 'linear-gradient(135deg, #1f1f1f 0%, #2a2a2a 100%)',
      cancelGradientHover: 'linear-gradient(135deg, #2a2a2a 0%, #333333 100%)',
      cancelText: '#e5e7eb',
      cancelBorder: '#404040',
      cancelBorderHover: '#505050',
      shadow: '0 25px 50px rgba(0, 0, 0, 0.5)',
    };
  }
  return {
    isDark: false,
    backdrop: 'rgba(15, 23, 42, 0.45)',
    surface: '#ffffff',
    surfaceMuted: '#f1f5f9',
    surfaceCode: '#f8fafc',
    surfaceInput: '#ffffff',
    border: '#e2e8f0',
    borderStrong: '#cbd5e1',
    text: '#0f172a',
    textMuted: '#475569',
    textSubtle: '#64748b',
    tabActiveBg: '#dbeafe',
    tabActiveText: '#1d4ed8',
    tabIdleText: '#64748b',
    cancelGradient: 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)',
    cancelGradientHover: 'linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%)',
    cancelText: '#0f172a',
    cancelBorder: '#cbd5e1',
    cancelBorderHover: '#94a3b8',
    shadow: '0 25px 50px rgba(15, 23, 42, 0.18)',
  };
}

const buildModalStyles = (p: ModalPalette): string => `
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2147483647;
  background: ${p.backdrop};
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  pointer-events: auto;
  isolation: isolate;
  touch-action: auto;
`;

// Dynamic modal content styles based on viewport
const getModalContentStyles = (p: ModalPalette): string => {
  const mobile = isMobile();
  return `
    background: ${p.surface};
    border-radius: ${mobile ? '0' : '0'};
    padding: ${mobile ? '8px' : '20px'};
    ${mobile ? 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;' : 'position: relative; max-width: 750px; width: 90%; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden;'}
    -webkit-overflow-scrolling: touch;
    color: ${p.text};
    box-shadow: ${mobile ? 'none' : p.shadow};
    pointer-events: auto;
    z-index: 2;
    box-sizing: border-box;
    touch-action: auto;
  `;
};

let buttonElement: HTMLButtonElement | null = null;
let modalElement: HTMLDivElement | null = null;
let isDragging = false;
const dragOffset = { x: 0, y: 0 };
let isAdmin = false;

/**
 * Check if current user is admin by looking at stored auth data
 */
function checkIsAdmin(): boolean {
  try {
    // Check sessionStorage first, then localStorage
    const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
    if (!authData) return false;

    const tokens = JSON.parse(authData);
    const accessToken = tokens.access_token;
    if (!accessToken) return false;

    // Decode JWT payload (middle part)
    const parts = accessToken.split('.');
    if (parts.length !== 3) return false;

    const payload = JSON.parse(atob(parts[1]));

    // Check if token is expired (exp is in seconds, Date.now() is in milliseconds)
    const exp = payload.exp;
    if (exp && Date.now() >= exp * 1000) {
      // Token expired - remove it and return false
      sessionStorage.removeItem('auth_tokens');
      localStorage.removeItem('auth_tokens');
      return false;
    }

    const role = payload.role || '';
    return role.toUpperCase() === 'ADMIN';
  } catch {
    return false;
  }
}

/**
 * Detect if the errors are frontend-related
 */
function detectErrorSource(errors: string): 'frontend' | 'backend' {
  const frontendPatterns = [
    // React errors
    /React/i,
    /ReactDOM/i,
    /component/i,
    /render/i,
    /useEffect/i,
    /useState/i,
    /useCallback/i,
    /useMemo/i,
    /useRef/i,
    /useContext/i,
    /jsx/i,
    /tsx/i,
    // DOM errors
    /insertBefore/i,
    /appendChild/i,
    /removeChild/i,
    /Node/i,
    /Element/i,
    /DOM/i,
    // Vite/bundler
    /vite/i,
    /bundle/i,
    /chunk/i,
    // TypeScript/JS runtime
    /TypeError/i,
    /ReferenceError/i,
    /SyntaxError/i,
    /undefined is not/i,
    /cannot read propert/i,
    // React-related libraries
    /radix/i,
    /framer/i,
    /tailwind/i,
    /stomp/i,
    // Source map references to frontend files
    /\.tsx/i,
    /\.jsx/i,
    /src\/components/i,
    /src\/hooks/i,
    /src\/lib/i,
    /src\/contexts/i,
  ];

  for (const pattern of frontendPatterns) {
    if (pattern.test(errors)) {
      return 'frontend';
    }
  }

  return 'backend';
}

/**
 * Fetch list of Docker containers
 */
async function fetchDockerContainers(): Promise<DockerContainer[]> {
  try {
    const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
    const tokens = authData ? JSON.parse(authData) : {};
    const accessToken = tokens.access_token || '';

    console.log('[Admin Debug] Token check:', { hasToken: !!accessToken, tokenLength: accessToken?.length });

    if (!accessToken) {
      console.error('[Admin Debug] No access token found in storage');
      return [];
    }

    const hostname = window.location.hostname;
    let apiBase = 'https://api.scrapalot.app/api/v1';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      apiBase = 'http://localhost:8091/api/v1';
    }

    const url = `${apiBase}/admin/debug/docker/containers`;
    console.log('[Admin Debug] Fetching containers from:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    console.log('[Admin Debug] Response:', { status: response.status, ok: response.ok });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Admin Debug] API error:", response.status, response.statusText, errorText);
      return [];
    }

    const data = await response.json();
    console.log('[Admin Debug] Received containers:', data.length);
    return data;
  } catch (error) {
    console.error('[Admin Debug] Exception:', error);
    return [];
  }
}

/**
 * Fetch network analysis
 */
async function fetchNetworkAnalysis(): Promise<NetworkAnalysis | null> {
  try {
    const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
    const tokens = authData ? JSON.parse(authData) : {};
    const accessToken = tokens.access_token || '';

    if (!accessToken) {
      return null;
    }

    const hostname = window.location.hostname;
    let apiBase = 'https://api.scrapalot.app/api/v1';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      apiBase = 'http://localhost:8091/api/v1';
    }

    const response = await fetch(`${apiBase}/admin/debug/docker/network`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    // Backend Jackson is globally configured for snake_case (CLAUDE.md rule
    // 12), but the rendering code below + NetworkAnalysis interface expect
    // camelCase. Map at the boundary so the rest of the file stays clean.
    const raw = await response.json() as {
      active_connections?: Array<{ protocol: string; local_address: string; remote_address: string; state: string; pid?: number | null; program?: string | null }>;
      container_networks?: Record<string, { container_id: string; container_name: string; ip_address: string; gateway: string; mac_address: string; network_name: string }>;
      listen_ports?: Array<{ port: number; protocol: string; address: string; program?: string | null; container_id?: string | null }>;
    };

    return {
      activeConnections: (raw.active_connections ?? []).map(c => ({
        protocol: c.protocol,
        localAddress: c.local_address,
        remoteAddress: c.remote_address,
        state: c.state,
        pid: c.pid ?? null,
        program: c.program ?? null,
      })),
      containerNetworks: Object.fromEntries(
        Object.entries(raw.container_networks ?? {}).map(([k, n]) => [k, {
          containerId: n.container_id,
          containerName: n.container_name,
          ipAddress: n.ip_address,
          gateway: n.gateway,
          macAddress: n.mac_address,
          networkName: n.network_name,
        }])
      ),
      listenPorts: (raw.listen_ports ?? []).map(p => ({
        port: p.port,
        protocol: p.protocol,
        address: p.address,
        program: p.program ?? null,
        containerId: p.container_id ?? null,
      })),
    };
  } catch (error) {
    console.error('Failed to fetch network analysis:', error);
    return null;
  }
}

/**
 * Fetch git commit info for a container
 */
async function fetchContainerGitInfo(containerId: string): Promise<ContainerGitInfo | null> {
  try {
    const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
    const tokens = authData ? JSON.parse(authData) : {};
    const accessToken = tokens.access_token || '';

    if (!accessToken) return null;

    const hostname = window.location.hostname;
    let apiBase = 'https://api.scrapalot.app/api/v1';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      apiBase = 'http://localhost:8091/api/v1';
    }

    const response = await fetch(`${apiBase}/admin/debug/docker/containers/${containerId}/git-info`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!response.ok) return null;

    return await response.json();
  } catch (error) {
    console.error('[Admin Debug] Failed to fetch git info:', error);
    return null;
  }
}

/**
 * Fetch git compare (diff) between two commits
 */
async function fetchGitCompare(repo: string, base: string, head: string): Promise<GitCompareResponse | null> {
  try {
    const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
    const tokens = authData ? JSON.parse(authData) : {};
    const accessToken = tokens.access_token || '';

    if (!accessToken) return null;

    const hostname = window.location.hostname;
    let apiBase = 'https://api.scrapalot.app/api/v1';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      apiBase = 'http://localhost:8091/api/v1';
    }

    const response = await fetch(
      `${apiBase}/admin/debug/docker/git-compare?repo=${encodeURIComponent(repo)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    );

    if (!response.ok) return null;

    return await response.json();
  } catch (error) {
    console.error('[Admin Debug] Failed to fetch git compare:', error);
    return null;
  }
}

/**
 * Fetch diff patch for a single file (on-demand loading when Compare API omits patches)
 */
async function fetchFileDiff(repo: string, base: string, head: string, path: string): Promise<string | null> {
  const cacheKey = `${repo}/${base}...${head}/${path}`;
  const cached = patchCache.get(cacheKey);
  if (cached) return cached;

  try {
    const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
    const tokens = authData ? JSON.parse(authData) : {};
    const accessToken = tokens.access_token || '';

    if (!accessToken) return null;

    const hostname = window.location.hostname;
    let apiBase = 'https://api.scrapalot.app/api/v1';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      apiBase = 'http://localhost:8091/api/v1';
    }

    const response = await fetch(
      `${apiBase}/admin/debug/docker/git-file-diff?repo=${encodeURIComponent(repo)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}&path=${encodeURIComponent(path)}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    );

    if (!response.ok) return null;

    const data: FileDiffResponse = await response.json();
    if (data.patch) {
      patchCache.set(cacheKey, data.patch);
      return data.patch;
    }
    return null;
  } catch (error) {
    console.error('[Admin Debug] Failed to fetch file diff:', error);
    return null;
  }
}

/**
 * Map file extension to highlight.js language name
 */
function detectLanguage(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    'kt': 'kotlin', 'kts': 'kotlin',
    'ts': 'typescript', 'tsx': 'typescript',
    'js': 'javascript', 'jsx': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript',
    'py': 'python',
    'yml': 'yaml', 'yaml': 'yaml',
    'css': 'css', 'scss': 'scss',
    'html': 'xml', 'xml': 'xml', 'svg': 'xml',
    'json': 'json',
    'sh': 'bash', 'bash': 'bash', 'zsh': 'bash',
    'sql': 'sql',
    'properties': 'properties', 'env': 'properties', 'conf': 'properties',
    'gradle': 'gradle',
    'md': 'markdown',
    'proto': 'properties',
  };
  return ext ? (map[ext] || null) : null;
}

/**
 * Highlight a single code line (without the +/- prefix) using highlight.js
 */
function highlightCode(code: string, lang: string | null): string {
  if (!lang || !code.trim()) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Render a unified diff patch into colored HTML with syntax highlighting and line numbers.
 * Line numbers are parsed from @@ hunk headers. Each line row gets data attributes for selection.
 */
function renderDiffPatch(patch: string, filename: string, fileIdx: number): string {
  const lines = patch.split('\n');
  const html: string[] = [];
  const lang = detectLanguage(filename);
  let oldLine = 0;
  let newLine = 0;
  const hunkHeaderRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  const gutterStyle = 'display: inline-block; width: 38px; text-align: right; padding-right: 6px; user-select: none; cursor: pointer; flex-shrink: 0; font-size: 10px;';
  const prefixStyle = 'display: inline-block; width: 12px; text-align: center; user-select: none; flex-shrink: 0;';

  for (const line of lines) {
    const hunkMatch = line.match(hunkHeaderRe);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      html.push(`<div style="background: #1e2d3d; color: #6cb6ff; padding: 2px 8px; font-size: 11px; border-top: 1px solid #333; border-bottom: 1px solid #333; display: flex;">`
        + `<span style="${gutterStyle} width: 80px; color: #6cb6ff;">${escapeHtml(line.match(/@@ .+? @@/)![0])}</span>`
        + `<span style="flex: 1;">${escapeHtml(line.replace(/@@ .+? @@/, '').trim())}</span></div>`);
    } else if (line.startsWith('+')) {
      const code = line.substring(1);
      html.push(`<div class="diff-line" data-file-idx="${fileIdx}" data-new-line="${newLine}" data-raw="${escapeHtml(code)}" style="background: #1a2e1a; display: flex; align-items: flex-start;">`
        + `<span class="diff-gutter" data-line="${newLine}" style="${gutterStyle} color: #3fb950;">${newLine}</span>`
        + `<span style="${prefixStyle} color: #3fb950;">+</span>`
        + `<span class="hljs-diff-add" style="flex: 1; padding-right: 8px;">${highlightCode(code, lang)}</span></div>`);
      newLine++;
    } else if (line.startsWith('-')) {
      const code = line.substring(1);
      html.push(`<div class="diff-line" data-file-idx="${fileIdx}" data-old-line="${oldLine}" data-raw="${escapeHtml(code)}" style="background: #2e1a1a; display: flex; align-items: flex-start;">`
        + `<span class="diff-gutter" data-line="${oldLine}" style="${gutterStyle} color: #f47067;">${oldLine}</span>`
        + `<span style="${prefixStyle} color: #f47067;">-</span>`
        + `<span class="hljs-diff-del" style="flex: 1; padding-right: 8px;">${highlightCode(code, lang)}</span></div>`);
      oldLine++;
    } else {
      const code = line.startsWith(' ') ? line.substring(1) : line;
      html.push(`<div class="diff-line" data-file-idx="${fileIdx}" data-new-line="${newLine}" data-old-line="${oldLine}" data-raw="${escapeHtml(code)}" style="display: flex; align-items: flex-start;">`
        + `<span class="diff-gutter" data-line="${newLine}" style="${gutterStyle} color: #484f58;">${newLine}</span>`
        + `<span style="${prefixStyle} color: #484f58;"> </span>`
        + `<span style="flex: 1; padding-right: 8px;">${highlightCode(code, lang)}</span></div>`);
      oldLine++;
      newLine++;
    }
  }

  return html.join('');
}

/**
 * Show inline diff viewer as overlay on top of existing debug modal
 */
let diffViewerElement: HTMLDivElement | null = null;

function showDiffViewer(repoName: string, baseSha: string, headSha: string): void {
  if (diffViewerElement) return;

  const mobile = isMobile();

  diffViewerElement = document.createElement('div');
  diffViewerElement.style.cssText = buildModalStyles(getModalPalette());
  diffViewerElement.innerHTML = `
    <div style="
      background: #1a1a1a;
      ${mobile ? 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;' : 'position: relative; max-width: 900px; width: 95%; max-height: 90vh; display: flex; flex-direction: column;'}
      color: #fff;
      box-shadow: ${mobile ? 'none' : '0 25px 50px rgba(0, 0, 0, 0.5)'};
      pointer-events: auto;
      z-index: 2;
      box-sizing: border-box;
    ">
      ${mobile ? '' : `
      <div style="flex-shrink: 0; padding: 14px 20px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0;">
          <span style="font-weight: 600; font-size: 14px; white-space: nowrap;">${escapeHtml(repoName)}</span>
          <span style="font-family: monospace; font-size: 12px; color: #8b949e; white-space: nowrap;">${baseSha.substring(0, 7)}...${headSha.substring(0, 7)}</span>
          <span id="diff-stats" style="font-size: 12px; color: #8b949e;">Loading...</span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
          <span id="diff-nav-label" style="font-size: 11px; color: #484f58; margin-right: 4px;"></span>
          <button id="diff-nav-prev" style="background: none; border: 1px solid #444; color: #8b949e; cursor: pointer; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1;" title="Previous file">&#9650;</button>
          <button id="diff-nav-next" style="background: none; border: 1px solid #444; color: #8b949e; cursor: pointer; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1;" title="Next file">&#9660;</button>
          <button id="diff-viewer-close" style="background: none; border: 1px solid #444; color: #ccc; cursor: pointer; height: 36px; padding: 0 12px; display: flex; align-items: center; justify-content: center; font-size: 13px; white-space: nowrap; margin-left: 4px;">Close</button>
        </div>
      </div>
      `}
      ${mobile ? `
      <div style="flex-shrink: 0; padding: 8px 10px; border-bottom: 1px solid #333;">
        <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
          <span style="font-weight: 600; font-size: 14px; white-space: nowrap;">${escapeHtml(repoName)}</span>
          <span style="font-family: monospace; font-size: 11px; color: #8b949e; white-space: nowrap;">${baseSha.substring(0, 7)}..${headSha.substring(0, 7)}</span>
          <span id="diff-stats" style="font-size: 11px; color: #8b949e; margin-left: auto; white-space: nowrap;">Loading...</span>
        </div>
      </div>
      ` : ''}
      <style>
        .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-type { color: #ff7b72; }
        .hljs-string, .hljs-attr { color: #a5d6ff; }
        .hljs-number, .hljs-literal { color: #79c0ff; }
        .hljs-comment, .hljs-meta { color: #8b949e; font-style: italic; }
        .hljs-function .hljs-title, .hljs-title.function_ { color: #d2a8ff; }
        .hljs-title.class_, .hljs-class .hljs-title { color: #f0883e; }
        .hljs-variable, .hljs-template-variable { color: #ffa657; }
        .hljs-params { color: #c9d1d9; }
        .hljs-property { color: #79c0ff; }
        .hljs-punctuation { color: #c9d1d9; }
        .hljs-regexp { color: #7ee787; }
        .hljs-symbol { color: #ffa657; }
        .hljs-tag { color: #7ee787; }
        .hljs-name { color: #7ee787; }
        .hljs-selector-id, .hljs-selector-class { color: #d2a8ff; }
        .hljs-attribute { color: #79c0ff; }
        .hljs-section { color: #d2a8ff; font-weight: bold; }
        .hljs-bullet { color: #ffa657; }
        .hljs-addition { color: #aff5b4; background: #033a16; }
        .hljs-deletion { color: #ffdcd7; background: #67060c; }
        .hljs-diff-add .hljs-keyword, .hljs-diff-add .hljs-built_in, .hljs-diff-add .hljs-type { color: #7ee787; }
        .hljs-diff-add .hljs-string, .hljs-diff-add .hljs-attr { color: #a5d6ff; }
        .hljs-diff-add .hljs-comment, .hljs-diff-add .hljs-meta { color: #56d364; font-style: italic; }
        .hljs-diff-add .hljs-number, .hljs-diff-add .hljs-literal, .hljs-diff-add .hljs-property { color: #79c0ff; }
        .hljs-diff-add .hljs-title.function_, .hljs-diff-add .hljs-function .hljs-title { color: #d2a8ff; }
        .hljs-diff-add { color: #aff5b4; }
        .hljs-diff-del .hljs-keyword, .hljs-diff-del .hljs-built_in, .hljs-diff-del .hljs-type { color: #ff7b72; }
        .hljs-diff-del .hljs-string, .hljs-diff-del .hljs-attr { color: #a5d6ff; }
        .hljs-diff-del .hljs-comment, .hljs-diff-del .hljs-meta { color: #8b949e; font-style: italic; }
        .hljs-diff-del .hljs-number, .hljs-diff-del .hljs-literal, .hljs-diff-del .hljs-property { color: #79c0ff; }
        .hljs-diff-del .hljs-title.function_, .hljs-diff-del .hljs-function .hljs-title { color: #d2a8ff; }
        .hljs-diff-del { color: #ffdcd7; }
        .diff-gutter { cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; }
        .diff-gutter:hover { background: #30363d !important; }
        .diff-line.diff-line-selected { outline: 1px solid #1f6feb; outline-offset: -1px; }
        .diff-line.diff-line-selected .diff-gutter { background: #1f3d6f !important; color: #58a6ff !important; }
        .diff-copy-toast {
          position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
          background: #1f6feb; color: #fff; padding: 8px 16px; font-size: 13px;
          z-index: 2147483647; pointer-events: none; opacity: 0;
          transition: opacity 0.2s;
        }
      </style>
      <div id="diff-viewer-content" style="flex: 1; min-height: 0; overflow-y: auto; padding: ${mobile ? '8px' : '12px'}; -webkit-overflow-scrolling: touch;">
        <div style="color: #8b949e; text-align: center; padding: 40px 0;">Loading diff...</div>
      </div>
      ${mobile ? `
      <div style="flex-shrink: 0; padding: 8px 10px; border-top: 1px solid #333; background: #161b22; display: flex; align-items: center; gap: 8px;">
        <button id="diff-viewer-close" style="background: none; border: 1px solid #444; color: #ccc; cursor: pointer; height: 44px; padding: 0 16px; display: flex; align-items: center; justify-content: center; font-size: 14px; white-space: nowrap; flex-shrink: 0;">Close</button>
        <span id="diff-nav-label" style="font-size: 12px; color: #484f58; flex: 1; text-align: center;"></span>
        <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          <button id="diff-nav-prev" style="background: none; border: 1px solid #444; color: #8b949e; cursor: pointer; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; font-size: 16px; line-height: 1;" title="Previous file">&#9650;</button>
          <button id="diff-nav-next" style="background: none; border: 1px solid #444; color: #8b949e; cursor: pointer; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; font-size: 16px; line-height: 1;" title="Next file">&#9660;</button>
        </div>
      </div>
      ` : ''}
    </div>
  `;

  document.body.appendChild(diffViewerElement);

  // Close handlers
  const closeBtn = document.getElementById('diff-viewer-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDiffViewer);
  }
  diffViewerElement.addEventListener('click', (e) => {
    if (e.target === diffViewerElement) closeDiffViewer();
  });

  // Fetch and render
  fetchGitCompare(repoName, baseSha, headSha).then((data) => {
    const contentEl = document.getElementById('diff-viewer-content');
    const statsEl = document.getElementById('diff-stats');
    if (!contentEl) return;

    if (!data || data.error) {
      contentEl.innerHTML = `<div style="color: #f47067; text-align: center; padding: 40px 0;">${escapeHtml(data?.error || 'Failed to load diff')}</div>`;
      return;
    }

    if (data.files.length === 0) {
      contentEl.innerHTML = '<div style="color: #8b949e; text-align: center; padding: 40px 0;">No file changes found</div>';
      if (statsEl) statsEl.textContent = '0 files';
      return;
    }

    // Update stats
    const totalAdd = data.files.reduce((s, f) => s + f.additions, 0);
    const totalDel = data.files.reduce((s, f) => s + f.deletions, 0);
    if (statsEl) {
      statsEl.innerHTML = `${data.files.length} file${data.files.length !== 1 ? 's' : ''} <span style="color: #7ee787;">+${totalAdd}</span> <span style="color: #f47067;">-${totalDel}</span>`;
    }

    // Build tree from flat file list
    interface TreeNode {
      name: string;
      children: Map<string, TreeNode>;
      file?: FileDiff;
      fileIdx?: number;
    }

    const root: TreeNode = { name: '', children: new Map() };

    data.files.forEach((file, idx) => {
      const parts = file.filename.split('/');
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          // Leaf file node
          current.children.set(part + '::' + idx, { name: part, children: new Map(), file, fileIdx: idx });
        } else {
          if (!current.children.has(part)) {
            current.children.set(part, { name: part, children: new Map() });
          }
          current = current.children.get(part)!;
        }
      }
    });

    // Collapse single-child directory chains (src/main/kotlin → src/main/kotlin)
    const collapseChain = (node: TreeNode): TreeNode => {
      for (const [key, child] of node.children) {
        if (!child.file && child.children.size === 1) {
          const [grandKey, grandChild] = [...child.children.entries()][0];
          if (!grandChild.file) {
            // Merge: child + grandChild into one node
            const merged: TreeNode = { name: child.name + '/' + grandChild.name, children: grandChild.children };
            node.children.delete(key);
            node.children.set(child.name + '/' + grandKey, collapseChain(merged));
            continue;
          }
        }
        node.children.set(key, collapseChain(child));
      }
      return node;
    };
    collapseChain(root);

    const statusColors: Record<string, string> = {
      'modified': '#d29922', 'added': '#3fb950', 'removed': '#f47067', 'renamed': '#6cb6ff',
    };

    // Render tree recursively
    const renderTree = (node: TreeNode, depth: number): string => {
      let html = '';
      // Sort: directories first, then files
      const entries = [...node.children.entries()].sort(([, a], [, b]) => {
        const aIsDir = !a.file ? 0 : 1;
        const bIsDir = !b.file ? 0 : 1;
        if (aIsDir !== bIsDir) return aIsDir - bIsDir;
        return a.name.localeCompare(b.name);
      });

      for (const [, child] of entries) {
        const indent = depth * 16;
        if (child.file) {
          // File leaf
          const f = child.file;
          const idx = child.fileIdx!;
          const sColor = statusColors[f.status] || '#8b949e';
          const sLabel = f.status.charAt(0).toUpperCase();
          html += `<div class="diff-tree-file" data-idx="${idx}" style="display: flex; align-items: center; gap: 6px; padding: ${mobile ? '6px 8px' : '3px 8px'}; padding-left: ${indent + 8}px; cursor: pointer; user-select: none; border-bottom: 1px solid #1c1c1c;" onmouseover="this.style.background='#1c2333'" onmouseout="this.style.background='none'">
            <span style="color: ${sColor}; font-size: 9px; font-weight: 700; border: 1px solid ${sColor}; padding: 0 3px; flex-shrink: 0;">${sLabel}</span>
            <span style="font-family: monospace; font-size: ${mobile ? '11px' : '12px'}; color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${escapeHtml(child.name)}</span>
            <span style="font-size: 10px; color: #8b949e; white-space: nowrap; flex-shrink: 0;"><span style="color: #7ee787;">+${f.additions}</span> <span style="color: #f47067;">-${f.deletions}</span></span>
          </div>`;
          const binaryExts = new Set(['pdf','db','sqlite','png','jpg','jpeg','gif','ico','svg','woff','woff2','ttf','eot','zip','tar','gz','jar','war','exe','dll','so','dylib','pyc','class','bin','dat','lock']);
          const ext = f.filename.split('.').pop()?.toLowerCase() || '';
          const isBinary = binaryExts.has(ext);
          const noPatchBody = !f.patch && !isBinary
            ? `<div class="diff-load-on-demand" data-filename="${escapeHtml(f.filename)}" data-file-idx="${idx}" style="color: #60a5fa; padding: 8px; cursor: pointer;" title="Click to load diff from GitHub">Click to load diff${f.additions + f.deletions > 0 ? ` <span style="color: #7ee787;">+${f.additions}</span> <span style="color: #f47067;">-${f.deletions}</span>` : ''}</div>`
            : '<div style="color: #8b949e; padding: 8px;">Binary file or no diff available</div>';
          html += `<div id="diff-file-body-${idx}" style="display: none; font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: ${mobile ? '10px' : '11px'}; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-all; background: #0d1117; border-bottom: 1px solid #333;">
            ${f.patch ? renderDiffPatch(f.patch, f.filename, idx) : noPatchBody}
          </div>`;
        } else {
          // Directory node
          const dirId = `diff-dir-${depth}-${child.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
          html += `<div class="diff-tree-dir" data-dir-id="${dirId}" style="display: flex; align-items: center; gap: 4px; padding: ${mobile ? '5px 8px' : '2px 8px'}; padding-left: ${indent + 8}px; cursor: pointer; user-select: none; border-bottom: 1px solid #1c1c1c;" onmouseover="this.style.background='#161b22'" onmouseout="this.style.background='none'">
            <span class="diff-dir-arrow" style="color: #484f58; font-size: 10px; width: 12px; text-align: center; flex-shrink: 0;">&#9660;</span>
            <span style="color: #8b949e; font-size: 12px; flex-shrink: 0;">&#128193;</span>
            <span style="font-family: monospace; font-size: ${mobile ? '11px' : '12px'}; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(child.name)}</span>
          </div>`;
          html += `<div id="${dirId}" class="diff-dir-children">${renderTree(child, depth + 1)}</div>`;
        }
      }
      return html;
    };

    contentEl.innerHTML = renderTree(root, 0);

    // Collect file elements in tree order for prev/next navigation
    const fileElements = [...contentEl.querySelectorAll('.diff-tree-file')] as HTMLElement[];
    const fileCount = fileElements.length;
    let currentFileNav = -1;

    const navLabel = document.getElementById('diff-nav-label');

    const updateNavLabel = () => {
      if (navLabel) {
        navLabel.textContent = currentFileNav >= 0 ? `${currentFileNav + 1}/${fileCount}` : '';
      }
    };

    const highlightFile = (el: HTMLElement, on: boolean) => {
      el.style.background = on ? '#1c2333' : '';
      el.style.borderLeft = on ? '2px solid #3b82f6' : '';
    };

    const navigateToFile = (index: number) => {
      if (index < 0 || index >= fileCount) return;

      // Remove highlight from previous
      if (currentFileNav >= 0 && currentFileNav < fileCount) {
        highlightFile(fileElements[currentFileNav], false);
      }

      currentFileNav = index;
      const el = fileElements[index];
      const idx = el.dataset.idx;
      const body = document.getElementById(`diff-file-body-${idx}`);

      // Expand the diff
      if (body && body.style.display === 'none') {
        body.style.display = 'block';
        // Auto-trigger on-demand loading
        const onDemand = body.querySelector('.diff-load-on-demand') as HTMLElement | null;
        if (onDemand) onDemand.click();
      }

      // Ensure parent directories are expanded
      let parent = el.parentElement;
      while (parent && parent !== contentEl) {
        if (parent.classList.contains('diff-dir-children') && parent.style.display === 'none') {
          parent.style.display = 'block';
          const dirHeader = parent.previousElementSibling;
          if (dirHeader) {
            const arrow = dirHeader.querySelector('.diff-dir-arrow') as HTMLElement;
            if (arrow) arrow.innerHTML = '&#9660;';
          }
        }
        parent = parent.parentElement;
      }

      // Highlight and scroll to file header
      highlightFile(el, true);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      updateNavLabel();
    };

    // Prev/Next buttons
    document.getElementById('diff-nav-prev')?.addEventListener('click', () => {
      navigateToFile(currentFileNav <= 0 ? fileCount - 1 : currentFileNav - 1);
    });
    document.getElementById('diff-nav-next')?.addEventListener('click', () => {
      navigateToFile(currentFileNav >= fileCount - 1 ? 0 : currentFileNav + 1);
    });

    // On-demand diff loading handler (delegated)
    const loadFileDiff = async (trigger: HTMLElement) => {
      const filename = trigger.dataset.filename;
      const fileIdx = trigger.dataset.fileIdx;
      if (!filename || !fileIdx) return;

      trigger.innerHTML = '<span style="color: #8b949e;">Loading diff...</span>';
      trigger.style.cursor = 'default';

      const patch = await fetchFileDiff(repoName, baseSha, headSha, filename);
      const bodyEl = document.getElementById(`diff-file-body-${fileIdx}`);
      if (!bodyEl) return;

      if (patch) {
        bodyEl.innerHTML = renderDiffPatch(patch, filename, parseInt(fileIdx, 10));
      } else {
        trigger.innerHTML = '<span style="color: #f47067;">Failed to load diff</span>';
      }
    };

    contentEl.addEventListener('click', (e) => {
      const trigger = (e.target as HTMLElement).closest('.diff-load-on-demand') as HTMLElement | null;
      if (trigger) void loadFileDiff(trigger);
    });

    // Toggle file diffs on click
    fileElements.forEach((el, elIndex) => {
      el.addEventListener('click', () => {
        const idx = el.dataset.idx;
        const body = document.getElementById(`diff-file-body-${idx}`);
        if (body) {
          const expanding = body.style.display === 'none';
          body.style.display = expanding ? 'block' : 'none';
          // Auto-trigger on-demand loading when expanding
          if (expanding) {
            const onDemand = body.querySelector('.diff-load-on-demand') as HTMLElement | null;
            if (onDemand) onDemand.click();
          }
        }
        // Update nav position
        if (currentFileNav >= 0 && currentFileNav < fileCount) {
          highlightFile(fileElements[currentFileNav], false);
        }
        currentFileNav = elIndex;
        highlightFile(el, true);
        updateNavLabel();
      });
    });

    // Toggle directory collapse
    contentEl.querySelectorAll('.diff-tree-dir').forEach((el) => {
      el.addEventListener('click', () => {
        const dirId = (el as HTMLElement).dataset.dirId;
        const children = document.getElementById(dirId!);
        const arrow = el.querySelector('.diff-dir-arrow') as HTMLElement;
        if (children) {
          const collapsed = children.style.display === 'none';
          children.style.display = collapsed ? 'block' : 'none';
          if (arrow) arrow.innerHTML = collapsed ? '&#9660;' : '&#9654;';
        }
      });
    });

    // --- Line selection for copy reference ---
    // Single click = select/highlight only. Drag across lines = select + copy on release.
    let selStartLine: HTMLElement | null = null;

    const clearLineSelection = () => {
      contentEl.querySelectorAll('.diff-line-selected').forEach(el => el.classList.remove('diff-line-selected'));
      selStartLine = null;
    };

    const getLineRows = (fileIdx: string): HTMLElement[] => {
      return [...contentEl.querySelectorAll(`.diff-line[data-file-idx="${fileIdx}"]`)] as HTMLElement[];
    };

    const selectRange = (startEl: HTMLElement, endEl: HTMLElement) => {
      const fileIdx = startEl.dataset.fileIdx;
      if (!fileIdx || fileIdx !== endEl.dataset.fileIdx) return;
      const rows = getLineRows(fileIdx);
      const startIdx = rows.indexOf(startEl);
      const endIdx = rows.indexOf(endEl);
      if (startIdx === -1 || endIdx === -1) return;
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      // Only clear CSS classes, do NOT null selStartLine
      contentEl.querySelectorAll('.diff-line-selected').forEach(el => el.classList.remove('diff-line-selected'));
      for (let i = lo; i <= hi; i++) {
        rows[i].classList.add('diff-line-selected');
      }
    };

    const showCopyToast = (msg: string) => {
      let toast = document.querySelector('.diff-copy-toast') as HTMLElement;
      if (!toast) {
        toast = document.createElement('div');
        toast.className = 'diff-copy-toast';
        document.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.style.opacity = '1';
      setTimeout(() => { toast.style.opacity = '0'; }, 2000);
    };

    const copySelectedLines = () => {
      const selected = [...contentEl.querySelectorAll('.diff-line-selected')] as HTMLElement[];
      if (selected.length === 0) return;

      const fileIdx = selected[0].dataset.fileIdx;
      if (!fileIdx) return;
      const file = data!.files[parseInt(fileIdx, 10)];
      if (!file) return;

      // Filter to only added lines (have data-new-line but NOT data-old-line)
      const addedLines = selected.filter(el => el.dataset.newLine && !el.dataset.oldLine);

      // If no added lines in selection, fall back to all selected lines
      const linesToCopy = addedLines.length > 0 ? addedLines : selected;

      // Determine line range from the lines to copy
      const lineNums: number[] = [];
      linesToCopy.forEach(el => {
        const n = el.dataset.newLine || el.dataset.oldLine;
        if (n) lineNums.push(parseInt(n, 10));
      });
      const minLine = Math.min(...lineNums);
      const maxLine = Math.max(...lineNums);

      // Collect raw code from data-raw attribute
      const codeLines = linesToCopy.map(el => {
        // Decode HTML entities from data-raw
        const raw = el.dataset.raw || '';
        const tmp = document.createElement('textarea');
        tmp.innerHTML = raw;
        return tmp.value;
      });

      const rangeStr = minLine === maxLine ? `${minLine}` : `${minLine}-${maxLine}`;
      const reference = `@${repoName}/${file.filename} lines:${rangeStr}\n\`\`\`\n${codeLines.join('\n')}\n\`\`\``;

      const addedCount = addedLines.length;
      const totalCount = selected.length;
      const toastMsg = addedCount > 0 && addedCount < totalCount
        ? `Copied ${addedCount} added line${addedCount > 1 ? 's' : ''} (${totalCount - addedCount} skipped)`
        : `Copied ${linesToCopy.length} line${linesToCopy.length > 1 ? 's' : ''} reference`;

      navigator.clipboard.writeText(reference).then(() => {
        showCopyToast(toastMsg);
      });
    };

    // Two-click selection: 1st click on gutter = start, hover extends, 2nd click on gutter = finish + copy
    // Click same line twice = copy single line. Click outside gutter = cancel.
    let selActive = false;

    contentEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const gutter = target.closest('.diff-gutter');

      if (gutter) {
        const lineRow = gutter.closest('.diff-line') as HTMLElement;
        if (!lineRow) return;

        if (!selActive) {
          // First click: start selection
          clearLineSelection();
          selActive = true;
          selStartLine = lineRow;
          lineRow.classList.add('diff-line-selected');
        } else {
          // Second click: finish selection + copy
          selectRange(selStartLine!, lineRow);
          selActive = false;
          copySelectedLines();
        }
      } else {
        // Clicked outside gutter: cancel selection
        selActive = false;
        clearLineSelection();
      }
    });

    contentEl.addEventListener('mouseover', (e) => {
      if (!selActive || !selStartLine) return;
      const target = e.target as HTMLElement;
      const lineRow = target.closest('.diff-line') as HTMLElement;
      if (!lineRow) return;
      selectRange(selStartLine, lineRow);
    });
  });
}

function closeDiffViewer(): void {
  if (diffViewerElement) {
    diffViewerElement.remove();
    diffViewerElement = null;
  }
}

/**
 * Create and show the modal - exported so React floating dock can trigger it.
 * Non-admin users see only the Frontend tab (browser console logs) and the
 * Report Bug submit button. Admin users keep full access (Backend tab, Docker
 * logs, network analysis, container picker, git diffs).
 */
export async function showAdminDebugModal(): Promise<void> {
  if (modalElement) return;

  const errors = consoleErrorCapture.formatForSubmission();
  const errorCount = consoleErrorCapture.getErrorCount();
  const warningCount = consoleErrorCapture.getWarningCount();
  const logCount = consoleErrorCapture.getLogCount();

  // Check if mobile for responsive styles
  const mobile = isMobile();

  // Admin status drives which tabs/sections are rendered. Non-admins only
  // get the Frontend (browser console) tab; everything that hits the
  // /admin/debug API is hidden because they can't authenticate against it.
  const isAdminUser = checkIsAdmin();
  const initialTab = isAdminUser ? 'backend' : 'frontend';
  // Submit button gating tracks errors in the *active* tab. For frontend it's
  // the browser console (`errorCount`). For backend it's the count parsed
  // from Docker logs, which arrives async — start at 0, will be updated by
  // updateBackendBadges() after autoFetchBackendLogs() resolves.
  let backendErrorCount = 0;
  const isCurrentTabErrorFree = (): boolean => {
    const hidden = document.getElementById('target-repo-value') as HTMLInputElement | null;
    const tab = hidden?.value || initialTab;
    if (tab === 'backend') return backendErrorCount === 0;
    return consoleErrorCapture.getErrorCount() === 0;
  };
  const submitDisabled = initialTab === 'backend'
    ? backendErrorCount === 0
    : errorCount === 0;
  const t = (key: string, fallback: string): string => {
    try {
      const out = i18n.t(key, { defaultValue: fallback });
      return typeof out === 'string' ? out : fallback;
    } catch {
      return fallback;
    }
  };

  // Pick a theme-aware color palette so the modal honours the current
  // light/dark mode instead of being permanently dark.
  const p = getModalPalette();

  // Create modal with loading state for Docker logs
  modalElement = document.createElement('div');
  modalElement.style.cssText = buildModalStyles(p);
  modalElement.innerHTML = `
    <div style="${getModalContentStyles(p)}">
      <!-- HEADER (Always visible) -->
      <div style="flex-shrink: 0;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
          <h2 style="margin: 0; font-size: ${mobile ? '16px' : '18px'}; display: flex; align-items: center; gap: 6px; color: ${p.text};">
            ${BUTTON_ICON.replace('white', '#ef4444').replace('24', '20')}
            ${t('bugTracker.title', 'Bug Tracker')}
          </h2>
          ${isAdminUser ? `
          <button id="copy-all-logs" style="padding: ${mobile ? '10px' : '8px'}; border-radius: 0; border: none;
                  background: #3b82f6; color: #fff; cursor: pointer; font-size: ${mobile ? '14px' : '12px'}; font-weight: 500;
                  min-height: ${mobile ? '38px' : 'auto'}; display: flex; align-items: center; justify-content: center;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          </button>
          ` : ''}
        </div>

        <!-- Tabs for Target Repository (Backend tab only visible to admins) -->
        <div style="display: ${isAdminUser ? 'flex' : 'none'}; gap: 0; border-bottom: 1px solid ${p.border};">
        <button id="tab-backend" data-target="backend" class="repo-tab" style="padding: ${mobile ? '8px 12px' : '8px 16px'}; border: none;
                background: ${initialTab === 'backend' ? p.tabActiveBg : 'transparent'}; color: ${initialTab === 'backend' ? p.tabActiveText : p.tabIdleText};
                cursor: pointer; font-size: ${mobile ? '14px' : '13px'}; border-bottom: 2px solid ${initialTab === 'backend' ? p.tabActiveText : 'transparent'};
                transition: all 0.2s; flex: ${mobile ? '1' : 'none'}; min-height: ${mobile ? '36px' : 'auto'}; display: flex; align-items: center; gap: 4px;">
          <span>${mobile ? 'Backend' : 'Backend (Docker)'}</span>
          <span id="backend-error-badge" style="display: none; background: #dc2626; color: white; padding: 2px 6px; border-radius: 0; font-size: ${mobile ? '11px' : '10px'}; min-width: 20px; text-align: center;"></span>
          <span id="backend-warn-badge" style="display: none; background: #f59e0b; color: white; padding: 2px 6px; border-radius: 0; font-size: ${mobile ? '11px' : '10px'}; min-width: 20px; text-align: center;"></span>
        </button>
        <button id="tab-frontend" data-target="frontend" class="repo-tab" style="padding: ${mobile ? '8px 12px' : '8px 16px'}; border: none;
                background: ${initialTab === 'frontend' ? p.tabActiveBg : 'transparent'}; color: ${initialTab === 'frontend' ? p.tabActiveText : p.tabIdleText};
                cursor: pointer; font-size: ${mobile ? '14px' : '13px'}; border-bottom: 2px solid ${initialTab === 'frontend' ? p.tabActiveText : 'transparent'};
                transition: all 0.2s; flex: ${mobile ? '1' : 'none'}; min-height: ${mobile ? '36px' : 'auto'}; display: flex; align-items: center; gap: 4px;">
          <span>${mobile ? 'Frontend' : 'Frontend (Browser)'}</span>
          ${errorCount > 0 ? `<span style="background: #dc2626; color: white; padding: 2px 6px; border-radius: 0; font-size: ${mobile ? '11px' : '10px'}; min-width: 20px; text-align: center;">${errorCount}</span>` : ''}
          ${warningCount > 0 ? `<span style="background: #f59e0b; color: white; padding: 2px 6px; border-radius: 0; font-size: ${mobile ? '11px' : '10px'}; min-width: 20px; text-align: center;">${warningCount}</span>` : ''}
          ${(logCount - errorCount - warningCount) > 0 ? `<span style="background: #3b82f6; color: white; padding: 2px 6px; border-radius: 0; font-size: ${mobile ? '11px' : '10px'}; min-width: 20px; text-align: center;">${logCount - errorCount - warningCount}</span>` : ''}
        </button>
        </div>
      </div>
      <!-- END HEADER -->

      <!-- SCROLLABLE CONTENT -->
      <!-- min-height: 0 is REQUIRED: a flex:1 child in a flex-direction:column
           parent has implicit min-height:auto, so it grows to fit its content
           instead of shrinking — overflow-y never engages and the parent
           (overflow:hidden) clips the overflow, making it unscrollable on
           mobile. Same fix the diff viewer already has. -->
      <div style="flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; padding-top: 8px;">
        <input type="hidden" id="target-repo-value" value="${initialTab}">

        <!-- Backend Docker Logs Panel (admin only) -->
      <div id="panel-backend" style="margin-bottom: 8px; display: ${isAdminUser && initialTab === 'backend' ? 'block' : 'none'};">
        <!-- Compact Controls Row -->
        <div style="display: flex; flex-direction: ${mobile ? 'column' : 'row'}; flex-wrap: wrap; gap: ${mobile ? '10px' : '6px'}; margin-bottom: 6px; align-items: ${mobile ? 'stretch' : 'center'}; background: ${p.surfaceMuted}; padding: ${mobile ? '8px' : '6px 8px'}; border-left: 2px solid #3b82f6;">
          <div style="display: flex; gap: ${mobile ? '10px' : '6px'}; align-items: center; flex-wrap: wrap; ${mobile ? 'justify-content: space-between; width: 100%;' : ''}">
            <select id="container-select" style="padding: ${mobile ? '10px 12px' : '3px 6px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: ${p.surfaceInput}; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; min-height: ${mobile ? '38px' : 'auto'}; ${mobile ? 'width: 100%;' : 'min-width: 150px;'}">
              <option value="">Loading containers...</option>
            </select>
            ${mobile ? '' : `<div style="width: 1px; height: 16px; background: ${p.border}; margin: 0 2px;"></div>`}
            <div style="display: flex; gap: 8px; align-items: center; ${mobile ? 'width: 100%;' : ''}">
              <select id="backend-log-level" style="padding: ${mobile ? '10px 12px' : '3px 6px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                      background: ${p.surfaceInput}; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; min-height: ${mobile ? '38px' : 'auto'}; ${mobile ? 'flex: 1;' : ''}">
                <option value="all">All</option>
                <option value="error" selected>ERROR</option>
                <option value="warn">WARN</option>
              </select>
              <span style="font-size: ${mobile ? '14px' : '11px'}; color: ${p.textSubtle};">Lines:</span>
              <input type="number" id="backend-context-lines" value="200" min="50" max="1000"
                     style="width: ${mobile ? '70px' : '50px'}; padding: ${mobile ? '10px 12px' : '3px 6px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                            background: ${p.surfaceInput}; color: ${p.text}; font-size: ${mobile ? '14px' : '11px'}; min-height: ${mobile ? '38px' : 'auto'};" />
            </div>
          </div>
          <div id="git-info-section" style="display: none; font-size: ${mobile ? '12px' : '11px'}; color: ${p.textMuted}; padding: 2px 0;">
          </div>
          <div style="display: flex; gap: ${mobile ? '8px' : '4px'}; ${mobile ? 'width: 100%;' : 'margin-left: auto;'}">
            <button id="refresh-backend-logs" style="padding: ${mobile ? '12px 16px' : '3px 8px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: transparent; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; white-space: nowrap;
                    min-height: ${mobile ? '38px' : 'auto'}; flex: ${mobile ? '1' : 'none'};">
              Refresh
            </button>
            <button id="clear-backend-logs" style="padding: ${mobile ? '12px 16px' : '6px 10px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: transparent; color: ${p.textMuted}; cursor: pointer; font-size: ${mobile ? '14px' : '12px'}; white-space: nowrap;
                    min-height: ${mobile ? '38px' : 'auto'}; flex: ${mobile ? '1' : 'none'}; display: flex; align-items: center; justify-content: center;">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
            </button>
            <button id="copy-backend-logs" style="padding: ${mobile ? '12px 16px' : '6px 10px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: transparent; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '12px'}; white-space: nowrap;
                    min-height: ${mobile ? '38px' : 'auto'}; flex: ${mobile ? '1' : 'none'}; display: flex; align-items: center; justify-content: center;">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
          </div>
        </div>

        <pre id="backend-logs-content" style="background: ${p.surfaceCode}; padding: ${mobile ? '10px' : '10px'}; border-radius: 0; font-size: ${mobile ? '11px' : '11px'};
                    height: ${mobile ? '35vh' : '300px'}; overflow: auto; white-space: pre-wrap; word-break: break-word;
                    margin: 0 0 8px 0; color: ${p.text}; border: 1px solid ${p.border}; -webkit-overflow-scrolling: touch;">
          <span style="color: ${p.textSubtle};">Loading Docker logs...</span>
        </pre>

        <!-- Network Analysis Section -->
        <div id="network-analysis-section" style="margin-top: 8px; display: ${mobile ? 'none' : 'block'};">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; background: ${p.surfaceMuted}; padding: ${mobile ? '10px' : '6px 8px'};">
            <span style="font-size: ${mobile ? '14px' : '12px'}; color: ${p.textMuted}; font-weight: 500;">🔍 Network Analysis</span>
            <button id="refresh-network-btn" style="padding: ${mobile ? '10px 12px' : '4px 8px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: transparent; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '13px' : '10px'}; white-space: nowrap;
                    min-height: ${mobile ? '36px' : 'auto'};">
              Refresh
            </button>
          </div>
          <div id="network-analysis-content" style="background: ${p.surfaceCode}; padding: ${mobile ? '10px' : '10px'}; border-radius: 0; font-size: ${mobile ? '11px' : '10px'};
                      max-height: ${mobile ? '15vh' : '200px'}; overflow: auto; white-space: pre-wrap; word-break: break-word;
                      margin: 0; color: ${p.textSubtle}; border: 1px solid ${p.border}; -webkit-overflow-scrolling: touch;">
            Click "Refresh" to load network analysis
          </div>
        </div>
      </div>

      <!-- Frontend Browser Logs Panel -->
      <div id="panel-frontend" style="margin-bottom: 8px; display: ${initialTab === 'frontend' ? 'block' : 'none'};">
        <!-- Compact Controls Row -->
        <div style="display: flex; flex-direction: ${mobile ? 'column' : 'row'}; flex-wrap: wrap; gap: ${mobile ? '10px' : '6px'}; margin-bottom: 6px; align-items: ${mobile ? 'stretch' : 'center'}; background: ${p.surfaceMuted}; padding: ${mobile ? '8px' : '6px 8px'}; border-left: 2px solid #3b82f6;">
          <div style="display: flex; gap: ${mobile ? '10px' : '6px'}; align-items: center; flex-wrap: wrap; ${mobile ? 'justify-content: space-between;' : ''}">
            <span style="font-size: ${mobile ? '14px' : '12px'}; color: ${p.textMuted}; font-weight: 500;">Browser Console</span>
            <span style="font-size: ${mobile ? '12px' : '10px'}; color: ${p.textSubtle};">
              ${errorCount > 0 ? `${errorCount} error${errorCount !== 1 ? 's' : ''}` : ''}${errorCount > 0 && warningCount > 0 ? ', ' : ''}${warningCount > 0 ? `${warningCount} warning${warningCount !== 1 ? 's' : ''}` : ''}${logCount === 0 ? 'no issues' : ''}
            </span>
            ${mobile ? '' : `<div style="width: 1px; height: 16px; background: ${p.border}; margin: 0 2px;"></div>`}
            <select id="frontend-log-level" style="padding: ${mobile ? '10px 12px' : '3px 6px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: ${p.surfaceInput}; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; min-height: ${mobile ? '38px' : 'auto'};">
              <option value="all" ${errorCount === 0 && warningCount === 0 ? 'selected' : ''}>All</option>
              <option value="error" ${errorCount > 0 ? 'selected' : ''}>ERROR</option>
              <option value="warn" ${errorCount === 0 && warningCount > 0 ? 'selected' : ''}>WARNING</option>
              <option value="log">DEBUG</option>
            </select>
          </div>
          <div style="display: flex; gap: ${mobile ? '8px' : '4px'}; ${mobile ? 'width: 100%;' : 'margin-left: auto;'}">
            ${logCount === 0 ? `
              <button id="test-capture-btn" style="padding: ${mobile ? '12px 16px' : '3px 8px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                      background: transparent; color: ${p.textMuted}; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; white-space: nowrap;
                      min-height: ${mobile ? '38px' : 'auto'}; flex: ${mobile ? '1' : 'none'};">
                Test
              </button>
            ` : ''}
            <button id="refresh-browser-logs" style="padding: ${mobile ? '12px 16px' : '3px 8px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: transparent; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; white-space: nowrap;
                    min-height: ${mobile ? '38px' : 'auto'}; flex: ${mobile ? '1' : 'none'};">
              Refresh
            </button>
            <div style="position: relative; display: inline-block;">
              <button id="clear-dropdown-btn" style="padding: ${mobile ? '12px 16px' : '6px 10px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                      background: transparent; color: #f59e0b; cursor: pointer; font-size: ${mobile ? '14px' : '12px'}; white-space: nowrap;
                      min-height: ${mobile ? '38px' : 'auto'}; flex: ${mobile ? '1' : 'none'}; display: flex; align-items: center; gap: 4px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                <span id="clear-dropdown-text">Clear</span> ▼
              </button>
              <div id="clear-dropdown-menu" style="display: none; position: absolute; top: 100%; right: 0; margin-top: 4px;
                      background: ${p.surface}; border: 1px solid ${p.borderStrong}; min-width: 160px; z-index: 1000;">
                <button id="clear-console-btn" style="width: 100%; padding: ${mobile ? '12px 16px' : '8px 12px'}; border: none;
                        background: transparent; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; text-align: left;
                        border-bottom: 1px solid ${p.border}; transition: background 0.2s;">
                  Clear Console
                </button>
                <button id="clear-cache-btn" style="width: 100%; padding: ${mobile ? '12px 16px' : '8px 12px'}; border: none;
                        background: transparent; color: #f59e0b; cursor: pointer; font-size: ${mobile ? '14px' : '11px'}; text-align: left;
                        transition: background 0.2s; display: flex; align-items: center; gap: 6px;" title="Clear all browser cache and reload">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  Clear Cache & Reload
                </button>
              </div>
            </div>
            <button id="copy-browser-logs" style="padding: ${mobile ? '12px 16px' : '6px 10px'}; border-radius: 0; border: 1px solid ${p.borderStrong};
                    background: transparent; color: ${p.text}; cursor: pointer; font-size: ${mobile ? '14px' : '12px'}; white-space: nowrap;
                    min-height: ${mobile ? '38px' : 'auto'}; flex: ${mobile ? '1' : 'none'}; display: flex; align-items: center; justify-content: center;">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
          </div>
        </div>

        <pre id="browser-logs-content" style="background: ${p.surfaceCode}; padding: ${mobile ? '10px' : '10px'}; border-radius: 0; font-size: ${mobile ? '11px' : '11px'};
                    height: ${mobile ? '40vh' : '400px'}; overflow: auto; white-space: pre-wrap; word-break: break-word; color: ${p.text};
                    margin: 0; border: 1px solid ${p.border}; -webkit-overflow-scrolling: touch;">${logCount > 0 ? colorizeLogs(errors) : `<span style="color: ${p.textSubtle};">No errors or warnings captured</span>`}</pre>
      </div>

        <!-- Additional Context Section - Flexible height on mobile -->
        <div style="${mobile ? 'display: flex; flex-direction: column; flex: 1; min-height: 0; margin-top: 8px;' : ''}">
          <label style="display: block; margin-bottom: 4px; font-size: ${mobile ? '12px' : '10px'}; color: ${p.textMuted}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; flex-shrink: 0;">
            💬 Additional Context
          </label>
          <textarea id="debug-context" style="width: 100%; ${mobile ? 'flex: 1; resize: none; min-height: 120px;' : 'min-height: 50px; resize: vertical;'} background: ${p.surfaceInput};
                    border: 1px solid ${p.borderStrong}; border-radius: 0; padding: ${mobile ? '10px' : '8px'}; color: ${p.text};
                    font-size: ${mobile ? '13px' : '12px'}; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    transition: border-color 0.2s, box-shadow 0.2s; outline: none;"
                    placeholder="Optional context..."
                    onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59, 130, 246, 0.1)';"
                    onblur="this.style.borderColor='${p.borderStrong}'; this.style.boxShadow='none';"></textarea>
          <div style="margin-top: 2px; font-size: ${mobile ? '10px' : '9px'}; color: ${p.textMuted}; flex-shrink: 0;">
            Optional: Help the AI understand the context
          </div>
        </div>

        <div id="debug-result" style="display: none; padding: ${mobile ? '14px' : '12px'}; border-radius: 0; margin-bottom: 8px; font-size: ${mobile ? '14px' : '12px'}; border-left: 3px solid;"></div>
      </div>
      <!-- END SCROLLABLE CONTENT -->

      <!-- FOOTER (Always visible) -->
      <div style="flex-shrink: 0;">
        <div id="debug-submit-hint" style="display: ${submitDisabled ? 'block' : 'none'}; font-size: ${mobile ? '11px' : '10px'}; color: ${p.textMuted}; padding: 4px 0 6px 0; text-align: ${mobile ? 'center' : 'right'};">
          ${t('bugTracker.submitDisabledHint', 'Report Bug is enabled only when the browser console contains an ERROR.')}
        </div>
        <div style="display: flex; gap: ${mobile ? '8px' : '10px'}; justify-content: ${mobile ? 'stretch' : 'flex-end'}; flex-direction: row; padding-top: 6px; border-top: 1px solid ${p.border};">
        <button id="debug-cancel" style="padding: ${mobile ? '12px 10px' : '10px 20px'}; border-radius: 0; border: 1px solid ${p.cancelBorder};
                background: ${p.cancelGradient}; color: ${p.cancelText}; cursor: pointer; font-size: ${mobile ? '14px' : '13px'}; font-weight: 500;
                min-height: ${mobile ? '44px' : 'auto'}; flex: ${mobile ? '1' : 'none'}; transition: all 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.08);"
                onmouseover="this.style.background='${p.cancelGradientHover}'; this.style.borderColor='${p.cancelBorderHover}'; this.style.transform='translateY(-1px)'; this.style.boxShadow='0 4px 8px rgba(0,0,0,0.15)';"
                onmouseout="this.style.background='${p.cancelGradient}'; this.style.borderColor='${p.cancelBorder}'; this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(0,0,0,0.08)';">
          ✕ ${t('bugTracker.cancel', 'Cancel')}
        </button>
        <button id="debug-submit" ${submitDisabled ? 'disabled' : ''} style="padding: ${mobile ? '12px 10px' : '10px 20px'}; border-radius: 0; border: none;
                background: ${submitDisabled ? 'linear-gradient(135deg, #4b1d1d 0%, #3a1414 100%)' : 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)'};
                color: ${submitDisabled ? '#9ca3af' : '#fff'}; cursor: ${submitDisabled ? 'not-allowed' : 'pointer'}; font-size: ${mobile ? '14px' : '13px'}; font-weight: 600;
                opacity: ${submitDisabled ? '0.6' : '1'};
                min-height: ${mobile ? '44px' : 'auto'}; flex: ${mobile ? '1' : 'none'}; transition: all 0.2s; box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);"
                ${submitDisabled ? '' : `onmouseover="this.style.background='linear-gradient(135deg, #b91c1c 0%, #991b1b 100%)'; this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 16px rgba(220, 38, 38, 0.5)';" onmouseout="this.style.background='linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)'; this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 12px rgba(220, 38, 38, 0.4)';"`}>
          🐞 ${t('bugTracker.reportBug', 'Report Bug')}
        </button>
        </div>
      </div>
      <!-- END FOOTER -->
    </div>
  `;

  modalElement.id = 'admin-debug-modal-standalone';

  // Ensure modal is appended AFTER any existing Radix portals (higher in DOM = on top)
  document.body.appendChild(modalElement);

  // Also re-append button to keep it on top of everything
  if (buttonElement) {
    document.body.appendChild(buttonElement);
  }

  // Tab switching - add touch support for mobile
  const tabs = modalElement.querySelectorAll('.repo-tab');
  const panelBackend = document.getElementById('panel-backend');
  const panelFrontend = document.getElementById('panel-frontend');

  const handleTabSwitch = (tab: Element) => {
    const target = (tab as HTMLElement).dataset.target;
    const hiddenInput = document.getElementById('target-repo-value') as HTMLInputElement;
    if (hiddenInput) hiddenInput.value = target || 'backend';

    // Update tab styles using the modal's resolved palette
    tabs.forEach((t) => {
      const el = t as HTMLElement;
      const isActive = el.dataset.target === target;
      el.style.background = isActive ? p.tabActiveBg : 'transparent';
      el.style.color = isActive ? p.tabActiveText : p.tabIdleText;
      el.style.borderBottom = isActive ? `2px solid ${p.tabActiveText}` : '2px solid transparent';
    });

    // Show/hide panels
    if (panelBackend && panelFrontend) {
      if (target === 'backend') {
        panelBackend.style.display = 'block';
        panelFrontend.style.display = 'none';
      } else if (target === 'frontend') {
        panelBackend.style.display = 'none';
        panelFrontend.style.display = 'block';
      }
    }

    // Submit button gating depends on the active tab — Frontend uses the
    // browser console error count, Backend uses the Docker log ERROR count.
    refreshSubmitState();
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => handleTabSwitch(tab));
    // Add touch support for mobile - no preventDefault to allow scrolling
    tab.addEventListener('touchend', (_e) => {
      handleTabSwitch(tab);
    }, { passive: true });
  });

  // Event listeners - add both click and touchend for mobile compatibility
  const addTouchSafeListener = (id: string, handler: () => void, shouldPreventDefault = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', handler);
    // Add touchend handler for mobile
    el.addEventListener('touchend', (e) => {
      // Only preventDefault if explicitly needed (e.g., for modal close)
      // Otherwise let browser handle default touch behavior (scrolling, etc.)
      if (shouldPreventDefault) {
        e.preventDefault();
        e.stopPropagation();
      }
      handler();
    }, { passive: !shouldPreventDefault });
  };

  addTouchSafeListener('debug-cancel', hideModal);
  addTouchSafeListener('debug-submit', submitAutofix);

  // Modal backdrop click/touch to close
  modalElement.addEventListener('click', (e) => {
    if (e.target === modalElement) hideModal();
  });
  modalElement.addEventListener('touchend', (e) => {
    if (e.target === modalElement) {
      e.preventDefault();
      hideModal();
    }
  }, { passive: false });

  // Copy button handlers - use touch-safe listeners for mobile
  let backendLogsData = '';

  addTouchSafeListener('copy-backend-logs', () => {
    const text = backendLogsData || 'No Docker logs available';
    navigator.clipboard.writeText('please fix this bug:\n\n=== DOCKER LOGS ===\n' + text);
    const btn = document.getElementById('copy-backend-logs');
    if (btn) {
      const icon = btn.querySelector('svg');
      if (icon) {
        icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      }
      setTimeout(() => {
        if (icon) {
          icon.innerHTML = '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
        }
      }, 2000);
    }
  });

  addTouchSafeListener('copy-browser-logs', () => {
    // Dynamically fetch current logs every time Copy is clicked
    const errors = consoleErrorCapture.formatForSubmission();
    const logCount = consoleErrorCapture.getLogCount();

    const logLevelSelect = document.getElementById('frontend-log-level') as HTMLSelectElement;
    const currentFilter = logLevelSelect?.value || 'all';
    let text = logCount > 0 ? errors : 'No browser logs captured';

    // If using a specific filter (not "all"), copy with inclusive filtering
    // ERROR → includes ERROR + WARN + LOG, WARN → includes WARN + LOG, etc.
    if (currentFilter !== 'all') {
      text = filterFrontendLogsForCopy(text, currentFilter);
      // If no logs match the filter, show a message
      if (text.startsWith('No')) {
        text = `No ${currentFilter.toUpperCase()} logs found`;
      }
    }

    // Use "please investigate" for LOG level, "please fix this bug" for errors/warnings
    const prefix = currentFilter === 'log' ? 'please investigate:' : 'please fix this bug:';
    navigator.clipboard.writeText(prefix + '\n\n=== BROWSER LOGS ===\n' + text);
    const btn = document.getElementById('copy-browser-logs');
    if (btn) {
      const icon = btn.querySelector('svg');
      if (icon) {
        icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      }
      setTimeout(() => {
        if (icon) {
          icon.innerHTML = '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
        }
      }, 2000);
    }
  });

  addTouchSafeListener('test-capture-btn', () => {
    console.warn('[Test] This is a test warning from Bug Tracker');
    // Close and reopen modal to show the new warning
    hideModal();
    setTimeout(() => showAdminDebugModal(), 100);
  });

  addTouchSafeListener('copy-all-logs', async () => {
    // Dynamically fetch current logs every time Copy All is clicked
    const errors = consoleErrorCapture.formatForSubmission();
    const logCount = consoleErrorCapture.getLogCount();

    const logLevelSelect = document.getElementById('frontend-log-level') as HTMLSelectElement;
    const currentFilter = logLevelSelect?.value || 'all';

    // Auto-fetch fresh Docker logs for backend and chat containers
    let dockerText = 'No Docker logs available';
    try {
      console.log('[Bug Tracker] Copy All: Fetching Docker containers...');
      const containers = await fetchDockerContainers();
      console.log('[Bug Tracker] Copy All: Received containers:', containers.length);

      const targetContainers = containers.filter(c =>
        c.name === 'scrapalot-backend' || c.name === 'scrapalot-chat'
      );
      console.log('[Bug Tracker] Copy All: Target containers (backend/chat):', targetContainers.length);

      if (targetContainers.length > 0) {
        const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
        const tokens = authData ? JSON.parse(authData) : {};
        const accessToken = tokens.access_token || '';

        if (accessToken) {
          const hostname = window.location.hostname;
          let apiBase = 'https://api.scrapalot.app/api/v1';
          if (hostname === 'localhost' || hostname === '127.0.0.1') {
            apiBase = 'http://localhost:8091/api/v1';
          }

          console.log('[Bug Tracker] Copy All: Fetching logs from:', apiBase);

          // Fetch logs for all target containers with 500 lines for complete context
          const logPromises = targetContainers.map(async container => {
            try {
              const url = `${apiBase}/admin/debug/docker/containers/${container.id}/logs?tail_lines=100`;
              console.log(`[Bug Tracker] Copy All: Fetching logs for ${container.name} from:`, url);

              const response = await fetch(url, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` },
              });

              console.log(`[Bug Tracker] Copy All: Response for ${container.name}:`, { status: response.status, ok: response.ok });

              if (!response.ok) {
                console.warn(`[Bug Tracker] Copy All: Failed to fetch logs for ${container.name}:`, response.status);
                return '';
              }

              const data = await response.json();
              const logs = data.logs || '';
              console.log(`[Bug Tracker] Copy All: Logs length for ${container.name}:`, logs.length);

              // Format as separate section per container
              return `=== ${container.name.toUpperCase()} ===\n${logs}`;
            } catch (error) {
              console.error(`[Bug Tracker] Copy All: Error fetching logs for ${container.name}:`, error);
              return '';
            }
          });

          const allDockerLogs = await Promise.all(logPromises);
          const filteredLogs = allDockerLogs.filter(log => log.trim() !== '');

          // Only update dockerText if we actually got logs
          if (filteredLogs.length > 0) {
            dockerText = filteredLogs.join('\n\n');
            console.log('[Bug Tracker] Copy All: Successfully fetched Docker logs');
            console.log('[Bug Tracker] Copy All: Docker logs length:', dockerText.length, 'chars');
            console.log('[Bug Tracker] Copy All: Docker logs preview (first 200 chars):', dockerText.substring(0, 200));
          } else {
            console.warn('[Bug Tracker] Copy All: No Docker logs returned from any container');
          }
        } else {
          console.warn('[Bug Tracker] Copy All: No access token available');
        }
      } else {
        console.warn('[Bug Tracker] Copy All: No backend/chat containers found');
      }
    } catch (error) {
      console.error('[Bug Tracker] Copy All: Failed to fetch Docker logs:', error);
    }

    let browserText = logCount > 0 ? errors : 'No browser logs captured';

    // If using a specific filter (not "all"), copy with inclusive filtering
    // ERROR → includes ERROR + WARN + LOG, WARN → includes WARN + LOG, etc.
    if (currentFilter !== 'all') {
      browserText = filterFrontendLogsForCopy(browserText, currentFilter);
      // If no logs match the filter, show a message
      if (browserText.startsWith('No')) {
        browserText = `No ${currentFilter.toUpperCase()} logs found`;
      }
    }

    // Use "please investigate" for LOG level, "please fix this bug" for errors/warnings
    const prefix = currentFilter === 'log' ? 'please investigate:' : 'please fix this bug:';
    const allLogs = `${prefix}

=== DOCKER LOGS ===
${dockerText}

=== BROWSER LOGS ===
${browserText}`;
    void navigator.clipboard.writeText(allLogs);
    const btn = document.getElementById('copy-all-logs');
    if (btn) {
      const icon = btn.querySelector('svg');
      if (icon) {
        icon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
      }
      setTimeout(() => {
        if (icon) {
          icon.innerHTML = '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
        }
      }, 2000);
    }
  });

  // Count errors and warnings in backend logs
  const countBackendLogLevels = (logs: string): { errors: number; warnings: number } => {
    if (!logs) return { errors: 0, warnings: 0 };

    const lines = logs.split('\n');
    let errors = 0;
    let warnings = 0;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // First, try to extract the explicit log level from [LEVEL] pattern
      // Allow spaces after level: [INFO   ] or [ERROR  ]
      const levelMatch = trimmedLine.match(/^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}\s+\[(\w+)\s*\]/);
      if (levelMatch) {
        const level = levelMatch[1].toUpperCase();
        if (level === 'ERROR' || level === 'CRITICAL') {
          errors++;
        } else if (level === 'WARNING' || level === 'WARN') {
          warnings++;
        }
        continue; // Skip keyword matching if we found explicit level
      }

      // Fallback: check for error/warning keywords in the line
      const lowerLine = line.toLowerCase();

      // Skip "No [LEVEL] logs found" messages - these are NOT actual errors/warnings
      if (/no\s+(error|warn|warning|critical)\s+logs?\s+found/i.test(trimmedLine)) {
        continue;
      }

      // Skip admin debug logs with level= parameters (e.g., "level=error", "level=warn")
      // These are INFO logs about querying for errors/warnings, not actual errors/warnings
      if (/\blevel=(error|warn|warning|critical)\b/i.test(trimmedLine)) {
        continue;
      }

      // Check for error patterns (more specific to avoid false positives)
      if (/\berror\b/.test(lowerLine) || /\bexception\b/.test(lowerLine) || /\btraceback\b/.test(lowerLine) || /\bcritical\b/.test(lowerLine)) {
        errors++;
      } else if (/\bwarn(ing)?\b/.test(lowerLine)) {
        warnings++;
      }
    }

    return { errors, warnings };
  };

  // Update backend tab badges
  const updateBackendBadges = (logs: string) => {
    const { errors, warnings } = countBackendLogLevels(logs);

    // Track for submit gating — backend tab uses Docker log ERRORs, not the
    // browser console count.
    backendErrorCount = errors;

    const errorBadge = document.getElementById('backend-error-badge');
    const warnBadge = document.getElementById('backend-warn-badge');

    if (errorBadge) {
      if (errors > 0) {
        errorBadge.textContent = String(errors);
        errorBadge.style.display = 'inline-block';
      } else {
        errorBadge.style.display = 'none';
      }
    }

    if (warnBadge) {
      if (warnings > 0) {
        warnBadge.textContent = String(warnings);
        warnBadge.style.display = 'inline-block';
      } else {
        warnBadge.style.display = 'none';
      }
    }

    // Backend ERRORs may have just appeared (autofetch landed) or vanished
    // (refresh after a fix) — reflect that on the submit button immediately.
    refreshSubmitState();
  };

  // Auto-fetch backend logs for scrapalot-backend and scrapalot-chat on modal open
  const autoFetchBackendLogs = async () => {
    try {
      const containers = await fetchDockerContainers();

      // Filter only backend and chat containers
      const targetContainers = containers.filter(c =>
        c.name === 'scrapalot-backend' || c.name === 'scrapalot-chat'
      );

      if (targetContainers.length === 0) {
        console.warn('[Bug Tracker] No backend/chat containers found');
        return;
      }

      // Fetch logs for all target containers in parallel
      const logPromises = targetContainers.map(async container => {
        try {
          const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
          const tokens = authData ? JSON.parse(authData) : {};
          const accessToken = tokens.access_token || '';

          if (!accessToken) return '';

          const hostname = window.location.hostname;
          let apiBase = 'https://api.scrapalot.app/api/v1';
          if (hostname === 'localhost' || hostname === '127.0.0.1') {
            apiBase = 'http://localhost:8091/api/v1';
          }

          const response = await fetch(`${apiBase}/admin/debug/docker/containers/${container.id}/logs?tail_lines=100`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}` },
          });

          if (!response.ok) return '';

          const data = await response.json();
          return data.logs || '';
        } catch (error) {
          console.error(`[Bug Tracker] Error fetching logs for ${container.name}:`, error);
          return '';
        }
      });

      const allLogs = await Promise.all(logPromises);
      const combinedLogs = allLogs.join('\n');

      // Update badge counts
      updateBackendBadges(combinedLogs);
    } catch (error) {
      console.error('[Bug Tracker] Auto-fetch backend logs failed:', error);
    }
  };

  // Populate container dropdown
  const populateContainerDropdown = async () => {
    const containerSelect = document.getElementById('container-select') as HTMLSelectElement;
    if (!containerSelect) return;

    try {
      const containers = await fetchDockerContainers();

      containerSelect.innerHTML = '';

      if (containers.length === 0) {
        console.warn("Admin Debug: fetchDockerContainers returned empty array");
        containerSelect.innerHTML = '<option value="">No containers - check browser console (F12)</option>';
        return;
      }

      containers.forEach((container, index) => {
        const option = document.createElement('option');
        option.value = container.id;
        option.textContent = `${container.name} (${container.image})`;
        containerSelect.appendChild(option);

        // Auto-select first container
        if (index === 0) {
          containerSelect.value = container.id;
        }
      });

      // Trigger log fetch and git info after populating
      await updateDockerLogs();
      void updateGitInfo();
    } catch (error) {
      containerSelect.innerHTML = '<option value="">Error loading containers</option>';
    }
  };

  // Fetch Docker logs for selected container
  const updateDockerLogs = async () => {
    const containerSelect = document.getElementById('container-select') as HTMLSelectElement;
    const contextLinesInput = document.getElementById('backend-context-lines') as HTMLInputElement;
    const logLevelSelect = document.getElementById('backend-log-level') as HTMLSelectElement;
    const backendLogsEl = document.getElementById('backend-logs-content');

    if (!backendLogsEl) return;

    const containerId = containerSelect?.value || '';
    if (!containerId) {
      backendLogsEl.innerHTML = '<span style="color: #666;">Select a container to view logs</span>';
      return;
    }

    const tailLines = contextLinesInput ? parseInt(contextLinesInput.value) : 200;
    const logLevel = logLevelSelect ? logLevelSelect.value : 'all';

    try {
      const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
      const tokens = authData ? JSON.parse(authData) : {};
      const accessToken = tokens.access_token || '';

      if (!accessToken) {
        backendLogsEl.innerHTML = '<span style="color: #ef4444;">Not authenticated</span>';
        return;
      }

      const hostname = window.location.hostname;
      let apiBase = 'https://api.scrapalot.app/api/v1';
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        apiBase = 'http://localhost:8091/api/v1';
      }

      const url = `${apiBase}/admin/debug/docker/containers/${containerId}/logs?tail_lines=${tailLines}&level=${logLevel}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        backendLogsEl.innerHTML = `<span style="color: #ef4444;">Error: HTTP ${response.status}</span>`;
        updateBackendBadges('');
        return;
      }

      const data = await response.json();
      backendLogsData = data.logs;

      // Colorize and display logs
      backendLogsEl.innerHTML = colorizeLogs(data.logs);
      backendLogsEl.scrollTop = backendLogsEl.scrollHeight;

      // Update badges
      updateBackendBadges(data.logs);
    } catch (error) {
      backendLogsEl.innerHTML = `<span style="color: #ef4444;">Error: ${error instanceof Error ? error.message : 'Unknown error'}</span>`;
      updateBackendBadges('');
    }
  };

  // Render network analysis
  const renderNetworkAnalysis = async () => {
    const networkContent = document.getElementById('network-analysis-content');
    if (!networkContent) return;

    networkContent.innerHTML = '<span style="color: #f59e0b;">Loading...</span>';

    try {
      const analysis = await fetchNetworkAnalysis();

      if (!analysis) {
        networkContent.innerHTML = '<span style="color: #ef4444;">Failed to load network analysis</span>';
        return;
      }

      let html = '';

      // Active Connections
      const activeConnections = analysis.activeConnections ?? [];
      html += '<div style="margin-bottom: 12px;"><strong style="color: #60a5fa;">🔗 Active Connections</strong><br>';
      if (activeConnections.length === 0) {
        html += '<span style="color: #666;">No active connections</span>';
      } else {
        activeConnections.slice(0, 10).forEach(conn => {
          const stateColor = conn.state === 'LISTEN' ? '#22c55e' : conn.state === 'ESTABLISHED' ? '#3b82f6' : '#888';
          html += `<div style="margin-left: 12px; font-size: 10px; color: #a3a3a3;">`;
          html += `<span style="color: ${stateColor};">${conn.state}</span> `;
          html += `${escapeHtml(conn.protocol)} ${escapeHtml(conn.localAddress)} → ${escapeHtml(conn.remoteAddress)}`;
          if (conn.program) {
            html += ` <span style="color: #666;">(${escapeHtml(conn.program)})</span>`;
          }
          html += `</div>`;
        });
        if (activeConnections.length > 10) {
          html += `<div style="margin-left: 12px; font-size: 10px; color: #666;">... and ${activeConnections.length - 10} more</div>`;
        }
      }
      html += '</div>';

      // Container Networks
      html += '<div style="margin-bottom: 12px;"><strong style="color: #60a5fa;">🌐 Container Networks</strong><br>';
      const containerNetworks = Object.values(analysis.containerNetworks ?? {});
      if (containerNetworks.length === 0) {
        html += '<span style="color: #666;">No container networks found</span>';
      } else {
        containerNetworks.forEach(net => {
          html += `<div style="margin-left: 12px; font-size: 10px; color: #a3a3a3;">`;
          html += `<strong style="color: #e5e7eb;">${escapeHtml(net.containerName)}</strong> `;
          html += `<span style="color: #666;">${escapeHtml(net.ipAddress)}</span>`;
          html += `</div>`;
        });
      }
      html += '</div>';

      // Listening Ports
      const listenPorts = analysis.listenPorts ?? [];
      html += '<div style="margin-bottom: 0;"><strong style="color: #60a5fa;">📡 Listening Ports</strong><br>';
      if (listenPorts.length === 0) {
        html += '<span style="color: #666;">No listening ports found</span>';
      } else {
        listenPorts.slice(0, 10).forEach(port => {
          html += `<div style="margin-left: 12px; font-size: 10px; color: #a3a3a3;">`;
          html += `<span style="color: #22c55e;">:${port.port}</span> `;
          html += `<span style="color: #666;">${escapeHtml(port.protocol)} ${escapeHtml(port.address)}</span>`;
          html += `</div>`;
        });
        if (listenPorts.length > 10) {
          html += `<div style="margin-left: 12px; font-size: 10px; color: #666;">... and ${listenPorts.length - 10} more</div>`;
        }
      }
      html += '</div>';

      networkContent.innerHTML = html;
    } catch (error) {
      networkContent.innerHTML = `<span style="color: #ef4444;">Error: ${error instanceof Error ? error.message : 'Unknown error'}</span>`;
    }
  };

  // Initial fetch — backend endpoints are admin-only, skip them for non-admin users.
  if (isAdminUser) {
    void populateContainerDropdown();
    void renderNetworkAnalysis();
    void autoFetchBackendLogs(); // Auto-detect errors in backend/chat containers
  }

  // Enable mouse wheel scrolling on backend logs
  const backendLogsEl = document.getElementById('backend-logs-content');
  if (backendLogsEl) {
    backendLogsEl.addEventListener('wheel', (e) => e.stopPropagation());
  }

  // Format relative date (e.g. "2h ago", "3d ago")
  const formatRelativeDate = (isoDate: string): string => {
    const now = Date.now();
    const then = new Date(isoDate).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    const diffDays = Math.floor(diffHrs / 24);
    return `${diffDays}d ago`;
  };

  // Render git info for the selected container
  const updateGitInfo = async () => {
    const gitSection = document.getElementById('git-info-section');
    const containerSelect = document.getElementById('container-select') as HTMLSelectElement;
    if (!gitSection || !containerSelect) return;

    const containerId = containerSelect.value;
    if (!containerId) {
      gitSection.style.display = 'none';
      return;
    }

    gitSection.style.display = 'block';
    gitSection.innerHTML = '<span style="color: #666;">Loading git info...</span>';

    const info = await fetchContainerGitInfo(containerId);

    if (!info) {
      gitSection.innerHTML = '<span style="color: #666;">Git info unavailable</span>';
      return;
    }

    if (!info.repo_name) {
      gitSection.style.display = 'none';
      return;
    }

    if (info.error) {
      gitSection.innerHTML = `<span style="color: #ef4444;">Git: ${escapeHtml(info.error)}</span>`;
      return;
    }

    const deployed = info.deployed_commit ? info.deployed_commit.substring(0, 7) : '?';

    if (!info.deployed_commit) {
      gitSection.innerHTML = '<span style="color: #666;">No commit tag on image</span>';
      return;
    }

    if (info.recent_commits.length === 0) {
      gitSection.innerHTML = `<span style="font-family: monospace; color: #888;">${deployed}</span> <span style="color: #666;">No GH_TOKEN</span>`;
      return;
    }

    // Build dropdown with recent commits
    const deployedColor = info.is_up_to_date ? '#22c55e' : '#f59e0b';
    const statusBadge = info.is_up_to_date
      ? `<span style="color: #22c55e; font-size: ${mobile ? '12px' : '10px'};">✓ Up to date</span>`
      : '';

    let options = '';
    for (const commit of info.recent_commits) {
      const shortSha = commit.sha.substring(0, 7);
      const msg = commit.message ? commit.message.substring(0, 40) : '';
      const relDate = commit.date ? formatRelativeDate(commit.date) : '';
      const label = `${shortSha} ${msg}${relDate ? ` (${relDate})` : ''}`;
      const defaultIdx = Math.min(3, info.recent_commits.length - 1);
      const selected = commit.sha === info.recent_commits[defaultIdx].sha ? ' selected' : '';
      options += `<option value="${escapeHtml(commit.sha)}"${selected}>${escapeHtml(label)}</option>`;
    }

    gitSection.innerHTML =
      `<div style="display: flex; ${mobile ? 'flex-direction: column; gap: 6px;' : 'flex-direction: row; align-items: center; gap: 4px; flex-wrap: wrap;'}">` +
        `<span style="font-family: monospace; color: ${deployedColor}; white-space: nowrap;">${deployed}</span>` +
        `${statusBadge}` +
        `<select id="git-commit-select" style="` +
          `font-family: monospace; font-size: ${mobile ? '14px' : '11px'}; background: #1a1a2e; color: #e0e0e0; ` +
          `border: 1px solid #333; padding: ${mobile ? '10px 12px' : '2px 4px'}; ` +
          `${mobile ? 'width: 100%;' : 'max-width: 320px;'} min-height: ${mobile ? '38px' : 'auto'};` +
        `">${options}</select>` +
        `<button id="git-compare-btn" style="background: none; border: 1px solid #333; color: #60a5fa; cursor: pointer; ` +
          `font-size: ${mobile ? '14px' : '11px'}; padding: ${mobile ? '8px 12px' : '2px 8px'}; ` +
          `${mobile ? '' : 'margin-left: 4px;'} white-space: nowrap;" ` +
          `onmouseover="this.style.background='#1e3a5f'" onmouseout="this.style.background='none'">Compare</button>` +
      `</div>`;

    // Compare button handler.
    // GitHub `/compare/{base}...{head}` requires base to be the older commit, otherwise
    // it returns total_commits=0 and an empty files array. For scrapalot-ui / -backend /
    // -gw the deployed image revision usually equals recent_commits[0] so passing
    // (selected, deployed) works. scrapalot-chat is the outlier — Python hot-reload from
    // the volume mount means the image rebuilds rarely, so `deployed_commit` can be many
    // commits behind main and every entry in the dropdown is newer. Detect that and swap.
    const commitSelect = document.getElementById('git-commit-select') as HTMLSelectElement;
    const compareBtn = document.getElementById('git-compare-btn');
    if (commitSelect && compareBtn) {
      compareBtn.addEventListener('click', () => {
        const selectedSha = commitSelect.value;
        const deployedIdx = info.recent_commits.findIndex(c => c.sha === info.deployed_commit);
        const selectedIdx = info.recent_commits.findIndex(c => c.sha === selectedSha);
        const selectedIsNewer =
          deployedIdx >= 0 && selectedIdx >= 0 && selectedIdx < deployedIdx;
        const [base, head] = selectedIsNewer
          ? [info.deployed_commit!, selectedSha]
          : [selectedSha, info.deployed_commit!];
        showDiffViewer(info.repo_name!, base, head);
      });
    }
  };

  // Backend controls event listeners
  document.getElementById('container-select')?.addEventListener('change', () => {
    updateDockerLogs();
    updateGitInfo();
  });
  document.getElementById('backend-log-level')?.addEventListener('change', updateDockerLogs);
  document.getElementById('backend-context-lines')?.addEventListener('change', updateDockerLogs);

  // Network analysis refresh button
  addTouchSafeListener('refresh-network-btn', async () => {
    const btn = document.getElementById('refresh-network-btn');
    if (btn) {
      btn.textContent = 'Loading...';
      btn.setAttribute('disabled', 'true');
    }
    await renderNetworkAnalysis();
    if (btn) {
      btn.textContent = 'Refresh';
      btn.removeAttribute('disabled');
    }
  });

  // Manual refresh button for backend - use touch-safe listener
  const refreshBackendHandler = async () => {
    const btn = document.getElementById('refresh-backend-logs');
    if (btn) {
      btn.textContent = 'Loading...';
      btn.setAttribute('disabled', 'true');
    }
    await updateDockerLogs();
    if (btn) {
      btn.textContent = 'Refresh';
      btn.removeAttribute('disabled');
    }
  };
  addTouchSafeListener('refresh-backend-logs', refreshBackendHandler);

  // Clear button for backend - use touch-safe listener
  addTouchSafeListener('clear-backend-logs', () => {
    const backendLogsEl = document.getElementById('backend-logs-content');
    if (backendLogsEl) {
      backendLogsEl.textContent = 'Logs cleared';
      backendLogsEl.style.color = '#666';
      backendLogsData = '';
    }
  });

  // Filter function for frontend logs display (exclusive - shows only selected level)
  const filterFrontendLogs = (logs: string, level: string): string => {
    if (level === 'all') return logs;

    const lines = logs.split('\n');
    const filtered: string[] = [];

    // Log entry markers that start a new log entry
    const logEntryPattern = /^\[(error|warning|warn|debug|info|log)\]/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lowerLine = line.toLowerCase();

      // Check if this line starts a new log entry
      const isNewEntry = logEntryPattern.test(line.trim());

      if (isNewEntry) {
        // Check if this entry matches our filter
        const shouldInclude =
          (level === 'error' && (lowerLine.includes('[error]') || lowerLine.includes('exception'))) ||
          (level === 'warn' && (lowerLine.includes('[warning]') || lowerLine.includes('[warn]'))) ||
          (level === 'log' && (lowerLine.includes('[debug]') || lowerLine.includes('[info]') || lowerLine.includes('[log]')));

        if (shouldInclude) {
          // Include this line and all subsequent lines until the next log entry
          filtered.push(line);
          // Add all following lines until we hit another log entry or end of array
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j];
            if (logEntryPattern.test(nextLine.trim())) {
              // Next log entry found, stop
              break;
            }
            // Include stack trace lines and continuation
            filtered.push(nextLine);
          }
        }
      }
    }

    return filtered.length > 0 ? filtered.join('\n') : `No ${level.toUpperCase()} logs found`;
  };

  // Filter function for copying (inclusive - includes selected level AND all lower priority levels)
  // ERROR → includes ERROR + WARNING + DEBUG
  // WARN → includes WARNING + DEBUG
  // LOG → includes only DEBUG
  const filterFrontendLogsForCopy = (logs: string, level: string): string => {
    if (level === 'all') return logs;

    const lines = logs.split('\n');
    const filtered: string[] = [];

    // Log entry markers that start a new log entry
    const logEntryPattern = /^\[(error|warning|warn|debug|info|log)\]/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lowerLine = line.toLowerCase();

      // Check if this line starts a new log entry
      const isNewEntry = logEntryPattern.test(line.trim());

      if (isNewEntry) {
        // Inclusive filtering: include this level and all lower priority levels
        const shouldInclude =
          (level === 'error' && (lowerLine.includes('[error]') || lowerLine.includes('[warning]') || lowerLine.includes('[warn]') || lowerLine.includes('[debug]') || lowerLine.includes('[info]') || lowerLine.includes('[log]') || lowerLine.includes('exception'))) ||
          (level === 'warn' && (lowerLine.includes('[warning]') || lowerLine.includes('[warn]') || lowerLine.includes('[debug]') || lowerLine.includes('[info]') || lowerLine.includes('[log]'))) ||
          (level === 'log' && (lowerLine.includes('[debug]') || lowerLine.includes('[info]') || lowerLine.includes('[log]')));

        if (shouldInclude) {
          // Include this line and all subsequent lines until the next log entry
          filtered.push(line);
          // Add all following lines until we hit another log entry or end of array
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j];
            if (logEntryPattern.test(nextLine.trim())) {
              // Next log entry found, stop
              break;
            }
            // Include stack trace lines and continuation
            filtered.push(nextLine);
          }
        }
      }
    }

    return filtered.length > 0 ? filtered.join('\n') : `No ${level.toUpperCase()} logs found`;
  };

  // Re-evaluate the submit button state based on the active tab's error count.
  // For Frontend tab this is the browser console error count; for Backend tab
  // it's the count parsed from the latest Docker log fetch. Called on initial
  // render, on tab switch, and whenever logs are refreshed / filtered.
  const refreshSubmitState = () => {
    const submitBtn = document.getElementById('debug-submit') as HTMLButtonElement | null;
    const hint = document.getElementById('debug-submit-hint');
    if (!submitBtn) return;
    const disabled = isCurrentTabErrorFree();
    submitBtn.disabled = disabled;
    submitBtn.style.opacity = disabled ? '0.6' : '1';
    submitBtn.style.cursor = disabled ? 'not-allowed' : 'pointer';
    submitBtn.style.background = disabled
      ? 'linear-gradient(135deg, #4b1d1d 0%, #3a1414 100%)'
      : 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)';
    submitBtn.style.color = disabled ? '#9ca3af' : '#fff';
    if (hint) hint.style.display = disabled ? 'block' : 'none';
  };

  // Update frontend logs display
  const updateFrontendLogs = () => {
    const logLevelSelect = document.getElementById('frontend-log-level') as HTMLSelectElement;
    const browserLogsEl = document.getElementById('browser-logs-content');

    if (!browserLogsEl) return;

    const logLevel = logLevelSelect ? logLevelSelect.value : 'all';
    const freshErrors = consoleErrorCapture.formatForSubmission();

    if (freshErrors) {
      const filtered = filterFrontendLogs(freshErrors, logLevel);
      // Colorize logs before displaying
      browserLogsEl.innerHTML = colorizeLogs(filtered);
    } else {
      browserLogsEl.textContent = 'No errors or warnings captured';
      browserLogsEl.style.color = '#666';
    }

    // Auto-scroll to bottom after DOM update
    setTimeout(() => {
      browserLogsEl.scrollTop = browserLogsEl.scrollHeight;
    }, 0);

    // The user might have hit refresh after fixing the bug repro — the submit
    // button must follow the live error count, not the count from modal open.
    refreshSubmitState();
  };

  // Enable mouse wheel scrolling on frontend logs
  const browserLogsEl = document.getElementById('browser-logs-content');
  if (browserLogsEl) {
    browserLogsEl.addEventListener('wheel', (e) => e.stopPropagation());
  }

  // Frontend controls event listeners
  document.getElementById('frontend-log-level')?.addEventListener('change', updateFrontendLogs);

  // Apply initial filter based on pre-selected dropdown value
  updateFrontendLogs();

  // Refresh button for frontend - use touch-safe listener
  addTouchSafeListener('refresh-browser-logs', () => {
    const btn = document.getElementById('refresh-browser-logs');
    if (btn) {
      btn.textContent = 'Loading...';
      btn.setAttribute('disabled', 'true');
    }
    updateFrontendLogs();
    if (btn) {
      setTimeout(() => {
        btn.textContent = 'Refresh';
        btn.removeAttribute('disabled');
      }, 300);
    }
  });

  // Clear cache button - aggressive cache cleaning with immediate reload
  addTouchSafeListener('clear-cache-btn', async () => {
    const btn = document.getElementById('clear-cache-btn');
    if (btn) {
      btn.textContent = 'Clearing...';
      btn.setAttribute('disabled', 'true');
    }

    try {
      // 1. Save critical data BEFORE clearing (use correct storage keys from storage-utils.ts)
      const authTokens = localStorage.getItem('auth_tokens');
      const sessionAuthTokens = sessionStorage.getItem('auth_tokens');
      const uiState = localStorage.getItem('scrapalot_ui_state');  // Contains currentWorkspace + cachedUser
      const userPrefs = localStorage.getItem('scrapalot_user_prefs');

      // 2. Clear localStorage
      localStorage.clear();

      // 3. Restore critical data
      if (authTokens) {
        localStorage.setItem('auth_tokens', authTokens);
      }
      if (uiState) {
        localStorage.setItem('scrapalot_ui_state', uiState);  // Restore workspace + user
      }
      if (userPrefs) {
        localStorage.setItem('scrapalot_user_prefs', userPrefs);
      }

      // 4. Clear sessionStorage (except auth tokens)
      sessionStorage.clear();
      if (sessionAuthTokens) {
        sessionStorage.setItem('auth_tokens', sessionAuthTokens);
      }

      // 3. Clear IndexedDB (if exists)
      if (window.indexedDB) {
        const databases = await window.indexedDB.databases();
        for (const db of databases) {
          if (db.name) {
            window.indexedDB.deleteDatabase(db.name);
          }
        }
      }

      // 4. Clear Service Worker cache
      if ('serviceWorker' in navigator && 'caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
      }

      // 5. Unregister Service Workers
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      }

      // Show success message briefly before reload
      if (btn) {
        btn.textContent = 'Cleared!';
        btn.style.background = '#22c55e';
        btn.style.color = '#fff';
      }

      // Dispatch custom event to notify all contexts to refresh their data
      // This ensures collections, workspaces, and other data are re-fetched from server
      window.dispatchEvent(new CustomEvent('scrapalot:cache-cleared', { detail: { timestamp: Date.now() } }));

      // 6. Force reload to ensure all cached assets are refreshed
      // Give browser time to save localStorage changes (1000ms)
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      console.error('Cache clear error:', error);
      if (btn) {
        btn.textContent = '❌ Error';
        btn.style.background = '#ef4444';
        btn.style.color = '#fff';
        btn.removeAttribute('disabled');
        setTimeout(() => {
          btn.textContent = '🗑️ Cache';
          btn.style.background = '';
          btn.style.color = '';
        }, 2000);
      }
    }
  });

  // Dropdown functionality
  const dropdownBtn = document.getElementById('clear-dropdown-btn');
  const dropdownMenu = document.getElementById('clear-dropdown-menu');

  // Toggle dropdown
  const toggleDropdown = () => {
    if (dropdownMenu) {
      const isVisible = dropdownMenu.style.display === 'block';
      dropdownMenu.style.display = isVisible ? 'none' : 'block';
    }
  };

  // Close dropdown
  const closeDropdown = () => {
    if (dropdownMenu) {
      dropdownMenu.style.display = 'none';
    }
  };

  // Dropdown button click handler
  if (dropdownBtn) {
    dropdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });

    // Touch support
    dropdownBtn.addEventListener('touchend', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleDropdown();
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (dropdownBtn && dropdownMenu && !dropdownBtn.contains(e.target as Node) && !dropdownMenu.contains(e.target as Node)) {
      closeDropdown();
    }
  });

// Dropdown item hover effects
  const clearConsoleBtn = document.getElementById('clear-console-btn');
  const clearCacheBtnDropdown = document.getElementById('clear-cache-btn');

  if (clearConsoleBtn) {
    clearConsoleBtn.addEventListener('mouseenter', () => {
      clearConsoleBtn.style.background = '#2a2a2a';
    });
    clearConsoleBtn.addEventListener('mouseleave', () => {
      clearConsoleBtn.style.background = 'transparent';
    });

    // Clear console button handler
    addTouchSafeListener('clear-console-btn', () => {
      // Clear the actual browser logs capture
      if (typeof consoleErrorCapture.clear === 'function') {
        consoleErrorCapture.clear();
      }
      // Refresh the display to show empty state
      updateFrontendLogs();
      // Close dropdown
      closeDropdown();
    });
  }

  if (clearCacheBtnDropdown) {
    clearCacheBtnDropdown.addEventListener('mouseenter', () => {
      clearCacheBtnDropdown.style.background = '#2a2a2a';
    });
    clearCacheBtnDropdown.addEventListener('mouseleave', () => {
      clearCacheBtnDropdown.style.background = 'transparent';
    });

    // Update the existing clear-cache-btn handler to close dropdown
    clearCacheBtnDropdown.addEventListener('click', () => {
      closeDropdown();
    });
  }
}

function hideModal(): void {
  if (modalElement) {
    modalElement.remove();
    modalElement = null;
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Colorize log lines by level (ERROR=red, WARN/WARNING=orange, LOG=blue, others=default)
 * Handles multi-line entries: stack traces inherit the color of their parent entry
 * Returns HTML string with <span> tags for coloring
 */
function colorizeLogs(logs: string, defaultColor = '#a3a3a3'): string {
  if (!logs) return '';

  const lines = logs.split('\n');
  const colorized: string[] = [];

  // Track current entry color for multi-line entries (stack traces)
  let currentColor = defaultColor;

  // Patterns that indicate a NEW log entry (not a continuation)
  const frontendEntryPattern = /^\[(ERROR|WARNING|WARN|DEBUG|INFO|LOG)\]/i;
  const backendEntryPattern = /^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}/; // Timestamp start
  const separatorPattern = /^-{3,}$/; // Entry separator like "---"

  for (const line of lines) {
    const escaped = escapeHtml(line);
    const trimmedLine = line.trim();

    // Entry separator - reset to dim gray
    if (separatorPattern.test(trimmedLine)) {
      currentColor = '#555';
      colorized.push(`<span style="color: ${currentColor};">${escaped}</span>`);
      continue;
    }

    // Check for frontend log entry start: [ERROR], [WARNING], [DEBUG], [INFO]
    const frontendMatch = trimmedLine.match(frontendEntryPattern);
    if (frontendMatch) {
      const level = frontendMatch[1].toUpperCase();
      if (level === 'ERROR') {
        currentColor = '#ef4444'; // red
      } else if (level === 'WARNING' || level === 'WARN') {
        currentColor = '#f59e0b'; // orange
      } else if (level === 'DEBUG' || level === 'INFO' || level === 'LOG') {
        currentColor = '#6b7280'; // gray
      }
      colorized.push(`<span style="color: ${currentColor};">${escaped}</span>`);
      continue;
    }

    // Check for backend log entry start (has timestamp)
    if (backendEntryPattern.test(trimmedLine)) {
      // First, try to extract the explicit log level from [LEVEL] pattern
      // Allow spaces after level: [INFO   ] or [ERROR  ]
      const levelMatch = trimmedLine.match(/^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}\s+\[(\w+)\s*\]/);
      if (levelMatch) {
        const level = levelMatch[1].toUpperCase();
        if (level === 'ERROR' || level === 'CRITICAL') {
          currentColor = '#ef4444'; // red
        } else if (level === 'WARNING' || level === 'WARN') {
          currentColor = '#f59e0b'; // orange
        } else if (level === 'INFO' || level === 'DEBUG') {
          currentColor = '#6b7280'; // gray
        } else {
          currentColor = defaultColor;
        }
      } else {
        // Fallback: check for error/warning keywords in the line
        const lowerLine = line.toLowerCase();
        if (/\b(error|critical)\b/.test(lowerLine) || /\bexception\b/.test(lowerLine) || /\btraceback\b/.test(lowerLine)) {
          currentColor = '#ef4444'; // red
        } else if (/\bwarn(ing)?\b/.test(lowerLine)) {
          currentColor = '#f59e0b'; // orange
        } else if (/\b(info|debug)\b/.test(lowerLine)) {
          currentColor = '#6b7280'; // gray
        } else {
          currentColor = defaultColor;
        }
      }
      colorized.push(`<span style="color: ${currentColor};">${escaped}</span>`);
      continue;
    }

    // Continuation line (stack trace, etc.) - keep current color
    // But if this line itself contains strong error indicators, highlight it
    const lowerLine = line.toLowerCase();
    if (currentColor === defaultColor) {
      // Not in an entry yet, check for standalone error/warning indicators
      if (/\b(error|exception|traceback|critical)\b/.test(lowerLine)) {
        colorized.push(`<span style="color: #ef4444;">${escaped}</span>`);
        continue;
      } else if (/\bwarn(ing)?\b/.test(lowerLine)) {
        colorized.push(`<span style="color: #f59e0b;">${escaped}</span>`);
        continue;
      }
    }

    // Use current entry color for continuation lines
    colorized.push(`<span style="color: ${currentColor};">${escaped}</span>`);
  }

  return colorized.join('\n');
}

async function submitAutofix(): Promise<void> {
  const submitBtn = document.getElementById('debug-submit') as HTMLButtonElement;
  const resultDiv = document.getElementById('debug-result') as HTMLDivElement;
  const contextInput = document.getElementById('debug-context') as HTMLTextAreaElement;
  const targetRepoInput = document.getElementById('target-repo-value') as HTMLInputElement;

  if (!submitBtn || !resultDiv) return;

  // Defensive: reject submission if there is no captured ERROR in the active
  // tab's logs. Submit button is rendered disabled in this case but a
  // determined user could re-enable it via DevTools — refuse the call here
  // too so we never burn a CI run on an empty report.
  const targetRepo = targetRepoInput?.value || 'frontend';
  const errorBadgeEl = document.getElementById('backend-error-badge');
  const backendHasErrors = !!errorBadgeEl && errorBadgeEl.style.display !== 'none' && parseInt(errorBadgeEl.textContent || '0', 10) > 0;
  if (targetRepo === 'frontend' && consoleErrorCapture.getErrorCount() === 0) {
    return;
  }
  if (targetRepo === 'backend' && !backendHasErrors) {
    return;
  }

  const triggeringLabel = (() => {
    try {
      const out = i18n.t('bugTracker.triggering', { defaultValue: 'Triggering...' });
      return typeof out === 'string' ? out : 'Triggering...';
    } catch {
      return 'Triggering...';
    }
  })();

  submitBtn.disabled = true;
  submitBtn.textContent = triggeringLabel;

  try {
    const errors = consoleErrorCapture.formatForSubmission();
    const context = contextInput?.value || '';

    // Get auth token
    const authData = sessionStorage.getItem('auth_tokens') || localStorage.getItem('auth_tokens');
    const tokens = authData ? JSON.parse(authData) : {};
    const accessToken = tokens.access_token || '';

    // Determine API base URL
    const hostname = window.location.hostname;
    let apiBase = 'https://api.scrapalot.app/api/v1';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      apiBase = 'http://localhost:8090/api/v1';
    }

    const response = await fetch(`${apiBase}/admin/debug/trigger-autofix`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        browser_errors: errors,
        error_context: context,
        target_repo: targetRepo,
      }),
    });

    const data = await response.json();

    // Determine which repo to link to based on target
    const repoName = targetRepo === 'frontend' ? 'scrapalot-ui' : 'scrapalot-chat';
    const actionsUrl = `https://github.com/sime2408/${repoName}/actions`;

    resultDiv.style.display = 'block';
    if (data.success) {
      resultDiv.style.background = '#14532d';
      resultDiv.style.border = '1px solid #22c55e';
      resultDiv.innerHTML = `
        <strong style="color: #22c55e;">Success!</strong>
        <p style="margin: 8px 0 0 0; color: #86efac;">${data.message}</p>
        <a href="${actionsUrl}" target="_blank"
           style="color: #60a5fa; margin-top: 8px; display: inline-block;">
          View GitHub Actions (${repoName}) →
        </a>
      `;
      submitBtn.textContent = 'Done';
    } else {
      resultDiv.style.background = '#450a0a';
      resultDiv.style.border = '1px solid #ef4444';
      resultDiv.innerHTML = `
        <strong style="color: #ef4444;">Failed</strong>
        <p style="margin: 8px 0 0 0; color: #fca5a5;">${data.message || 'Unknown error'}</p>
      `;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Retry';
    }
  } catch (error) {
    resultDiv.style.display = 'block';
    resultDiv.style.background = '#450a0a';
    resultDiv.style.border = '1px solid #ef4444';
    resultDiv.innerHTML = `
      <strong style="color: #ef4444;">Error</strong>
      <p style="margin: 8px 0 0 0; color: #fca5a5;">${error instanceof Error ? error.message : 'Network error'}</p>
    `;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Retry';
  }
}

/**
 * Make button draggable. Track actual movement distance to distinguish taps from drags.
 */
let dragMoved = false;
function setupDrag(button: HTMLButtonElement): void {
  let startX = 0;
  let startY = 0;

  const onMouseDown = (e: MouseEvent | TouchEvent) => {
    isDragging = true;
    dragMoved = false;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    startX = clientX;
    startY = clientY;
    const rect = button.getBoundingClientRect();
    dragOffset.x = clientX - rect.left;
    dragOffset.y = clientY - rect.top;
    button.style.cursor = 'grabbing';
  };

  const onMouseMove = (e: MouseEvent | TouchEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    // Mark as moved if distance > 5px
    if (Math.abs(clientX - startX) > 5 || Math.abs(clientY - startY) > 5) {
      dragMoved = true;
    }

    const newX = clientX - dragOffset.x;
    const newY = clientY - dragOffset.y;

    // Constrain to viewport
    const maxX = window.innerWidth - button.offsetWidth;
    const maxY = window.innerHeight - button.offsetHeight;

    button.style.left = `${Math.max(0, Math.min(newX, maxX))}px`;
    button.style.top = `${Math.max(0, Math.min(newY, maxY))}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
  };

  const onMouseUp = () => {
    isDragging = false;
    button.style.cursor = 'grab';
  };

  button.addEventListener('mousedown', onMouseDown);
  button.addEventListener('touchstart', onMouseDown, { passive: false });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('touchmove', onMouseMove, { passive: false });
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('touchend', onMouseUp);
}

/**
 * Create the debug button
 */
function createButton(): void {
  if (buttonElement) return;

  // Check if document.body is available (DOM ready)
  if (!document.body) {
    console.warn('[Bug Tracker] document.body not ready, skipping button creation');
    return;
  }

  buttonElement = document.createElement('button');
  buttonElement.id = 'admin-debug-btn-standalone';
  buttonElement.style.cssText = BUTTON_STYLES;
  buttonElement.innerHTML = BUTTON_ICON;
  buttonElement.title = 'Trigger Auto-fix Workflow (Admin)';

  // Hover effect
  buttonElement.addEventListener('mouseenter', () => {
    if (!isDragging) {
      buttonElement!.style.backgroundColor = BUTTON_HOVER_BG;
      buttonElement!.style.transform = 'scale(1.1)';
      buttonElement!.style.opacity = '1';
    }
  });
  buttonElement.addEventListener('mouseleave', () => {
    buttonElement!.style.backgroundColor = '#dc2626';
    buttonElement!.style.transform = 'scale(1)';
    buttonElement!.style.opacity = '0.5';
  });

  // Touch effect (for mobile)
  buttonElement.addEventListener('touchstart', () => {
    buttonElement!.style.opacity = '1';
  });
  buttonElement.addEventListener('touchend', () => {
    buttonElement!.style.opacity = '0.5';
  });

  // Click handler (only if not dragging)
  buttonElement.addEventListener('click', () => {
    if (!dragMoved) {
      void showAdminDebugModal();
    }
  });

  setupDrag(buttonElement);
  document.body.appendChild(buttonElement);
}

function removeButton(): void {
  if (buttonElement) {
    buttonElement.remove();
    buttonElement = null;
  }
}

/**
 * Update visibility based on admin status and current route.
 * The standalone button is no longer created — admin debug is now
 * triggered from the React FloatingToolbar dock. This function only
 * keeps the modal z-order observer alive for portal re-appending.
 */
function updateVisibility(): void {
  isAdmin = checkIsAdmin();

  // Remove legacy standalone button if it exists
  if (buttonElement) {
    removeButton();
  }
}

/**
 * Ensure the button and modal stay on top of Radix UI portals and PDF viewer
 * by re-appending them when new direct children are added to body
 */
function setupPortalObserver(): void {
  const observer = new MutationObserver((mutations) => {
    // Only check direct children of body to avoid performance issues
    let shouldReappend = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.parentElement === document.body) {
          // Check for Radix portals or PDF viewer portal
          if (
            node.hasAttribute('data-radix-portal') ||
            node.id === 'pdf-viewer-portal'
          ) {
            shouldReappend = true;
            break;
          }
        }
      }
      if (shouldReappend) break;
    }

    if (shouldReappend) {
      // Use requestAnimationFrame to avoid blocking
      requestAnimationFrame(() => {
        if (buttonElement && buttonElement.parentElement === document.body) {
          document.body.appendChild(buttonElement);
        }
        if (modalElement && modalElement.parentElement === document.body) {
          document.body.appendChild(modalElement);
        }
      });
    }
  });

  observer.observe(document.body, { childList: true });
}

/**
 * Initialize the standalone debug button
 * Call this BEFORE React starts
 */
export function initAdminDebugButton(): void {
  // Wait for DOM to be ready before initializing
  const initialize = () => {
    // Initial check
    updateVisibility();

    // Re-check periodically (for login/logout)
    setInterval(updateVisibility, 2000);

    // Also check on storage changes (login/logout in another tab)
    window.addEventListener('storage', updateVisibility);

    // Watch for Radix portals and keep button on top
    if (document.body) {
      setupPortalObserver();
    }
  };

  // If DOM is already loaded, initialize immediately
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// React Element Picker — Chrome DevTools-style "inspect element" that walks
// the React fiber tree from the clicked DOM node to the source JSX location
// and copies `@<project-relative-path>:<line>` to the clipboard.
// ────────────────────────────────────────────────────────────────────────────

interface PickerSourceInfo {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
  componentName: string;
}

let pickerActive = false;
let pickerOverlay: HTMLDivElement | null = null;
let pickerInfoBox: HTMLDivElement | null = null;
let pickerHoveredEl: HTMLElement | null = null;
// Box-model visualization (like Chrome DevTools): margin ring outside the
// element in orange, padding ring inside the element in green.
let pickerPaddingStrips: HTMLDivElement[] = [];
let pickerMarginStrips: HTMLDivElement[] = [];
const pickerListeners = new Set<(active: boolean) => void>();

function notifyPickerState(active: boolean): void {
  for (const fn of pickerListeners) {
    try { fn(active); } catch { /* ignore */ }
  }
}

export function onElementPickerStateChange(fn: (active: boolean) => void): () => void {
  pickerListeners.add(fn);
  return () => { pickerListeners.delete(fn); };
}

export function isReactElementPickerActive(): boolean {
  return pickerActive;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React fiber internals are untyped
function getFiberFromNode(node: HTMLElement): any | null {
  const key = Object.keys(node).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  return key ? ((node as any)[key] ?? null) : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fiber.type can be anything
function getComponentName(type: any): string {
  if (!type) return '';
  if (typeof type === 'string') return type;
  if (typeof type === 'function') return type.displayName || type.name || '';
  if (typeof type === 'object') {
    return type.displayName || type.render?.displayName || type.render?.name || '';
  }
  return '';
}

function getReactSourceInfo(node: HTMLElement): PickerSourceInfo | null {
  // 1. lovable-tagger attaches `__jsxSource__` symbol directly on the DOM node
  const lovableKey = Symbol.for('__jsxSource__');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- symbol access on DOM
  const lovableSource = (node as any)[lovableKey];
  if (lovableSource?.fileName && lovableSource?.lineNumber) {
    return {
      fileName: lovableSource.fileName,
      lineNumber: lovableSource.lineNumber,
      columnNumber: lovableSource.columnNumber,
      componentName: lovableSource.displayName || '',
    };
  }

  // 2. React fiber `_debugSource` (dev mode, jsx-dev-runtime)
  let fiber = getFiberFromNode(node);
  while (fiber) {
    if (fiber._debugSource?.fileName) {
      let compName = getComponentName(fiber.type);
      if (!compName) {
        // Walk up the owner chain to find the enclosing user component
        let owner = fiber._debugOwner;
        while (owner && !compName) {
          compName = getComponentName(owner.type || owner.elementType);
          owner = owner._debugOwner;
        }
      }
      return {
        fileName: fiber._debugSource.fileName,
        lineNumber: fiber._debugSource.lineNumber,
        columnNumber: fiber._debugSource.columnNumber,
        componentName: compName,
      };
    }
    fiber = fiber.return;
  }
  return null;
}

function normalizePickerPath(absPath: string): string {
  // Prefer path relative to workspace root (contains one of the known repos)
  const markers = ['scrapalot-ui/', 'scrapalot-chat/', 'scrapalot-backend/', 'scrapalot-gw/', 'scrapalot-docs/'];
  for (const m of markers) {
    const idx = absPath.lastIndexOf(m);
    if (idx >= 0) return absPath.substring(idx);
  }
  // Fallback: strip leading slashes and any "file://" prefix
  return absPath.replace(/^file:\/\//, '').replace(/^\/+/, '');
}

/**
 * Build a compact HTML snippet from a DOM element when no React source info
 * is available. Keeps the tag + the attributes most useful for locating it in
 * source (id, class, data-*, role, aria-label, href, name, type, placeholder)
 * plus a short text preview.
 */
function buildHtmlSnippet(node: HTMLElement): string {
  const tag = node.tagName.toLowerCase();
  const keepAttrs = new Set([
    'id', 'class', 'role', 'type', 'name', 'href', 'src',
    'alt', 'title', 'placeholder', 'value',
    'aria-label', 'aria-labelledby', 'aria-describedby',
  ]);
  const parts: string[] = [tag];

  for (const attr of Array.from(node.attributes)) {
    const lower = attr.name.toLowerCase();
    if (keepAttrs.has(lower) || lower.startsWith('data-')) {
      let val = attr.value;
      // Collapse long class lists and long values for readability
      if (val.length > 120) val = val.substring(0, 117) + '...';
      // Escape double quotes inside value
      val = val.replace(/"/g, '\\"');
      parts.push(`${attr.name}="${val}"`);
    }
  }

  // Short text preview (first line, max 60 chars)
  const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
  const textPreview = text.length > 60 ? text.substring(0, 57) + '...' : text;

  const openTag = `<${parts.join(' ')}>`;
  if (textPreview && !['input', 'img', 'br', 'hr', 'meta', 'link', 'svg'].includes(tag)) {
    return `${openTag}${textPreview}</${tag}>`;
  }
  return openTag;
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function showPickerToast(message: string, color = '#22c55e'): void {
  const toast = document.createElement('div');
  toast.setAttribute('data-picker-toast', '1');
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: ${color};
    color: white;
    padding: 10px 16px;
    font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    z-index: 2147483647;
    pointer-events: none;
    max-width: 90vw;
    word-break: break-all;
    isolation: isolate;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2400);
}

function makeStrip(color: string): HTMLDivElement {
  const d = document.createElement('div');
  d.setAttribute('data-picker-overlay', '1');
  d.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: ${color};
    z-index: 2147483644;
    box-sizing: border-box;
    left: 0; top: 0; width: 0; height: 0;
  `;
  return d;
}

function ensurePickerOverlay(): void {
  if (pickerOverlay && pickerInfoBox) return;

  // Margin strips — rendered below the main rectangle, outside the element
  pickerMarginStrips = [0, 1, 2, 3].map(() => {
    const d = makeStrip('rgba(246, 178, 107, 0.35)'); // orange
    document.body.appendChild(d);
    return d;
  });

  // Padding strips — rendered below the main rectangle, inside the element
  pickerPaddingStrips = [0, 1, 2, 3].map(() => {
    const d = makeStrip('rgba(147, 196, 125, 0.4)'); // green
    document.body.appendChild(d);
    return d;
  });

  pickerOverlay = document.createElement('div');
  pickerOverlay.setAttribute('data-picker-overlay', '1');
  pickerOverlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    border: 2px solid #3b82f6;
    background: rgba(59, 130, 246, 0.12);
    z-index: 2147483645;
    transition: left 0.05s, top 0.05s, width 0.05s, height 0.05s;
    box-sizing: border-box;
  `;
  document.body.appendChild(pickerOverlay);

  pickerInfoBox = document.createElement('div');
  pickerInfoBox.setAttribute('data-picker-overlay', '1');
  // 50% translucent so the highlighted element underneath remains visible;
  // backdrop blur keeps the text readable against any background.
  pickerInfoBox.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: rgba(17, 17, 17, 0.5);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    color: #fff;
    text-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
    padding: 6px 10px;
    font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    z-index: 2147483646;
    max-width: 70vw;
    word-break: break-all;
    isolation: isolate;
  `;
  document.body.appendChild(pickerInfoBox);
}

function hidePickerOverlay(): void {
  pickerOverlay?.remove();
  pickerInfoBox?.remove();
  for (const s of pickerPaddingStrips) s.remove();
  for (const s of pickerMarginStrips) s.remove();
  pickerOverlay = null;
  pickerInfoBox = null;
  pickerPaddingStrips = [];
  pickerMarginStrips = [];
}

function placeStrip(s: HTMLDivElement, left: number, top: number, width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    s.style.width = '0px';
    s.style.height = '0px';
    return;
  }
  s.style.left = `${left}px`;
  s.style.top = `${top}px`;
  s.style.width = `${width}px`;
  s.style.height = `${height}px`;
}

function isPickerInfrastructureNode(node: Element | null): boolean {
  if (!node) return false;
  if (node.getAttribute?.('data-picker-overlay') === '1') return true;
  if (node.getAttribute?.('data-picker-toast') === '1') return true;
  if (node.closest?.('[data-picker-button="1"]')) return true;
  if (node.closest?.('[data-testid="tool-dock-picker-button"]')) return true;
  return false;
}

function updatePickerOverlayForElement(target: HTMLElement): void {
  pickerHoveredEl = target;
  ensurePickerOverlay();

  const rect = target.getBoundingClientRect();
  pickerOverlay!.style.left = `${rect.left}px`;
  pickerOverlay!.style.top = `${rect.top}px`;
  pickerOverlay!.style.width = `${rect.width}px`;
  pickerOverlay!.style.height = `${rect.height}px`;

  // Box-model: read computed padding + margin (clamp negative margins to 0)
  const cs = window.getComputedStyle(target);
  const pt = Math.max(0, parseFloat(cs.paddingTop) || 0);
  const pr = Math.max(0, parseFloat(cs.paddingRight) || 0);
  const pb = Math.max(0, parseFloat(cs.paddingBottom) || 0);
  const pl = Math.max(0, parseFloat(cs.paddingLeft) || 0);
  const mt = Math.max(0, parseFloat(cs.marginTop) || 0);
  const mr = Math.max(0, parseFloat(cs.marginRight) || 0);
  const mb = Math.max(0, parseFloat(cs.marginBottom) || 0);
  const ml = Math.max(0, parseFloat(cs.marginLeft) || 0);

  // Margin strips — 4 rectangles forming an orange ring around the element
  // [0] top, [1] right, [2] bottom, [3] left
  placeStrip(pickerMarginStrips[0], rect.left - ml, rect.top - mt, rect.width + ml + mr, mt);
  placeStrip(pickerMarginStrips[1], rect.right, rect.top, mr, rect.height);
  placeStrip(pickerMarginStrips[2], rect.left - ml, rect.bottom, rect.width + ml + mr, mb);
  placeStrip(pickerMarginStrips[3], rect.left - ml, rect.top, ml, rect.height);

  // Padding strips — 4 rectangles forming a green ring inside the element
  placeStrip(pickerPaddingStrips[0], rect.left, rect.top, rect.width, pt);
  placeStrip(pickerPaddingStrips[1], rect.right - pr, rect.top + pt, pr, Math.max(0, rect.height - pt - pb));
  placeStrip(pickerPaddingStrips[2], rect.left, rect.bottom - pb, rect.width, pb);
  placeStrip(pickerPaddingStrips[3], rect.left, rect.top + pt, pl, Math.max(0, rect.height - pt - pb));

  const info = getReactSourceInfo(target);
  const tag = target.tagName.toLowerCase();
  const compName = info?.componentName ? ` <${info.componentName}>` : '';
  const fileLine = info
    ? `${normalizePickerPath(info.fileName)}:${info.lineNumber}`
    : `${buildHtmlSnippet(target)} (HTML fallback)`;
  pickerInfoBox!.textContent = `${tag}${compName} — ${fileLine}`;

  const infoWidth = Math.min(560, window.innerWidth - 16);
  pickerInfoBox!.style.maxWidth = `${infoWidth}px`;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - infoWidth - 8));
  const topAbove = rect.top - 28;
  const top = topAbove > 4 ? topAbove : Math.min(rect.bottom + 4, window.innerHeight - 28);
  pickerInfoBox!.style.left = `${left}px`;
  pickerInfoBox!.style.top = `${top}px`;
}

function commitPickerSelection(target: HTMLElement): void {
  const info = getReactSourceInfo(target);
  stopReactElementPicker();

  let clipText: string;
  let toastColor = '#22c55e';
  if (info) {
    const relative = normalizePickerPath(info.fileName);
    clipText = `@${relative}:${info.lineNumber}`;
  } else {
    clipText = `@${buildHtmlSnippet(target)}`;
    toastColor = '#f59e0b';
  }

  void copyTextToClipboard(clipText).then(ok => {
    if (ok) showPickerToast(`Copied ${clipText}`, toastColor);
    else showPickerToast('Failed to copy to clipboard', '#ef4444');
  });
}

// ── Touch flow (mobile) ────────────────────────────────────────────────────
// Tap/drag highlights elements (same as desktop hover). When the finger lifts
// and stays still for 500 ms the accept/reject floating buttons appear. Drag
// again to cancel the buttons and pick another element.

let pickerDebounceTimer: number | null = null;
let pickerConfirmButtons: HTMLDivElement | null = null;
// Transient flag set right after the user taps Reject. The synthesized click
// fires AFTER we tear down the confirm buttons, which would otherwise reach
// handlePickerClick with pickerConfirmButtons=null and commit the hovered
// element. This flag keeps that click suppressed for a short window.
let pickerRecentlyRejected = false;

function cancelPickerDebounce(): void {
  if (pickerDebounceTimer !== null) {
    clearTimeout(pickerDebounceTimer);
    pickerDebounceTimer = null;
  }
}

function hidePickerConfirmButtons(): void {
  pickerConfirmButtons?.remove();
  pickerConfirmButtons = null;
}

function showPickerConfirmButtons(): void {
  if (!pickerHoveredEl) return;
  hidePickerConfirmButtons();

  const rect = pickerHoveredEl.getBoundingClientRect();
  const btnSize = 48;
  const gap = 12;
  const containerWidth = btnSize * 2 + gap;
  const containerHeight = btnSize;

  const container = document.createElement('div');
  container.setAttribute('data-picker-overlay', '1');
  let top = rect.bottom + 8;
  if (top + containerHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - containerHeight - 8);
  }
  let left = rect.left + rect.width / 2 - containerWidth / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - containerWidth - 8));
  container.style.cssText = `
    position: fixed;
    top: ${top}px;
    left: ${left}px;
    display: flex;
    gap: ${gap}px;
    z-index: 2147483647;
    pointer-events: auto;
  `;

  const makeBtn = (color: string, iconSvg: string, label: string, onPress: (e: Event) => void): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.setAttribute('data-picker-overlay', '1');
    btn.setAttribute('aria-label', label);
    btn.style.cssText = `
      width: ${btnSize}px; height: ${btnSize}px;
      border: 2px solid rgba(255, 255, 255, 0.25);
      background: ${color};
      color: white;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
      cursor: pointer;
      touch-action: manipulation;
      padding: 0;
    `;
    btn.innerHTML = iconSvg;
    btn.addEventListener('click', onPress, true);
    btn.addEventListener('touchend', onPress, true);
    return btn;
  };

  const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const X_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  const rejectBtn = makeBtn('#ef4444', X_SVG, 'Reject', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pickerRecentlyRejected = true;
    hidePickerConfirmButtons();
    // Clear after the synthesized click would have arrived
    window.setTimeout(() => { pickerRecentlyRejected = false; }, 500);
    // Stay active — let user drag to a different element
  });
  const acceptBtn = makeBtn('#22c55e', CHECK_SVG, 'Accept', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pickerHoveredEl) return;
    const target = pickerHoveredEl;
    hidePickerConfirmButtons();
    commitPickerSelection(target);
  });

  container.appendChild(rejectBtn);
  container.appendChild(acceptBtn);
  document.body.appendChild(container);
  pickerConfirmButtons = container;
}

function getTouchTargetElement(e: TouchEvent): HTMLElement | null {
  const touch = e.touches[0] ?? e.changedTouches[0];
  if (!touch) return null;
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  return el instanceof HTMLElement ? el : null;
}

function handlePickerTouchStart(e: TouchEvent): void {
  if (!pickerActive) return;
  const target = getTouchTargetElement(e);
  if (!target || isPickerInfrastructureNode(target)) return;
  cancelPickerDebounce();
  hidePickerConfirmButtons();
  e.preventDefault();
  e.stopPropagation();
  updatePickerOverlayForElement(target);
}

function handlePickerTouchMove(e: TouchEvent): void {
  if (!pickerActive) return;
  const target = getTouchTargetElement(e);
  if (!target || isPickerInfrastructureNode(target)) return;
  cancelPickerDebounce();
  hidePickerConfirmButtons();
  e.preventDefault();
  e.stopPropagation();
  updatePickerOverlayForElement(target);
}

function handlePickerTouchEnd(e: TouchEvent): void {
  if (!pickerActive) return;
  const target = getTouchTargetElement(e);
  if (target && isPickerInfrastructureNode(target)) {
    // Let the accept/reject button handle its own event
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  cancelPickerDebounce();
  if (!pickerHoveredEl) return;
  pickerDebounceTimer = window.setTimeout(() => {
    pickerDebounceTimer = null;
    showPickerConfirmButtons();
  }, 500);
}

// ── Mouse flow (desktop) ───────────────────────────────────────────────────

function handlePickerMove(e: MouseEvent): void {
  if (!pickerActive) return;
  const target = e.target as HTMLElement | null;
  if (!target || isPickerInfrastructureNode(target)) return;
  updatePickerOverlayForElement(target);
}

function handlePickerClick(e: MouseEvent): void {
  if (!pickerActive) return;
  const rawTarget = e.target as Element | null;
  // Infrastructure check FIRST — Accept/Reject buttons, picker overlays and
  // the tool-dock picker toggle must receive their own click. If we swallow
  // them first, their listeners never fire and (e.g.) Accept can't commit.
  if (rawTarget && isPickerInfrastructureNode(rawTarget)) {
    return;
  }
  // Suppress synthesized click from a touchend that already scheduled the
  // debounced confirm buttons — otherwise desktop commit would fire instantly.
  // Also swallow the synthesized click that arrives right after a Reject tap,
  // which would otherwise commit the still-hovered element.
  if (pickerConfirmButtons || pickerDebounceTimer !== null || pickerRecentlyRejected) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const target = (pickerHoveredEl || rawTarget) as HTMLElement | null;
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  commitPickerSelection(target);
}

function handlePickerKey(e: KeyboardEvent): void {
  if (!pickerActive) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    stopReactElementPicker();
    showPickerToast('Element picker cancelled', '#6b7280');
  }
}

// Suppress mouseover/mousedown so hovered widgets (popovers, tooltips) don't
// react while the user is picking. We only listen in capture phase.
function handlePickerSwallow(e: Event): void {
  if (!pickerActive) return;
  const target = e.target as Element | null;
  if (isPickerInfrastructureNode(target)) return;
  e.stopPropagation();
  if ('preventDefault' in e) {
    try { (e as MouseEvent).preventDefault(); } catch { /* ignore */ }
  }
}

// When a Radix Dialog in modal mode is open, react-remove-scroll puts
// `pointer-events: none` on <body>; that property inherits to every
// descendant, so document.elementFromPoint returns html/body and no tap
// lands on real React components. We override body inline (inline beats
// the class-based rule) while the picker is active, then restore.
let savedBodyPointerEvents: { value: string; priority: string } | null = null;

function enableBodyPointerEvents(): void {
  savedBodyPointerEvents = {
    value: document.body.style.getPropertyValue('pointer-events'),
    priority: document.body.style.getPropertyPriority('pointer-events'),
  };
  // Use !important so it beats any class-based or inline `!important` rule
  // from react-remove-scroll / scroll-lock libraries.
  document.body.style.setProperty('pointer-events', 'auto', 'important');
}

function restoreBodyPointerEvents(): void {
  if (!savedBodyPointerEvents) return;
  const { value, priority } = savedBodyPointerEvents;
  document.body.style.removeProperty('pointer-events');
  if (value) {
    document.body.style.setProperty('pointer-events', value, priority || '');
  }
  savedBodyPointerEvents = null;
}

export function startReactElementPicker(): void {
  if (pickerActive) return;
  pickerActive = true;
  document.body.style.cursor = 'crosshair';
  enableBodyPointerEvents();

  // Mouse / keyboard (desktop)
  document.addEventListener('mousemove', handlePickerMove, true);
  document.addEventListener('click', handlePickerClick, true);
  document.addEventListener('keydown', handlePickerKey, true);
  document.addEventListener('mousedown', handlePickerSwallow, true);
  document.addEventListener('mouseup', handlePickerSwallow, true);

  // Touch (mobile) — capture-phase, non-passive so we can preventDefault
  document.addEventListener('touchstart', handlePickerTouchStart, { capture: true, passive: false });
  document.addEventListener('touchmove', handlePickerTouchMove, { capture: true, passive: false });
  document.addEventListener('touchend', handlePickerTouchEnd, { capture: true, passive: false });
  document.addEventListener('touchcancel', handlePickerTouchEnd, { capture: true, passive: false });

  notifyPickerState(true);
  showPickerToast('Tap or drag to highlight. Pause to confirm.', '#3b82f6');
}

export function stopReactElementPicker(): void {
  if (!pickerActive) return;
  pickerActive = false;
  document.body.style.cursor = '';
  restoreBodyPointerEvents();

  document.removeEventListener('mousemove', handlePickerMove, true);
  document.removeEventListener('click', handlePickerClick, true);
  document.removeEventListener('keydown', handlePickerKey, true);
  document.removeEventListener('mousedown', handlePickerSwallow, true);
  document.removeEventListener('mouseup', handlePickerSwallow, true);

  document.removeEventListener('touchstart', handlePickerTouchStart, { capture: true } as AddEventListenerOptions);
  document.removeEventListener('touchmove', handlePickerTouchMove, { capture: true } as AddEventListenerOptions);
  document.removeEventListener('touchend', handlePickerTouchEnd, { capture: true } as AddEventListenerOptions);
  document.removeEventListener('touchcancel', handlePickerTouchEnd, { capture: true } as AddEventListenerOptions);

  cancelPickerDebounce();
  hidePickerConfirmButtons();
  hidePickerOverlay();
  pickerHoveredEl = null;
  notifyPickerState(false);
}

export function toggleReactElementPicker(): void {
  if (pickerActive) stopReactElementPicker();
  else startReactElementPicker();
}
