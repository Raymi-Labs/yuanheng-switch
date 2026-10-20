import { useRef, useState } from "react";
import { Check, ChevronRight, ChevronsUpDown, Star } from "lucide-react";
import type { YuanhengConnectionStatus } from "@/lib/api";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CompactSelectPicker } from "./CompactSelectPicker";
import { GROUP_FAVORITES_KEY } from "./GroupPicker";
import {
  groupModelsByVendor,
  modelVendorOf,
  sortModelNames,
} from "./modelVendors";
import {
  useLocalPickerFavorites,
  useModelFavorites,
} from "./useModelFavorites";
import { dt } from "./desktopI18n";

const GROUP_KINDS = ["groups"] as const;
export interface ToolModelSelection {
  model: string;
  group: string;
}

/** Browsing never applies configuration; only a model leaf emits the complete pair. */
export function ToolModelPicker({
  connection,
  models,
  model,
  group,
  recommended,
  tool,
  disabled,
  onDark,
  onRefresh,
  onChange,
}: {
  connection: YuanhengConnectionStatus;
  models: string[];
  model?: string;
  group?: string | null;
  recommended?: string | null;
  tool: string;
  disabled?: boolean;
  onDark?: boolean;
  onRefresh?: () => void;
  onChange: (selection: ToolModelSelection) => void;
}) {
  const modelFavorites = useModelFavorites();
  const groupFavorites = useLocalPickerFavorites(
    GROUP_FAVORITES_KEY,
    GROUP_KINDS,
  );
  const [vendorChoice, setVendorChoice] = useState<{
    model?: string;
    id: string;
  }>();
  const [open, setOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string>();
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const vendors = groupModelsByVendor([...new Set(models)]).sort(
    (a, b) =>
      Number(modelFavorites.favorites.vendors.includes(b.id)) -
      Number(modelFavorites.favorites.vendors.includes(a.id)),
  );
  const currentVendor = model ? modelVendorOf(model).id : undefined;
  const vendorId =
    vendorChoice?.model === model ? vendorChoice?.id : currentVendor;
  const vendor =
    vendors.find((item) => item.id === vendorId) ??
    vendors.find((item) => item.id === currentVendor) ??
    vendors[0];
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) =>
    terms.every((term) => text.toLowerCase().includes(term));
  const entries = connection.groups
    .flatMap((option) => {
      const available = (vendor?.models ?? []).filter((name) =>
        connection.modelGroups[name]?.includes(option.id),
      );
      const visible = available.filter((name) =>
        matches(`${option.id} ${option.description} ${name}`),
      );
      return visible.length
        ? [
            {
              ...option,
              models: sortModelNames(visible, [model, recommended]).sort(
                (a, b) =>
                  Number(modelFavorites.favorites.models.includes(b)) -
                  Number(modelFavorites.favorites.models.includes(a)),
              ),
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Number(groupFavorites.favorites.groups.includes(b.id)) -
        Number(groupFavorites.favorites.groups.includes(a.id)),
    );
  // Refresh may remove a branch. Never reinterpret it as the first remaining group.
  const branch = entries.find((entry) => entry.id === activeGroup);
  const viewingCurrent =
    !vendorChoice ||
    vendorChoice.model !== model ||
    vendor?.id === currentVendor;
  const confirmed = Boolean(
    model &&
      group &&
      models.includes(model) &&
      connection.groups.some((item) => item.id === group) &&
      connection.modelGroups[model]?.includes(group),
  );
  const saveFailed = modelFavorites.saveFailed || groupFavorites.saveFailed;
  const triggerClass = cn(
    "h-9 text-[11px]",
    onDark &&
      "border-white/15 bg-white/[0.08] text-white hover:bg-white/[0.12] focus:border-[#e9b67c]/70",
  );
  const resetList = () => {
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  const chooseBranch = (id: string) => {
    setActiveGroup(id);
    const first = entries.find((entry) => entry.id === id)?.models[0];
    setHighlight(first ? `model:${first}` : "");
    resetList();
    inputRef.current?.focus();
  };
  const favorite = (
    kind: "models" | "vendors" | "groups",
    id: string,
    name: string,
  ) => {
    const selected =
      kind === "groups"
        ? groupFavorites.favorites.groups.includes(id)
        : modelFavorites.favorites[kind].includes(id);
    const action =
      kind === "groups"
        ? selected
          ? "取消收藏分组 {{name}}"
          : "收藏分组 {{name}}"
        : kind === "vendors"
          ? selected
            ? "取消收藏厂商 {{name}}"
            : "收藏厂商 {{name}}"
          : selected
            ? "取消收藏模型 {{name}}"
            : "收藏模型 {{name}}";
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={dt(action, { name })}
        aria-pressed={selected}
        title={dt(action, { name })}
        className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ")
            event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (kind === "groups") groupFavorites.toggle(kind, id);
          else modelFavorites.toggle(kind, id);
        }}
      >
        <Star
          aria-hidden
          className={cn(
            "h-3.5 w-3.5",
            selected && "fill-amber-400 text-amber-600",
          )}
        />
      </button>
    );
  };

  return (
    <div className="min-w-0">
      <div className="grid grid-cols-[minmax(105px,.65fr)_minmax(0,1.35fr)] gap-2">
        <div className="min-w-0">
          <p
            className={cn(
              "mb-1 text-[10px]",
              onDark ? "text-white/60" : "text-muted-foreground",
            )}
          >
            {dt("1 · 模型供应商")}
          </p>
          <div className="flex min-w-0 items-center gap-1">
            <CompactSelectPicker
              label={dt("{{tool}} 模型供应商", { tool })}
              value={vendor?.id ?? ""}
              options={vendors.map((item) => ({
                value: item.id,
                label: item.label,
                icon: item.icon,
              }))}
              disabled={disabled}
              triggerClassName={cn("flex-1", triggerClass)}
              onChange={(id) => {
                setVendorChoice({ model, id });
                setActiveGroup(undefined);
                setSearch("");
                setOpen(false);
              }}
            />
            {vendor && favorite("vendors", vendor.id, vendor.label)}
          </div>
        </div>
        <div className="min-w-0">
          <p
            className={cn(
              "mb-1 text-[10px]",
              onDark ? "text-white/60" : "text-muted-foreground",
            )}
          >
            {dt("2 · 分组与模型")}
          </p>
          <Popover
            modal
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (next) {
                setSearch("");
                setHighlight("");
                setActiveGroup(
                  viewingCurrent && confirmed ? group! : undefined,
                );
                onRefresh?.();
              }
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                role="combobox"
                aria-label={dt("{{tool}} 分组与模型", { tool })}
                aria-expanded={open}
                disabled={disabled || !vendor}
                className={cn(
                  "flex w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-background px-2.5 text-left shadow-sm disabled:opacity-50",
                  triggerClass,
                )}
                onClick={(event) => event.stopPropagation()}
              >
                <span
                  className="min-w-0 flex-1 truncate"
                  title={
                    viewingCurrent && model
                      ? `${group ?? dt("未选择分组")} / ${model}`
                      : undefined
                  }
                >
                  {viewingCurrent && model
                    ? `${group ?? dt("未选择分组")} / ${model}`
                    : dt("选择分组，再选择模型")}
                </span>
                <ChevronsUpDown
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 opacity-50"
                />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={6}
              className="z-[1000] w-[560px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
              onClick={(event) => event.stopPropagation()}
            >
              <Command
                shouldFilter={false}
                value={highlight}
                onValueChange={setHighlight}
                className="max-h-[min(460px,var(--radix-popover-content-available-height))]"
                onKeyDown={(event) => {
                  if (event.target !== inputRef.current) return;
                  if (
                    event.key === "ArrowRight" &&
                    highlight.startsWith("group:")
                  ) {
                    event.preventDefault();
                    chooseBranch(highlight.slice(6));
                  } else if (event.key === "ArrowLeft" && branch) {
                    event.preventDefault();
                    setHighlight(`group:${branch.id}`);
                    setActiveGroup(undefined);
                  }
                }}
              >
                <div className="shrink-0 border-b">
                  <CommandInput
                    ref={inputRef}
                    placeholder={dt("搜索分组或模型…")}
                    value={search}
                    onValueChange={(value) => {
                      setSearch(value);
                      resetList();
                    }}
                  />
                  <p className="px-3 py-2 text-[10px] text-muted-foreground">
                    {dt("选择分组后展开模型，点选模型后应用完整组合")}
                  </p>
                </div>
                <CommandList
                  ref={listRef}
                  className="min-h-0 max-h-[330px] flex-1 overscroll-contain"
                >
                  {entries.length === 0 ? (
                    <p
                      role="status"
                      className="px-4 py-8 text-center text-xs text-muted-foreground"
                    >
                      {search
                        ? dt("没有找到匹配的分组或模型")
                        : dt("该厂商暂无可用分组，请刷新模型目录")}
                    </p>
                  ) : (
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
                      <CommandGroup
                        heading={dt("令牌分组")}
                        className="min-w-0 border-r"
                      >
                        {entries.map((entry) => (
                          <div
                            key={entry.id}
                            className={cn(
                              "flex items-center rounded-md",
                              branch?.id === entry.id && "bg-primary/10",
                            )}
                          >
                            <CommandItem
                              value={`group:${entry.id}`}
                              disabled={disabled}
                              className="min-w-0 flex-1 gap-1 py-2.5"
                              onSelect={() => {
                                if (!disabled) chooseBranch(entry.id);
                              }}
                            >
                              <span className="min-w-0 flex-1">
                                <span
                                  className="block truncate text-[11px]"
                                  title={entry.id}
                                >
                                  {entry.id}
                                </span>
                                <span className="text-[10px] text-muted-foreground">
                                  {entry.ratio != null
                                    ? `${entry.ratio}x · `
                                    : ""}
                                  {dt("{{count}} 个模型", {
                                    count: entry.models.length,
                                  })}
                                </span>
                              </span>
                              <ChevronRight
                                aria-hidden
                                className="text-muted-foreground"
                              />
                            </CommandItem>
                            {favorite("groups", entry.id, entry.id)}
                          </div>
                        ))}
                      </CommandGroup>
                      <div className="min-w-0">
                        {branch ? (
                          <CommandGroup heading={branch.id}>
                            {branch.models.map((name) => (
                              <div key={name} className="flex items-center">
                                <CommandItem
                                  value={`model:${name}`}
                                  aria-label={name}
                                  disabled={disabled}
                                  className="min-w-0 flex-1 gap-1.5 py-2.5"
                                  onSelect={() => {
                                    if (
                                      disabled ||
                                      !connection.modelGroups[name]?.includes(
                                        branch.id,
                                      )
                                    )
                                      return;
                                    onChange({ model: name, group: branch.id });
                                    setOpen(false);
                                  }}
                                >
                                  <Check
                                    aria-hidden
                                    className={cn(
                                      "text-primary",
                                      model === name && group === branch.id
                                        ? "opacity-100"
                                        : "opacity-0",
                                    )}
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span
                                      className="block truncate text-[11px] font-medium"
                                      title={name}
                                    >
                                      {name}
                                    </span>
                                    {name === recommended && (
                                      <span className="text-[10px] text-muted-foreground">
                                        {dt("推荐")}
                                      </span>
                                    )}
                                  </span>
                                </CommandItem>
                                {favorite("models", name, name)}
                              </div>
                            ))}
                          </CommandGroup>
                        ) : (
                          <p
                            role="status"
                            className="px-4 py-8 text-center text-xs text-muted-foreground"
                          >
                            {dt("先选择左侧分组")}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {model && !confirmed && (
        <p
          role="status"
          className={cn(
            "mt-2 text-[10px]",
            onDark ? "text-amber-200" : "text-amber-700 dark:text-amber-300",
          )}
        >
          {dt(
            "当前组合未在目录中确认，已保留原配置；请刷新或重新选择分组与模型。",
          )}
        </p>
      )}
      {saveFailed && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {dt("无法保存收藏，请检查本地存储后重试")}
        </p>
      )}
    </div>
  );
}
