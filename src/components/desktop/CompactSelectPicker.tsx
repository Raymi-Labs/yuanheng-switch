import { ProviderIcon } from "@/components/ProviderIcon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface CompactSelectOption {
  value: string;
  label: string;
  icon?: string;
  iconName?: string;
}

export interface CompactSelectPickerProps {
  label: string;
  value: string;
  options: CompactSelectOption[];
  disabled?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
  itemClassName?: string;
  onChange: (value: string) => void;
  onOpen?: () => void;
}

const encodeValue = (value: string) => `value:${value}`;
const decodeValue = (value: string) => value.slice("value:".length);

/**
 * 跨平台紧凑选择器。
 *
 * 不使用系统原生 select，避免 Windows/macOS WebView 将触发器文字颜色
 * 继承到系统白色弹层后出现“只有悬停才看得见”的问题。
 */
export function CompactSelectPicker({
  label,
  value,
  options,
  disabled,
  triggerClassName,
  contentClassName,
  itemClassName,
  onChange,
  onOpen,
}: CompactSelectPickerProps) {
  const selected =
    options.find((option) => option.value === value) ??
    (value ? undefined : options[0]);

  return (
    <Select
      value={
        selected
          ? encodeValue(selected.value)
          : value
            ? encodeValue(value)
            : undefined
      }
      disabled={disabled || options.length === 0}
      onValueChange={(nextValue) => onChange(decodeValue(nextValue))}
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          "h-8 min-w-0 gap-2 px-2 text-left text-[10px] shadow-sm",
          triggerClassName,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {selected?.icon && (
            <ProviderIcon
              icon={selected.icon}
              name={selected.iconName ?? selected.label}
              size={14}
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {selected?.label ?? value}
          </span>
        </span>
      </SelectTrigger>
      <SelectContent
        position="popper"
        sideOffset={6}
        className={cn(
          "z-[1000] max-h-[240px] min-w-[var(--radix-select-trigger-width)]",
          contentClassName,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {options.map((option) => (
          <SelectItem
            key={encodeValue(option.value)}
            value={encodeValue(option.value)}
            className={cn("text-[10.5px]", itemClassName)}
          >
            <span className="flex min-w-0 items-center gap-2">
              {option.icon && (
                <span aria-hidden="true">
                  <ProviderIcon
                    icon={option.icon}
                    name={option.iconName ?? option.label}
                    size={14}
                  />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
