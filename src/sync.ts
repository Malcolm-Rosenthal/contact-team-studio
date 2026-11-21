import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type DataFilePath = 'manuscript.md' | 'bible.json' | 'stats.json';

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface LocalFileRecord {
  path: DataFilePath;
  content: string;
  sha: string | null;
  dirty: boolean;
  updatedAt: number;
}

export interface SyncConflict {
  path: DataFilePath;
  localContent: string;
  remoteContent: string;
  remoteSha: string;
}

export type SyncResult =
  | { status: 'synced' }
  | { status: 'offline' }
  | { status: 'unconfigured' }
  | { status: 'conflict'; conflicts: SyncConflict[] }
  | { status: 'error'; message: string };

interface StudioDB extends DBSchema {
  files: {
    key: DataFilePath;
    value: LocalFileRecord;
  };
}

const CONFIG_KEY = 'contact-team-github-config';
const ALL_FILES: DataFilePath[] = ['manuscript.md', 'bible.json', 'stats.json'];

let dbPromise: Promise<IDBPDatabase<StudioDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<StudioDB>('contact-team-studio-db', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'path' });
        }
      },
    });
  }
  return dbPromise;
}

// --- UTF-8 SAFE BASE64 ---
function encodeBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeBase64(b64: string): string {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// --- CONFIG STORAGE ---
export function loadConfig(): GitHubConfig | null {
  const raw = localStorage.getItem(CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GitHubConfig;
    if (parsed.owner && parsed.repo && parsed.token) {
      return { ...parsed, branch: parsed.branch || 'main' };
    }
  } catch {
    return null;
  }
  return null;
}

export function saveConfig(config: GitHubConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...config, branch: config.branch || 'main' }));
}

export function clearConfig(): void {
  localStorage.removeItem(CONFIG_KEY);
}

// --- LOCAL INDEXEDDB OPS ---
export async function getLocalFile(path: DataFilePath): Promise<LocalFileRecord | undefined> {
  const db = await getDB();
  return db.get('files', path);
}

export async function saveLocalFile(path: DataFilePath, content: string): Promise<LocalFileRecord> {
  const db = await getDB();
  const existing = await db.get('files', path);
  const record: LocalFileRecord = {
    path,
    content,
    sha: existing?.sha ?? null,
    dirty: true,
    updatedAt: Date.now(),
  };
  await db.put('files', record);
  return record;
}

export async function hasUnsyncedChanges(): Promise<boolean> {
  const db = await getDB();
  for (const path of ALL_FILES) {
    const rec = await db.get('files', path);
    if (rec?.dirty) return true;
  }
  return false;
}

// --- GITHUB REST API ---
function apiHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchRemoteFile(
  config: GitHubConfig,
  path: string
): Promise<{ content: string; sha: string } | null> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}?ref=${config.branch}`;
  const res = await fetch(url, { headers: apiHeaders(config.token), cache: 'no-store' });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return {
    content: decodeBase64(data.content || ''),
    sha: data.sha as string,
  };
}

async function putRemoteFile(
  config: GitHubConfig,
  path: string,
  content: string,
  sha: string | null,
  message: string
): Promise<{ status: 'ok'; sha: string } | { status: 'conflict' }> {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
  const body: Record<string, string> = {
    message,
    content: encodeBase64(content),
    branch: config.branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: apiHeaders(config.token),
    body: JSON.stringify(body),
  });

  if (res.status === 409) return { status: 'conflict' };
  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return { status: 'ok', sha: data.content.sha as string };
}

// --- FULL SYNC (PULL + PUSH WITH CONFLICT DETECTION) ---
export async function syncAll(): Promise<SyncResult> {
  const config = loadConfig();
  if (!config) return { status: 'unconfigured' };
  if (!navigator.onLine) return { status: 'offline' };

  const db = await getDB();
  const conflicts: SyncConflict[] = [];

  try {
    for (const path of ALL_FILES) {
      const local = await db.get('files', path);
      const remote = await fetchRemoteFile(config, path);

      // Case 1: Nothing local yet -> pull remote
      if (!local) {
        if (remote) {
          await db.put('files', {
            path,
            content: remote.content,
            sha: remote.sha,
            dirty: false,
            updatedAt: Date.now(),
          });
        }
        continue;
      }

      // Case 2: Local is clean -> update if remote moved ahead
      if (!local.dirty) {
        if (remote && remote.sha !== local.sha) {
          await db.put('files', {
            path,
            content: remote.content,
            sha: remote.sha,
            dirty: false,
            updatedAt: Date.now(),
          });
        }
        continue;
      }

      // Case 3: Local is dirty AND remote changed -> conflict!
      if (remote && local.sha && remote.sha !== local.sha) {
        conflicts.push({
          path,
          localContent: local.content,
          remoteContent: remote.content,
          remoteSha: remote.sha,
        });
        continue;
      }

      // Case 4: Local is dirty and remote matches our base SHA -> safe to push
      const putRes = await putRemoteFile(
        config,
        path,
        local.content,
        remote ? remote.sha : null,
        `Sync ${path} (${new Date().toLocaleString()})`
      );

      if (putRes.status === 'conflict') {
        const latest = await fetchRemoteFile(config, path);
        if (latest) {
          conflicts.push({
            path,
            localContent: local.content,
            remoteContent: latest.content,
            remoteSha: latest.sha,
          });
        }
      } else {
        await db.put('files', {
          ...local,
          sha: putRes.sha,
          dirty: false,
          updatedAt: Date.now(),
        });
      }
    }

    return conflicts.length > 0 ? { status: 'conflict', conflicts } : { status: 'synced' };
  } catch (err: any) {
    return { status: 'error', message: err?.message || String(err) };
  }
}

// --- CONFLICT RESOLUTION ---
export async function resolveConflict(
  conflict: SyncConflict,
  strategy: 'pull' | 'force-push' | 'save-copy'
): Promise<void> {
  const config = loadConfig();
  if (!config) throw new Error('GitHub not configured');
  const db = await getDB();

  if (strategy === 'pull') {
    await db.put('files', {
      path: conflict.path,
      content: conflict.remoteContent,
      sha: conflict.remoteSha,
      dirty: false,
      updatedAt: Date.now(),
    });
    return;
  }

  if (strategy === 'force-push') {
    const res = await putRemoteFile(
      config,
      conflict.path,
      conflict.localContent,
      conflict.remoteSha,
      `Force push ${conflict.path} (resolved conflict)`
    );
    if (res.status === 'ok') {
      await db.put('files', {
        path: conflict.path,
        content: conflict.localContent,
        sha: res.sha,
        dirty: false,
        updatedAt: Date.now(),
      });
    }
    return;
  }

  if (strategy === 'save-copy') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const copyPath = conflict.path.replace(/(\.[^.]+)$/, `.conflict-${stamp}$1`);
    await putRemoteFile(
      config,
      copyPath,
      conflict.localContent,
      null,
      `Save conflict copy of ${conflict.path}`
    );
    // Then pull remote into the main file
    await db.put('files', {
      path: conflict.path,
      content: conflict.remoteContent,
      sha: conflict.remoteSha,
      dirty: false,
      updatedAt: Date.now(),
    });
  }
}