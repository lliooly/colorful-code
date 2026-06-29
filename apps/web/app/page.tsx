import { systemPrompt } from '@colorful-code/prompts';
import { WORKSPACE_NAME } from '@colorful-code/shared';
import { Button } from '@/components/ui/button';

const statusItems = [
  { label: 'Frontend', value: 'Next.js 16 / Ready' },
  { label: 'Backend', value: 'NestJS / Scaffolded' },
  { label: 'Desktop', value: 'Tauri 2 / Reserved' }
] as const;

const capabilityItems = [
  'Monorepo workspace with pnpm + Turborepo',
  'Shared UI preset wired with shadcn',
  'Bazel entrypoint reserved for later',
  'CI checks for lint, typecheck, and build'
] as const;

export default function HomePage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_color-mix(in_oklch,var(--primary),transparent_84%),_transparent_42%),linear-gradient(135deg,color-mix(in_oklch,var(--background),white_18%)_0%,var(--background)_36%,color-mix(in_oklch,var(--secondary),white_35%)_100%)] px-5 py-8 text-foreground sm:px-8 sm:py-12">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <section className="relative overflow-hidden rounded-[2rem] border border-border/70 bg-card/85 p-6 shadow-[0_30px_120px_-40px_rgba(0,0,0,0.28)] backdrop-blur sm:p-8">
          <div className="absolute -top-20 right-0 size-64 rounded-full bg-[radial-gradient(circle,_color-mix(in_oklch,var(--primary),white_20%)_0%,transparent_70%)] opacity-55" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/20 to-transparent" />

          <div className="relative flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-5">
              <span className="inline-flex w-fit items-center rounded-full border border-border bg-background/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
                Agent Preview Surface
              </span>
              <div className="space-y-4">
                <h1 className="max-w-3xl text-4xl font-semibold leading-none tracking-[-0.04em] text-balance sm:text-6xl">
                  {WORKSPACE_NAME}
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
                  A compact preview page to verify the repository boots, the UI
                  preset is wired, and the project is ready to continue into the
                  Agent course build.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button>Preview page online</Button>
                <Button variant="outline">Scaffold verified</Button>
              </div>
            </div>

            <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
              {statusItems.map((item) => (
                <div
                  key={item.label}
                  className="rounded-[1.6rem] border border-border/70 bg-background/85 p-4 shadow-sm"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    {item.label}
                  </p>
                  <p className="mt-3 text-sm font-medium text-foreground">
                    {item.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[2rem] border border-border/70 bg-card/88 p-6 shadow-[0_24px_80px_-48px_rgba(0,0,0,0.4)]">
            <div className="flex items-center justify-between gap-4 border-b border-border/70 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  Capability Snapshot
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                  What is already wired
                </h2>
              </div>
              <div className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
                static preview
              </div>
            </div>

            <div className="mt-5 grid gap-3">
              {capabilityItems.map((item, index) => (
                <div
                  key={item}
                  className="flex items-start gap-4 rounded-[1.4rem] border border-border/70 bg-background/75 px-4 py-4"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-sm font-semibold">
                    0{index + 1}
                  </div>
                  <p className="pt-1 text-sm leading-6 text-foreground/90">{item}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-6">
            <div className="rounded-[2rem] border border-border/70 bg-foreground p-6 text-background shadow-[0_24px_80px_-48px_rgba(0,0,0,0.45)]">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-background/60">
                Prompt Seed
              </p>
              <p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-background/78">
                {systemPrompt}
              </p>
            </div>

            <div className="rounded-[2rem] border border-border/70 bg-card/88 p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                Run Target
              </p>
              <div className="mt-4 rounded-[1.4rem] border border-border/70 bg-background px-4 py-4 font-mono text-sm text-foreground">
                pnpm dev
              </div>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                This page is intentionally small and static, so you can focus on
                confirming the frontend workspace and overall repository pipeline.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
