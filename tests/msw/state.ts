import type { AppId } from "@/lib/api/types";
import type {
  YuanhengAnnouncementFeed,
  YuanhengConnectionStatus,
  YuanhengReasoningLevel,
  YuanhengToolId,
  YuanhengToolConfigureResult,
  YuanhengToolStatus,
} from "@/lib/api/yuanheng";
import type {
  McpServer,
  Provider,
  SessionMessage,
  SessionMeta,
  Settings,
} from "@/types";
import { deepClone } from "@/utils/deepClone";

type ProvidersByApp = Record<AppId, Record<string, Provider>>;
type CurrentProviderState = Record<AppId, string>;
type McpConfigState = Record<AppId, Record<string, McpServer>>;
type LiveProviderIdsByApp = Record<
  "opencode" | "openclaw" | "hermes",
  string[]
>;

const createDefaultProviders = (): ProvidersByApp => ({
  claude: {
    "claude-1": {
      id: "claude-1",
      name: "Claude Default",
      settingsConfig: {},
      category: "official",
      sortIndex: 0,
      createdAt: Date.now(),
    },
    "claude-2": {
      id: "claude-2",
      name: "Claude Custom",
      settingsConfig: {},
      category: "custom",
      sortIndex: 1,
      createdAt: Date.now() + 1,
    },
  },
  "claude-desktop": {},
  codex: {
    "codex-1": {
      id: "codex-1",
      name: "Codex Default",
      settingsConfig: {},
      category: "official",
      sortIndex: 0,
      createdAt: Date.now(),
    },
    "codex-2": {
      id: "codex-2",
      name: "Codex Secondary",
      settingsConfig: {},
      category: "custom",
      sortIndex: 1,
      createdAt: Date.now() + 1,
    },
  },
  gemini: {
    "gemini-1": {
      id: "gemini-1",
      name: "Gemini Default",
      settingsConfig: {
        env: {
          GEMINI_API_KEY: "test-key",
          GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com",
        },
      },
      category: "official",
      sortIndex: 0,
      createdAt: Date.now(),
    },
  },
  grokbuild: {},
  opencode: {},
  openclaw: {},
  hermes: {},
});

const createDefaultCurrent = (): CurrentProviderState => ({
  claude: "claude-1",
  "claude-desktop": "",
  codex: "codex-1",
  gemini: "gemini-1",
  grokbuild: "",
  opencode: "",
  openclaw: "",
  hermes: "",
});

let providers = createDefaultProviders();
let current = createDefaultCurrent();
let liveProviderIds: LiveProviderIdsByApp = {
  opencode: [],
  openclaw: [],
  hermes: [],
};
let settingsState: Settings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  enableClaudePluginIntegration: false,
  claudeConfigDir: "/default/claude",
  codexConfigDir: "/default/codex",
  language: "zh-CN",
};
let appConfigDirOverride: string | null = null;
const sessionMessageKey = (providerId: string, sourcePath: string) =>
  `${providerId}:${sourcePath}`;

const createDefaultSessions = (): SessionMeta[] => {
  const now = Date.now();
  return [
    {
      providerId: "codex",
      sessionId: "codex-session-1",
      title: "Codex Session One",
      summary: "Codex summary",
      projectDir: "/mock/codex",
      createdAt: now - 2000,
      lastActiveAt: now - 1000,
      sourcePath: "/mock/codex/session-1.jsonl",
      resumeCommand: "codex resume codex-session-1",
    },
    {
      providerId: "claude",
      sessionId: "claude-session-1",
      title: "Claude Session One",
      summary: "Claude summary",
      projectDir: "/mock/claude",
      createdAt: now - 4000,
      lastActiveAt: now - 3000,
      sourcePath: "/mock/claude/session-1.jsonl",
      resumeCommand: "claude --resume claude-session-1",
    },
  ];
};

const createDefaultSessionMessages = (): Record<string, SessionMessage[]> => ({
  [sessionMessageKey("codex", "/mock/codex/session-1.jsonl")]: [
    {
      role: "user",
      content: "First codex message",
      ts: Date.now() - 1000,
    },
  ],
  [sessionMessageKey("claude", "/mock/claude/session-1.jsonl")]: [
    {
      role: "user",
      content: "First claude message",
      ts: Date.now() - 3000,
    },
  ],
});

let sessionsState = createDefaultSessions();
let sessionMessagesState = createDefaultSessionMessages();
let mcpConfigs: McpConfigState = {
  claude: {
    sample: {
      id: "sample",
      name: "Sample Claude Server",
      enabled: true,
      apps: {
        claude: true,
        codex: false,
        gemini: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      },
      server: {
        type: "stdio",
        command: "claude-server",
      },
    },
  },
  "claude-desktop": {},
  codex: {
    httpServer: {
      id: "httpServer",
      name: "HTTP Codex Server",
      enabled: false,
      apps: {
        claude: false,
        codex: true,
        gemini: false,
        opencode: false,
        openclaw: false,
        hermes: false,
      },
      server: {
        type: "http",
        url: "http://localhost:3000",
      },
    },
  },
  gemini: {},
  grokbuild: {},
  opencode: {},
  openclaw: {},
  hermes: {},
};

