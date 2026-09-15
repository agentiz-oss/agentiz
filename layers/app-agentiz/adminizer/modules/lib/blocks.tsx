import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from './ui';

/**
 * The controls that sit above a list. They are in a shared file because every list screen of this
 * rework has the same row of them, and a filter that is a `<select>` on one screen and a row of
 * buttons on the next is the thing the UI review called «каждый экран изучаешь заново».
 *
 * Nothing here holds state: which filter is applied is part of the address (`setQueryParam` in
 * `format.ts`), so a link to a filtered list is an ordinary link.
 */

export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Поиск',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Input
      value={value}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      placeholder={placeholder}
      className={cn('h-8 w-64', className)}
    />
  );
}

export function Filter({
  value,
  onChange,
  options,
  className,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
  /** A value somebody may read but not change — shown, not hidden: it explains the behaviour. */
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" className={cn('h-8 w-auto min-w-36', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
