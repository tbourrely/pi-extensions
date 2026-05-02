pi-extensions
==============

Collection of small pi extensions for filesystem and git safety. Drop these files into either your project-local extensions dir (.pi/extensions/) or the global agent extensions dir (~/.pi/agent/extensions/), or load ad-hoc with `--extension /path/to/extension.ts`.

Included extensions
-------------------

- path-whitelist.ts
  - Enforces a filesystem whitelist for tools and bash.
  - Default whitelist file: <agentDir>/whitelist.txt (usually ~/.pi/agent/whitelist.txt).
  - CLI flags:
    - --whitelist-paths "dir1,dir2" (comma-separated)
    - --whitelist-file /abs/path/to/file
    - --whitelist-check-tokens (true/false) — inspect bash command tokens for path-like arguments.
  - Behavior: allows tool execution only when the session cwd and referenced file tokens are under one of the whitelisted base paths. Recommended to prevent accidental access to secrets.

- path-blacklist.ts
  - Blocks reading of files that match glob patterns.
  - Default blacklist file: <agentDir>/blacklist.txt (usually ~/.pi/agent/blacklist.txt).
  - CLI flags:
    - --blacklist-globs "g1,g2" (comma-separated globs)
    - --blacklist-file /abs/path/to/file
    - --blacklist-check-bash-tokens (true/false) — inspect bash tokens and block commands referencing blacklisted files.
  - Behavior: stops read/ls/find/grep and inspects bash tokens; useful to block .env, secret files, etc.
  - Glob support: **, *, ? (typical patterns such as "**/.env" or ".env" are supported).

- git-protect.ts
  - Read-only mode for Git operations. Blocks destructive git operations invoked via the bash tool.
  - Default blocked subcommands (stricter-by-default): add, commit, push, reset, checkout, merge, rebase, cherry-pick, revert, clean, pull, apply, am, stash.pop, stash.apply, stash.drop, branch.delete, tag.delete
  - CLI flag:
    - --git-protect-blocked "sub1,sub2,..." (override defaults)
  - Behavior: inspects bash invocations and blocks git subcommands that would alter repository state (including `git merge --abort`, `git revert --no-edit`, branch/tag deletes, stash pop/apply/drop, etc.).

How to install
--------------

1. Copy the .ts extension files into one of the following locations:
   - Project-local: <repo>/.pi/extensions/
   - Global: ~/.pi/agent/extensions/

   Or pass them directly to pi at startup:
   pi --extension ~/projects/pi-extensions/path-whitelist.ts

2. Configure via flags or the default files in the agent dir:
   - Default agent dir: ~/.pi/agent/ (override with PI_CODING_AGENT_DIR)
   - whitelist: ~/.pi/agent/whitelist.txt
   - blacklist: ~/.pi/agent/blacklist.txt

3. Example flags:
   pi --whitelist-paths "/home/alice/projects/myrepo,/tmp"
   pi --blacklist-globs "**/.env,.env,secrets/*.key"
   pi --git-protect-blocked "add,commit,push,reset,checkout,merge,rebase,clean"

Security notes
--------------

- Extensions run in-process and are trusted. Do not install untrusted extensions.
- These extensions perform heuristic checks (token inspection, glob matching, realpath canonicalization). They reduce risk but are not a sandbox: symlink TOCTOU and other race conditions are possible.
- For strong guarantees, run pi inside an isolated environment (container, VM) or restrict the system user permissions.
