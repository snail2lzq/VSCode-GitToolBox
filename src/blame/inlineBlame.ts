import * as vscode from 'vscode';
import type { RepositoriesView } from '../views/repositoriesView';
import { blameLine } from './blameService';
import type { LineBlame } from './blameService';

export class InlineBlame implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly cache = new Map<string, LineBlame | undefined>();
  private editor: vscode.TextEditor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: AbortController | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly repositories: RepositoriesView, private readonly output: vscode.LogOutputChannel) {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === vscode.window.activeTextEditor?.document) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(() => { this.cache.clear(); this.schedule(); }),
      vscode.workspace.onDidCloseTextDocument(() => { this.cache.clear(); }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('gittoolbox.inlineBlame')) {
          this.schedule();
        }
      }),
      repositories.onDidChangeTreeData(() => { this.cache.clear(); this.schedule(); }),
    );
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed) {
      return;
    }
    this.sequence++;
    clearTimeout(this.timer);
    this.pending?.abort();
    this.pending = undefined;
    this.editor?.setDecorations(this.decoration, []);
    this.editor = undefined;
    const sequence = this.sequence;
    this.timer = setTimeout(() => { void this.update(sequence); }, 200);
  }

  private async update(sequence: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length !== 1 || !vscode.workspace.isTrusted
      || !['file', 'vscode-remote'].includes(editor.document.uri.scheme)
      || !vscode.workspace.getConfiguration('gittoolbox', editor.document.uri).get<boolean>('inlineBlame.enabled', true)) {
      return;
    }
    const repository = this.repositories.getRepository(editor.document.uri);
    const git = this.repositories.gitPath;
    if (!repository || !git) {
      return;
    }
    const version = editor.document.version;
    const line = editor.selection.active.line;
    const id = editor.document.uri.toString();
    const state = repository.state;
    const untracked = [...state.untrackedChanges, ...state.workingTreeChanges].some(change => change.uri.toString() === id && change.status === 7);
    const added = state.indexChanges.some(change => change.uri.toString() === id && [1, 9].includes(change.status));
    if (untracked || added || !state.HEAD?.commit) {
      this.render(editor, line, untracked ? '未受版本控制' : '尚未提交');
      return;
    }
    const key = JSON.stringify([id, version, state.HEAD.commit, line]);
    const controller = new AbortController();
    this.pending = controller;
    try {
      let blame = this.cache.get(key);
      if (!this.cache.has(key)) {
        const contents = editor.document.getText();
        if (contents.length > 2_000_000) {
          return;
        }
        blame = await blameLine(git, repository.rootUri.fsPath, editor.document.uri.fsPath, line + 1, contents, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        if (this.cache.size >= 100) {
          this.cache.delete(this.cache.keys().next().value!);
        }
        this.cache.set(key, blame);
      }
      if (!blame || this.disposed || sequence !== this.sequence || editor !== vscode.window.activeTextEditor
        || editor.document.version !== version) {
        return;
      }
      if (blame.uncommitted) {
        this.render(editor, line, '尚未提交');
      } else {
        const time = this.formatTime(blame.authorTime);
        const text = [blame.author, time, blame.summary]
          .map(value => value.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' · ');
        this.render(editor, line, text);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.output.debug('Inline blame is unavailable for this line.', error);
      }
    } finally {
      if (this.pending === controller) {
        this.pending = undefined;
      }
    }
  }

  private formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(timestamp));
  }

  private render(editor: vscode.TextEditor, line: number, text: string): void {
    const end = editor.document.lineAt(line).range.end;
    const characters = Array.from(text);
    const contentText = characters.length > 64 ? `${characters.slice(0, 61).join('')}...` : text;
    editor.setDecorations(this.decoration, [{
      range: new vscode.Range(end, end), renderOptions: { after: { contentText } },
    }]);
    this.editor = editor;
  }

  dispose(): void {
    this.disposed = true;
    this.sequence++;
    clearTimeout(this.timer);
    this.pending?.abort();
    this.editor?.setDecorations(this.decoration, []);
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.cache.clear();
    this.decoration.dispose();
  }
}
