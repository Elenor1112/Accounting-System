import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

/** Minimal class joiner — avoids a dependency for something this small. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-foreground hover:opacity-90',
  secondary: 'border border-border bg-surface text-foreground hover:bg-surface-muted',
  ghost: 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
  danger: 'bg-negative text-white hover:opacity-90',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  );
});

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn('input-base', className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn('input-base', className)} {...props}>
        {children}
      </select>
    );
  },
);

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label-base">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-negative">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-subtle-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warning';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-muted-foreground border-border',
  accent: 'bg-accent-subtle text-accent border-transparent',
  positive: 'bg-positive-subtle text-positive border-transparent',
  negative: 'bg-negative-subtle text-negative border-transparent',
  warning: 'bg-warning-subtle text-warning border-transparent',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Maps a document/journal status to a consistent colour across the app. */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'paid':
    case 'posted':
    case 'approved':
    case 'completed':
      return 'positive';
    case 'overdue':
    case 'rejected':
    case 'void':
    case 'cancelled':
      return 'negative';
    case 'pending_approval':
    case 'partially_paid':
    case 'submitted':
    case 'in_progress':
      return 'warning';
    case 'sent':
      return 'accent';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={cn('card', padded && 'p-4', className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

/**
 * Empty state. Data-entry software is mostly empty on day one, so this is a
 * first-class screen rather than an afterthought — it says what the thing is
 * and offers the action that creates one.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-4 rounded-md border border-negative/30 bg-negative-subtle px-3 py-2 text-sm text-negative"
    >
      {message}
    </div>
  );
}

/** A labelled figure — the unit the dashboard and report headers are built from. */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'positive' | 'negative';
}) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1.5 text-2xl font-semibold tabular tracking-tight',
          tone === 'positive' && 'text-positive',
          tone === 'negative' && 'text-negative',
          tone === 'neutral' && 'text-foreground',
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}

/** Wraps a wide table so it scrolls itself rather than the page. */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}
