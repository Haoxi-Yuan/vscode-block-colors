# Block Colors

A sidebar color panel for recoloring the parts of the VS Code window.

## Use

1. Click the palette icon in the Activity Bar (or run **Block Colors: Open Color Panel**).
2. Click a block in the miniature window: Title Bar, Activity Bar, Side Bar, Tab Bar,
   Active Tab, Editor, Panel / Terminal, Status Bar.
3. Choose **Background** or **Text**, then drag in the color square and hue bar, type a hex
   value, or click a swatch. Changes apply live.
4. **Auto** (Text only) picks black or white text, whichever reads best on the background.
5. **Reset** clears one channel, **Reset block** clears the block, **Reset all blocks**
   clears everything this extension set.

## Where colors are saved

The switch at the top chooses the target:

- **User (all windows)**: your user `settings.json`.
- **This workspace**: the project's `.vscode/settings.json` (or the `.code-workspace` file),
  handy for telling Remote SSH windows apart.

Colors are written to `workbench.colorCustomizations`. Only the keys listed below are
touched; any other color customizations you have are left alone.

| Block | Background keys | Text keys |
| --- | --- | --- |
| Title Bar | `titleBar.activeBackground`, `titleBar.inactiveBackground` | `titleBar.activeForeground`, `titleBar.inactiveForeground` (60%) |
| Activity Bar | `activityBar.background` | `activityBar.foreground`, `activityBar.inactiveForeground` (60%) |
| Side Bar | `sideBar.background`, `sideBarSectionHeader.background` | `sideBar.foreground`, `sideBarTitle.foreground`, `sideBarSectionHeader.foreground` |
| Tab Bar | `editorGroupHeader.tabsBackground`, `tab.inactiveBackground` | `tab.inactiveForeground` |
| Active Tab | `tab.activeBackground` | `tab.activeForeground` |
| Editor | `editor.background`, `editorGutter.background` | `editor.foreground` |
| Panel / Terminal | `panel.background`, `terminal.background` | `terminal.foreground`, `panelTitle.activeForeground` |
| Status Bar | `statusBar.background`, `statusBar.noFolderBackground` | `statusBar.foreground`, `statusBar.noFolderForeground` |

Theme-specific blocks such as `"[Default Dark Modern]": { ... }` take precedence over these
top-level keys, so remove those if a color does not seem to apply.

## Build and install

Needs Node.js (for `npx`) and VS Code 1.74 or later.

```sh
git clone https://github.com/Haoxi-Yuan/vscode-block-colors.git
cd vscode-block-colors
npx --yes @vscode/vsce package
code --install-extension block-colors-0.1.0.vsix
```

If `code` is not found, run *Shell Command: Install 'code' command in PATH* from VS Code's Command Palette.

## License

MIT, see [LICENSE](LICENSE).