const disconnectedYuanheng = (): YuanhengConnectionStatus => ({
  connected: false,
  baseUrl: "https://cn.meta-api.vip",
  userId: null,
  account: null,
  models: [],
  groups: [],
  modelGroups: {},
  reasoningLevels: {},
  announcement: null,
  lastSyncedAt: null,
});

const emptyToolStatuses = (): YuanhengToolStatus[] =>
  [
    "claude",
    "claude-desktop",
    "codex",
    "chatgpt-desktop",
    "workbuddy",
    "dsh",
    "gemini",
    "grokbuild",
    "opencode",
    "openclaw",
    "hermes",
  ].map((app) => ({
    app: app as YuanhengToolId,
    supported: false,
    configured: false,
    needsUpdate: false,
    model: null,
    reasoning: "auto",
    recommendedModel: null,
    message: "账号中暂时没有可用模型",
  }));

let yuanhengConnectionState = disconnectedYuanheng();
let yuanhengAnnouncementFeed: YuanhengAnnouncementFeed = {
  enabled: false,
  announcements: [],
  source: "platform",
};
let yuanhengToolStatuses = emptyToolStatuses();
let configuredToolCalls: YuanhengToolId[][] = [];
let configuredToolGroupCalls: Partial<Record<YuanhengToolId, string>>[] = [];
let configuredToolReasoningCalls: Partial<
  Record<YuanhengToolId, YuanhengReasoningLevel>
>[] = [];
let launchedToolCalls: YuanhengToolId[] = [];
let restartedToolCalls: YuanhengToolId[] = [];
let toolLaunchDirectories: Partial<Record<YuanhengToolId, string>> = {};
let launchedToolRequests: Array<{
  app: YuanhengToolId;
  cwd: string | null;
}> = [];

const cloneProviders = (value: ProvidersByApp) =>
  deepClone(value) as ProvidersByApp;

type SessionSyncFixture = {
  targets: string[];
  pending: Record<string, unknown>;
  states: unknown[];
  runCalls: Array<{ targetProvider: string; scope?: unknown }>;
  undoCalls: Array<{ targetProvider: string; targetSessionId: string }>;
  launchChecks: Array<{ targetProvider: string; projectDir: string | null }>;
  muteCalls: Array<{ targetProvider: string; projectDirs: string[] }>;
  prefs: { promptOnLaunch: boolean; muted: unknown[] };
  failLaunchCheck: boolean;
  failRun: boolean;
};

const createDefaultSessionSync = (): SessionSyncFixture => ({
  targets: ["claude", "codex"],
  pending: {},
  states: [],
  runCalls: [],
  undoCalls: [],
  launchChecks: [],
  muteCalls: [],
  prefs: { promptOnLaunch: true, muted: [] },
  failLaunchCheck: false,
  failRun: false,
});

let sessionSyncState = createDefaultSessionSync();

export const getSessionSyncState = () => sessionSyncState;
export const setSessionSyncFixtures = (
  next: Partial<
    Omit<
      SessionSyncFixture,
      "runCalls" | "undoCalls" | "launchChecks" | "muteCalls"
    >
  >,
) => {
  sessionSyncState = { ...sessionSyncState, ...next };
};

export const resetProviderState = () => {
  sessionSyncState = createDefaultSessionSync();
  providers = createDefaultProviders();
  current = createDefaultCurrent();
  liveProviderIds = {
    opencode: [],
    openclaw: [],
    hermes: [],
  };
  sessionsState = createDefaultSessions();
  sessionMessagesState = createDefaultSessionMessages();
  settingsState = {
    showInTray: true,
    minimizeToTrayOnClose: true,
    enableClaudePluginIntegration: false,
    claudeConfigDir: "/default/claude",
    codexConfigDir: "/default/codex",
    language: "zh-CN",
  };
  appConfigDirOverride = null;
  mcpConfigs = {
    claude: {
      sample: {
        id: "sample",
        name: "Sample Claude Server",
        enabled: true,
        apps: {
          claude: true,
          codex: false,
          gemini: false,
          opencode: false,
          openclaw: false,
          hermes: false,
        },
        server: {
          type: "stdio",
          command: "claude-server",
        },
      },
    },
    "claude-desktop": {},
    codex: {
      httpServer: {
        id: "httpServer",
        name: "HTTP Codex Server",
        enabled: false,
        apps: {
          claude: false,
          codex: true,
          gemini: false,
          opencode: false,
          openclaw: false,
          hermes: false,
        },
        server: {
          type: "http",
          url: "http://localhost:3000",
        },
      },
    },
    gemini: {},
    grokbuild: {},
    opencode: {},
    openclaw: {},
    hermes: {},
  };
  yuanhengConnectionState = disconnectedYuanheng();
  yuanhengAnnouncementFeed = {
    enabled: false,
    announcements: [],
    source: "platform",
  };
  yuanhengToolStatuses = emptyToolStatuses();
  configuredToolCalls = [];
  configuredToolGroupCalls = [];
  configuredToolReasoningCalls = [];
  launchedToolCalls = [];
  restartedToolCalls = [];
  toolLaunchDirectories = {};
  launchedToolRequests = [];
};

