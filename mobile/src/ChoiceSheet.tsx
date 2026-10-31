import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";

export type Choice = {
  id: string;
  label: string;
  meta?: string;
  note?: string;
  active?: boolean;
};

export function ChoiceSheet({
  title,
  subtitle,
  choices,
  searchable = false,
  searchPlaceholder = "搜索",
  emptyText = "没有匹配的选项",
  close,
  onSelect,
}: {
  title: string;
  subtitle?: string;
  choices: Choice[];
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  close: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const list = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return choices;
    return choices.filter((c) =>
      [c.label, c.meta, c.note]
        .filter((v): v is string => !!v)
        .some((v) => v.toLowerCase().includes(keyword)),
    );
  }, [choices, query]);
  return (
    <div className="sheet-backdrop">
      <section
        className="sheet choice-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheet-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="choice-subtitle">{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label={`关闭${title}`}
            onClick={close}
          >
            <X size={20} />
          </button>
        </div>
        {searchable && (
          <div className="search-box compact">
            <Search size={15} />
            <input
              aria-label={`${title}搜索`}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={40}
            />
            {query && (
              <button
                className="icon-button"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        <div className="choice-list">
          {list.map((c) => (
            <button
              key={c.id}
              className={`choice-item ${c.active ? "active" : ""}`}
              aria-pressed={c.active}
              onClick={() => {
                onSelect(c.id);
                close();
              }}
            >
              <span className="choice-text">
                <strong>{c.label}</strong>
                {c.note && <small>{c.note}</small>}
              </span>
              {c.meta && <span className="choice-meta">{c.meta}</span>}
              {c.active && <Check size={17} className="choice-check" />}
            </button>
          ))}
          {!list.length && <p className="choice-empty">{emptyText}</p>}
        </div>
      </section>
    </div>
  );
}
