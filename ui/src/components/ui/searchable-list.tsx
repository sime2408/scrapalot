import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';

export interface SearchableListProps<T> {
  items: T[];
  /** Key on T to search against, or a custom filter function. */
  searchBy: keyof T | ((item: T, query: string) => boolean);
  /** Renders each filtered item. */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Placeholder for the search input. */
  placeholder?: string;
  /** Shown below the input when the filtered list is empty. */
  emptyMessage?: string;
  /** Extra className on the root wrapper. */
  className?: string;
  /** Extra className on the search input. */
  inputClassName?: string;
  /** data-testid for the search input. */
  inputTestId?: string;
  /** Controlled search value. If provided, component is controlled. */
  value?: string;
  /** Called when search changes (controlled mode). */
  onValueChange?: (value: string) => void;
}

/**
 * Searchable list with built-in filter logic.
 *
 * Usage (uncontrolled):
 *   <SearchableList
 *     items={models} searchBy="name"
 *     renderItem={m => <ModelRow key={m.id} model={m} />}
 *     placeholder="Search models..."
 *   />
 *
 * Usage (controlled):
 *   <SearchableList
 *     items={models} searchBy="name"
 *     value={search} onValueChange={setSearch}
 *     renderItem={m => <ModelRow key={m.id} model={m} />}
 *   />
 */
export function SearchableList<T>({
  items,
  searchBy,
  renderItem,
  placeholder = 'Search...',
  emptyMessage = 'No results',
  className,
  inputClassName,
  inputTestId,
  value: controlledValue,
  onValueChange,
}: SearchableListProps<T>) {
  const [internalQuery, setInternalQuery] = useState('');
  const isControlled = controlledValue !== undefined;
  const query = isControlled ? controlledValue : internalQuery;

  const setQuery = (v: string) => {
    if (isControlled) {
      onValueChange?.(v);
    } else {
      setInternalQuery(v);
    }
  };

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const lower = query.toLowerCase();
    return items.filter((item) => {
      if (typeof searchBy === 'function') return searchBy(item, lower);
      const val = item[searchBy];
      return String(val ?? '').toLowerCase().includes(lower);
    });
  }, [items, query, searchBy]);

  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className={`pl-8 pr-8 h-8 text-sm ${inputClassName ?? ''}`}
          data-testid={inputTestId}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="py-4 text-center text-sm text-muted-foreground">{emptyMessage}</div>
      ) : (
        <div>{filtered.map((item, i) => renderItem(item, i))}</div>
      )}
    </div>
  );
}
