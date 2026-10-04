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

- An owner device can read code, use Ask, write instructions, start tasks, approve results and manage devices.
- A read-only device can read the map and the source. It cannot use Ask, write instructions, see tasks or read the Ask conversation.
- Each paired device can see all registered repositories. Peekumi does not have permissions for each repository. Register only the repositories that your devices can see.
- Only the owner token can add or remove a repository. The `peekumi` command on the host uses it. A device session cannot do this.

### Inspection

- Inspection is read-only. Peekumi reads committed Git objects. It does not change, switch or push the checkout, and it does not follow symlinks.
- Peekumi labels binary files, large files, submodules and common secret filenames, and it does not show their content. This is not a secret scanner. Other files can contain sensitive code or data.

### Where your code goes

- **Ask** sends the selected code and its context to Anthropic through the Claude Code client on your computer. All built-in tools of Claude Code are disabled for Ask. While one answer runs, Ask can use read-only lookups through a key that is valid only for that answer. The lookups read committed code and cannot run code or change files.
- **Tasks** run Codex or Claude Code, which send code to OpenAI or Anthropic. Do not use Ask or tasks on code that must not leave your computer.

### Agent tasks

- A task runs the agent in a separate Git worktree on its own branch. The worktree is not a security sandbox: the agent runs with the permissions of your user account.
- Codex runs with its `--approve-for-me` preset. Claude Code runs with accepted edits and can use Bash. Start tasks only with instructions that you trust.
- Peekumi never pushes or merges an agent branch. Examine the result before you merge it.

### Network exposure

- By default, Peekumi listens only on `127.0.0.1`.
- `peekumi share` uses Tailscale Serve. Only devices on your tailnet can connect. Peekumi never enables Tailscale Funnel.
- `peekumi share --tunnel cloudflare` makes a public URL that anyone on the internet can reach. Pairing still controls access, but more attackers can try to connect. Use it only for a short time, and close it with Ctrl+C.
- A pairing link contains a token. Keep pairing links private, and do not put them in chats, issues or logs.

### Known limits

- Browser memory and browser history are not a guarantee of secure erasure.
- The service worker keeps only the application files. It never keeps source, API responses or pairing tokens.
