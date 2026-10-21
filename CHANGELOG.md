# Changelog

## Unreleased

- **Dependency verification for AI tools**: new read-only MCP tool `verify_package` checks exact PyPI names against a pinned Trend Micro hallucinated-module dataset and the official registry; a match is a hard stop. npm checks confirm registry existence only because the dataset does not cover npm. KeyVault does not install packages, and registry presence is not a safety verdict.

## 1.6.0 (2026-10-07)

- **Agent pass**: let your AI tools keep working while you are away, for an overnight run or a long job. Choose an end time (up to 24 hours) and what they can use: everything, or only one project and the keys linked to it. The KeyVault page still locks after the usual time and needs your master password; your AI tools keep going until the end time, then KeyVault locks completely. Lock ends a pass at once, and so does the button on the lock screen. Passes are recorded in Activity, and only you can start one.
- While a pass is limited to a project, AI tools only see that project and its keys, and cannot create other projects.
- When the vault is locked, AI tools now open the unlock page at most once every 30 minutes, so an unattended run does not keep opening browser tabs.

## 1.5.0 (2026-10-06)

- **Checklist subtasks**: break an item into smaller steps, one level deep, with ids such as `RO-FOUND-001.1`. Subtasks stay with their parent when it moves phase, go with it when it is deleted, and show as "2/3 subtasks" on the parent, which folds them away. Add one with the subtask button on any item, or indent lines when you paste a list.
- AI tools can add subtasks (`subtasks` on an item, or `parent` pointing at an existing item) and nest or un-nest items with `update_checklist_items`. The next item to work on is the next open subtask, not its parent.

## 1.4.0 (2026-10-05)

- **Search GitHub** from Projects: in **Find my repos**, or next to **Browse…** in a project's folders. **My repos** lists your own and your organisations' repos (private ones too, with a GitHub token in the vault); **All of GitHub** searches everywhere. Each result shows if it is already on this computer and which project it belongs to. Add it as a project, link it to the open project, or clone it into your code folder in one click.
- The GitHub token stays in the vault: it goes only to GitHub, never to the browser, and `git clone` gets it through environment variables, so it is not written into the clone.
- Fixed: typing quickly in **New project** could put the folder path into the name.

## 1.3.0 (2026-10-05)

- **Project checklists**: every project now has a build checklist, organised in phases, with ids such as `RO-FOUND-001`, a status (to do, in progress, done, blocked, superseded), an owner and notes. Progress, totals by status (which double as filters), search and phase filters at the top. Add, rename, reorder and delete phases and items, change a project's ID prefix, or paste a list you already have. Superseded items stay on record but do not count towards progress.
- **Your AI writes and updates it**: new MCP tools `get_checklist`, `add_checklist_items` and `update_checklist_items`. Ask "Write a build checklist for this project in KeyVault", and as it works it marks items in progress and done and flags blockers. The project brief lists the open items by phase. AI tools cannot start a checklist over unless you ask.
- Project cards and **Continue where you left off** show checklist progress and the item in progress or up next.
- Existing next-steps lists move into the checklist automatically, as a "Next steps" phase.
- **Start with your computer**: KeyVault can now start hidden when you sign in, so it is already running after every restart and you never have to open the exe first. KeyVault asks once; change it any time in **Settings**, or with `keyvault autostart on` / `off`. The vault still stays locked until you unlock it. New command `keyvault background` starts KeyVault without opening the browser.

## 1.2.0 (2026-10-04)

- **Projects**: a harness for picking up any project where you left off. Each project has its local folders, a "where I left off" note, a next-steps checklist, links, the vault keys it uses and an activity log. Live git status per folder (branch, uncommitted changes, last commit). One click opens a folder in Explorer, VS Code, Cursor or a terminal. Create, rename, duplicate, archive and delete projects (deleting never touches your files). A Windows folder picker, and **Find my repos** to turn existing git repos into projects in one go.
- **Works with any LLM**: new MCP tools `list_projects`, `get_project`, `create_project`, `update_project`, `log_progress` and `open_project`, so Claude, Codex, Cursor or LM Studio can resume a project, work in its folders and log progress. AI tools cannot delete projects, and only archive one when you ask. For anything else, **Copy brief for any AI** copies a ready-to-paste summary.
- Projects are stored inside your encrypted vault.
- Git status never lets a repo's own config run a program (`core.fsmonitor` is switched off for every call KeyVault makes).

