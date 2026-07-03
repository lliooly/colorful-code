'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import {
  PlusCircle,
  Search,
  Puzzle,
  FolderRoot,
  MessageCirclePlus,
  Settings,
  FileDiff,
  Ellipsis,
  Check,
  ArrowLeft,
  ArrowRight,
  Upload,
  PanelLeft,
  ArrowUp,
  Square,
  Languages,
  SunMoon,
  ShieldCheck,
  SlidersHorizontal,
  Cpu,
  Network,
  Sparkles,
  Code2,
  TestTube2,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  Mic,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
} from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Progress } from '@/components/ui/progress';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  Select,
  SelectContent,
  SelectGroup,
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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  canUseMacosSpeech,
  ensureAgentServer,
  isTauriRuntime,
  listenMacosSpeech,
  pickUploadFile,
  pickWorkspaceDirectory,
  startMacosSpeech,
  stopMacosSpeech,
  type AgentServerStatus,
  type MacosSpeechEvent,
} from './desktop';
import {
  appendVoiceAudio,
  createSession,
  eventsUrl,
  forkCheckpoint,
  listModelPresets,
  listRemoteModels,
  listCheckpoints,
  listSessions,
  restoreCheckpoint,
  restoreSession,
  sendControl,
  sendMessage,
  startVoiceTranscription,
  stopVoiceTranscription,
  testModelConfig,
  type PublicModelPreset,
} from './api';
import {
  appendTranscriptToDraft,
  startVoiceRecorder,
  type VoiceRecorder,
} from './voice-recorder';
import {
  AGENT_PREFERENCES_STORAGE_KEY,
  DEFAULT_AGENT_PREFERENCES,
  getVisibleModelPresetIds,
  getVisiblePermissionModes,
  isLanguage,
  mergeAgentPreferences,
  setModelPresetVisibility,
  setPermissionModeVisibility,
  type AgentPreferences,
  type Language,
  type ThemePreference,
} from './preferences';
import {
  applyAgentEvent,
  checkpointsToChats,
  composeMessageWithAttachments,
  composeVisibleMessageWithAttachments,
  conversationItemsFromHistory,
  createAgentViewState,
  createWorkspaceProject,
  formatToolSourceLabel,
  patchCounts,
  patchStatusLabel,
  sortedEditProposals,
  type ConversationItem,
  type LocalFileAttachment,
  type WorkspaceProject,
} from './state';
import {
  PERMISSION_MODES,
  SESSION_EVENT_TYPES,
  type Checkpoint,
  type FilePatch,
  type ModelConfig,
  type ModelProtocol,
  type PermissionMode,
  type SessionSummary,
  type SessionEvent,
} from './types';

const sidebarItems = [
  { key: 'search', icon: Search, href: '#search' },
  { key: 'plugins', icon: Puzzle, href: '#plugins' },
] as const;

const WORKSPACE_PATH = '/Users/shishishi/Desktop/colorful-code';

function subscribeDesktopRuntime(): () => void {
  return () => {};
}

function getDesktopRuntimeSnapshot(): boolean {
  return isTauriRuntime(typeof window === 'undefined' ? {} : window);
}

function getDesktopRuntimeServerSnapshot(): boolean {
  return false;
}

const defaultProjects: WorkspaceProject[] = [
  {
    id: 'local',
    name: 'Local project',
    path: WORKSPACE_PATH,
    chats: [],
  },
];

type ModelPreset = {
  id: string;
  label: string;
  protocol?: ModelProtocol;
  baseURL?: string;
  defaultModel?: string;
  requiresApiKey: true;
  requiresBaseURL: boolean;
  requiresModel: boolean;
};

const PRESETS: readonly ModelPreset[] = [
  {
    id: 'claude',
    label: 'Claude',
    protocol: 'anthropic',
    defaultModel: 'claude-fable-5',
    requiresApiKey: true,
    requiresBaseURL: false,
    requiresModel: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    requiresApiKey: true,
    requiresBaseURL: false,
    requiresModel: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    defaultModel: 'gpt-5.5',
    requiresApiKey: true,
    requiresBaseURL: false,
    requiresModel: false,
  },
  {
    id: 'custom',
    label: 'Custom',
    requiresApiKey: true,
    requiresBaseURL: true,
    requiresModel: true,
  },
];

type SettingsSection = 'general' | 'model' | 'mcp' | 'skills' | 'lsp';

const settingsSections: ReadonlyArray<{
  id: SettingsSection;
  icon: typeof SlidersHorizontal;
}> = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'model', icon: Cpu },
  { id: 'mcp', icon: Network },
  { id: 'skills', icon: Sparkles },
  { id: 'lsp', icon: Code2 },
];

const languageNames: Record<Language, string> = {
  en: 'English',
  zh: '中文',
};

const copy = {
  en: {
    nav: {
      search: 'Search',
      plugins: 'Plugins',
      projects: 'Projects',
      chats: 'Chats',
      settings: 'Settings',
      localProject: 'Local project',
      newChat: 'New chat',
      createChat: 'Create chat',
      importDirectory: 'Import local directory',
      createDefaultChat: 'Create default chat',
      loadingCheckpoints: 'Loading checkpoints...',
      noCheckpoints: 'No checkpoints yet.',
      createChatToStart: 'Create a chat to start.',
    },
    topbar: {
      streamConnected: 'stream connected',
      streamOffline: 'stream offline',
      noSession: 'no session',
      idle: 'idle',
      server: 'server',
      managed: 'managed',
      existing: 'existing',
      starting: 'starting',
      cancel: 'Cancel',
      editProposals: 'View edit proposals',
      more: 'More',
      workspace: 'Workspace',
      exportTranscript: 'Export transcript',
      copySessionId: 'Copy session id',
      refreshCheckpoints: 'Refresh checkpoints',
      forkCheckpoint: 'Fork current checkpoint',
      openPlugins: 'Open plugins',
      openSettings: 'Open settings',
    },
    empty: {
      title: 'Start a new conversation',
      description:
        'Create a session, then send a message to connect the page with your backend.',
      sidebarReady: 'Sidebar stays fixed',
      scrollerReady: 'Message scroller is ready',
    },
    composer: {
      placeholderReady: 'Type a message...',
      placeholderCreate: 'Create a session first',
      uploadFile: 'Upload file',
      openingFile: 'Opening file picker...',
      openFolder: 'Open folder',
      openingFolder: 'Opening folder picker...',
      remove: 'Remove',
      permissionMode: 'Permission mode',
      contextWindow: 'Context window',
      modelContext: 'Model context',
      contextPercent: 'of current context budget',
      compact: 'Compact context',
      compactDescription:
        'Summarise older messages to free context window space.',
      compacting: 'Compacting…',
      model: 'Model',
      send: 'Send',
      baseUrl: 'Base URL',
      apiKey: 'API key',
    },
    settings: {
      title: 'Settings',
      description: 'Tune the workspace shell without leaving the conversation.',
      general: 'General',
      model: 'Model',
      mcp: 'MCP',
      skills: 'Skills',
      lsp: 'LSP',
      language: 'Language',
      languageDescription: 'Choose the UI language for this agent workspace.',
      theme: 'Appearance',
      themeDescription:
        'Choose how the application looks. System follows your OS setting.',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      permissions: 'Permissions',
      permissionsDescription:
        'Choose which permission modes appear in the chat composer.',
      comingNext: 'This settings area is coming next.',
      test: 'Test',
      testing: 'Testing...',
      fetchModels: 'Fetch models',
      fetchingModels: 'Fetching...',
      apiKey: 'API key',
      baseUrl: 'Base URL',
      protocol: 'Protocol',
      modelId: 'Model',
      modelTemplates: 'Templates',
      modelTemplatesDescription:
        'Enable the templates you want available in the chat composer. At least one template stays on.',
      templateEnabled: 'Enabled',
      templateDisabled: 'Disabled',
      customModelDescription:
        'Custom needs protocol, base URL, API key, and a model id.',
      namedModelDescription:
        'This template uses the adapter defaults; provide a request-scoped key to test and run it.',
      connectionOk: 'Model responded',
      connectionFailed: 'Model test failed',
      modelListFailed: 'Could not fetch models',
      chooseRemoteModel: 'Choose a remote model',
    },
    permissionModes: {
      default: 'Default permission',
      plan: 'Plan mode',
      acceptEdits: 'Accept edits',
      readOnly: 'Read only',
      bypass: 'Full access',
    },
    permissionModeDescriptions: {
      default:
        'Ask before edits outside the workspace or actions that need network access.',
      plan: 'Review the plan first; the agent will not edit files until approved.',
      acceptEdits:
        'Apply workspace edits automatically, but still ask for risky actions.',
      readOnly: 'Inspect files and answer questions without changing the workspace.',
      bypass:
        'Allow edits and commands without approval prompts. Use only when you trust the task.',
    },
  },
  zh: {
    nav: {
      search: '搜索',
      plugins: '插件',
      projects: '项目',
      chats: '会话',
      settings: '设置',
      localProject: '本地项目',
      newChat: '新会话',
      createChat: '创建会话',
      importDirectory: '导入本地目录',
      createDefaultChat: '创建默认会话',
      loadingCheckpoints: '正在加载检查点...',
      noCheckpoints: '还没有检查点。',
      createChatToStart: '先创建会话开始使用。',
    },
    topbar: {
      streamConnected: '流已连接',
      streamOffline: '流离线',
      noSession: '无会话',
      idle: '空闲',
      server: '服务',
      managed: '托管',
      existing: '已有',
      starting: '启动中',
      cancel: '取消',
      editProposals: '查看编辑提案',
      more: '更多',
      workspace: '工作区',
      exportTranscript: '导出对话',
      copySessionId: '复制会话 id',
      refreshCheckpoints: '刷新检查点',
      forkCheckpoint: '从当前检查点分叉',
      openPlugins: '打开插件',
      openSettings: '打开设置',
    },
    empty: {
      title: '开始新的对话',
      description: '创建会话后发送消息，将页面连接到你的后端。',
      sidebarReady: '侧边栏保持固定',
      scrollerReady: '消息滚动器已就绪',
    },
    composer: {
      placeholderReady: '输入消息...',
      placeholderCreate: '请先创建会话',
      uploadFile: '上传文件',
      openingFile: '正在打开文件选择器...',
      openFolder: '打开文件夹',
      openingFolder: '正在打开文件夹选择器...',
      remove: '移除',
      permissionMode: '权限模式',
      contextWindow: '上下文窗口',
      modelContext: '模型上下文',
      contextPercent: '当前上下文预算',
      compact: '压缩上下文',
      compactDescription: '将较早的对话总结为摘要，释放上下文窗口空间。',
      compacting: '压缩中…',
      model: '模型',
      send: '发送',
      baseUrl: '基础 URL',
      apiKey: 'API key',
    },
    settings: {
      title: '设置',
      description: '在不中断对话的情况下调整当前工作区体验。',
      general: '通用',
      model: '模型',
      mcp: 'MCP',
      skills: 'Skills',
      lsp: 'LSP',
      language: '语言',
      languageDescription: '选择当前 agent 工作区的界面语言。',
      theme: '外观',
      themeDescription: '选择应用的外观主题。跟随系统会使用你操作系统的设置。',
      themeSystem: '跟随系统',
      themeLight: '浅色',
      themeDark: '深色',
      permissions: '权限',
      permissionsDescription: '选择哪些权限模式显示在聊天输入区。',
      comingNext: '这个设置页面下一步再接入。',
      test: '测试',
      testing: '测试中...',
      fetchModels: '获取模型列表',
      fetchingModels: '获取中...',
      apiKey: 'API key',
      baseUrl: 'Base URL',
      protocol: '协议',
      modelId: '模型',
      modelTemplates: '模版',
      modelTemplatesDescription:
        '开启需要显示在聊天输入区的模版。系统会至少保留一个模版可用。',
      templateEnabled: '已开启',
      templateDisabled: '已关闭',
      customModelDescription: 'Custom 需要协议、Base URL、API key 和模型 id。',
      namedModelDescription:
        '这个模版使用 adapter 默认配置；填入临时 key 后即可测试和运行。',
      connectionOk: '模型有响应',
      connectionFailed: '模型测试失败',
      modelListFailed: '获取模型列表失败',
      chooseRemoteModel: '选择远端模型',
    },
    permissionModes: {
      default: '默认权限',
      plan: '计划模式',
      acceptEdits: '自动接受编辑',
      readOnly: '只读模式',
      bypass: '完全访问',
    },
    permissionModeDescriptions: {
      default: '外部文件编辑和联网等操作会先询问确认。',
      plan: '先审阅计划，批准前不会修改文件。',
      acceptEdits: '自动应用工作区内编辑，危险操作仍会询问。',
      readOnly: '只读取和分析文件，不修改当前工作区。',
      bypass: '无需确认即可执行编辑和命令。只在完全信任任务时使用。',
    },
  },
} as const satisfies Record<Language, Record<string, unknown>>;

