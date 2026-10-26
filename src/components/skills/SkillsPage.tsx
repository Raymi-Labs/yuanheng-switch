import {
  useState,
  useMemo,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  Search,
  Loader2,
  Settings,
  ShieldCheck,
  ShieldAlert,
  Store,
  type LucideIcon,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { SkillCard } from "./SkillCard";
import { RepoManagerPanel } from "./RepoManagerPanel";
import {
  useDiscoverableSkills,
  useInstalledSkills,
  useInstallSkill,
  useSkillRepos,
  useAddSkillRepo,
  useRemoveSkillRepo,
  useSearchSkillsSh,
} from "@/hooks/useSkills";
import type { AppId } from "@/lib/api/types";
import type {
  DiscoverableSkill,
  SkillSecurityReport,
  SkillRepo,
  SkillsShDiscoverableSkill,
} from "@/lib/api/skills";
import { formatSkillError } from "@/lib/errors/skillErrorParser";
import { settingsApi, skillsApi } from "@/lib/api";
import { APP_ICON_MAP, SKILLS_APP_IDS } from "@/config/appConfig";

export type SkillsPageSource = "repos" | "skillssh";

interface SkillsPageProps {
  initialApp?: AppId;
  initialSource?: SkillsPageSource;
  onSourceChange?: (source: SkillsPageSource) => void;
}

export interface SkillsPageHandle {
  refresh: () => void;
  openRepoManager: () => void;
}

type SkillsPageHeaderAction = {
  key: string;
  sources: readonly SkillsPageSource[];
  labelKey: string;
  Icon: LucideIcon;
  execute: (page: SkillsPageHandle | null) => void;
};

const SKILLS_PAGE_HEADER_ACTIONS: readonly SkillsPageHeaderAction[] = [
  {
    key: "refresh-repos",
    sources: ["repos"],
    labelKey: "skills.refresh",
    Icon: RefreshCw,
    execute: (page) => page?.refresh(),
  },
  {
    key: "manage-repos",
    sources: ["repos", "skillssh"],
    labelKey: "skills.repoManager",
    Icon: Settings,
    execute: (page) => page?.openRepoManager(),
  },
];

export const getSkillsPageHeaderActions = (source: SkillsPageSource) =>
  SKILLS_PAGE_HEADER_ACTIONS.filter((action) =>
    action.sources.includes(source),
  );

const SKILLSSH_PAGE_SIZE = 20;

export type SkillMarketCategory =
  | "all"
  | "coding"
  | "design"
  | "automation"
  | "data"
  | "content"
  | "other";

type SkillMarketSort = "relevance" | "popular" | "name";
type SkillMarketSource = "repos" | "skillssh";

type SkillMarketDetail = {
  skill: DiscoverableSkill & { installed: boolean };
  source: SkillMarketSource;
  category: Exclude<SkillMarketCategory, "all">;
  installs?: number;
};

const CATEGORY_KEYWORDS: Record<
  Exclude<SkillMarketCategory, "all" | "other">,
  readonly string[]
> = {
  coding: [
    "code",
    "coding",
    "developer",
    "git",
    "github",
    "test",
    "debug",
    "api",
    "编程",
    "开发",
    "测试",
  ],
  design: [
    "design",
    "figma",
    "image",
    "photo",
    "ui",
    "ux",
    "设计",
    "图片",
    "视觉",
  ],
  automation: [
    "automation",
    "browser",
    "workflow",
    "agent",
    "scrape",
    "自动化",
    "浏览器",
    "工作流",
  ],
  data: [
    "data",
    "database",
    "sql",
    "excel",
    "spreadsheet",
    "analytics",
    "数据",
    "表格",
    "分析",
  ],
  content: [
    "content",
    "write",
    "writing",
    "document",
    "pdf",
    "video",
    "audio",
    "内容",
    "写作",
    "文档",
    "视频",
    "音频",
  ],
};

export function inferSkillMarketCategory(
  skill: Pick<
    DiscoverableSkill,
    "name" | "description" | "directory" | "repoName"
  >,
): Exclude<SkillMarketCategory, "all"> {
  const haystack = [
    skill.name,
    skill.description,
    skill.directory,
    skill.repoName,
  ]
    .join(" ")
    .toLowerCase();
  const tokens = haystack.split(/[^a-z0-9\u3400-\u9fff]+/).filter(Boolean);
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (
      keywords.some((keyword) => {
        const normalized = keyword.toLowerCase();
        return /^[a-z0-9]+$/.test(normalized) && normalized.length <= 3
          ? tokens.includes(normalized)
          : haystack.includes(normalized);
      })
    ) {
      return category as Exclude<SkillMarketCategory, "all" | "other">;
    }
  }
  return "other";
}

