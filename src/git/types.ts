import type { Disposable, Event, Uri } from 'vscode';

// Structural subset of VS Code's built-in Git API v1.
// Reference: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
export interface GitChange {
  readonly uri: Uri;
  readonly originalUri?: Uri;
  readonly status: number;
}

export interface GitRef {
  readonly type: number;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface GitCommit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly authorDate?: Date;
  readonly commitDate?: Date;
}

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: {
    readonly HEAD: {
      readonly name?: string;
      readonly commit?: string;
      readonly upstream?: { readonly remote: string; readonly name: string };
      readonly ahead?: number;
      readonly behind?: number;
    } | undefined;
    readonly indexChanges: readonly GitChange[];
    readonly workingTreeChanges: readonly GitChange[];
    readonly untrackedChanges: readonly GitChange[];
    readonly mergeChanges: readonly GitChange[];
    readonly onDidChange: Event<void>;
  };
  status(): Promise<void>;
  getBranches(query: { remote?: boolean }): Promise<GitRef[]>;
  log(options: { maxEntries?: number; refNames?: string[] }): Promise<GitCommit[]>;
  getCommit(ref: string): Promise<GitCommit>;
  checkout(branch: string): Promise<void>;
}

export interface GitAPI {
  getRepository(uri: Uri): GitRepository | null;
  toGitUri(uri: Uri, ref: string): Uri;
  readonly git: { readonly path: string };
  readonly state: 'uninitialized' | 'initialized';
  readonly repositories: readonly GitRepository[];
  readonly onDidChangeState: Event<string>;
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: (listener: () => void) => Disposable;
  getAPI(version: 1): GitAPI;
}