export const getYuanhengConnection = () =>
  deepClone(yuanhengConnectionState) as YuanhengConnectionStatus;

export const getYuanhengAnnouncements = () =>
  deepClone(yuanhengAnnouncementFeed) as YuanhengAnnouncementFeed;

export const setYuanhengAnnouncements = (feed: YuanhengAnnouncementFeed) => {
  yuanhengAnnouncementFeed = deepClone(feed) as YuanhengAnnouncementFeed;
};

export const setYuanhengConnection = (
  status: Partial<YuanhengConnectionStatus>,
) => {
  yuanhengConnectionState = { ...disconnectedYuanheng(), ...status };
  if (Object.prototype.hasOwnProperty.call(status, "announcement")) {
    yuanhengAnnouncementFeed = status.announcement
      ? {
          enabled: true,
          announcements: [
            {
              id: "legacy",
              content: status.announcement,
              extra: null,
              publishDate: "",
              type: "default",
            },
          ],
          source: "legacy",
        }
      : { enabled: false, announcements: [], source: "platform" };
  }
  const models = yuanhengConnectionState.models;
  yuanhengToolStatuses = emptyToolStatuses().map((item) => {
    const preferred =
      item.app === "claude" || item.app === "claude-desktop"
        ? (models.find((model) => model.includes("claude")) ??
          models.find((model) => model.includes("deepseek")) ??
          models.find((model) => model.includes("gpt")) ??
          models[0])
        : item.app === "gemini"
          ? models.find((model) => model.includes("gemini"))
          : (models.find((model) => model.includes("gpt")) ?? models[0]);
    return {
      ...item,
      supported: Boolean(preferred),
      recommendedModel: preferred ?? null,
      message: preferred ? null : item.message,
    };
  });
};

export const getYuanhengToolStatuses = () =>
  deepClone(yuanhengToolStatuses) as YuanhengToolStatus[];

export const setYuanhengToolStatus = (
  app: YuanhengToolId,
  status: Partial<YuanhengToolStatus>,
) => {
  const current = yuanhengToolStatuses.find((item) => item.app === app);
  if (current) Object.assign(current, status);
};

export const configureYuanhengTools = (
  apps: YuanhengToolId[],
  models: Partial<Record<YuanhengToolId, string>> = {},
  groups: Partial<Record<YuanhengToolId, string>> = {},
  reasoning: Partial<Record<YuanhengToolId, YuanhengReasoningLevel>> = {},
): YuanhengToolConfigureResult[] => {
  configuredToolCalls.push([...apps]);
  configuredToolGroupCalls.push({ ...groups });
  configuredToolReasoningCalls.push({ ...reasoning });
  return apps.map((app) => {
    const status = yuanhengToolStatuses.find((item) => item.app === app);
    if (!status?.supported) {
      return {
        app,
        configured: false,
        model: null,
        warnings: [],
        error: "当前账号没有兼容模型",
      };
    }
    const model = models[app] ?? status.recommendedModel;
    status.configured = true;
    status.needsUpdate = false;
    status.model = model;
    status.group = groups[app] ?? null;
    status.reasoning = reasoning[app] ?? "auto";
    status.message = "元衡配置已写入";
    return {
      app,
      configured: true,
      model,
      warnings: [],
      error: null,
    };
  });
};

export const recordToolLaunch = (app: YuanhengToolId, cwd?: string | null) => {
  launchedToolCalls.push(app);
  launchedToolRequests.push({ app, cwd: cwd ?? null });
};
export const recordToolRestart = (app: YuanhengToolId) =>
  restartedToolCalls.push(app);
export const getToolLaunchDirectory = (app: YuanhengToolId) =>
  toolLaunchDirectories[app] ?? null;
export const setToolLaunchDirectory = (app: YuanhengToolId, cwd: string) => {
  toolLaunchDirectories[app] = cwd;
  return cwd;
};
export const getConfiguredToolCalls = () => [...configuredToolCalls];
export const getConfiguredToolGroupCalls = () => [...configuredToolGroupCalls];
export const getConfiguredToolReasoningCalls = () => [
  ...configuredToolReasoningCalls,
];
export const getLaunchedToolCalls = () => [...launchedToolCalls];
export const getLaunchedToolRequests = () => [...launchedToolRequests];
export const getRestartedToolCalls = () => [...restartedToolCalls];

