pi-extensions
==============

Collection of small pi extensions for filesystem and git safety. Drop these files into either your project-local extensions dir (.pi/extensions/) or the global agent extensions dir (~/.pi/agent/extensions/), or load ad-hoc with `--extension /path/to/extension.ts`.

Included extensions
-------------------

### path-permissions.ts

**Consolidated permissions extension with secure-by-default file access control.**

- **Secure-by-default**: No file access is allowed unless explicitly permitted.
- **Single "paths" array**: The permissions file uses a single "paths" array that may contain both base filesystem paths and glob patterns. The loader classifies each entry (wildcard-containing entries are treated as globs).
- **JSON configuration**: Clean, structured configuration file (also supports plain text format).
- **Default location**: `~/.pi/agent/permissions.json`

#### Configuration

**JSON format** (permissions.json) - **Recommended**:
```json
{
  "paths": [
    "~/projects/myproject",
    "~/Documents/work",
    "/tmp",
    "**/*.py",
    "**/*.ts",
    "**/*.js",
    "**/*.md",
    "README.md",
    "package.json"
  ]
}
```

**Plain text format** (also supported):
```
# Comments start with #
# Each non-empty line is classified as either a base path or a glob pattern.
# Use the "path:" prefix to force a base-path entry if needed.
path: ~/projects/myproject
# Wildcard-containing entries are treated as globs:
**/*.py
**/*.md
README.md
```

**CLI flags**:
- `--permissions-paths "dir1,dir2"` — comma-separated allowed base paths
- `--permissions-globs "**/*.py,README.md"` — comma-separated allowed glob patterns
- `--permissions-file /path/to/file` — custom permissions file location
- `--permissions-check-bash-tokens true/false` — inspect bash command tokens (default: true)

#### Behavior

- **Blocks all file operations by default** if no permissions are configured.
- **Allows access if**:
  - The path is under an allowed base path, OR
  - The path matches an allowed glob pattern
- **Checks**: read, write, edit, ls, find, grep, bash
- **Bash inspection**: Checks working directory and path-like tokens in commands

#### Example usage

**Option 1: JSON configuration file**
```bash
# Create ~/.pi/agent/permissions.json
cat > ~/.pi/agent/permissions.json << 'JSON'
{
  "paths": ["~/projects", "**/*.py", "**/*.md"]
}
JSON

pi  # Will enforce permissions from file
```

**Option 2: CLI flags**
```bash
pi --permissions-paths "~/projects/myrepo" --permissions-globs "**/*.py,**/*.md"
```

**Option 3: Custom config file**
```bash
pi --permissions-file ./my-permissions.json
```

#### Configuration Examples

**Allow a specific project**:
```json
{
  "paths": ["~/projects/myapp"]
}
```

**Allow only specific file types everywhere**:
```json
{
  "paths": [
    "**/*.py",
    "**/*.ts",
    "**/*.md",
    "package.json",
    "tsconfig.json"
  ]
}
```

**Combined approach (recommended)**:
```json
{
  "paths": [
    "~/projects/myapp",
    "/tmp",
    "**/*.py",
    "**/*.ts",
    "**/*.json",
    "**/*.md"
  ]
}
```

### git-protect.ts

- **Read-only mode for Git operations**. Blocks destructive git operations invoked via the bash tool.
- Default blocked subcommands: add, commit, push, reset, checkout, merge, rebase, cherry-pick, revert, clean, pull, apply, am, stash.pop, stash.apply, stash.drop, branch.delete, tag.delete
- CLI flag:
  - `--git-protect-blocked "sub1,sub2,..."` (override defaults)
- Behavior: inspects bash invocations and blocks git subcommands that would alter repository state.

How to install
--------------

1. Copy the .ts extension files into one of the following locations:
   - Project-local: `<repo>/.pi/extensions/`
   - Global: `~/.pi/agent/extensions/`

   Or pass them directly to pi at startup:
   ```bash
   pi --extension ~/projects/pi-extensions/path-permissions.ts
   ```

2. Configure permissions:
   - Default config: `~/.pi/agent/permissions.json`
   - Or use CLI flags for quick setup

3. Quick start examples:
   ```bash
   # Allow current project
   pi --permissions-paths "$(pwd)"
   
   # Allow specific file patterns
   pi --permissions-globs "**/*.py,**/*.md" --permissions-paths "~/projects"
   
   # Git protection
   pi --git-protect-blocked "add,commit,push"
   ```

Security notes
--------------

- Extensions run in-process and are trusted. Do not install untrusted extensions.
- These extensions perform heuristic checks (token inspection, glob matching, realpath canonicalization). They reduce risk but are not a sandbox: symlink TOCTOU and other race conditions are possible.
- For strong guarantees, run pi inside an isolated environment (container, VM) or restrict the system user permissions.
- The permissions extension is **deny-by-default**: without configuration, all file operations are blocked. This is a secure starting point.