const permissionModeTriggerClasses: Record<PermissionMode, string> = {
  readOnly:
    'text-emerald-600 hover:text-emerald-700 dark:text-emerald-400',
  plan: 'text-sky-600 hover:text-sky-700 dark:text-sky-400',
  default:
    'text-blue-600 hover:text-blue-700 dark:text-blue-400',
  acceptEdits:
    'text-orange-600 hover:text-orange-700 dark:text-orange-400',
  bypass:
    'text-red-600 hover:text-red-700 dark:text-red-400',
};

export default function AgentPage(): ReactNode {
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>('default');
  const [presetId, setPresetId] = useState<string>('claude');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setAgentServer] = useState<AgentServerStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [viewState, setViewState] = useState(() => createAgentViewState());
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [sessionHistory, setSessionHistory] = useState<SessionSummary[]>([]);
  const [loadingSessionHistory, setLoadingSessionHistory] = useState(false);
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(
    null,
  );
  const [currentCheckpointId, setCurrentCheckpointId] = useState<string | null>(
    null,
  );
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(false);
  const [checkpointAction, setCheckpointAction] = useState<{
    id: string;
    type: 'restore' | 'fork';
  } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);
  const [attachments, setAttachments] = useState<LocalFileAttachment[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    null,
  );
  const [selectedPatchPath, setSelectedPatchPath] = useState<string | null>(
    null,
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    defaultProjects[0]?.id ?? 'local',
  );
  const [projects, setProjects] = useState<WorkspaceProject[]>(defaultProjects);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<SettingsSection>('general');
  const [preferences, setPreferences] = useState<AgentPreferences>(() => {
    if (typeof window === 'undefined') return DEFAULT_AGENT_PREFERENCES;
    try {
      const stored = window.localStorage.getItem(AGENT_PREFERENCES_STORAGE_KEY);
      return mergeAgentPreferences(stored ? JSON.parse(stored) : null);
    } catch {
      return DEFAULT_AGENT_PREFERENCES;
    }
  });

  const [customProtocol, setCustomProtocol] = useState<ModelProtocol>('openai');
  const [customBaseURL, setCustomBaseURL] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [presetApiKeys, setPresetApiKeys] = useState<Record<string, string>>(
    {},
  );
  const [presetModelOverrides, setPresetModelOverrides] = useState<
    Record<string, string>
  >({});
  const [modelPresets, setModelPresets] = useState<PublicModelPreset[]>(() => [
    ...PRESETS,
  ]);
  const [loadingModelPresets, setLoadingModelPresets] = useState(false);
  const [testingModel, setTestingModel] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelStatus, setModelStatus] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);

  const sourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null);
  const voiceRequestIdRef = useRef<string | null>(null);
  const voicePartialRef = useRef('');
  const macosSpeechActiveRef = useRef(false);
  const macosSpeechUnlistenRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);
  const sidebarPanelRef = useRef<PanelImperativeHandle | null>(null);

  const cleanupMacosSpeech = useCallback(() => {
    macosSpeechActiveRef.current = false;
    macosSpeechUnlistenRef.current?.();
    macosSpeechUnlistenRef.current = null;
    voicePartialRef.current = '';
  }, []);

  const {
    items,
    hookWarnings,
    approval,
    editProposals,
    runStatus,
  } = viewState;

  const modelPresetIds = useMemo(
    () => modelPresets.map((item) => item.id),
    [modelPresets],
  );
  const visibleModelPresetIds = useMemo(
    () => getVisibleModelPresetIds(preferences, modelPresetIds),
    [modelPresetIds, preferences],
  );
  const visibleModelPresets = useMemo(
    () =>
      modelPresets.filter((item) => visibleModelPresetIds.includes(item.id)),
    [modelPresets, visibleModelPresetIds],
  );
  const preset = useMemo(
    () =>
      visibleModelPresets.find((item) => item.id === presetId) ??
      visibleModelPresets[0] ??
      modelPresets[0],
    [modelPresets, presetId, visibleModelPresets],
  );
  const isCustom = preset.id === 'custom';
  const selectedModelProtocol =
    preset.protocol ?? (isCustom ? customProtocol : undefined);
  const selectedRemoteModel = isCustom
    ? customModel
    : (presetModelOverrides[preset.id] ?? '');
  const canFetchRemoteModels = selectedModelProtocol === 'openai';
  const desktopRuntime = useSyncExternalStore(
    subscribeDesktopRuntime,
    getDesktopRuntimeSnapshot,
    getDesktopRuntimeServerSnapshot,
  );
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const checkpointChats = useMemo(
    () => checkpointsToChats(checkpoints),
    [checkpoints],
  );
  const persistedChats = useMemo(
    () =>
      sessionHistory
        .filter((summary) => summary.id !== sessionId)
        .map((summary) => ({
          id: summary.id,
          title: summary.title,
          updatedAt: new Date(summary.updatedAt).toLocaleString(),
          session: summary,
        })),
    [sessionHistory, sessionId],
  );
  const displayedChats =
    checkpointChats.length > 0
      ? checkpointChats.map((chat) => ({ ...chat, session: null }))
      : persistedChats;
  const orderedEditProposals = useMemo(
    () => sortedEditProposals(editProposals),
    [editProposals],
  );
  const selectedProposal =
    orderedEditProposals.find(
      (proposal) => proposal.proposalId === selectedProposalId,
    ) ??
    orderedEditProposals[0] ??
    null;
  const selectedPatch =
    selectedProposal?.patches.find(
      (patch) => patch.path === selectedPatchPath,
    ) ??
    selectedProposal?.patches[0] ??
    null;
  const displayError = error ?? viewState.error;
  const t = copy[preferences.language];
  const visiblePermissionModes = useMemo(
    () => getVisiblePermissionModes(preferences),
    [preferences],
  );

  const contextProgress = useMemo(() => {
    const base = sessionId ? Math.min(90, 18 + items.length * 7) : 16;
    return isCustom ? Math.min(98, base + 8) : base;
  }, [isCustom, items.length, sessionId]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    return () => {
      const recorder = voiceRecorderRef.current;
      voiceRecorderRef.current = null;
      voiceRequestIdRef.current = null;
      voicePartialRef.current = '';
      if (recorder) {
        void recorder.stop();
      }
      if (sessionId) {
        void stopVoiceTranscription(sessionId).catch(() => undefined);
      }
      if (macosSpeechActiveRef.current) {
        void stopMacosSpeech().catch(() => undefined);
      }
      cleanupMacosSpeech();
    };
  }, [cleanupMacosSpeech, sessionId]);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = preferences.language;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme(theme: ThemePreference): void {
      const isDark =
        theme === 'dark' || (theme === 'system' && mediaQuery.matches);
      root.classList.toggle('dark', isDark);
    }

    applyTheme(preferences.theme);
    if ('__TAURI_INTERNALS__' in window) {
      const windowTheme =
        preferences.theme === 'system' ? null : preferences.theme;
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().setTheme(windowTheme),
        )
        .catch(() => undefined);
    }

    if (preferences.theme === 'system') {
      function handleSystemChange(): void {
        applyTheme('system');
      }
      mediaQuery.addEventListener('change', handleSystemChange);
      return () => mediaQuery.removeEventListener('change', handleSystemChange);
    }
  }, [preferences.language, preferences.theme]);

  useEffect(() => {
    window.localStorage.setItem(
      AGENT_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  }, [preferences]);

  useEffect(() => {
    if (!desktopRuntime) return;
    let cancelled = false;

    void ensureAgentServer()
      .then((status) => {
        if (cancelled || !status) return;
        setAgentServer(status);
        if (status.running) {
          setNotice(
            status.managed
              ? 'Local agent server started.'
              : 'Connected to an existing local agent server.',
          );
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          `Desktop agent server failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [desktopRuntime]);

  useEffect(() => {
    if (!settingsOpen) return;
    let cancelled = false;
    async function loadPresets(): Promise<void> {
      setLoadingModelPresets(true);
      try {
        const presets = await listModelPresets();
        if (cancelled) return;
        setModelPresets(presets);
        setPresetId((current) =>
          presets.some((item) => item.id === current)
            ? current
            : (presets[0]?.id ?? 'claude'),
        );
      } catch (err) {
        if (cancelled) return;
        setModelStatus({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (!cancelled) setLoadingModelPresets(false);
      }
    }
    void loadPresets();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  const resetConversation = useCallback(
    (seedItems: ConversationItem[] = []) => {
      setViewState(createAgentViewState(seedItems));
      seqRef.current = 0;
    },
    [],
  );

  const refreshSessionHistory = useCallback(async () => {
    setLoadingSessionHistory(true);
    try {
      const data = await listSessions();
      setSessionHistory(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSessionHistory(false);
    }
  }, []);

  const refreshCheckpoints = useCallback(async (id: string) => {
    setLoadingCheckpoints(true);
    try {
      const data = await listCheckpoints(id);
      setCheckpoints(data.checkpoints);
      setCurrentCheckpointId(data.currentCheckpointId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingCheckpoints(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listSessions()
      .then((data) => {
        if (!cancelled) setSessionHistory(data.sessions);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      if (
        event.type === 'voice_transcript_status' ||
        event.type === 'voice_transcript_delta' ||
        event.type === 'voice_transcript_done' ||
        event.type === 'voice_transcript_error'
      ) {
        if (event.requestId !== voiceRequestIdRef.current) {
          return;
        }
        if (event.type === 'voice_transcript_status') {
          setListening(event.status !== 'stopped');
          if (event.status === 'stopped') {
            voiceRequestIdRef.current = null;
            voicePartialRef.current = '';
          }
          return;
        }
        if (event.type === 'voice_transcript_delta') {
          voicePartialRef.current += event.text;
          setDraft((prev) => appendTranscriptToDraft(prev, event.text));
          return;
        }
        if (event.type === 'voice_transcript_done') {
          if (!voicePartialRef.current) {
            setDraft((prev) => appendTranscriptToDraft(prev, event.text));
          }
          setListening(false);
          voiceRequestIdRef.current = null;
          voicePartialRef.current = '';
          return;
        }
        if (event.type === 'voice_transcript_error') {
          setError(event.message);
          setListening(false);
          voiceRequestIdRef.current = null;
          voicePartialRef.current = '';
          return;
        }
      }
      seqRef.current += 1;
      const seq = seqRef.current;
      setViewState((prev) => applyAgentEvent(prev, event, seq));
      if (event.type === 'run_status' && event.status !== 'running') {
        const id = sessionIdRef.current;
        if (id) void refreshCheckpoints(id);
        void refreshSessionHistory();
      }
    },
    [refreshCheckpoints, refreshSessionHistory],
  );

  const openStream = useCallback(
    (id: string) => {
      sourceRef.current?.close();
      const source = new EventSource(eventsUrl(id));
      sourceRef.current = source;

      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);

      for (const type of SESSION_EVENT_TYPES) {
        source.addEventListener(type, (raw: MessageEvent<string>) => {
          try {
            const event = JSON.parse(raw.data) as SessionEvent;
            handleEvent(event);
          } catch {
            setError(`Failed to parse ${type} event.`);
          }
        });
      }
    },
    [handleEvent],
  );

  const closeStream = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => closeStream, [closeStream]);

  const buildModelConfig = useCallback((): ModelConfig => {
    if (!isCustom) {
      const config: ModelConfig = { preset: preset.id };
      const apiKey = presetApiKeys[preset.id]?.trim();
      const model = presetModelOverrides[preset.id]?.trim();
      if (apiKey) config.apiKey = apiKey;
      if (model) config.model = model;
      return config;
    }
    const config: ModelConfig = { preset: 'custom', protocol: customProtocol };
    if (customBaseURL.trim()) config.baseURL = customBaseURL.trim();
    if (customModel.trim()) config.model = customModel.trim();
    if (customApiKey.trim()) config.apiKey = customApiKey.trim();
    return config;
  }, [
    isCustom,
    preset.id,
    presetApiKeys,
    presetModelOverrides,
    customProtocol,
    customBaseURL,
    customModel,
    customApiKey,
  ]);

  const handleCreate = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const id = await createSession({
        permissionMode,
        cwd: selectedProject?.path,
        workspaceRoots: selectedProject ? [selectedProject.path] : undefined,
        model: buildModelConfig(),
        watchWorkspace: true,
      });
      resetConversation();
      setCheckpoints([]);
      setCurrentCheckpointId(null);
      setSessionId(id);
      sessionIdRef.current = id;
      void refreshCheckpoints(id);
      openStream(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }, [
    permissionMode,
    selectedProject,
    buildModelConfig,
    refreshCheckpoints,
    openStream,
    resetConversation,
  ]);

  const handleSend = useCallback(async () => {
    if (!sessionId || (!draft.trim() && attachments.length === 0)) return;
    const text = composeMessageWithAttachments(draft, attachments);
    const visibleText = composeVisibleMessageWithAttachments(
      draft,
      attachments,
    );
    setDraft('');
    setAttachments([]);
    setViewState((prev) => ({
      ...prev,
      items: [...prev.items, { kind: 'user', text: visibleText }],
    }));
    try {
      await sendMessage(sessionId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, draft, attachments]);

  const handleSetMode = useCallback(
    async (mode: PermissionMode) => {
      setPermissionMode(mode);
      if (!sessionId) return;
      try {
        await sendControl(sessionId, { type: 'set_permission_mode', mode });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId],
  );

  const handleSetLanguage = useCallback((language: string) => {
    if (!isLanguage(language)) return;
    setPreferences((prev) => ({ ...prev, language }));
  }, []);

  const handleSetTheme = useCallback((theme: string) => {
    if (theme !== 'system' && theme !== 'light' && theme !== 'dark') return;
    setPreferences((prev) => ({ ...prev, theme }));
  }, []);

  const handleSetPresetApiKey = useCallback((id: string, apiKey: string) => {
    setPresetApiKeys((prev) => ({ ...prev, [id]: apiKey }));
  }, []);

  const handleTestModel = useCallback(async () => {
    setTestingModel(true);
    setModelStatus(null);
    try {
      const result = await testModelConfig(buildModelConfig());
      setModelStatus({
        type: 'success',
        message: `${t.settings.connectionOk}: ${result.model}${
          result.sample ? ` · ${result.sample}` : ''
        }`,
      });
    } catch (err) {
      setModelStatus({
        type: 'error',
        message: `${
          t.settings.connectionFailed
        }: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setTestingModel(false);
    }
  }, [buildModelConfig, t.settings.connectionFailed, t.settings.connectionOk]);

  const handleFetchRemoteModels = useCallback(async () => {
    setFetchingModels(true);
    setModelStatus(null);
    try {
      const models = await listRemoteModels(buildModelConfig());
      setRemoteModels(models);
      setModelStatus({
        type: 'success',
        message: `${models.length} ${t.settings.chooseRemoteModel}`,
      });
    } catch (err) {
      setModelStatus({
        type: 'error',
        message: `${
          t.settings.modelListFailed
        }: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setFetchingModels(false);
    }
  }, [
    buildModelConfig,
    t.settings.chooseRemoteModel,
    t.settings.modelListFailed,
  ]);

  const handleSetPermissionVisibility = useCallback(
    (mode: PermissionMode, visible: boolean) => {
      const next = setPermissionModeVisibility(preferences, mode, visible);
      const nextVisibleModes = getVisiblePermissionModes(next);
      setPreferences(next);
      if (
        !next.permissionModeVisibility[permissionMode] &&
        nextVisibleModes.length > 0
      ) {
        void handleSetMode(nextVisibleModes[0]);
      }
    },
    [handleSetMode, permissionMode, preferences],
  );

  const handleSetModelPresetVisibility = useCallback(
    (id: string, visible: boolean) => {
      const next = setModelPresetVisibility(preferences, id, visible);
      const nextVisibleIds = getVisibleModelPresetIds(next, modelPresetIds);
      setPreferences(next);
      if (!nextVisibleIds.includes(presetId) && nextVisibleIds.length > 0) {
        setPresetId(nextVisibleIds[0] ?? presetId);
        setRemoteModels([]);
        setModelStatus(null);
      }
    },
    [modelPresetIds, preferences, presetId],
  );

  const handleCancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await sendControl(sessionId, { type: 'cancel' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  const [listening, setListening] = useState(false);

  const handleMacosSpeechEvent = useCallback(
    (event: MacosSpeechEvent) => {
      if (!macosSpeechActiveRef.current) {
        return;
      }
      if (event.kind === 'status') {
        setListening(event.text !== 'stopped');
        if (event.text === 'stopped') {
          cleanupMacosSpeech();
        }
        return;
      }
      if (event.kind === 'error') {
        setError(event.text);
        setListening(false);
        cleanupMacosSpeech();
        return;
      }
      const previous = voicePartialRef.current;
      const addition = event.text.startsWith(previous)
        ? event.text.slice(previous.length)
        : event.text;
      voicePartialRef.current = event.text;
      setDraft((prev) => appendTranscriptToDraft(prev, addition));
      if (event.kind === 'done') {
        setListening(false);
        cleanupMacosSpeech();
      }
    },
    [cleanupMacosSpeech],
  );

  const startMacosSpeechFallback = useCallback(async () => {
    cleanupMacosSpeech();
    voiceRequestIdRef.current = null;
    voicePartialRef.current = '';
    macosSpeechUnlistenRef.current =
      await listenMacosSpeech(handleMacosSpeechEvent);
    macosSpeechActiveRef.current = true;
    setListening(true);
    const started = await startMacosSpeech(preferences.language);
    if (!started) {
      cleanupMacosSpeech();
      setListening(false);
      throw new Error('macOS native speech is not available.');
    }
  }, [cleanupMacosSpeech, handleMacosSpeechEvent, preferences.language]);

  const handleMicClick = useCallback(async () => {
    if (!sessionId) {
      setError('Create a session before starting voice input.');
      return;
    }

    if (voiceRecorderRef.current) {
      const recorder = voiceRecorderRef.current;
      voiceRecorderRef.current = null;
      setListening(false);
      await recorder.stop();
      await stopVoiceTranscription(sessionId).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
      return;
    }

    if (macosSpeechActiveRef.current) {
      setListening(false);
      await stopMacosSpeech().catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
      cleanupMacosSpeech();
      return;
    }

    const requestId = `voice-${Date.now().toString(36)}`;
    const modelConfig = buildModelConfig();
    const openAiApiKey =
      modelConfig.preset === 'openai' ||
      (modelConfig.preset === 'custom' && modelConfig.protocol === 'openai')
        ? modelConfig.apiKey
        : presetApiKeys.openai;

    try {
      setError(null);
      voiceRequestIdRef.current = requestId;
      voicePartialRef.current = '';
      setListening(true);
      await startVoiceTranscription(sessionId, {
        requestId,
        ...(openAiApiKey?.trim() ? { apiKey: openAiApiKey.trim() } : {}),
        language: preferences.language,
      });
      voiceRecorderRef.current = await startVoiceRecorder({
        onChunk: async (chunk) => {
          const activeSessionId = sessionIdRef.current;
          if (!activeSessionId || voiceRequestIdRef.current !== requestId) {
            return;
          }
          await appendVoiceAudio(activeSessionId, chunk);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      voiceRequestIdRef.current = null;
      voicePartialRef.current = '';
      setListening(false);
      await voiceRecorderRef.current?.stop().catch(() => undefined);
      voiceRecorderRef.current = null;
      await stopVoiceTranscription(sessionId).catch(() => undefined);
      if (/OpenAI API key/i.test(message) && canUseMacosSpeech()) {
        try {
          await startMacosSpeechFallback();
          setError(null);
          return;
        } catch (fallbackError) {
          setError(
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError),
          );
          return;
        }
      }
      setError(message);
    }
  }, [
    sessionId,
    buildModelConfig,
    cleanupMacosSpeech,
    presetApiKeys.openai,
    preferences.language,
    startMacosSpeechFallback,
  ]);

  const [compacting, setCompacting] = useState(false);
  const handleCompact = useCallback(async () => {
    if (!sessionId || compacting) return;
    setCompacting(true);
    try {
      await sendControl(sessionId, { type: 'compact' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompacting(false);
    }
  }, [sessionId, compacting]);

  const handleApprovalDecision = useCallback(
    async (allow: boolean) => {
      if (!sessionId || !approval) return;
      const { requestId } = approval;
      setViewState((prev) => ({ ...prev, approval: null }));
      try {
        await sendControl(sessionId, {
          type: 'approval_response',
          requestId,
          decision: allow
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: 'Denied from agent page.' },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId, approval],
  );

  const handleEditDecision = useCallback(
    async (proposalId: string, decision: 'approve' | 'reject') => {
      if (!sessionId) return;
      try {
        await sendControl(sessionId, {
          type: 'edit_decision',
          proposalId,
          decision,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId],
  );

  const handleRestoreCheckpoint = useCallback(
    async (checkpoint: Checkpoint) => {
      if (!sessionId) return;
      setError(null);
      setCheckpointAction({ id: checkpoint.id, type: 'restore' });
      try {
        const restored = await restoreCheckpoint(sessionId, checkpoint.id, {
          model: buildModelConfig(),
        });
        resetConversation(
          conversationItemsFromHistory(checkpoint.snapshot.history),
        );
        setPermissionMode(checkpoint.snapshot.permissionMode);
        setCurrentCheckpointId(restored.checkpointId);
        sessionIdRef.current = restored.id;
        setSessionId(restored.id);
        await refreshCheckpoints(restored.id);
        openStream(restored.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCheckpointAction(null);
      }
    },
    [
      sessionId,
      buildModelConfig,
      resetConversation,
      refreshCheckpoints,
      openStream,
    ],
  );

  const handleForkCheckpoint = useCallback(
    async (checkpoint: Checkpoint) => {
      if (!sessionId) return;
      setError(null);
      setCheckpointAction({ id: checkpoint.id, type: 'fork' });
      try {
        const forked = await forkCheckpoint(sessionId, checkpoint.id, {
          model: buildModelConfig(),
        });
        resetConversation(
          conversationItemsFromHistory(checkpoint.snapshot.history),
        );
        setPermissionMode(checkpoint.snapshot.permissionMode);
        sessionIdRef.current = forked.id;
        setSessionId(forked.id);
        await refreshCheckpoints(forked.id);
        openStream(forked.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCheckpointAction(null);
      }
    },
    [
      sessionId,
      buildModelConfig,
      resetConversation,
      refreshCheckpoints,
      openStream,
    ],
  );

  const handleRestorePersistedSession = useCallback(
    async (summary: SessionSummary) => {
      setError(null);
      setRestoringSessionId(summary.id);
      try {
        if (summary.checkpointId) {
          const data = await listCheckpoints(summary.id);
          const checkpoint =
            data.checkpoints.find((item) => item.id === summary.checkpointId) ??
            data.checkpoints.at(-1);
          if (checkpoint) {
            const restored = await restoreCheckpoint(
              summary.id,
              checkpoint.id,
              {
                model: buildModelConfig(),
              },
            );
            resetConversation(
              conversationItemsFromHistory(checkpoint.snapshot.history),
            );
            setPermissionMode(checkpoint.snapshot.permissionMode);
            setCurrentCheckpointId(restored.checkpointId);
            setCheckpoints(data.checkpoints);
            sessionIdRef.current = restored.id;
            setSessionId(restored.id);
            await refreshCheckpoints(restored.id);
            openStream(restored.id);
            return;
          }
        }

        const restored = await restoreSession(summary.id, {
          model: buildModelConfig(),
        });
        sessionIdRef.current = restored.id;
        setSessionId(restored.id);
        resetConversation();
        await refreshCheckpoints(restored.id);
        openStream(restored.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRestoringSessionId(null);
      }
    },
    [buildModelConfig, openStream, refreshCheckpoints, resetConversation],
  );

  const handleCopySessionId = useCallback(async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  const handleExportTranscript = useCallback(() => {
    const transcript = items
      .map((item) => {
        if (item.kind === 'user') return `User:\n${item.text}`;
        if (item.kind === 'assistant') return `Assistant:\n${item.text}`;
        return `Tool ${item.name}:\n${JSON.stringify(item.input, null, 2)}${
          item.result ? `\n\nResult:\n${item.result.content}` : ''
        }`;
      })
      .join('\n\n---\n\n');
    void navigator.clipboard.writeText(transcript);
  }, [items]);

  const handlePickWorkspaceDirectory = useCallback(async () => {
    setPickingDirectory(true);
    try {
      const path = await pickWorkspaceDirectory();
      if (path) {
        const existing = projects.find((project) => project.path === path);
        if (existing) {
          setSelectedProjectId(existing.id);
          return;
        }
        const project = createWorkspaceProject(path, projects.length);
        setProjects((prev) => [...prev, project]);
        setSelectedProjectId(project.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingDirectory(false);
    }
  }, [projects]);

  const handlePickUploadFile = useCallback(async () => {
    setPickingFile(true);
    try {
      const file = await pickUploadFile();
      if (!file) return;
      setAttachments((prev) =>
        prev.some((attachment) => attachment.path === file.path)
          ? prev
          : [...prev, file],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingFile(false);
    }
  }, []);

  const handleToggleSidebar = useCallback(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (sidebarCollapsed) {
      panel.expand();
      return;
    }
    panel.collapse();
  }, [sidebarCollapsed]);

  const handleNavigateBack = useCallback(() => {
    window.history.back();
  }, []);

  const handleNavigateForward = useCallback(() => {
    window.history.forward();
  }, []);

  return (
    <TooltipProvider>
      <SidebarProvider
        defaultOpen
        className="!min-h-0 h-dvh max-h-dvh overflow-hidden"
      >
        <div
          className="fixed top-0 left-0 z-40 flex h-12 items-center px-3"
          data-tauri-drag-region="deep"
        >
          <div className="ml-[5.75rem] flex items-center gap-2.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleToggleSidebar}
                  aria-label={
                    sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
                  }
                  data-tauri-drag-region="false"
                  className="text-sidebar-foreground/70 hover:bg-sidebar-accent/45 hover:text-sidebar-foreground [&_svg]:size-4"
                >
                  <PanelLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleNavigateBack}
                  aria-label="Back"
                  data-tauri-drag-region="false"
                  className="text-sidebar-foreground/55 hover:bg-sidebar-accent/45 hover:text-sidebar-foreground [&_svg]:size-4"
                >
                  <ArrowLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Back</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleNavigateForward}
                  aria-label="Forward"
                  data-tauri-drag-region="false"
                  className="text-sidebar-foreground/35 hover:bg-sidebar-accent/45 hover:text-sidebar-foreground [&_svg]:size-4"
                >
                  <ArrowRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Forward</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <ResizablePanelGroup
          orientation="horizontal"
          className="h-full min-h-0 max-h-full overflow-hidden bg-transparent text-foreground"
        >
          <ResizablePanel
            className="min-h-0 overflow-hidden"
            panelRef={sidebarPanelRef}
            defaultSize="280px"
            minSize="224px"
            maxSize="360px"
            collapsible
            collapsedSize="64px"
            onResize={(size) => setSidebarCollapsed(size.inPixels <= 80)}
          >
            <Sidebar
              className={cn(
                'w-full min-w-0',
                sidebarCollapsed
                  ? 'agent-sidebar-glass sidebar-collapsed-top-cutout'
                  : 'agent-sidebar-glass border-r border-border/55',
              )}
              collapsible="none"
            >
              <div className="h-12 shrink-0" data-tauri-drag-region="deep" />
              <SidebarContent
                className={cn(
                  sidebarCollapsed && 'items-center gap-3 overflow-y-auto overflow-x-hidden',
                )}
              >
                <SidebarGroup
                  className={cn(sidebarCollapsed && 'items-center px-2')}
                >
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          onClick={() => void handleCreate()}
                          disabled={connecting}
                          tooltip={sessionId ? t.nav.newChat : t.nav.createChat}
                          className={cn(
                            sidebarCollapsed && 'justify-center px-2',
                          )}
                        >
                          <PlusCircle />
                          <span className={cn(sidebarCollapsed && 'hidden')}>
                            {sessionId ? t.nav.newChat : t.nav.createChat}
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      {sidebarItems.map((item) => (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            asChild
                            tooltip={t.nav[item.key]}
                            className={cn(
                              sidebarCollapsed && 'justify-center px-2',
                            )}
                          >
                            <a href={item.href}>
                              <item.icon />
                              <span
                                className={cn(sidebarCollapsed && 'hidden')}
                              >
                                {t.nav[item.key]}
                              </span>
                            </a>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                <SidebarSeparator />

                <SidebarGroup
                  className={cn(
                    'group',
                    sidebarCollapsed && 'items-center px-2',
                  )}
                >
                  <SidebarGroupLabel
                    className={cn(
                      sidebarCollapsed && 'hidden',
                      'text-muted-foreground/60',
                    )}
                  >
                    {t.nav.projects}
                  </SidebarGroupLabel>
                  <SidebarGroupAction
                    type="button"
                    aria-label={t.nav.importDirectory}
                    className={cn(
                      sidebarCollapsed && 'hidden',
                      'opacity-0 group-hover:opacity-100 transition-opacity hover:bg-transparent text-muted-foreground [&>svg]:size-3.5',
                    )}
                    onClick={() => void handlePickWorkspaceDirectory()}
                    disabled={pickingDirectory}
                  >
                    <PlusCircle />
                  </SidebarGroupAction>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {projects.map((project) => (
                        <SidebarMenuItem key={project.id}>
                          <SidebarMenuButton
                            onClick={() => setSelectedProjectId(project.id)}
                            tooltip={
                              project.id === 'local'
                                ? t.nav.localProject
                                : project.name
                            }
                            className={cn(
                              sidebarCollapsed && 'justify-center px-2',
                            )}
                          >
                            <FolderRoot />
                            <span className={cn(sidebarCollapsed && 'hidden')}>
                              {project.id === 'local'
                                ? t.nav.localProject
                                : project.name}
                            </span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>

                <SidebarSeparator />

                <SidebarGroup
                  className={cn(
                    'group',
                    sidebarCollapsed && 'items-center px-2',
                  )}
                >
                  <SidebarGroupLabel
                    className={cn(
                      sidebarCollapsed && 'hidden',
                      'text-muted-foreground/60',
                    )}
                  >
                    {t.nav.chats}
                  </SidebarGroupLabel>
                  <SidebarGroupAction
                    type="button"
                    aria-label={t.nav.createDefaultChat}
                    className={cn(
                      sidebarCollapsed && 'hidden',
                      'opacity-0 group-hover:opacity-100 transition-opacity hover:bg-transparent text-muted-foreground [&>svg]:size-3.5',
                    )}
                    onClick={() => void handleCreate()}
                  >
                    <PlusCircle />
                  </SidebarGroupAction>
                  <SidebarGroupContent>
                    {displayedChats.length === 0 && !sidebarCollapsed ? (
                      <p className="px-3 text-xs text-muted-foreground">
                        {sessionId
                          ? loadingCheckpoints
                            ? t.nav.loadingCheckpoints
                            : t.nav.noCheckpoints
                          : loadingSessionHistory
                            ? t.nav.loadingCheckpoints
                            : t.nav.createChatToStart}
                      </p>
                    ) : null}
                    <SidebarMenu>
                      {displayedChats.map((chat) => (
                        <SidebarMenuItem key={chat.id}>
                          <SidebarMenuButton
                            disabled={
                              loadingCheckpoints ||
                              loadingSessionHistory ||
                              checkpointAction?.id === chat.id ||
                              restoringSessionId === chat.id
                            }
                            onClick={() => {
                              if (chat.session) {
                                void handleRestorePersistedSession(
                                  chat.session,
                                );
                                return;
                              }
                              const checkpoint = checkpoints.find(
                                (item) => item.id === chat.id,
                              );
                              if (checkpoint)
                                void handleRestoreCheckpoint(checkpoint);
                            }}
                            tooltip={chat.title}
                            className={cn(
                              sidebarCollapsed && 'justify-center px-2',
                            )}
                          >
                            <MessageCirclePlus />
                            <div
                              className={cn(
                                'min-w-0 flex-1',
                                sidebarCollapsed && 'hidden',
                              )}
                            >
                              <p className="truncate text-xs font-medium">
                                {chat.title}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {chat.updatedAt}
                              </p>
                            </div>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>

              <SidebarFooter
                className={cn(
                  'gap-2 p-1',
                  sidebarCollapsed && 'items-center px-2',
                )}
              >
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      tooltip={t.nav.settings}
                      className={cn(sidebarCollapsed && 'justify-center px-2')}
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings />
                      <span className={cn(sidebarCollapsed && 'hidden')}>
                        {t.nav.settings}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarFooter>
            </Sidebar>
          </ResizablePanel>
          <ResizableHandle
            withHandle
            className={cn(
              sidebarCollapsed && 'agent-sidebar-resize-handle-cutout',
            )}
          />
          <ResizablePanel
            minSize="360px"
            className="min-h-0 overflow-hidden bg-background"
          >
            <div className="agent-compact-ui flex h-full min-h-0 flex-col overflow-hidden">
              <div
                className="flex h-12 shrink-0 items-center justify-end gap-2 px-5"
                data-tauri-drag-region="deep"
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setDiffOpen(true)}
                      data-tauri-drag-region="false"
                    >
                      <FileDiff />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t.topbar.editProposals}</TooltipContent>
                </Tooltip>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-tauri-drag-region="false"
                    >
                      <Ellipsis />
                      {t.topbar.more}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-56">
                    <DropdownMenuLabel>{t.topbar.workspace}</DropdownMenuLabel>
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        disabled={items.length === 0}
                        onSelect={handleExportTranscript}
                      >
                        {t.topbar.exportTranscript}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!sessionId}
                        onSelect={() => void handleCopySessionId()}
                      >
                        {t.topbar.copySessionId}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!sessionId || loadingCheckpoints}
                        onSelect={() => {
                          if (sessionId) void refreshCheckpoints(sessionId);
                        }}
                      >
                        {t.topbar.refreshCheckpoints}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!currentCheckpointId}
                        onSelect={() => {
                          const checkpoint = checkpoints.find(
                            (item) => item.id === currentCheckpointId,
                          );
                          if (checkpoint) void handleForkCheckpoint(checkpoint);
                        }}
                      >
                        {t.topbar.forkCheckpoint}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() =>
                        setNotice(
                          'Plugin management is not exposed by the current backend API.',
                        )
                      }
                    >
                      {t.topbar.openPlugins}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
                      {t.topbar.openSettings}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 sm:px-6">
                {displayError ? (
                  <Alert className="mb-4">
                    <AlertTitle>Connection issue</AlertTitle>
                    <AlertDescription>{displayError}</AlertDescription>
                  </Alert>
                ) : null}

                {notice ? (
                  <Alert className="mb-4">
                    <AlertTitle>Notice</AlertTitle>
                    <AlertDescription className="flex items-center justify-between gap-3">
                      <span>{notice}</span>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setNotice(null)}
                      >
                        Dismiss
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {approval ? (
                  <Alert className="mb-4 border-amber-500/40 bg-amber-500/10">
                    <AlertTitle>Approval required · {approval.name}</AlertTitle>
                    <AlertDescription>
                      <div className="mt-2 space-y-3">
                        <p>{approval.message}</p>
                        <pre className="max-h-40 overflow-auto rounded-2xl border border-border/60 bg-background/70 p-3 text-xs">
                          {JSON.stringify(approval.input, null, 2)}
                        </pre>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="destructive"
                            onClick={() => void handleApprovalDecision(false)}
                          >
                            Deny
                          </Button>
                          <Button
                            onClick={() => void handleApprovalDecision(true)}
                          >
                            Approve
                          </Button>
                        </div>
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {hookWarnings.length > 0 ? (
                  <Alert className="mb-4 border-amber-500/40">
                    <AlertTitle>Hook warnings</AlertTitle>
                    <AlertDescription>
                      {hookWarnings.map((warning) => (
                        <p key={warning.seq} className="text-xs">
                          {warning.hookId} · {warning.hookEvent} ·{' '}
                          {warning.message}
                        </p>
                      ))}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)]">
                  <section className="flex min-h-0 flex-col">
                    <div className="min-h-0 flex-1 px-2 py-2 sm:px-4">
                      <MessageScrollerProvider>
                        <MessageScroller className="h-full">
                          <MessageScrollerViewport>
                            <MessageScrollerContent className="gap-4">
                              {items.length === 0 ? (
                                <MessageScrollerItem scrollAnchor>
                                  <Empty className="min-h-[420px] border-border/60 bg-background/40">
                                    <EmptyHeader>
                                      <EmptyMedia variant="icon">
                                        <MessageCirclePlus />
                                      </EmptyMedia>
                                      <EmptyTitle>{t.empty.title}</EmptyTitle>
                                      <EmptyDescription>
                                        {t.empty.description}
                                      </EmptyDescription>
                                    </EmptyHeader>
                                    <EmptyContent>
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Check />
                                        {t.empty.sidebarReady}
                                      </div>
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Check />
                                        {t.empty.scrollerReady}
                                      </div>
                                    </EmptyContent>
                                  </Empty>
                                </MessageScrollerItem>
                              ) : (
                                items.map((item, index) =>
                                  item.kind === 'user' ? (
                                    <MessageScrollerItem key={`u-${index}`}>
                                      <Message align="end">
                                        <MessageContent>
                                          <div className="rounded-3xl border border-border/60 bg-primary/8 px-4 py-3">
                                            <p className="whitespace-pre-wrap text-sm leading-6">
                                              {item.text}
                                            </p>
                                          </div>
                                        </MessageContent>
                                      </Message>
                                    </MessageScrollerItem>
                                  ) : item.kind === 'assistant' ? (
                                    <MessageScrollerItem
                                      key={`a-${item.runId}-${index}`}
                                    >
                                      <Message>
                                        <MessageAvatar>
                                          <Avatar className="size-9">
                                            <AvatarFallback>AI</AvatarFallback>
                                          </Avatar>
                                        </MessageAvatar>
                                        <MessageContent>
                                          <div className="rounded-3xl border border-border/60 bg-background px-4 py-3">
                                            {item.thinking ? (
                                              <details className="mb-3 rounded-2xl border border-border/60 bg-muted/30 px-3 py-2">
                                                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                                                  Thinking
                                                </summary>
                                                <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
                                                  {item.thinking}
                                                </p>
                                              </details>
                                            ) : null}
                                            <p className="whitespace-pre-wrap text-sm leading-6">
                                              {item.text || '...'}
                                            </p>
                                          </div>
                                          <MessageFooter>
                                            <span>
                                              {item.finalized
                                                ? 'final'
                                                : 'streaming'}
                                            </span>
                                          </MessageFooter>
                                        </MessageContent>
                                      </Message>
                                    </MessageScrollerItem>
                                  ) : (
                                    <MessageScrollerItem key={item.toolUseId}>
                                      <div className="rounded-3xl border border-border/60 bg-muted/20 px-4 py-3">
                                        <p className="text-xs font-medium text-muted-foreground">
                                          Tool call · {item.name}
                                          {formatToolSourceLabel(item.source)
                                            ? ` · ${formatToolSourceLabel(item.source)}`
                                            : ''}
                                          {item.result
                                            ? item.result.isError
                                              ? ' · error'
                                              : ' · done'
                                            : ' · running'}
                                        </p>
                                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-foreground/80">
                                          {JSON.stringify(item.input, null, 2)}
                                        </pre>
                                        {item.result ? (
                                          <pre
                                            className={cn(
                                              'mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border/60 bg-background/70 p-3 text-xs',
                                              item.result.isError &&
                                                'text-destructive',
                                            )}
                                          >
                                            {item.result.content}
                                          </pre>
                                        ) : null}
                                      </div>
                                    </MessageScrollerItem>
                                  ),
                                )
                              )}
                            </MessageScrollerContent>
                          </MessageScrollerViewport>
                          <MessageScrollerButton />
                        </MessageScroller>
                      </MessageScrollerProvider>
                    </div>

                    <div className="rounded-3xl border border-border/60 bg-card/80 pt-1.5 pb-3 shadow-sm">
                      <Textarea
                        value={draft}
                        placeholder={
                          sessionId
                            ? t.composer.placeholderReady
                            : t.composer.placeholderCreate
                        }
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void handleSend();
                          }
                        }}
                        className="min-h-20 resize-none border-0 bg-transparent px-5 py-0 text-sm focus-visible:ring-0"
                        rows={3}
                      />

                      {attachments.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {attachments.map((attachment) => (
                            <div
                              key={attachment.path}
                              className="flex max-w-full items-center gap-2 rounded-2xl border border-border/60 bg-background/70 px-3 py-2 text-xs"
                            >
                              <Upload className="size-3.5" />
                              <span className="truncate">
                                {attachment.name}
                              </span>
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() =>
                                  setAttachments((prev) =>
                                    prev.filter(
                                      (item) => item.path !== attachment.path,
                                    ),
                                  )
                                }
                              >
                                {t.composer.remove}
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div className="mt-3 px-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={t.composer.uploadFile}
                              >
                                <PlusCircle className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem
                                disabled={pickingFile}
                                onSelect={() => void handlePickUploadFile()}
                              >
                                <Upload />
                                {pickingFile
                                  ? t.composer.openingFile
                                  : t.composer.uploadFile}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={pickingDirectory}
                                onSelect={() =>
                                  void handlePickWorkspaceDirectory()
                                }
                              >
                                <FolderRoot />
                                {pickingDirectory
                                  ? t.composer.openingFolder
                                  : t.composer.openFolder}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>

                          {visiblePermissionModes.length > 0 ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className={
                                    permissionModeTriggerClasses[permissionMode]
                                  }
                                >
                                  <ShieldCheck className="size-3.5" />
                                  <span className="max-w-[7rem] truncate">
                                    {t.permissionModes[permissionMode]}
                                  </span>
                                  <ChevronDown className="size-3 opacity-60" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent className="min-w-72">
                                <DropdownMenuLabel>
                                  {t.composer.permissionMode}
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {visiblePermissionModes.map((mode) => (
                                  <DropdownMenuItem
                                    key={mode}
                                    onSelect={() => void handleSetMode(mode)}
                                  >
                                    <span className="flex flex-col items-start gap-0.5">
                                      <span>{t.permissionModes[mode]}</span>
                                      <span className="max-w-72 text-xs leading-5 text-muted-foreground">
                                        {t.permissionModeDescriptions[mode]}
                                      </span>
                                    </span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>

                        <div className="flex items-center gap-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label={t.composer.contextWindow}
                                  >
                                    <CircularProgress value={contextProgress} />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent className="w-72">
                                  <DropdownMenuLabel>
                                    {t.composer.contextWindow}
                                  </DropdownMenuLabel>
                                  <DropdownMenuSeparator />
                                  <div className="px-2 py-2">
                                    <Progress value={contextProgress} />
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      {Math.round(contextProgress)}%{' '}
                                      {t.composer.contextPercent}
                                    </p>
                                  </div>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    disabled={!sessionId || compacting}
                                    onSelect={() => void handleCompact()}
                                  >
                                    <span className="flex flex-col items-start gap-0.5">
                                      <span className="text-sm">
                                        {compacting
                                          ? t.composer.compacting
                                          : t.composer.compact}
                                      </span>
                                      <span className="text-xs text-muted-foreground">
                                        {t.composer.compactDescription}
                                      </span>
                                    </span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t.composer.contextWindow} ·{' '}
                              {Math.round(contextProgress)}%
                            </TooltipContent>
                          </Tooltip>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="xs">
                                <Cpu className="size-3.5" />
                                <span className="max-w-[6rem] truncate">
                                  {preset.label}
                                </span>
                                <ChevronDown className="size-3 text-muted-foreground" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="min-w-44">
                              <DropdownMenuLabel>
                                {t.composer.model}
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {visibleModelPresets.map((item) => (
                                <DropdownMenuItem
                                  key={item.id}
                                  disabled={!!sessionId}
                                  onSelect={() => {
                                    setPresetId(item.id);
                                    setRemoteModels([]);
                                    setModelStatus(null);
                                  }}
                                >
                                  {item.label}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>

                          <Button
                              variant="ghost"
                              size="icon-xs"
                              onClick={handleMicClick}
                              aria-label="Voice input"
                              className={
                                listening
                                  ? 'text-red-500 hover:text-red-500 animate-pulse'
                                  : ''
                              }
                            >
                              <Mic className="size-3.5" />
                            </Button>
                            {runStatus === 'running' ? (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                onClick={() => void handleCancel()}
                                className="ml-1 text-destructive hover:text-destructive"
                              >
                                <Square className="size-3.5" />
                              </Button>
                            ) : (
                              <Button
                                variant="default"
                                size="icon-xs"
                                onClick={() => void handleSend()}
                                disabled={
                                  !sessionId ||
                                  (!draft.trim() && attachments.length === 0)
                                }
                                className="ml-1 rounded-full bg-foreground text-background hover:bg-foreground/85"
                              >
                                <ArrowUp className="size-3.5" />
                              </Button>
                            )}
                        </div>
                      </div>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarProvider>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="agent-compact-ui h-[88svh] max-h-[calc(100svh-2rem)] min-h-[min(520px,calc(100svh-2rem))] w-[92vw] max-w-[92vw] overflow-hidden p-0 sm:h-[86svh] sm:w-[88vw] sm:max-w-[88vw] md:min-h-[min(620px,calc(100svh-2rem))]">
          <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)]">
            <aside className="border-b border-border/60 bg-muted/30 p-4 md:border-b-0 md:border-r">
              <div className="flex items-center gap-3 px-2 py-2">
                <Settings />
                <span className="text-base font-medium">
                  {t.settings.title}
                </span>
              </div>
              <div className="mt-6 flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
                {settingsSections.map((section) => {
                  const SectionIcon = section.icon;
                  return (
                    <Button
                      key={section.id}
                      variant={
                        activeSettingsSection === section.id
                          ? 'secondary'
                          : 'ghost'
                      }
                      className="justify-start"
                      onClick={() => setActiveSettingsSection(section.id)}
                    >
                      <SectionIcon />
                      {t.settings[section.id]}
                    </Button>
                  );
                })}
              </div>
            </aside>

            <div className="min-w-0 overflow-y-auto px-6 py-7 md:px-10">
              <div className="flex flex-col gap-4 pr-12 sm:flex-row sm:items-start sm:justify-between">
                <DialogHeader className="max-w-3xl">
                  <DialogTitle className="text-2xl">
                    {t.settings[activeSettingsSection]}
                  </DialogTitle>
                  <DialogDescription className="max-w-2xl text-base leading-7">
                    {t.settings.description}
                  </DialogDescription>
                </DialogHeader>
                {activeSettingsSection === 'model' ? (
                  <Button
                    onClick={() => void handleTestModel()}
                    disabled={testingModel}
                    className="w-fit shrink-0 sm:mr-2"
                  >
                    <TestTube2 />
                    {testingModel ? t.settings.testing : t.settings.test}
                  </Button>
                ) : null}
              </div>

              {activeSettingsSection === 'general' ? (
                <div className="mt-8 flex max-w-4xl flex-col gap-5">
                  <section className="grid items-center gap-4 rounded-3xl border border-border/60 bg-background/70 p-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="flex min-w-0 items-start gap-3">
                      <Languages />
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium">
                          {t.settings.language}
                        </h3>
                        <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                          {t.settings.languageDescription}
                        </p>
                      </div>
                    </div>
                    <Select
                      value={preferences.language}
                      onValueChange={handleSetLanguage}
                    >
                      <SelectTrigger className="w-full sm:w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {Object.entries(languageNames).map(
                            ([language, label]) => (
                              <SelectItem key={language} value={language}>
                                {label}
                              </SelectItem>
                            ),
                          )}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </section>

                  <section className="grid items-center gap-4 rounded-3xl border border-border/60 bg-background/70 p-5 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="flex min-w-0 items-start gap-3">
                      <SunMoon />
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium">
                          {t.settings.theme}
                        </h3>
                        <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                          {t.settings.themeDescription}
                        </p>
                      </div>
                    </div>
                    <Select
                      value={preferences.theme}
                      onValueChange={handleSetTheme}
                    >
                      <SelectTrigger className="w-full sm:w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="system">
                            {t.settings.themeSystem}
                          </SelectItem>
                          <SelectItem value="light">
                            {t.settings.themeLight}
                          </SelectItem>
                          <SelectItem value="dark">
                            {t.settings.themeDark}
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </section>

                  <section className="rounded-3xl border border-border/60 bg-background/70">
                    <div className="flex items-start gap-3 p-5">
                      <ShieldCheck />
                      <div>
                        <h3 className="text-sm font-medium">
                          {t.settings.permissions}
                        </h3>
                        <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
                          {t.settings.permissionsDescription}
                        </p>
                      </div>
                    </div>
                    <div className="border-t border-border/60">
                      {PERMISSION_MODES.map((mode) => (
                        <div
                          key={mode}
                          className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-4 last:border-b-0"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm font-medium">
                              {t.permissionModes[mode]}
                            </span>
                            <span className="mt-1 block max-w-2xl text-sm leading-6 text-muted-foreground">
                              {t.permissionModeDescriptions[mode]}
                            </span>
                          </span>
                          <Switch
                            checked={preferences.permissionModeVisibility[mode]}
                            onCheckedChange={(checked) =>
                              handleSetPermissionVisibility(mode, checked)
                            }
                            aria-label={t.permissionModes[mode]}
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              ) : activeSettingsSection === 'model' ? (
                <div className="mt-8 flex max-w-5xl flex-col gap-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <h3 className="text-sm font-medium">
                        {t.settings.modelTemplates}
                      </h3>
                      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                        {t.settings.modelTemplatesDescription}
                      </p>
                    </div>
                    {loadingModelPresets ? (
                      <span className="text-xs text-muted-foreground">
                        {t.settings.fetchingModels}
                      </span>
                    ) : null}
                  </div>

                  {modelPresets.map((item) => {
                    const itemEnabled = visibleModelPresetIds.includes(item.id);
                    const itemSelected = preset.id === item.id;
                    const itemCustom = item.id === 'custom';
                    const itemApiKey = itemCustom
                      ? customApiKey
                      : (presetApiKeys[item.id] ?? '');
                    const itemModel = itemCustom
                      ? customModel
                      : (presetModelOverrides[item.id] ?? '');

                    return (
                      <section
                        key={item.id}
                        className={cn(
                          'rounded-3xl border border-border/60 bg-background/70 p-5 transition-colors',
                          itemSelected && 'border-primary/45 bg-primary/8',
                          !itemEnabled && 'bg-muted/20 opacity-75',
                        )}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              setPresetId(item.id);
                              setModelStatus(null);
                              setRemoteModels([]);
                            }}
                          >
                            <span className="block text-sm font-medium">
                              {item.label}
                            </span>
                            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                              {itemCustom
                                ? t.settings.customModelDescription
                                : t.settings.namedModelDescription}
                            </span>
                            <span className="mt-3 block truncate font-mono text-xs text-muted-foreground">
                              {item.baseURL ?? 'provider default'} ·{' '}
                              {item.defaultModel ?? 'model default'}
                            </span>
                          </button>
                          <div className="flex shrink-0 items-center gap-2 pt-0.5">
                            <span className="text-xs text-muted-foreground">
                              {itemEnabled
                                ? t.settings.templateEnabled
                                : t.settings.templateDisabled}
                            </span>
                            <Switch
                              checked={itemEnabled}
                              onCheckedChange={(checked) =>
                                handleSetModelPresetVisibility(
                                  item.id,
                                  checked,
                                )
                              }
                              aria-label={`${item.label} ${
                                itemEnabled
                                  ? t.settings.templateEnabled
                                  : t.settings.templateDisabled
                              }`}
                            />
                          </div>
                        </div>

                        <div className="mt-5 grid gap-4 sm:grid-cols-2">
                          {itemCustom ? (
                            <>
                              <label className="flex flex-col gap-2 text-sm font-medium">
                                {t.settings.protocol}
                                <Select
                                  value={customProtocol}
                                  disabled={!!sessionId}
                                  onValueChange={(value) =>
                                    setCustomProtocol(value as ModelProtocol)
                                  }
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      <SelectItem value="openai">
                                        openai
                                      </SelectItem>
                                      <SelectItem value="anthropic">
                                        anthropic
                                      </SelectItem>
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              </label>
                              <label className="flex flex-col gap-2 text-sm font-medium">
                                {t.settings.baseUrl}
                                <Input
                                  placeholder="https://api.example.com/v1"
                                  value={customBaseURL}
                                  disabled={!!sessionId}
                                  onChange={(e) =>
                                    setCustomBaseURL(e.target.value)
                                  }
                                />
                              </label>
                            </>
                          ) : null}

                          <label className="flex flex-col gap-2 text-sm font-medium">
                            {t.settings.apiKey}
                            <Input
                              type="password"
                              autoComplete="off"
                              value={itemApiKey}
                              disabled={!!sessionId}
                              onChange={(e) =>
                                itemCustom
                                  ? setCustomApiKey(e.target.value)
                                  : handleSetPresetApiKey(
                                      item.id,
                                      e.target.value,
                                    )
                              }
                            />
                          </label>

                          <label className="flex flex-col gap-2 text-sm font-medium">
                            {t.settings.modelId}
                            <Input
                              placeholder={item.defaultModel ?? 'model-id'}
                              value={itemModel}
                              disabled={!!sessionId}
                              onChange={(e) =>
                                itemCustom
                                  ? setCustomModel(e.target.value)
                                  : setPresetModelOverrides((prev) => ({
                                      ...prev,
                                      [item.id]: e.target.value,
                                    }))
                              }
                            />
                          </label>
                        </div>

                        {itemSelected ? (
                          <div className="mt-5 flex flex-wrap items-center gap-3">
                            <Button
                              variant="outline"
                              disabled={!canFetchRemoteModels || fetchingModels}
                              onClick={() => void handleFetchRemoteModels()}
                            >
                              <RefreshCw />
                              {fetchingModels
                                ? t.settings.fetchingModels
                                : t.settings.fetchModels}
                            </Button>

                            {remoteModels.length > 0 ? (
                              <Select
                                value={selectedRemoteModel}
                                onValueChange={(model) =>
                                  itemCustom
                                    ? setCustomModel(model)
                                    : setPresetModelOverrides((prev) => ({
                                        ...prev,
                                        [item.id]: model,
                                      }))
                                }
                                disabled={!!sessionId}
                              >
                                <SelectTrigger className="w-full sm:w-72">
                                  <SelectValue
                                    placeholder={t.settings.chooseRemoteModel}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {remoteModels.map((model) => (
                                      <SelectItem key={model} value={model}>
                                        {model}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            ) : null}
                          </div>
                        ) : null}
                      </section>
                    );
                  })}

                  {modelStatus ? (
                    <div
                      className={cn(
                        'flex items-start gap-3 rounded-3xl border p-4 text-sm',
                        modelStatus.type === 'success'
                          ? 'border-primary/30 bg-primary/8'
                          : 'border-destructive/40 bg-destructive/10 text-destructive',
                      )}
                    >
                      {modelStatus.type === 'success' ? (
                        <CheckCircle2 />
                      ) : (
                        <AlertCircle />
                      )}
                      <span className="break-words">{modelStatus.message}</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-6 rounded-3xl border border-dashed border-border/70 p-6 text-sm text-muted-foreground">
                  {t.settings.comingNext}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Sheet open={diffOpen} onOpenChange={setDiffOpen}>
        <SheetContent
          side="right"
          className="agent-compact-ui w-full sm:max-w-2xl"
        >
          <SheetHeader>
            <SheetTitle>Edit proposals</SheetTitle>
            <SheetDescription>
              Review backend edit proposals, approve or reject them, and inspect
              patch details.
            </SheetDescription>
          </SheetHeader>
          {orderedEditProposals.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-border/70 p-6 text-sm text-muted-foreground">
              No edit proposals have streamed in yet.
            </div>
          ) : (
            <div className="mt-6 grid min-h-0 gap-4">
              <div className="flex flex-wrap gap-2">
                {orderedEditProposals.map((proposal) => (
                  <Button
                    key={proposal.proposalId}
                    variant={
                      proposal.proposalId === selectedProposal?.proposalId
                        ? 'default'
                        : 'outline'
                    }
                    size="sm"
                    onClick={() => {
                      setSelectedProposalId(proposal.proposalId);
                      setSelectedPatchPath(proposal.patches[0]?.path ?? null);
                    }}
                  >
                    {proposal.status} · {proposal.patches.length}
                  </Button>
                ))}
              </div>

              {selectedProposal ? (
                <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {selectedProposal.proposalId}
                      </p>
                      <p className="text-sm font-medium">
                        {selectedProposal.status}
                        {selectedProposal.reason
                          ? ` · ${selectedProposal.reason}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={selectedProposal.status !== 'proposed'}
                        onClick={() =>
                          void handleEditDecision(
                            selectedProposal.proposalId,
                            'reject',
                          )
                        }
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        disabled={selectedProposal.status !== 'proposed'}
                        onClick={() =>
                          void handleEditDecision(
                            selectedProposal.proposalId,
                            'approve',
                          )
                        }
                      >
                        Approve
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {selectedProposal.patches.map((patch) => {
                      const counts = patchCounts(patch);
                      return (
                        <Button
                          key={patch.path}
                          variant={
                            selectedPatch?.path === patch.path
                              ? 'default'
                              : 'outline'
                          }
                          size="xs"
                          onClick={() => setSelectedPatchPath(patch.path)}
                        >
                          {patchStatusLabel(patch.status)} · +{counts.added} -
                          {counts.removed}
                        </Button>
                      );
                    })}
                  </div>

                  {selectedPatch ? (
                    <PatchPreview patch={selectedPatch} />
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

function PatchPreview({ patch }: { patch: FilePatch }): ReactNode {
  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-border/60">
      <div className="border-b border-border/60 bg-muted/30 px-3 py-2">
        <p className="break-all font-mono text-xs">{patch.path}</p>
      </div>
      <div className="max-h-[52vh] overflow-auto bg-background">
        {patch.hunks.map((hunk, hunkIndex) => (
          <div key={`${patch.path}-${String(hunkIndex)}`}>
            <div className="bg-muted/40 px-3 py-1 font-mono text-[11px] text-muted-foreground">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
              {hunk.newLines} @@
            </div>
            {hunk.lines.map((line, lineIndex) => (
              <div
                key={`${patch.path}-${String(hunkIndex)}-${String(lineIndex)}`}
                className={cn(
                  'grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 px-3 py-1 font-mono text-xs',
                  patchLineTone(line.kind),
                )}
              >
                <span className="select-none text-muted-foreground">
                  {line.oldNumber ?? ''}
                  {line.oldNumber || line.newNumber ? ' / ' : ''}
                  {line.newNumber ?? ''}
                </span>
                <span className="whitespace-pre-wrap break-words">
                  {line.kind === 'added'
                    ? '+'
                    : line.kind === 'removed'
                      ? '-'
                      : ' '}
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const CIRCLE_RADIUS = 9;
const CIRCLE_CIRCUM = 2 * Math.PI * CIRCLE_RADIUS;

function CircularProgress({ value }: { value: number }) {
  const offset = CIRCLE_CIRCUM * (1 - Math.min(100, Math.max(0, value)) / 100);
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 rotate-[-90deg]"
      fill="none"
      strokeLinecap="round"
    >
      <circle
        cx="12"
        cy="12"
        r={CIRCLE_RADIUS}
        className="stroke-muted-foreground/30"
        strokeWidth={2}
      />
      <circle
        cx="12"
        cy="12"
        r={CIRCLE_RADIUS}
        className="stroke-primary transition-[stroke-dashoffset] duration-300"
        strokeWidth={2}
        strokeDasharray={CIRCLE_CIRCUM}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

function patchLineTone(
  kind: FilePatch['hunks'][number]['lines'][number]['kind'],
): string {
  switch (kind) {
    case 'added':
      return 'bg-emerald-500/10';
    case 'removed':
      return 'bg-destructive/10';
    default:
      return 'bg-background';
  }
}
