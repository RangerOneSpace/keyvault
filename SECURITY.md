# Security

KeyVault stores secrets, so we take reports seriously and want its limits to be clear.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting (**Security > Report a vulnerability** on this repository) or email [support@rangerone.io](mailto:support@rangerone.io) with "KeyVault security" in the subject. We aim to reply within 5 working days and will credit you in the release notes unless you would rather we did not.

## What KeyVault protects against

- **Someone reading your disk, backups or cloud storage.** The vault file and backups are AES-256-GCM encrypted with a key derived from your master password (PBKDF2-HMAC-SHA256, 600,000 iterations, random salt, fresh nonce per save). Tampering is detected.
- **Other websites in your browser.** KeyVault listens on `127.0.0.1` only, checks the `Host` header (blocks DNS rebinding) and `Origin`, requires custom request headers (blocks cross-site requests), and serves a Content Security Policy that forbids external scripts and connections. A single-use, two-minute login link gives the browser a session token, kept in localStorage for that exact origin (so other localhost ports cannot read it) and sent in a header. There is no cookie, so other servers on localhost never receive it. KeyVault stores only a SHA-256 hash of each session token, so a restart does not sign you out and the file on disk cannot be used to sign in. Sessions expire after 30 days unused, and Settings can sign out every other browser. A session never unlocks the vault: that always needs the master password.
- **Other devices on your network.** Nothing listens on a network interface.
- **GitHub search.** Only when you search or clone does KeyVault contact `api.github.com` and `github.com`. A GitHub token from the vault, if you stored one, is sent only there: never to the browser, and to `git clone` through environment variables, so it is not written into the cloned repo's config or shown on its command line. Clone targets are checked: an `owner/repo` name, an existing full folder path, and a new folder that does not exist yet.
- **Keys leaking into AI chat logs.** No MCP tool or agent route returns a key value or a browser login link. Keys are written to dotenv files or injected into processes. Command output and container logs are scrubbed of every key stored in the vault (not only the ones used), including a key cut off at the output size limit.
- **Project notes and folders.** Projects are stored inside the encrypted vault, so your notes are protected like your keys. Folder paths are never run through a shell: they are passed to Explorer, VS Code, Cursor or the terminal as plain arguments. KeyVault reads git status with `core.fsmonitor` switched off, so a repo's own config cannot make it run a program. AI tools can read, create and update projects and open their folders, but cannot delete a project, and only archive one when told to; every change they make is recorded in the project's activity log and in **Activity**.
- **Command injection through Docker metadata.** Compose file paths from Docker labels are passed as arguments, never through a shell. Container names and project names are validated.
- **Password guessing through the UI.** Increasing delays after five wrong attempts, on top of the deliberately slow key derivation.
- **Leaving it open.** Auto-lock after a period without activity in the KeyVault window (AI tool use does not count). An optional **agent pass** keeps the vault available to AI tools (over the same local, token-authenticated agent API) until a time you choose, at most 24 hours, while the page itself still locks and needs the master password. A pass can be limited to one project and its linked keys, ends at its time, on **Lock**, or on restart, and is recorded in Activity. AI tools cannot start or extend a pass.

## What it does not protect against

Be honest with yourself about these:

- **Malware on your computer.** Anything running as your user account while the vault is unlocked can talk to KeyVault the same way your AI tools do (the agent token in `~/.keyvault/agent.json` is readable by your account), read files KeyVault writes, or log your keystrokes. This is the same trust boundary as `ssh-agent` or a password manager's browser extension.
- **An AI tool you have told to misbehave, or one that has been prompt-injected.** `run_with_secrets` runs commands with real keys. Output is scrubbed, but a command could still send a key elsewhere (for example `curl` to a hostile server) or encode it so the scrubber does not recognise it. Keep your AI tool's approval prompts on for commands you did not expect, and check **Activity**.
- **Files KeyVault writes for you.** `.env` files are plain text by nature. KeyVault adds them to `.gitignore`, but they are only as safe as the folder they are in. An AI tool that can read files by itself can open them and put the keys in the chat, so prefer `run_with_secrets` or compose "Up with keys" where you can.
- **Short values.** Values under 4 characters are not scrubbed from output (real API keys are far longer).
- **A weak master password.** Use a phrase of several words.
- **Forgetting your master password.** There is no recovery, by design.
- **Browser extensions** with access to all sites can read the KeyVault page while it is open.

KeyVault is an inventory and a safe way to hand keys to your local tools. For production secrets shared across a team or servers, use a dedicated secrets manager as well.

## Supported versions

Security fixes go into the latest release.
