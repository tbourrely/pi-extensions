// path-permissions.ts
// Consolidated permissions extension (replaces separate blacklist/whitelist).
// Secure-by-default: no file access is allowed unless explicitly permitted by
// allowed base paths or allowed glob patterns.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function globToRegExp(glob: string): RegExp {
  const patt = glob.replace(/\\/g, "/");
  let i = 0;
  let out = "^";
  while (i < patt.length) {
    const c = patt[i];
    if (c === "*") {
      if (patt[i + 1] === "*") {
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += ".";
      i += 1;
      continue;
    }
    if ("+.^$()[]{}|\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("permissions-globs", {
    type: "string",
    description: "Comma-separated allowed glob patterns (e.g. '**/*.py,README.md')",
    default: "",
  });
  pi.registerFlag("permissions-paths", {
    type: "string",
    description: "Comma-separated allowed base paths (absolute or relative to cwd)",
    default: "",
  });
  pi.registerFlag("permissions-file", {
    type: "string",
    description: "Path to permissions file (default: <agentDir>/permissions.txt)",
    default: "",
  });
  pi.registerFlag("permissions-check-bash-tokens", {
    type: "boolean",
    description: "When true, inspect path-like tokens in bash commands and block if they reference disallowed files",
    default: true,
  });

  const defaultPermissionsPath = path.join(getAgentDir(), "permissions.json");

  function loadPermissions(cwd: string): { globs: string[]; bases: string[] } {
    const fromFlag = ((pi.getFlag("permissions-globs") as string | undefined) || "").trim();
    const pathsFlag = ((pi.getFlag("permissions-paths") as string | undefined) || "").trim();
    const fileFlag = ((pi.getFlag("permissions-file") as string | undefined) || "").trim();

    const globs: string[] = [];
    const basesRaw: string[] = [];

    if (fromFlag) {
      for (const p of fromFlag.split(",")) {
        const t = p.trim();
        if (t) globs.push(t);
      }
    }

    if (pathsFlag) {
      for (const p of pathsFlag.split(",")) {
        const t = p.trim();
        if (t) basesRaw.push(t);
      }
    }

    const fileToRead = fileFlag ? (path.isAbsolute(fileFlag) ? fileFlag : path.resolve(cwd, fileFlag)) : defaultPermissionsPath;
    try {
      const txt = fs.readFileSync(fileToRead, "utf8");
      
      // Try parsing as JSON first
      try {
        const json = JSON.parse(txt);
        if (json.paths && Array.isArray(json.paths)) {
          basesRaw.push(...json.paths.filter((p: any) => typeof p === "string"));
        }
        if (json.globs && Array.isArray(json.globs)) {
          globs.push(...json.globs.filter((g: any) => typeof g === "string"));
        }
      } catch {
        // Not JSON, parse as plain text
        for (const line of txt.split(/\r?\n/)) {
          const raw = line.trim();
          if (!raw) continue;
          if (raw.startsWith("#")) continue;
          const low = raw.toLowerCase();
          if (low.startsWith("glob:") || low.startsWith("g:")) {
            const v = raw.split(":").slice(1).join(":").trim();
            if (v) globs.push(v);
            continue;
          }
          if (low.startsWith("path:") || low.startsWith("p:")) {
            const v = raw.split(":").slice(1).join(":").trim();
            if (v) basesRaw.push(v);
            continue;
          }
          // Heuristics: if line contains glob tokens, treat as glob, else as path
          if (raw.includes("*") || raw.includes("?") || raw.includes("[") || raw.includes("]")) {
            globs.push(raw);
          } else {
            basesRaw.push(raw);
          }
        }
      }
    } catch {
      // missing file is allowed; empty means no permissions configured
    }

    const bases: string[] = [];
    for (const b of basesRaw) {
      try {
        const expanded = b.startsWith("~") ? path.join(process.env.HOME || "", b.slice(1)) : b;
        const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
        const real = fs.realpathSync(abs).replace(/[\\/]+$/, "");
        bases.push(real);
      } catch {
        // ignore invalid base
      }
    }

    return { globs, bases };
  }

  function canonicalize(p: string, cwd: string): string | undefined {
    try {
      const expanded = p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p;
      const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
      return fs.realpathSync(abs).replace(/[\\/]+$/, "");
    } catch {
      return undefined;
    }
  }

  function isUnderAnyBase(candidate: string, bases: string[]): boolean {
    const candReal = (() => {
      try { return fs.realpathSync(candidate).replace(/[\/\\]+$/, ""); } catch { return undefined; }
    })();
    if (!candReal) return false;
    for (const base of bases) {
      if (candReal === base) return true;
      const bsep = base + path.sep;
      if (candReal.startsWith(bsep)) return true;
    }
    return false;
  }

  function tokensFromCommand(cmd: string): string[] {
    const tokens: string[] = [];
    const re = /'([^']*)'|"([^\"]*)"|([^ \t\r\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
      tokens.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
    }
    return tokens;
  }

  pi.on("tool_call", (event, ctx) => {
    const tool = event.toolName;
    const perms = loadPermissions(ctx.cwd);
    const globs = perms.globs;
    const bases = perms.bases;

    // By default secure: if no permissions configured at all, block all file operations
    const hasAnyPermission = globs.length > 0 || bases.length > 0;

    const globRegexes = globs.map(globToRegExp);

    function matchesGlob(candidatePath: string | undefined): { matched: boolean; pattern?: string } {
      if (!candidatePath) return { matched: false };
      const real = canonicalize(candidatePath, ctx.cwd);
      if (!real) return { matched: false };
      const testPaths = [real.replace(/\\/g, "/"), path.relative(ctx.cwd, real).replace(/\\/g, "/"), path.basename(real)];
      for (let i = 0; i < globRegexes.length; i++) {
        const rx = globRegexes[i];
        for (const tp of testPaths) {
          if (rx.test(tp)) return { matched: true, pattern: globs[i] };
        }
      }
      return { matched: false };
    }

    function isAllowed(candidate: string | undefined): { allowed: boolean; reason?: string } {
      if (!candidate) return { allowed: false, reason: "No path provided" };
      const real = canonicalize(candidate, ctx.cwd);
      if (!real) return { allowed: false, reason: "Path could not be resolved" };

      // allowed if under any base
      if (bases.length > 0 && isUnderAnyBase(real, bases)) return { allowed: true };

      // allowed if matches any allowed glob
      if (globs.length > 0) {
        const mg = matchesGlob(real);
        if (mg.matched) return { allowed: true };
      }

      return { allowed: false };
    }

    // Tools that operate on explicit paths
    if (["read", "write", "edit", "ls", "find", "grep"].includes(tool)) {
      if (!hasAnyPermission) {
        return { block: true, reason: "No permissions configured: operation denied" };
      }

      const inp: any = (event as any).input ?? {};
      const candidates: string[] = [];

      if (typeof inp.path === "string") candidates.push(inp.path);
      if (typeof inp.file_path === "string") candidates.push(inp.file_path);
      if (tool === "ls" && candidates.length === 0) {
        // ls without path refers to cwd
        candidates.push(ctx.cwd);
      }
      if (tool === "find") {
        if (typeof inp.pattern === "string") {
          const pat = inp.pattern;
          if (pat.includes(path.sep) || pat.startsWith(".")) {
            candidates.push(pat);
          } else {
            // bare pattern (e.g. "*.py"): allow only if some glob permission exists that would permit it,
            // or if cwd is under an allowed base. We conservatively require at least one permission to be present above.
            if (bases.length > 0) return; // allowed since cwd/base will govern
            // if only globs exist, check if any allowed glob is broad enough to match the pattern
            const patRx = globToRegExp(pat);
            for (const g of globs) {
              const grx = globToRegExp(g);
              // crude check: if grx matches a sample filename and patRx matches that sample filename
              // try sample names: "a" + extension combos
              const samples = ["testfile.py", "a.txt", "README.md", "setup.cfg"];
              for (const s of samples) {
                if (patRx.test(s) && grx.test(s)) return; // allow
              }
            }
            return { block: true, reason: `Find pattern not allowed: ${pat}` };
          }
        }
      }

      if (candidates.length === 0) return { block: true, reason: "No path candidate to check" };

      for (const c of candidates) {
        const res = isAllowed(c);
        if (!res.allowed) return { block: true, reason: `Path not permitted: ${c}` };
      }

      return;
    }

    if (tool === "bash") {
      const check = !!pi.getFlag("permissions-check-bash-tokens");

      // If no permissions configured, block all bash commands that might touch FS
      if (!hasAnyPermission) return { block: true, reason: "No permissions configured: bash disabled" };

      // First ensure cwd is allowed (if bases configured), otherwise require tokens to reference allowed paths/globs
      const cwdReal = (() => { try { return fs.realpathSync(ctx.cwd).replace(/[\\/]+$/, ""); } catch { return undefined; } })();
      if (bases.length > 0 && cwdReal && !isUnderAnyBase(cwdReal, bases)) {
        return { block: true, reason: `Working directory not in allowed bases: ${ctx.cwd}` };
      }

      if (!check) return;
      const cmd = (event as any).input?.command ?? "";
      const tokens = tokensFromCommand(cmd);
      for (const t of tokens) {
        if (!t) continue;
        if (t.includes(path.sep) || t.startsWith("~") || t.startsWith(".")) {
          if (t.startsWith("-")) continue;
          const allowed = isAllowed(t);
          if (!allowed.allowed) return { block: true, reason: `Bash command references disallowed path: ${t}` };
        }
      }
      return;
    }

    return;
  });
}
