import { systemPrompt } from '@colorful-code/prompts';
import { WORKSPACE_NAME } from '@colorful-code/shared';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_color-mix(in_oklch,var(--primary),transparent_82%),_transparent_48%),linear-gradient(180deg,var(--background)_0%,color-mix(in_oklch,var(--accent),white_68%)_100%)] px-6 py-16 text-foreground">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 rounded-[2rem] border border-border/70 bg-card/85 p-8 shadow-2xl shadow-black/5 backdrop-blur">
        <span className="w-fit rounded-full border border-border bg-secondary px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-secondary-foreground">
          Agent Course Project
        </span>
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight">{WORKSPACE_NAME}</h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            The monorepo scaffold is ready for web, server, shared packages, and
            a future desktop shell.
          </p>
        </div>
        <div className="rounded-3xl border border-border bg-foreground p-5 text-sm text-background">
          <p className="font-medium text-primary-foreground/80">Prompt seed</p>
          <p className="mt-2 whitespace-pre-wrap text-background/72">{systemPrompt}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button>shadcn preset is wired</Button>
          <Button variant="outline">Next workspace is ready</Button>
        </div>
      </div>
    </main>
  );
}