function normalizeSkillTargetApp(app: AppId): AppId {
  return SKILLS_APP_IDS.includes(app) ? app : "claude";
}

function skillsShToDiscoverableSkill(
  skill: SkillsShDiscoverableSkill,
): DiscoverableSkill {
  return {
    key: skill.key,
    name: skill.name,
    description: "",
    directory: skill.directory,
    repoOwner: skill.repoOwner,
    repoName: skill.repoName,
    repoBranch: skill.repoBranch,
    readmeUrl: skill.readmeUrl,
  };
}

/**
 * Skills 发现面板
 * 用于浏览和安装来自仓库或 skills.sh 的 Skills
 */
export const SkillsPage = forwardRef<SkillsPageHandle, SkillsPageProps>(
  ({ initialApp = "claude", initialSource = "repos", onSourceChange }, ref) => {
    const { t } = useTranslation();
    const [repoManagerOpen, setRepoManagerOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [filterRepo, setFilterRepo] = useState<string>("all");
    const [filterStatus, setFilterStatus] = useState<
      "all" | "installed" | "uninstalled"
    >("all");
    const [categoryFilter, setCategoryFilter] =
      useState<SkillMarketCategory>("all");
    const [sortOrder, setSortOrder] = useState<SkillMarketSort>("relevance");
    const [targetApp, setTargetApp] = useState<AppId>(() =>
      normalizeSkillTargetApp(initialApp),
    );
    const [detail, setDetail] = useState<SkillMarketDetail | null>(null);
    const [securityReports, setSecurityReports] = useState<
      Record<string, SkillSecurityReport>
    >({});
    const [securityInspectingKey, setSecurityInspectingKey] = useState<
      string | null
    >(null);
    const [securityInspectionError, setSecurityInspectionError] = useState<
      string | null
    >(null);

    // skills.sh 搜索状态
    const [searchSource, setSearchSource] =
      useState<SkillsPageSource>(initialSource);
    const [skillsShInput, setSkillsShInput] = useState("");
    const [skillsShQuery, setSkillsShQuery] = useState("");
    const [skillsShOffset, setSkillsShOffset] = useState(0);
    const [accumulatedResults, setAccumulatedResults] = useState<
      SkillsShDiscoverableSkill[]
    >([]);

    useEffect(
      () => setTargetApp(normalizeSkillTargetApp(initialApp)),
      [initialApp],
    );

    // Queries
    const {
      data: discoverableSkills,
      isLoading: loadingDiscoverable,
      isFetching: fetchingDiscoverable,
      refetch: refetchDiscoverable,
    } = useDiscoverableSkills();
    const { data: installedSkills } = useInstalledSkills();
    const { data: repos = [], refetch: refetchRepos } = useSkillRepos();

    // skills.sh 搜索
    const {
      data: skillsShResult,
      isLoading: loadingSkillsSh,
      isFetching: fetchingSkillsSh,
      isPlaceholderData: placeholderSkillsSh,
      isError: skillsShFailed,
      refetch: refetchSkillsSh,
    } = useSearchSkillsSh(skillsShQuery, SKILLSSH_PAGE_SIZE, skillsShOffset);

    // 当搜索结果返回时累积
    useEffect(() => {
      if (skillsShResult && !placeholderSkillsSh) {
        if (skillsShOffset === 0) {
          setAccumulatedResults(skillsShResult.skills);
        } else {
          setAccumulatedResults((prev) => [...prev, ...skillsShResult.skills]);
        }
      }
    }, [skillsShResult, skillsShOffset, placeholderSkillsSh]);

    // 手动提交搜索
    const handleSkillsShSearch = () => {
      const trimmed = skillsShInput.trim();
      if (trimmed.length < 2) return;
      if (trimmed === skillsShQuery && skillsShOffset === 0) return;
      setSkillsShOffset(0);
      setAccumulatedResults([]);
      setSkillsShQuery(trimmed);
    };

    // Mutations
    const installMutation = useInstallSkill();
    const addRepoMutation = useAddSkillRepo();
    const removeRepoMutation = useRemoveSkillRepo();

    // 已安装的 skill key 集合（使用 directory + repoOwner + repoName 组合判断）
    const installedKeys = useMemo(() => {
      if (!installedSkills) return new Set<string>();
      return new Set(
        installedSkills.map((s) => {
          // 构建唯一 key：directory + repoOwner + repoName
          const owner = s.repoOwner?.toLowerCase() || "";
          const name = s.repoName?.toLowerCase() || "";
          return `${s.directory.toLowerCase()}:${owner}:${name}`;
        }),
      );
    }, [installedSkills]);

    type DiscoverableSkillItem = DiscoverableSkill & { installed: boolean };

    // 从可发现技能中提取所有仓库选项
    const repoOptions = useMemo(() => {
      if (!discoverableSkills) return [];
      const repoSet = new Set<string>();
      discoverableSkills.forEach((s) => {
        if (s.repoOwner && s.repoName) {
          repoSet.add(`${s.repoOwner}/${s.repoName}`);
        }
      });
      return Array.from(repoSet).sort();
    }, [discoverableSkills]);

    // 为发现列表补齐 installed 状态，供 SkillCard 使用
    const skills: DiscoverableSkillItem[] = useMemo(() => {
      if (!discoverableSkills) return [];
      return discoverableSkills.map((d) => {
        // 同时处理 / 和 \ 路径分隔符（兼容 Windows 和 Unix）
        const installName =
          d.directory.split(/[/\\]/).pop()?.toLowerCase() ||
          d.directory.toLowerCase();
        // 使用 directory + repoOwner + repoName 组合判断是否已安装
        const key = `${installName}:${d.repoOwner.toLowerCase()}:${d.repoName.toLowerCase()}`;
        return {
          ...d,
          installed: installedKeys.has(key),
        };
      });
    }, [discoverableSkills, installedKeys]);

    // 检查 skills.sh 结果的安装状态
    const isSkillsShInstalled = (skill: SkillsShDiscoverableSkill): boolean => {
      const key = `${skill.directory.toLowerCase()}:${skill.repoOwner.toLowerCase()}:${skill.repoName.toLowerCase()}`;
      return installedKeys.has(key);
    };

    const loading =
      searchSource === "repos"
        ? loadingDiscoverable || fetchingDiscoverable
        : false;

    useImperativeHandle(ref, () => ({
      refresh: () => {
        refetchDiscoverable();
        refetchRepos();
      },
      openRepoManager: () => setRepoManagerOpen(true),
    }));

    const inspectSecurity = async (skill: DiscoverableSkill) => {
      const cached = securityReports[skill.key];
      if (cached) return cached;
      setSecurityInspectingKey(skill.key);
      setSecurityInspectionError(null);
      try {
        const report = await skillsApi.inspectSecurity(skill);
        setSecurityReports((current) => ({
          ...current,
          [skill.key]: report,
        }));
        return report;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSecurityInspectionError(message);
        throw error;
      } finally {
        setSecurityInspectingKey((current) =>
          current === skill.key ? null : current,
        );
      }
    };

    useEffect(() => {
      if (!detail) {
        setSecurityInspectionError(null);
        return;
      }
      void inspectSecurity(detail.skill).catch(() => undefined);
      // Security reports are immutable for the selected repository snapshot in this view.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detail?.skill.key]);

    const handleInstall = async (key: string) => {
      let skill: DiscoverableSkill | undefined;

      if (searchSource === "skillssh") {
        const found = accumulatedResults.find((s) => s.key === key);
        if (found) {
          skill = skillsShToDiscoverableSkill(found);
        }
      } else {
        skill = discoverableSkills?.find((s) => s.key === key);
      }

      if (!skill) {
        toast.error(t("skills.notFound"));
        return;
      }

      try {
        const report = await inspectSecurity(skill);
        if (report.blocked) {
          toast.error(t("skills.market.securityBlocked"), {
            description: t("skills.market.securityBlockedDescription"),
            duration: 10000,
          });
          return;
        }
        const securityAcknowledged = report.risk === "high";
        if (
          securityAcknowledged &&
          !window.confirm(t("skills.market.highRiskConfirm"))
        ) {
          return;
        }
        await installMutation.mutateAsync({
          skill,
          currentApp: targetApp,
          securityAcknowledged,
        });
        toast.success(t("skills.installSuccess", { name: skill.name }), {
          closeButton: true,
        });
        setDetail(null);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const { title, description } = formatSkillError(
          errorMessage,
          t,
          "skills.installFailed",
        );
        toast.error(title, {
          description,
          duration: 10000,
        });
        console.error("Install skill failed:", error);
      }
    };

    const handleUninstall = async (_directory: string) => {
      // 在发现面板中，不支持卸载，需要在主面板中操作
      toast.info(t("skills.uninstallInMainPanel"));
    };

    const handleAddRepo = async (repo: SkillRepo) => {
      try {
        await addRepoMutation.mutateAsync(repo);
        // Await discovery so we can report the real count
        const { data: freshSkills } = await refetchDiscoverable();
        const count =
          freshSkills?.filter(
            (s) =>
              s.repoOwner === repo.owner &&
              s.repoName === repo.name &&
              (s.repoBranch || "main") === (repo.branch || "main"),
          ).length ?? 0;
        toast.success(
          t("skills.repo.addSuccess", {
            owner: repo.owner,
            name: repo.name,
            count,
          }),
          { closeButton: true },
        );
      } catch (error) {
        toast.error(t("common.error"), {
          description: String(error),
        });
      }
    };

    const handleRemoveRepo = async (owner: string, name: string) => {
      try {
        await removeRepoMutation.mutateAsync({ owner, name });
        toast.success(t("skills.repo.removeSuccess", { owner, name }), {
          closeButton: true,
        });
      } catch (error) {
        toast.error(t("common.error"), {
          description: String(error),
        });
      }
    };

    // 过滤技能列表（仓库模式）
    const filteredSkills = useMemo(() => {
      // 按仓库筛选
      const byRepo = skills.filter((skill) => {
        if (filterRepo === "all") return true;
        const skillRepo = `${skill.repoOwner}/${skill.repoName}`;
        return skillRepo === filterRepo;
      });

      // 按安装状态筛选
      const byStatus = byRepo.filter((skill) => {
        if (filterStatus === "installed") return skill.installed;
        if (filterStatus === "uninstalled") return !skill.installed;
        return true;
      });

      const byCategory = byStatus.filter(
        (skill) =>
          categoryFilter === "all" ||
          inferSkillMarketCategory(skill) === categoryFilter,
      );
      const query = searchQuery.trim().toLowerCase();
      const searched = query
        ? byCategory.filter((skill) => {
            const name = skill.name?.toLowerCase() || "";
            const description = skill.description?.toLowerCase() || "";
            const repo = `${skill.repoOwner}/${skill.repoName}`.toLowerCase();
            return (
              name.includes(query) ||
              description.includes(query) ||
              repo.includes(query)
            );
          })
        : byCategory;

      if (sortOrder === "name") {
        return [...searched].sort((left, right) =>
          left.name.localeCompare(right.name),
        );
      }
      return searched;
    }, [
      skills,
      searchQuery,
      filterRepo,
      filterStatus,
      categoryFilter,
      sortOrder,
    ]);

    const filteredSkillsShResults = useMemo(() => {
      const filtered = accumulatedResults.filter((skill) => {
        if (categoryFilter === "all") return true;
        return (
          inferSkillMarketCategory(skillsShToDiscoverableSkill(skill)) ===
          categoryFilter
        );
      });
      if (sortOrder === "popular") {
        return [...filtered].sort(
          (left, right) => right.installs - left.installs,
        );
      }
      if (sortOrder === "name") {
        return [...filtered].sort((left, right) =>
          left.name.localeCompare(right.name),
        );
      }
      return filtered;
    }, [accumulatedResults, categoryFilter, sortOrder]);

    // 是否有更多 skills.sh 结果
    const hasMoreSkillsSh =
      skillsShResult && accumulatedResults.length < skillsShResult.totalCount;
    const searchingSkillsSh =
      (loadingSkillsSh || fetchingSkillsSh) && accumulatedResults.length === 0;

    // 无仓库配置时默认切换到 skills.sh；仓库发现结果为空时仍保留仓库视图，方便手动刷新重试。
    const effectiveSource =
      searchSource === "repos" && repos.length === 0 && !loading
        ? "skillssh"
        : searchSource;

    useEffect(() => {
      onSourceChange?.(effectiveSource);
    }, [effectiveSource, onSourceChange]);

    useEffect(() => {
      if (effectiveSource === "repos" && sortOrder === "popular") {
        setSortOrder("relevance");
      }
    }, [effectiveSource, sortOrder]);

    const categoryLabel = (category: SkillMarketCategory) =>
      t(`skills.market.categories.${category}`);
    const targetAppLabel = APP_ICON_MAP[targetApp].label;
    const detailSourceLabel = detail
      ? t(
          detail.source === "skillssh"
            ? "skills.market.communitySource"
            : "skills.market.configuredSource",
        )
      : "";
    const detailSecurityReport = detail
      ? securityReports[detail.skill.key]
      : undefined;
    const openDetailSource = async () => {
      if (!detail?.skill.readmeUrl) return;
      try {
        await settingsApi.openExternal(detail.skill.readmeUrl);
      } catch (error) {
        toast.error(t("common.error"), { description: String(error) });
      }
    };

    return (
      <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background/50 px-6">
        {/* 技能网格（可滚动详情区域） */}
        <div
          className="skills-scroll-area scroll-overlay min-h-0 flex-1 overflow-y-auto overflow-x-hidden animate-fade-in"
          data-testid="skills-discovery-scroll-area"
        >
          <div className="py-4">
            <section className="mb-4 flex flex-wrap items-center gap-4 rounded-xl border border-primary/15 bg-primary/[0.035] px-4 py-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Store className="h-5 w-5" />
              </span>
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-sm font-semibold">
                    {t("skills.market.title")}
                  </h2>
                  <Badge
                    variant="outline"
                    className="border-amber-500/35 bg-amber-500/5 text-[10px] text-amber-700 dark:text-amber-300"
                  >
                    {t("skills.market.unverifiedBadge")}
                  </Badge>
                </div>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {t("skills.market.description")}
                </p>
              </div>
              <div className="w-full sm:w-48">
                <Select
                  value={targetApp}
                  onValueChange={(value) => setTargetApp(value as AppId)}
                >
                  <SelectTrigger
                    className="bg-card text-foreground"
                    aria-label={t("skills.market.installTarget")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SKILLS_APP_IDS.map((app) => (
                      <SelectItem key={app} value={app}>
                        {APP_ICON_MAP[app].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </section>

            {/* 搜索来源切换 + 搜索框 */}
            <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center">
              {/* 来源切换 */}
              <div className="inline-flex gap-1 rounded-md border border-border-default bg-background p-1 shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveSource === "repos" ? "default" : "ghost"}
                  className={
                    effectiveSource === "repos"
                      ? "shadow-sm min-w-[64px]"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted min-w-[64px]"
                  }
                  onClick={() => setSearchSource("repos")}
                >
                  {t("skills.searchSource.repos")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={effectiveSource === "skillssh" ? "default" : "ghost"}
                  className={
                    effectiveSource === "skillssh"
                      ? "shadow-sm min-w-[80px]"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted min-w-[80px]"
                  }
                  onClick={() => setSearchSource("skillssh")}
                >
                  skills.sh
                </Button>
              </div>

              {effectiveSource === "repos" ? (
                <>
                  {/* 仓库模式搜索框 */}
                  <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder={t("skills.searchPlaceholder")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9 pr-3"
                    />
                  </div>
                  {/* 仓库筛选 */}
                  <div className="w-full md:w-56">
                    <Select value={filterRepo} onValueChange={setFilterRepo}>
                      <SelectTrigger className="bg-card border shadow-sm text-foreground">
                        <SelectValue
                          placeholder={t("skills.filter.repo")}
                          className="text-left truncate"
                        />
                      </SelectTrigger>
                      <SelectContent className="bg-card text-foreground shadow-lg max-h-64 min-w-[var(--radix-select-trigger-width)]">
                        <SelectItem
                          value="all"
                          className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                        >
                          {t("skills.filter.allRepos")}
                        </SelectItem>
                        {repoOptions.map((repo) => (
                          <SelectItem
                            key={repo}
                            value={repo}
                            className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                            title={repo}
                          >
                            <span className="truncate block max-w-[200px]">
                              {repo}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* 安装状态筛选 */}
                  <div className="w-full md:w-36">
                    <Select
                      value={filterStatus}
                      onValueChange={(val) =>
                        setFilterStatus(
                          val as "all" | "installed" | "uninstalled",
                        )
                      }
                    >
                      <SelectTrigger className="bg-card border shadow-sm text-foreground">
                        <SelectValue
                          placeholder={t("skills.filter.placeholder")}
                          className="text-left"
                        />
                      </SelectTrigger>
                      <SelectContent className="bg-card text-foreground shadow-lg">
                        <SelectItem
                          value="all"
                          className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                        >
                          {t("skills.filter.all")}
                        </SelectItem>
                        <SelectItem
                          value="installed"
                          className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                        >
                          {t("skills.filter.installed")}
                        </SelectItem>
                        <SelectItem
                          value="uninstalled"
                          className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                        >
                          {t("skills.filter.uninstalled")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {searchQuery && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("skills.count", { count: filteredSkills.length })}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {/* skills.sh 搜索框 */}
                  <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder={t("skills.skillssh.searchPlaceholder")}
                      value={skillsShInput}
                      onChange={(e) => setSkillsShInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSkillsShSearch();
                      }}
                      className="pl-9 pr-3"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={handleSkillsShSearch}
                    disabled={
                      skillsShInput.trim().length < 2 || fetchingSkillsSh
                    }
                    className="shrink-0"
                  >
                    {fetchingSkillsSh ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Search className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {t("skills.search")}
                  </Button>
                </>
              )}
            </div>

            <div className="mb-5 flex flex-wrap items-center gap-2">
              <div className="w-full sm:w-44">
                <Select
                  value={categoryFilter}
                  onValueChange={(value) =>
                    setCategoryFilter(value as SkillMarketCategory)
                  }
                >
                  <SelectTrigger
                    className="bg-card text-foreground"
                    aria-label={t("skills.market.category")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      [
                        "all",
                        "coding",
                        "design",
                        "automation",
                        "data",
                        "content",
                        "other",
                      ] as SkillMarketCategory[]
                    ).map((category) => (
                      <SelectItem key={category} value={category}>
                        {categoryLabel(category)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-full sm:w-40">
                <Select
                  value={sortOrder}
                  onValueChange={(value) =>
                    setSortOrder(value as SkillMarketSort)
                  }
                >
                  <SelectTrigger
                    className="bg-card text-foreground"
                    aria-label={t("skills.market.sort")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="relevance">
                      {t("skills.market.sortOptions.relevance")}
                    </SelectItem>
                    {effectiveSource === "skillssh" && (
                      <SelectItem value="popular">
                        {t("skills.market.sortOptions.popular")}
                      </SelectItem>
                    )}
                    <SelectItem value="name">
                      {t("skills.market.sortOptions.name")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {t("skills.market.installTargetHint", {
                  app: targetAppLabel,
                })}
              </span>
            </div>

            {/* 内容区域 */}
            {effectiveSource === "repos" ? (
              /* ===== 仓库模式 ===== */
              loading ? (
                <div className="flex items-center justify-center h-64">
                  <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : skills.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-center">
                  <p className="text-lg font-medium text-foreground">
                    {t("skills.empty")}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("skills.emptyDescription")}
                  </p>
                  <Button
                    variant="link"
                    onClick={() => setRepoManagerOpen(true)}
                    className="mt-3 text-sm font-normal"
                  >
                    {t("skills.addRepo")}
                  </Button>
                </div>
              ) : filteredSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center">
                  <p className="text-lg font-medium text-foreground">
                    {t("skills.noResults")}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("skills.emptyDescription")}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredSkills.map((skill) => (
                    <SkillCard
                      key={skill.key}
                      skill={skill}
                      sourceLabel={t("skills.market.configuredSource")}
                      trustLabel={t("skills.market.unverifiedBadge")}
                      categoryLabel={categoryLabel(
                        inferSkillMarketCategory(skill),
                      )}
                      targetLabel={t("skills.market.cardTarget", {
                        app: targetAppLabel,
                      })}
                      onView={() =>
                        setDetail({
                          skill,
                          source: "repos",
                          category: inferSkillMarketCategory(skill),
                        })
                      }
                      onInstall={handleInstall}
                      onUninstall={handleUninstall}
                    />
                  ))}
                </div>
              )
            ) : (
              /* ===== skills.sh 模式 ===== */
              <>
                {searchingSkillsSh ? (
                  <div className="flex items-center justify-center h-64">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <span className="ml-3 text-sm text-muted-foreground">
                      {t("skills.skillssh.loading")}
                    </span>
                  </div>
                ) : skillsShFailed ? (
                  <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
                    <p className="text-sm font-medium text-destructive">
                      {t("skills.skillssh.error")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void refetchSkillsSh()}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t("common.refresh")}
                    </Button>
                  </div>
                ) : skillsShQuery.length < 2 ? (
                  <div className="flex flex-col items-center justify-center h-64 text-center">
                    <Search className="h-12 w-12 text-muted-foreground/30 mb-4" />
                    <p className="text-sm text-muted-foreground">
                      {t("skills.skillssh.searchPlaceholder")}
                    </p>
                  </div>
                ) : accumulatedResults.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 text-center">
                    <p className="text-lg font-medium text-foreground">
                      {t("skills.skillssh.noResults", {
                        query: skillsShQuery,
                      })}
                    </p>
                  </div>
                ) : filteredSkillsShResults.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-48 text-center">
                    <p className="text-lg font-medium text-foreground">
                      {t("skills.noResults")}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {filteredSkillsShResults.map((skill) => {
                        const installed = isSkillsShInstalled(skill);
                        const discoverable = skillsShToDiscoverableSkill(skill);
                        const category = inferSkillMarketCategory(discoverable);
                        return (
                          <SkillCard
                            key={skill.key}
                            skill={{
                              ...discoverable,
                              installed,
                            }}
                            installs={skill.installs}
                            sourceLabel={t("skills.market.communitySource")}
                            trustLabel={t("skills.market.unverifiedBadge")}
                            categoryLabel={categoryLabel(category)}
                            targetLabel={t("skills.market.cardTarget", {
                              app: targetAppLabel,
                            })}
                            onView={() =>
                              setDetail({
                                skill: { ...discoverable, installed },
                                source: "skillssh",
                                category,
                                installs: skill.installs,
                              })
                            }
                            onInstall={handleInstall}
                            onUninstall={handleUninstall}
                          />
                        );
                      })}
                    </div>

                    {/* 加载更多 + 底部信息 */}
                    <div className="mt-6 flex flex-col items-center gap-2">
                      {hasMoreSkillsSh && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={fetchingSkillsSh}
                          onClick={() =>
                            setSkillsShOffset(
                              (prev) => prev + SKILLSSH_PAGE_SIZE,
                            )
                          }
                        >
                          {fetchingSkillsSh ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          ) : null}
                          {t("skills.skillssh.loadMore")}
                        </Button>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t("skills.skillssh.poweredBy")}
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* 仓库管理面板 */}
        {repoManagerOpen && (
          <RepoManagerPanel
            repos={repos}
            skills={skills}
            onAdd={handleAddRepo}
            onRemove={handleRemoveRepo}
            onClose={() => setRepoManagerOpen(false)}
          />
        )}

        <Dialog
          open={Boolean(detail)}
          onOpenChange={(open) => !open && setDetail(null)}
        >
          <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
            {detail && (
              <>
                <DialogHeader>
                  <div className="flex flex-wrap items-center gap-2 pr-8">
                    <DialogTitle>{detail.skill.name}</DialogTitle>
                    <Badge variant="secondary">{detailSourceLabel}</Badge>
                    <Badge variant="outline">
                      {categoryLabel(detail.category)}
                    </Badge>
                    {typeof detail.installs === "number" && (
                      <Badge variant="outline">
                        {t("skills.skillssh.installs", {
                          count: detail.installs,
                        })}
                      </Badge>
                    )}
                  </div>
                  <DialogDescription>
                    {detail.skill.description || t("skills.noDescription")}
                  </DialogDescription>
                </DialogHeader>

                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t("skills.market.publisher")}
                    </p>
                    <p className="mt-1 font-medium">{detail.skill.repoOwner}</p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t("skills.market.repository")}
                    </p>
                    <p className="mt-1 break-all font-medium">
                      {detail.skill.repoOwner}/{detail.skill.repoName}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t("skills.market.branch")}
                    </p>
                    <p className="mt-1 font-medium">
                      {detail.skill.repoBranch || "main"}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {t("skills.market.installTarget")}
                    </p>
                    <p className="mt-1 font-medium">{targetAppLabel}</p>
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs leading-5 text-amber-900 dark:text-amber-200">
                  <div className="flex items-start gap-3">
                    {detailSecurityReport?.risk === "low" ? (
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold">
                          {t("skills.market.securityTitle")}
                        </p>
                        {detailSecurityReport && (
                          <Badge
                            variant="outline"
                            className="bg-background/70 text-[9px]"
                          >
                            {t(
                              `skills.market.risk.${detailSecurityReport.risk}`,
                            )}
                          </Badge>
                        )}
                        {detailSecurityReport && (
                          <Badge
                            variant="outline"
                            className="bg-background/70 text-[9px]"
                          >
                            {t(
                              detailSecurityReport.sourceTrust === "known"
                                ? "skills.market.knownSource"
                                : "skills.market.communityUnverified",
                            )}
                          </Badge>
                        )}
                      </div>
                      {securityInspectingKey === detail.skill.key ? (
                        <p className="mt-1 flex items-center gap-1.5 text-amber-800/85 dark:text-amber-200/80">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t("skills.market.securityScanning")}
                        </p>
                      ) : securityInspectionError ? (
                        <p className="mt-1 text-destructive">
                          {t("skills.market.securityScanFailed")}
                        </p>
                      ) : detailSecurityReport ? (
                        <p className="mt-1 text-amber-800/85 dark:text-amber-200/80">
                          {t("skills.market.securitySummary", {
                            files: detailSecurityReport.filesScanned,
                            executables: detailSecurityReport.executableFiles,
                            findings: detailSecurityReport.findings.length,
                          })}
                        </p>
                      ) : (
                        <p className="mt-0.5 text-amber-800/85 dark:text-amber-200/80">
                          {t("skills.market.securityDescription")}
                        </p>
                      )}
                    </div>
                  </div>

                  {detailSecurityReport?.findings.slice(0, 6).map((finding) => (
                    <div
                      key={`${finding.code}:${finding.path}`}
                      className="rounded-md border border-amber-500/20 bg-background/55 px-2.5 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{finding.title}</p>
                        <span className="text-[9px] uppercase opacity-75">
                          {t(`skills.market.risk.${finding.risk}`)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[10px] opacity-85">
                        {finding.message}
                      </p>
                      <p className="mt-0.5 break-all font-mono text-[9px] opacity-65">
                        {finding.path}
                      </p>
                    </div>
                  ))}
                </div>

                <DialogFooter>
                  {detail.skill.readmeUrl && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void openDetailSource()}
                    >
                      {t("skills.market.viewSource")}
                    </Button>
                  )}
                  <Button
                    type="button"
                    disabled={
                      detail.skill.installed ||
                      installMutation.isPending ||
                      securityInspectingKey === detail.skill.key ||
                      Boolean(securityInspectionError) ||
                      detailSecurityReport?.blocked
                    }
                    onClick={() => void handleInstall(detail.skill.key)}
                  >
                    {installMutation.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    {detail.skill.installed
                      ? t("skills.installed")
                      : t("skills.market.installTo", {
                          app: targetAppLabel,
                        })}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    );
  },
);

SkillsPage.displayName = "SkillsPage";