export const getProviders = (appType: AppId) =>
  cloneProviders(providers)[appType] ?? {};

export const getCurrentProviderId = (appType: AppId) => current[appType] ?? "";

export const getLiveProviderIds = (
  appType: "opencode" | "openclaw" | "hermes",
) => [...liveProviderIds[appType]];

export const setLiveProviderIds = (
  appType: "opencode" | "openclaw" | "hermes",
  ids: string[],
) => {
  liveProviderIds[appType] = [...ids];
};

export const setCurrentProviderId = (appType: AppId, providerId: string) => {
  current[appType] = providerId;
};

export const updateProviders = (
  appType: AppId,
  data: Record<string, Provider>,
) => {
  providers[appType] = cloneProviders({ [appType]: data } as ProvidersByApp)[
    appType
  ];
};

export const setProviders = (
  appType: AppId,
  data: Record<string, Provider>,
) => {
  providers[appType] = deepClone(data) as Record<string, Provider>;
};

export const addProvider = (appType: AppId, provider: Provider) => {
  providers[appType] = providers[appType] ?? {};
  providers[appType][provider.id] = provider;
};

export const updateProvider = (appType: AppId, provider: Provider) => {
  if (!providers[appType]) return;
  providers[appType][provider.id] = {
    ...providers[appType][provider.id],
    ...provider,
  };
};

export const deleteProvider = (appType: AppId, providerId: string) => {
  if (!providers[appType]) return;
  delete providers[appType][providerId];
  if (current[appType] === providerId) {
    const fallback = Object.keys(providers[appType])[0] ?? "";
    current[appType] = fallback;
  }
};

export const updateSortOrder = (
  appType: AppId,
  updates: { id: string; sortIndex: number }[],
) => {
  if (!providers[appType]) return;
  updates.forEach(({ id, sortIndex }) => {
    const provider = providers[appType][id];
    if (provider) {
      providers[appType][id] = { ...provider, sortIndex };
    }
  });
};

export const listProviders = (appType: AppId) =>
  deepClone(providers[appType] ?? {}) as Record<string, Provider>;

export const getSettings = () => deepClone(settingsState) as Settings;

export const setSettings = (data: Partial<Settings>) => {
  settingsState = { ...settingsState, ...data };
};

export const getAppConfigDirOverride = () => appConfigDirOverride;

export const setAppConfigDirOverrideState = (value: string | null) => {
  appConfigDirOverride = value;
};

export const getMcpConfig = (appType: AppId) => {
  const servers = deepClone(mcpConfigs[appType] ?? {}) as Record<
    string,
    McpServer
  >;
  return {
    configPath: `/mock/${appType}.mcp.json`,
    servers,
  };
};

export const setMcpConfig = (
  appType: AppId,
  value: Record<string, McpServer>,
) => {
  mcpConfigs[appType] = deepClone(value) as Record<string, McpServer>;
};

export const setMcpServerEnabled = (
  appType: AppId,
  id: string,
  enabled: boolean,
) => {
  if (!mcpConfigs[appType]?.[id]) return;
  mcpConfigs[appType][id] = {
    ...mcpConfigs[appType][id],
    enabled,
  };
};

export const upsertMcpServer = (
  appType: AppId,
  id: string,
  server: McpServer,
) => {
  if (!mcpConfigs[appType]) {
    mcpConfigs[appType] = {};
  }
  mcpConfigs[appType][id] = deepClone(server) as McpServer;
};

export const deleteMcpServer = (appType: AppId, id: string) => {
  if (!mcpConfigs[appType]) return;
  delete mcpConfigs[appType][id];
};

export const listSessions = () => deepClone(sessionsState) as SessionMeta[];

export const getSessionMessages = (providerId: string, sourcePath: string) =>
  deepClone(
    sessionMessagesState[sessionMessageKey(providerId, sourcePath)] ?? [],
  ) as SessionMessage[];

export const deleteSession = (
  providerId: string,
  sessionId: string,
  sourcePath: string,
) => {
  sessionsState = sessionsState.filter(
    (session) =>
      !(
        session.providerId === providerId &&
        session.sessionId === sessionId &&
        session.sourcePath === sourcePath
      ),
  );
  delete sessionMessagesState[sessionMessageKey(providerId, sourcePath)];
  return true;
};

export const setSessionFixtures = (
  sessions: SessionMeta[],
  messages: Record<string, SessionMessage[]>,
) => {
  sessionsState = deepClone(sessions) as SessionMeta[];
  sessionMessagesState = deepClone(messages) as Record<
    string,
    SessionMessage[]
  >;
};
