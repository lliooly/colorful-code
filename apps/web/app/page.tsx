import { systemPrompt } from '@colorful-code/prompts';
import { WORKSPACE_NAME } from '@colorful-code/shared';
import { Button } from '@colorful-code/ui';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.14),_transparent_45%),linear-gradient(180deg,#f8fafc_0%,#ecfeff_100%)] px-6 py-16 text-slate-950">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 rounded-[2rem] border border-white/70 bg-white/80 p-8 shadow-2xl shadow-teal-950/5 backdrop-blur">
        <span className="w-fit rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-teal-700">
          Agent Course Project
        </span>
        <div className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight">{WORKSPACE_NAME}</h1>
          <p className="max-w-2xl text-base leading-7 text-slate-600">
            The monorepo scaffold is ready for web, server, shared packages, and
            a future desktop shell.
          </p>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-slate-950 p-5 text-sm text-slate-100">
          <p className="font-medium text-teal-300">Prompt seed</p>
          <p className="mt-2 whitespace-pre-wrap text-slate-300">{systemPrompt}</p>
        </div>
        <div>
          <Button>Shared UI package is wired</Button>
        </div>
      </div>
    </main>
  );
}
