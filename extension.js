const vscode = require('vscode');

const SECTION = 'workbench';
const SETTING = 'colorCustomizations';
const SCOPE_KEY = 'blockColors.scope';
const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

// Each UI block maps a background and a text channel to one or more theme color keys.
// The first key of a channel is the primary one: its value is what the panel shows.
// `alpha` derives a dimmer variant (e.g. inactive text) from the picked color.
const BLOCKS = [
  {
    id: 'titleBar',
    label: 'Title Bar',
    bg: [{ key: 'titleBar.activeBackground' }, { key: 'titleBar.inactiveBackground' }],
    fg: [{ key: 'titleBar.activeForeground' }, { key: 'titleBar.inactiveForeground', alpha: 0.6 }],
  },
  {
    id: 'activityBar',
    label: 'Activity Bar',
    bg: [{ key: 'activityBar.background' }],
    fg: [{ key: 'activityBar.foreground' }, { key: 'activityBar.inactiveForeground', alpha: 0.6 }],
  },
  {
    id: 'sideBar',
    label: 'Side Bar',
    bg: [{ key: 'sideBar.background' }, { key: 'sideBarSectionHeader.background' }],
    fg: [{ key: 'sideBar.foreground' }, { key: 'sideBarTitle.foreground' }, { key: 'sideBarSectionHeader.foreground' }],
  },
  {
    id: 'tabs',
    label: 'Tab Bar',
    bg: [{ key: 'editorGroupHeader.tabsBackground' }, { key: 'tab.inactiveBackground' }],
    fg: [{ key: 'tab.inactiveForeground' }],
  },
  {
    id: 'activeTab',
    label: 'Active Tab',
    bg: [{ key: 'tab.activeBackground' }],
    fg: [{ key: 'tab.activeForeground' }],
  },
  {
    id: 'editor',
    label: 'Editor',
    bg: [{ key: 'editor.background' }, { key: 'editorGutter.background' }],
    fg: [{ key: 'editor.foreground' }],
  },
  {
    id: 'panel',
    label: 'Panel / Terminal',
    bg: [{ key: 'panel.background' }, { key: 'terminal.background' }],
    fg: [{ key: 'terminal.foreground' }, { key: 'panelTitle.activeForeground' }],
  },
  {
    id: 'statusBar',
    label: 'Status Bar',
    bg: [{ key: 'statusBar.background' }, { key: 'statusBar.noFolderBackground' }],
    fg: [{ key: 'statusBar.foreground' }, { key: 'statusBar.noFolderForeground' }],
  },
];

const BLOCK_MAP = new Map(BLOCKS.map((b) => [b.id, b]));
const CHANNELS = ['bg', 'fg'];

function hasWorkspace() {
  return Boolean(vscode.workspace.workspaceFile) ||
    Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length);
}

function targetOf(scope) {
  return scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

function readScopeValue(scope) {
  const info = vscode.workspace.getConfiguration(SECTION).inspect(SETTING) || {};
  const value = scope === 'workspace' ? info.workspaceValue : info.globalValue;
  return value && typeof value === 'object' ? value : {};
}

function withAlpha(hex, alpha) {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return hex.slice(0, 7) + a;
}

function asColor(value) {
  return typeof value === 'string' ? value : null;
}

// Coalesces rapid edits (dragging in the picker) and writes them one batch at a time,
// so concurrent read-modify-write cycles on the settings object never lose an edit.
class ColorWriter {
  constructor() {
    this.pending = new Map();
    this.timer = null;
    this.chain = Promise.resolve();
  }

  set(scope, key, value) {
    if (!this.pending.has(scope)) this.pending.set(scope, new Map());
    this.pending.get(scope).set(key, value);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 80);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = new Map();
    this.chain = this.chain
      .then(() => this.write(batch))
      .catch((err) => vscode.window.showErrorMessage(`Block Colors: could not save colors (${err.message})`));
    return this.chain;
  }

  async write(batch) {
    for (const [scope, changes] of batch) {
      const next = { ...readScopeValue(scope) };
      for (const [key, value] of changes) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      const empty = Object.keys(next).length === 0;
      await vscode.workspace.getConfiguration(SECTION).update(SETTING, empty ? undefined : next, targetOf(scope));
    }
  }
}

class ColorPanelProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.writer = new ColorWriter();
  }

  get scope() {
    const saved = this.context.workspaceState.get(SCOPE_KEY, 'global');
    return saved === 'workspace' && hasWorkspace() ? 'workspace' : 'global';
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.postState();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
    });
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        this.postState();
        break;
      case 'setColor':
        this.setColor(msg.block, msg.channel, msg.value);
        break;
      case 'resetBlock':
        this.setColor(msg.block, 'bg', null);
        this.setColor(msg.block, 'fg', null);
        break;
      case 'resetAll':
        await this.resetAll();
        break;
      case 'setScope':
        await this.setScope(msg.scope);
        break;
      case 'error':
        console.error(`[Block Colors] webview error: ${msg.message}`);
        break;
    }
  }

  setColor(blockId, channel, value) {
    const block = BLOCK_MAP.get(blockId);
    if (!block || !CHANNELS.includes(channel)) return;
    if (value !== null && !(typeof value === 'string' && HEX_RE.test(value))) return;
    const scope = this.scope;
    for (const { key, alpha } of block[channel]) {
      let stored;
      if (value !== null) stored = alpha === undefined ? value : withAlpha(value, alpha);
      this.writer.set(scope, key, stored);
    }
  }

  async resetAll() {
    const scope = this.scope;
    const where = scope === 'workspace' ? 'this workspace' : 'your user settings';
    const choice = await vscode.window.showWarningMessage(
      `Remove all Block Colors from ${where}? Other color customizations are kept.`,
      { modal: true },
      'Reset'
    );
    if (choice !== 'Reset') return;
    await this.clearAll(scope);
  }

  async clearAll(scope) {
    for (const block of BLOCKS) {
      for (const channel of CHANNELS) {
        for (const { key } of block[channel]) this.writer.set(scope, key, undefined);
      }
    }
    await this.writer.flush();
  }

  async setScope(scope) {
    if (scope !== 'global' && scope !== 'workspace') return;
    if (scope === 'workspace' && !hasWorkspace()) {
      vscode.window.showInformationMessage('Block Colors: open a folder first to save colors per project.');
      this.postState();
      return;
    }
    await this.context.workspaceState.update(SCOPE_KEY, scope);
    this.postState();
  }

  getState() {
    const scope = this.scope;
    const globalValue = readScopeValue('global');
    const workspaceValue = readScopeValue('workspace');
    const own = scope === 'workspace' ? workspaceValue : globalValue;
    const blocks = {};
    for (const block of BLOCKS) {
      blocks[block.id] = {};
      for (const channel of CHANNELS) {
        const primary = block[channel][0].key;
        blocks[block.id][channel] = {
          value: asColor(own[primary]),
          inherited: scope === 'workspace' ? asColor(globalValue[primary]) : null,
          overridden: scope === 'global' && block[channel].some(({ key }) => workspaceValue[key] !== undefined),
        };
      }
    }
    return {
      type: 'state',
      scope,
      hasWorkspace: hasWorkspace(),
      workspaceName: vscode.workspace.name || null,
      definitions: BLOCKS.map((b) => ({
        id: b.id,
        label: b.label,
        bg: b.bg.map((k) => k.key),
        fg: b.fg.map((k) => k.key),
      })),
      blocks,
    };
  }

  postState() {
    if (this.view) this.view.webview.postMessage(this.getState());
  }

  postTheme() {
    if (this.view) this.view.webview.postMessage({ type: 'theme' });
  }

  html(webview) {
    const media = (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('panel.css')}">
<title>Block Colors</title>
</head>
<body>
  <div class="scope" role="radiogroup" aria-label="Save colors to">
    <button type="button" role="radio" data-scope="global">User (all windows)</button>
    <button type="button" role="radio" data-scope="workspace">This workspace</button>
  </div>
  <p class="hint" id="scopeHint"></p>

  <div class="window" id="win" aria-label="Click a block to edit its colors">
    <button type="button" class="r r-title" data-block="titleBar"><span class="t">Title Bar</span></button>
    <button type="button" class="r r-act" data-block="activityBar"><i></i><i></i><i></i></button>
    <button type="button" class="r r-side" data-block="sideBar"><span class="t">EXPLORER</span><i></i><i></i><i></i></button>
    <button type="button" class="r r-atab" data-block="activeTab"><span class="t">main.py</span></button>
    <button type="button" class="r r-tabs" data-block="tabs"><span class="t">utils.py</span></button>
    <button type="button" class="r r-editor" data-block="editor"><i></i><i></i><i></i><i></i></button>
    <button type="button" class="r r-panel" data-block="panel"><span class="t">TERMINAL</span><span class="t">$ _</span></button>
    <button type="button" class="r r-status" data-block="statusBar"><span class="t">main</span><span class="t">Ln 1, Col 1</span></button>
  </div>

  <section class="card">
    <div class="card-head">
      <h2 id="blockName">Editor</h2>
      <button type="button" class="link" id="resetBlock">Reset block</button>
    </div>
    <p class="hint" id="source"></p>
    <p class="warn" id="warn" hidden></p>

    <div class="channel" role="tablist">
      <button type="button" role="tab" data-ch="bg">Background</button>
      <button type="button" role="tab" data-ch="fg">Text</button>
    </div>

    <div class="sv" id="sv" tabindex="0" aria-label="Saturation and brightness"><div class="sv-thumb" id="svThumb"></div></div>
    <div class="hue" id="hue" tabindex="0" aria-label="Hue"><div class="hue-thumb" id="hueThumb"></div></div>

    <div class="hex-row">
      <span class="chip" id="chip"></span>
      <input id="hex" type="text" spellcheck="false" maxlength="9" aria-label="Hex color">
      <button type="button" id="auto" title="Use black or white text, whichever reads best on this background">Auto</button>
      <button type="button" id="resetCh" title="Go back to the theme color for this channel">Reset</button>
    </div>
    <div class="swatches" id="swatches"></div>
    <p class="hint" id="contrast"></p>
  </section>

  <button type="button" class="danger" id="resetAll">Reset all blocks</button>
  <script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}

function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

let activeProvider = null;

function activate(context) {
  const provider = new ColorPanelProvider(context);
  activeProvider = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('blockColors.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('blockColors.open', () =>
      vscode.commands.executeCommand('blockColors.panel.focus')
    ),
    vscode.commands.registerCommand('blockColors.resetAll', () => provider.resetAll()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.${SETTING}`)) provider.postState();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.postState()),
    vscode.window.onDidChangeActiveColorTheme(() => provider.postTheme())
  );

  return { provider, blocks: BLOCKS };
}

function deactivate() {
  return activeProvider ? activeProvider.writer.flush() : undefined;
}

module.exports = { activate, deactivate };