## 1.1.1 (2026-09-30)

- Fixed: Start all, Stop all and Restart said "Invalid compose project name" for projects whose names have capital letters or dots, such as those made by the Supabase CLI or older Docker Compose (Ranger_One_Platform).
- Opening an older copy of KeyVault.exe no longer replaces a newer KeyVault that is already running. It just opens the newer one.

## 1.1.0 (2026-09-29)

- **Apps**: a new tab that shows everything you have running as cards, like a streaming service. A spotlight for your main web app, a "Running now" row, one row per Docker compose project (stopped containers included) and a row for other services. Hover a card to open, restart, stop or see logs. Cards show each app's own icon, fetched from the app on your machine and kept to images only.
- The Ranger One brand fonts, Inter and JetBrains Mono, are now bundled with KeyVault (SIL Open Font Licence, see `ui/fonts/OFL.txt`), so it looks the same on every computer and still makes no outside requests.
- New home: https://github.com/RangerOneSpace/keyvault, with a Ranger One manual as the README.

## 1.0.5 (2026-09-29)

- Services: Start all, Stop all, Restart and the per-container buttons now show progress ("Stopping…") and stay disabled until Docker answers. Before, nothing seemed to happen while Docker worked.
- The list no longer refreshes under your pointer or while an action runs, so clicks are not lost.
- If any container fails, the message says which one and why, instead of reporting success.
- Stop all stops every container in the project at once instead of one by one (each can take up to 10 seconds).

## 1.0.4 (2026-09-29)

- Services: "Start all" has a glowing green border and "Stop all" a glowing red one, so they are easy to tell apart at a glance.

## 1.0.3 (2026-09-29)

Stop sending you back to KeyVault.exe.

- KeyVault now always runs as a hidden background process. Double-clicking KeyVault.exe starts it (or finds it running), opens your browser and closes its own window. Closing a window no longer stops KeyVault or locks the vault.
- One sign-in per browser, not per tab. New tabs and bookmarks open straight in, and the sign-in survives KeyVault restarting. Only SHA-256 hashes of session tokens are kept on disk (`sessions.json`). A sign-in never unlocks the vault: after a restart or auto-lock it still needs your master password.
- A fixed address, http://127.0.0.1:47821, so bookmarks keep working. If that port is taken, KeyVault picks a free one as before.
- If KeyVault stops, open pages reconnect by themselves as soon as it is running again.
- More auto-lock choices: 2, 8, 12 and 24 hours.
- Settings > Running KeyVault: "Sign out other browsers" and "Stop KeyVault".
- Fixed: locking while the Services tab was refreshing logged "Cannot read properties of null (reading 'settings')".
- `keyvault serve` still runs in the current window, for troubleshooting.

## 1.0.2 (2026-09-29)

- Full Ranger One design: navy, tactical blue and arctic white, square pixel styling, the animated R1 mark (approved boot sequence) on the unlock screen and in the app bar, terminal-style buttons.
- Links to rangerone.io, support@rangerone.io and GitHub in the footer, on the unlock screen and in Settings > About.
- Ranger One R1 app icon for KeyVault.exe.

## 1.0.1 (2026-09-29)

- Standalone executables: KeyVault.exe for Windows (double-click to open, no Node.js needed), plus macOS and Linux builds, published by a release workflow with SHA-256 checksums.
- The KeyVault window shows a one-time login link as a fallback if the browser does not open, and gives a fresh link when you press Enter.
- More reliable browser launch on Windows.
- Opening a newer version replaces an older KeyVault that is still running.

## 1.0.0 (2026-09-29)

First release.

- Encrypted local vault (AES-256-GCM, PBKDF2-SHA256 600k) with organisations, providers, environments, status, expiry dates and notes.
- Browser UI served on 127.0.0.1 with one-time login links, auto-lock, reveal-for-20-seconds and self-clearing clipboard.
- Encrypted backup and restore, previous-version safety copy, CSV inventory export without key values.
- MCP server for Claude Code, Claude Desktop, Codex CLI, Cursor, LM Studio and other MCP clients: list keys, write `.env` files and run commands with keys, with values scrubbed from output. Activity log of every use.
- Services tab: Docker containers grouped by compose project (start, stop, restart, logs, compose up with linked keys) and every listening localhost port (owner, network exposure, page title, stop).
- MCP tools for services: list, logs (scrubbed), container actions, compose up with keys, free a port.
- Zero runtime dependencies.
