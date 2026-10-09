# Security policy

## Report a vulnerability

Do not open a public issue for a security problem. Use the private **Report a vulnerability** form on the **Security** tab of this GitHub repository. Tell us the Peekumi version, your operating system and the steps that cause the problem. We reply in the private advisory.

Security fixes go into the latest release only.

## Threat model

Peekumi runs on your computer and shows the code of the repositories that you register. This section tells you what Peekumi protects, what it does not protect, and where your code goes.

### Access

- Each request, except pairing, needs a session or an access token. Peekumi has two tokens: the owner token and the read-only token. Each token is 32 random bytes. Only your user account can read the token files.
- Peekumi compares tokens in constant time. There is no limit on pairing attempts, but the tokens are long random values, so it is not practical to guess them.
- A pairing link changes a token into a session cookie. The cookie is `HttpOnly` and `SameSite=Strict`. It is also `Secure` when you use HTTPS through `peekumi share`. A session is valid for 30 days. Peekumi keeps only hashes of session IDs, and you can revoke a device at any time.
- A request that changes data must come from the same origin and must use JSON. Pages use a strict Content Security Policy, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- If a pairing link or a token leaks, rotate all access. The steps are in [Device access](docs/SETUP.md#device-access).

### What each device can do

- An owner device can read code, use Ask, write instructions, start tasks and sessions, answer command requests, approve results and manage devices.
- A read-only device can read the map and the source. It cannot use Ask, write instructions, see tasks or sessions, or read the Ask conversation.
- Each paired device can see all registered repositories. Peekumi does not have permissions for each repository. Register only the repositories that your devices can see.
- Only the owner token can add or remove a repository. The `peekumi` command on the host uses it. A device session cannot do this.

### Inspection

- Inspection is read-only. Peekumi reads committed Git objects. It does not change, switch or push the checkout, and it does not follow symlinks.
- To show uncommitted changes, Peekumi reads the files that `git status` names, but not ignored files. It keeps a copy of them as a private commit in its state folder, never in the repository. Peekumi runs no Git filter to read a file. `git status` itself can run the clean filters of your Git configuration (for example Git LFS), as it does in a terminal.
- Peekumi labels binary files, large files, submodules and common secret filenames, and it does not show their content or send it to Ask. The secret filenames are environment files (`.env`, `.env.*`, `*.env`, `.envrc`, except examples and templates), private keys and keystores (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.p8`, `*.jks`, `*.keystore`, `*.ppk`, `*.kdbx`, and `id_rsa`, `id_dsa`, `id_ecdsa` and `id_ed25519` with any suffix except `.pub`), and the credential files of common tools (`credentials`, `credentials.json`, `.npmrc`, `.netrc`, `.pgpass`, `.pypirc`, `.git-credentials`, `.dockercfg`, `.docker/config.json`, `.kube/config`, `.htpasswd`, `.yarnrc.yml`, `.terraformrc`, cloud service-account and `application_default_credentials.json` files, Terraform state and `*.tfvars`). This is not a secret scanner. Other files can contain sensitive code or data.

### Where your code goes

- **Ask** sends the selected code and its context to Anthropic through the Claude Code client on your computer. All built-in tools of Claude Code are disabled for Ask. While one answer runs, Ask can use read-only lookups through a key that is valid only for that answer. The lookups read committed code and cannot run code or change files.
- **Proposed fixes** use the same agent, the same restrictions and the same read-only lookups as Ask. The agent gets the rule breaks and reads the code at that commit. It changes nothing. Its proposals become instructions only when you save or send them.
- **Proposed rules** use the same agent, restrictions and read-only lookups as Ask. The agent changes nothing. Its rules go into `.peekumi.json` only through a task that you start and review.
- **Tasks** and **sessions** run Codex or Claude Code, which send code to OpenAI or Anthropic. If you choose OpenRouter for Ask, Ask sends your question and the code that it reads to OpenRouter, which sends them to the provider of the model that you chose. An OpenRouter task or session runs in Peekumi's own task agent. It can change files only in the worktree of the task, and it cannot run commands. The server keeps the OpenRouter key in its private state folder and never sends it to the browser. Do not use Ask or tasks on code that must not leave your computer.

- **Notifications** go from the server through the push service of the device's browser (Apple, Google, Mozilla or Microsoft). Peekumi encrypts each notification for the device, so the push service cannot read it. A notification contains the name of the task or session, a short line about what changed and a link that opens the run. A notification never contains code or a diff. The server keeps the subscriptions and its VAPID key in its private state folder. It accepts subscriptions only for the push services of these four companies.

### Agent tasks and sessions

- A task or a session runs the agent in a separate Git worktree on its own branch. The worktree is not a security sandbox: the agent runs with the permissions of your user account.
- Codex runs with its `--approve-for-me` preset, in tasks and in sessions. Claude Code runs with accepted edits and can use Bash in a task. Start tasks only with instructions that you trust.
- In a Claude Code session, the agent can run Git on its branch and a short list of test commands without a question. Each other command waits until you allow or deny it on an owner device. Peekumi alone checks each command against the list and your session rules; no rule goes to Claude Code. A rule never covers a command with several parts (`;`, `&`, `&&`, `|`, `$(…)`, a redirect). Peekumi offers no session rule for a program written with quotes, a backslash or a path, for shells, interpreters, `sudo` and other wrappers, package runners, containers and network tools, or for `git push` and `git config`. Options that start another program or reach outside the worktree (for example `go test -exec`, `npm test --script-shell`, `node --import`, `cargo --config`, `pytest -p`, `git --output` and `git diff --no-index`) always wait for you, also for listed commands. The details are in [WORKFLOW.md](docs/WORKFLOW.md#sessions).
- The listed test commands run the project's own test code, and the agent can change that code. So "ask first" stops other commands, but it does not make a session a sandbox: start sessions only for work that you trust, as for tasks.
- **Allow all commands** removes that question. The agent can then run any command with the permissions of your user account. It can read files outside the worktree, use the network and change other files on your computer. Use this mode only for work that you trust, and turn it off with **Commands: ask first**.
- Peekumi gives a session agent no project or user settings of Claude Code, so your own permission rules and hooks do not apply to it.
- Peekumi never pushes an agent branch. It merges a task or an ended session into your branch only when you tap **Merge** and confirm, and only as a fast-forward. Examine the result before you merge it.

### Network exposure

- By default, Peekumi listens only on `127.0.0.1`.
- `peekumi share` uses Tailscale Serve. Only devices on your tailnet can connect. Peekumi never enables Tailscale Funnel.
- `peekumi share --tunnel cloudflare` makes a public URL that anyone on the internet can reach. Pairing still controls access, but more attackers can try to connect. Use it only for a short time, and close it with Ctrl+C.
- A pairing link contains a token. Keep pairing links private, and do not put them in chats, issues or logs.

### Known limits

- Browser memory and browser history are not a guarantee of secure erasure.
- The service worker keeps only the application files. It never keeps source, API responses or pairing tokens.
