import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';
import { cn } from '../lib/utils';

type ButtonProps = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>;

export function Button({ children, className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-950 shadow-sm transition hover:-translate-y-px hover:shadow-md',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}
