// git-protect.ts
// Extension to block destructive Git commands invoked via the bash tool.
// Provides a read-only mode for Git by default: blocks operations that alter repository state.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("git-protect-blocked", {
    type: "string",
    description:
      "Comma-separated git subcommands to block (default: add,commit,push,reset,checkout,merge,rebase,cherry-pick,revert,clean,pull,apply,am,stash.pop,stash.apply,stash.pop,stash.drop,branch.delete,tag.delete)",
    default:
      "add,commit,push,reset,checkout,merge,rebase,cherry-pick,revert,clean,pull,apply,am,stash.pop,stash.apply,stash.drop,branch.delete,tag.delete",
  });

  // crude tokenizer: quoted tokens or words
  function tokensFromCommand(cmd: string): string[] {
    const tokens: string[] = [];
    const re = /'([^']*)'|"([^"]*)"|([^ \t\r\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
      tokens.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
    }
    return tokens;
  }

  // split compound shell command into pipeline/sequence segments so we can inspect each
  function splitShellSegments(cmd: string): string[] {
    return cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean);
  }

  function normalizeToken(t: string): string {
    return t.trim();
  }

  // Map common git aliases to canonical names
  const aliasMap: Record<string, string> = {
    ci: "commit",
    co: "checkout",
    st: "status",
    br: "branch",
    rb: "rebase",
    lg: "log",
  };

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash") return; // only inspect bash executions

    const blockedFlag = (pi.getFlag("git-protect-blocked") as string | undefined) ?? "";
    const configured = new Set(
      blockedFlag
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    );

    const defaultBlocked = new Set([
      "add",
      "commit",
      "push",
      "reset",
      "checkout",
      "merge",
      "rebase",
      "cherry-pick",
      "revert",
      "clean",
      "pull",
      "apply",
      "am",
      "stash.pop",
      "stash.apply",
      "stash.drop",
      "branch.delete",
      "tag.delete",
    ]);

    const blockedSet = configured.size > 0 ? configured : defaultBlocked;

    const cmd: string = (event as any).input?.command ?? "";
    if (!cmd) return;

    const segments = splitShellSegments(cmd);
    for (const seg of segments) {
      const toks = tokensFromCommand(seg);
      if (toks.length === 0) continue;

      // Skip env assignments and prefixes like 'sudo' or 'env' that may precede git
      let idx = 0;
      while (idx < toks.length) {
        const tk = toks[idx];
        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tk)) { idx++; continue; }
        if (tk === 'sudo' || tk === 'env' || tk === 'nice' || tk === 'nohup') { idx++; continue; }
        break;
      }
      if (idx >= toks.length) continue;

      const cmdTok = normalizeToken(toks[idx]);
      const base = cmdTok.split(/[\/]/).pop() ?? cmdTok;
      if (base.toLowerCase() !== 'git') continue;

      const subRaw = toks[idx+1] ? normalizeToken(toks[idx+1]).toLowerCase() : '';
      if (!subRaw) continue; // no subcommand
      const sub = aliasMap[subRaw] ?? subRaw; // resolve alias

      // handle branch delete: git branch -D NAME or git branch --delete NAME
      if (sub === 'branch') {
        const tail = toks.slice(idx+2).join(' ');
        if (/\b(-D|-d|--delete)\b/.test(tail) || blockedSet.has('branch.delete')) {
          return { block: true, reason: `Git operation blocked by policy: git branch (delete)` };
        }
        continue;
      }

      // handle tag delete: git tag -d NAME or git tag --delete NAME
      if (sub === 'tag') {
        const tail = toks.slice(idx+2).join(' ');
        if (/\b(-d|--delete)\b/.test(tail) || blockedSet.has('tag.delete')) {
          return { block: true, reason: `Git operation blocked by policy: git tag (delete)` };
        }
        continue;
      }

      // stash subcommands
      if (sub === 'stash') {
        const sub2 = toks[idx+2] ? normalizeToken(toks[idx+2]).toLowerCase() : '';
        if (['pop','apply','drop'].includes(sub2) || blockedSet.has(`stash.${sub2}`)) {
          return { block: true, reason: `Git operation blocked by policy: git stash ${sub2}` };
        }
        continue;
      }

      // merge: block merge and merge --abort
      if (sub === 'merge') {
        const tail = toks.slice(idx+2).join(' ');
        if (tail.includes('--abort') || blockedSet.has('merge')) {
          return { block: true, reason: `Git operation blocked by policy: git merge` };
        }
        continue;
      }

      // reset: any reset alters refs
      if (sub === 'reset') {
        if (blockedSet.has('reset')) {
          return { block: true, reason: `Git operation blocked by policy: git reset` };
        }
        continue;
      }

      // checkout: block
      if (sub === 'checkout') {
        if (blockedSet.has('checkout')) {
          return { block: true, reason: `Git operation blocked by policy: git checkout` };
        }
        continue;
      }

      // revert: block
      if (sub === 'revert') {
        if (blockedSet.has('revert')) {
          return { block: true, reason: `Git operation blocked by policy: git revert` };
        }
        continue;
      }

      // direct match for other destructive subcommands
      if (blockedSet.has(sub) || blockedSet.has(subRaw)) {
        return { block: true, reason: `Git operation blocked by policy: git ${sub}` };
      }

      // fallback: scan tokens for blocked subcommands (defensive)
      for (const tk of toks) {
        const tkn = normalizeToken(tk).toLowerCase();
        const mapped = aliasMap[tkn] ?? tkn;
        if (blockedSet.has(mapped)) {
          return { block: true, reason: `Git operation blocked by policy (detected token): ${mapped}` };
        }
      }
    }

    return;
  });
}
