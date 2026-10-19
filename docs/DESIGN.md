# Workspace design

Vortex uses a full-window workspace with a sidebar on wider screens and bottom navigation on phones. Navigation stays separate from the working content. Solid surfaces, clear headings, aligned controls and short labels take priority over decoration. The visual direction draws on Apple's [layout](https://developer.apple.com/design/human-interface-guidelines/layout), [sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars), [toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) and [materials](https://developer.apple.com/design/human-interface-guidelines/materials) guidance; this remains a web interface with its own icons and assets.

## Content and layout

- Keep shared navigation, login and VPS tools independent of the selected runtime. Minecraft worlds, players and add-ons belong in Bedrock workspaces; Node.js and Python controls belong in application workspaces.
- Give a page one clear primary action. Use lists for scanning inventories and grouped rows for settings. Keep real server covers available in the card view, rather than repeating decorative banners throughout administration pages.
- Show measured usage separately from resource limits. Unknown or stale data must stay visibly unknown; never replace it with an invented zero or a shared-resource label.
- Present progress, failure and uncertain outcomes beside the operation. Animation does not prove completion.
- Keep English and Vietnamese labels paired in the localization helpers. User names, paths, commands and native logs are content, not translation keys.

## Settings and keyboard access

Settings categories select existing sections without recreating their controls. Account, Appearance and Workspace are available to signed-in users; administration, members and uninstall are shown only to administrators. The navigation is an ordinary set of buttons, not a tab widget. `Tab` and `Shift+Tab` move between controls; `Enter` or `Space` selects a category. Arrow keys, `Home` and `End` move focus within the category navigation without selecting it. Selecting a category focuses its heading and brings the workspace to the top.

`Ctrl+K` or `Command+K` opens search and quick commands. Server workspace tabs support arrow keys, `Home` and `End`; activate the focused tab with `Enter` or `Space`. Dialogs keep their existing unsaved-change checks. Focus indicators must remain visible in both themes.

Respect `prefers-reduced-motion`, `prefers-reduced-transparency` and forced colors. Effects should be brief and should not animate whole data sections during routine measurement updates. On phones, controls need comfortable touch targets and editable fields must avoid text sizes that trigger unwanted browser zoom.

## Browser installation

The [web app manifest](../public/manifest.webmanifest) and local PNG icons let supporting browsers offer Vortex in their install or Add to Home Screen menu. Use HTTPS. The available command and standalone-window behavior depend on the browser and operating system. This does not turn Vortex into a native application.

No service worker or offline cache is registered. Authentication, live measurements and management actions still require the panel to be reachable. Installing the shortcut does not copy server data or credentials into an offline application.

## Maintenance

The final visual rules live in [workspace-system.css](../public/workspace-system.css). [workspace-settings.js](../public/workspace-settings.js) owns category navigation, while [workspace-system.js](../public/workspace-system.js) retains bounded viewport and focus continuity. Keep behavior in modules and visual tokens in the stylesheet; avoid fixing layout by changing authorization or operation semantics.

Verify desktop and phone layouts in both themes and languages, including long server names, empty inventories, offline nodes, loading failures, keyboard navigation and reduced-motion settings. A new visual treatment must preserve every applicable management tool.
