import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

test('agent chat surface does not render internal connection counters', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /MCP ·/);
  assert.doesNotMatch(source, /LSP ·/);
  assert.doesNotMatch(source, /Events ·/);
});

test('agent page uses the desktop runtime store for desktop-only guards', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /isDesktopRuntime/);
  assert.match(source, /desktopRuntime/);
});

test('agent page uses realtime voice transcription instead of browser speech recognition', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /SpeechRecognition/);
  assert.doesNotMatch(source, /webkitSpeechRecognition/);
  assert.match(source, /startVoiceTranscription/);
  assert.match(source, /appendTranscriptToDraft/);
  assert.doesNotMatch(source, /voice_transcript_delta[\s\S]{0,240}handleSend/);
});

test('settings manages installed plugin kinds instead of showing placeholders', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /comingNext/);
  assert.match(source, /settingsInstalledPlugins/);
  assert.match(source, /settingsPluginKind/);
  assert.match(source, /handleOpenPluginCatalog/);
});

test('agent sidebar uses persisted project history instead of local workspace helpers', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /selectedScope/);
  assert.match(source, /importProject/);
  assert.match(source, /deleteProjectRequest/);
  assert.match(source, /pinSession/);
  assert.match(source, /deleteSession/);
  assert.doesNotMatch(source, /createWorkspaceProject/);
  assert.doesNotMatch(source, /cwd: selectedProject/);
  assert.doesNotMatch(source, /workspaceRoots: selectedProject/);
});

test('agent sidebar exposes scoped new chat actions for projects and standalone chats', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /setSelectedScope\(selectedScopeForSession\(summary\)\)/);
  assert.match(
    source,
    /handleCreate\(\{\s*type: 'project',\s*projectId: project\.id,/,
  );
  assert.match(source, /handleCreate\(\{ type: 'chats' \}\)/);
});

test('agent sidebar uses quiet simple icons', () => {
  const pageSource = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );
  const sidebarSource = readFileSync(
    new URL('../components/ui/sidebar.tsx', import.meta.url),
    'utf8',
  );

  assert.match(pageSource, /Plus,/);
  assert.match(pageSource, /Folder,/);
  assert.match(pageSource, /MessageSquare,/);
  assert.doesNotMatch(pageSource, /FolderRoot/);
  assert.doesNotMatch(pageSource, /MessageCirclePlus/);
  assert.match(sidebarSource, /\[&_svg\]:size-3\.5/);
  assert.match(sidebarSource, /\[&>svg\]:size-3/);
});

test('agent sidebar exposes project deletion without bulk clear actions', () => {
  const source = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /handleClearStandaloneChats/);
  assert.doesNotMatch(source, /handleClearProjectChats/);
  assert.doesNotMatch(source, /handleClearAllHistory/);
  assert.doesNotMatch(source, />\s*Clear\s*</);
  assert.doesNotMatch(source, />\s*Clear all\s*</);
  assert.match(source, /handleDeleteProject/);
  assert.match(source, /Delete project/);
  assert.match(source, /handleDeleteHistorySession/);
});

test('message scroller absorbs spare height above the first message', () => {
  const scrollerSource = readFileSync(
    new URL('../components/ui/message-scroller.tsx', import.meta.url),
    'utf8',
  );
  const pageSource = readFileSync(
    new URL('../app/agent/page.tsx', import.meta.url),
    'utf8',
  );

  assert.match(scrollerSource, /min-h-full/);
  assert.match(scrollerSource, /first:mt-auto/);
  assert.doesNotMatch(pageSource, /calc\(100svh-24rem\)/);
});
