import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Star } from "lucide-react";
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
import {
  groupModelsByVendor,
  modelVendorOf,
  sortModelNames,
  type ModelVendorCatalog,
} from "./modelVendors";
import { dt } from "./desktopI18n";
import { useModelFavorites } from "./useModelFavorites";

export function ModelPicker({
  models,
  value,
  recommended,
  label,
  disabled,
  className,
  triggerLabel,
  onChange,
  onRefresh,
  modelMeta,
  modelVendors,
}: {
  models: string[];
  value?: string;
  recommended?: string | null;
  label: string;
  disabled?: boolean;
  className?: string;
  triggerLabel?: string;
  onChange: (value: string) => void;
  onRefresh?: () => void;
  modelVendors?: ModelVendorCatalog;
  modelMeta?: Record<
    string,
    { groups?: number; reasoningLevels?: number; available?: boolean }
  >;
}) {
  const vendors = groupModelsByVendor([...new Set(models)], modelVendors);
  const { favorites, toggle, saveFailed } = useModelFavorites(vendors);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("all");
  const contentRef = useRef<HTMLDivElement>(null);
  const favoriteFocusRef = useRef<{ kind: string; id: string } | null>(null);
  // Moving a model into/out of a group remounts its row. Keep keyboard focus
  // on the same action rather than dropping it onto the document body.
  useLayoutEffect(() => {
    const target = favoriteFocusRef.current;
    if (!target) return;
    const button = Array.from(
      contentRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-favorite-id]",
      ) ?? [],
    ).find(
      (item) =>
        item.dataset.favoriteKind === target.kind &&
        item.dataset.favoriteId === target.id,
    );
    button?.focus();
    favoriteFocusRef.current = null;
  }, [favorites, saveFailed]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const orderedModels = useMemo(
    () => sortModelNames([...new Set(models)], [value, recommended]),
    [models, recommended, value],
  );

  const favoriteVendorFirst = (a: { id: string }, b: { id: string }) =>
    Number(favorites.vendors.includes(b.id)) -
    Number(favorites.vendors.includes(a.id));
  vendors.sort(favoriteVendorFirst);
  const activeVendor = vendors.some((vendor) => vendor.id === vendorFilter)
    ? vendorFilter
    : "all";
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleModels = orderedModels.filter((model) => {
    const vendor = modelVendorOf(model, modelVendors);
    const text = `${model} ${vendor.label} ${vendor.id}`.toLowerCase();
    return (
      (activeVendor === "all" || vendor.id === activeVendor) &&
      terms.every((term) => text.includes(term))
    );
  });
  const current = visibleModels.find((model) => model === value);
  const isFavorite = (model: string) =>
    favorites.models.includes(model) ||
    favorites.vendors.includes(modelVendorOf(model, modelVendors).id);
  const favoriteModels = visibleModels.filter(
    (model) => model !== current && isFavorite(model),
  );
  const groups = groupModelsByVendor(
    visibleModels.filter((model) => model !== current && !isFavorite(model)),
    modelVendors,
  );
  const resetScroll = () => {
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  const favoriteButton = (
    kind: "models" | "vendors",
    id: string,
    name: string,
  ) => {
    const selected = favorites[kind].includes(id);
    const action =
      kind === "models"
        ? selected
          ? "取消收藏模型 {{name}}"
          : "收藏模型 {{name}}"
        : selected
          ? "取消收藏厂商 {{name}}"
          : "收藏厂商 {{name}}";
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={dt(action, { name })}
        aria-pressed={selected}
        data-favorite-kind={kind}
        data-favorite-id={id}
        title={dt(action, { name })}
        className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        onKeyDown={(event) => {
          // cmdk owns Enter on the search input, not on a favorite button.
          if (event.key === "Enter" || event.key === " ")
            event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (document.activeElement === event.currentTarget) {
            favoriteFocusRef.current = { kind, id };
          }
          toggle(kind, id);
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
  const renderModel = (model: string, showVendor = false) => {
    const meta = modelMeta?.[model];
    const details = [
      showVendor ? modelVendorOf(model, modelVendors).label : null,
      meta?.groups != null
        ? dt("{{count}} 个可用分组", { count: meta.groups })
        : null,
      meta?.reasoningLevels != null
        ? dt("{{count}} 档推理等级", { count: meta.reasoningLevels })
        : null,
    ].filter(Boolean);
    return (
      <div key={model} className="flex items-center">
        <CommandItem
          value={model}
          disabled={meta?.available === false}
          className="mx-1 min-w-0 flex-1 gap-2 rounded-lg px-2 py-2.5"
          onSelect={() => {
            if (!disabled && meta?.available !== false) {
              onChange(model);
              setOpen(false);
            }
          }}
        >
          <Check
            aria-hidden
            className={cn(
              "shrink-0 text-primary",
              value === model ? "opacity-100" : "opacity-0",
            )}
          />
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-[12px] font-medium"
              title={model}
            >
              {model}
            </span>
            {details.length > 0 && (
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                {details.join(" · ")}
              </span>
            )}
          </span>
          <span className="flex shrink-0 gap-1">
            {model === value && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                {dt("当前")}
              </span>
            )}
            {model === recommended && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-700 dark:text-emerald-400">
                {dt("推荐")}
              </span>
            )}
          </span>
        </CommandItem>
        {favoriteButton("models", model, model)}
      </div>
    );
  };

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setSearch("");
          setVendorFilter("all");
          onRefresh?.();
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "mt-1.5 flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-[11px] shadow-sm disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="truncate">
            {triggerLabel ?? (value || dt("选择模型"))}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        sideOffset={6}
        className="z-[1000] w-[max(360px,var(--radix-popover-trigger-width))] max-w-[calc(100vw-24px)] overflow-hidden p-0"
        onClick={(event) => event.stopPropagation()}
      >
        <Command
          shouldFilter={false}
          className="max-h-[min(520px,var(--radix-popover-content-available-height))]"
        >
          <div className="shrink-0 border-b bg-popover">
            <CommandInput
              ref={inputRef}
              placeholder={dt("搜索模型名称或厂商…")}
              value={search}
              onValueChange={(next) => {
                setSearch(next);
                resetScroll();
              }}
            />
            <div
              role="group"
              aria-label={dt("按厂商筛选")}
              className="flex gap-1 overflow-x-auto px-3 py-2"
            >
              {[{ id: "all", label: dt("全部") }, ...vendors].map((vendor) => (
                <div key={vendor.id} className="flex shrink-0 items-center">
                  <button
                    type="button"
                    aria-pressed={activeVendor === vendor.id}
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      activeVendor === vendor.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/60 text-muted-foreground hover:bg-muted",
                    )}
                    onClick={() => {
                      setVendorFilter(vendor.id);
                      resetScroll();
                      inputRef.current?.focus();
                    }}
                  >
                    {vendor.label}
                  </button>
                  {vendor.id !== "all" &&
                    favoriteButton("vendors", vendor.id, vendor.label)}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between px-3 pb-2 text-[10px] text-muted-foreground">
              <span>
                {dt("显示 {{visible}} / {{total}} 个模型", {
                  visible: visibleModels.length,
                  total: orderedModels.length,
                })}
              </span>
              {(search || activeVendor !== "all") && (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => {
                    setSearch("");
                    setVendorFilter("all");
                    resetScroll();
                    inputRef.current?.focus();
                  }}
                >
                  {dt("清除筛选")}
                </button>
              )}
            </div>
          </div>
          {saveFailed && (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {dt("无法保存收藏，请检查本地存储后重试")}
            </p>
          )}
          <CommandList
            ref={listRef}
            className="min-h-0 max-h-[360px] flex-1 overscroll-contain p-1"
          >
            {visibleModels.length === 0 && (
              <div
                role="status"
                className="px-4 py-8 text-center text-xs text-muted-foreground"
              >
                {dt("没有找到匹配的模型")}
              </div>
            )}
            {current && (
              <CommandGroup
                heading={dt("当前使用")}
                className="mb-1 rounded-lg bg-primary/[0.035]"
              >
                {renderModel(current, true)}
              </CommandGroup>
            )}
            {favoriteModels.length > 0 && (
              <CommandGroup
                heading={dt("常用收藏")}
                className="border-t first:border-t-0"
              >
                {sortModelNames(favoriteModels, [recommended]).map((model) =>
                  renderModel(model, true),
                )}
              </CommandGroup>
            )}
            {groups.map((group) => (
              <CommandGroup
                key={group.id}
                heading={`${group.label} · ${group.models.length}`}
                className="border-t first:border-t-0"
              >
                {sortModelNames(group.models, [recommended]).map((model) =>
                  renderModel(model),
                )}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
