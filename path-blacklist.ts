// path-blacklist.ts
// Extension to block reading of files matching configured glob patterns (supports **, *, ?).
// Default blacklist file: <agentDir>/blacklist.txt (e.g., ~/.pi/agent/blacklist.txt)

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
  pi.registerFlag("blacklist-globs", {
    type: "string",
    description: "Comma-separated glob patterns to block (e.g. '**/.env,.env')",
    default: "",
  });
  pi.registerFlag("blacklist-file", {
    type: "string",
    description: "Path to blacklist file (default: <agentDir>/blacklist.txt)",
    default: "",
  });
  pi.registerFlag("blacklist-check-bash-tokens", {
    type: "boolean",
    description: "When true, inspect path-like tokens in bash commands and block if they reference blacklisted files",
    default: true,
  });

  const defaultListPath = path.join(getAgentDir(), "blacklist.txt");

  function loadPatterns(cwd: string): string[] {
    const fromFlag = (pi.getFlag("blacklist-globs") as string | undefined) || "";
    const fileFlag = (pi.getFlag("blacklist-file") as string | undefined) || "";
    const arr: string[] = [];

    if (fromFlag) {
      for (const p of fromFlag.split(",")) {
        const t = p.trim();
        if (t) arr.push(t);
      }
    }

    const fileToRead = fileFlag ? (path.isAbsolute(fileFlag) ? fileFlag : path.resolve(cwd, fileFlag)) : defaultListPath;
    try {
      const txt = fs.readFileSync(fileToRead, "utf8");
      for (const line of txt.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("#")) continue;
        arr.push(t);
      }
    } catch {
      // missing file is allowed
    }

    return arr;
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

  function tokensFromCommand(cmd: string): string[] {
    const tokens: string[] = [];
    const re = /'([^']*)'|"([^"]*)"|([^ \t\r\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd)) !== null) {
      tokens.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
    }
    return tokens;
  }

  pi.on("tool_call", (event, ctx) => {
    const tool = event.toolName;
    const patterns = loadPatterns(ctx.cwd);
    if (patterns.length === 0) return; // nothing configured
    const regexes = patterns.map(globToRegExp);

    function testCandidate(candidatePath: string | undefined): { matched: boolean; pattern?: string } {
      if (!candidatePath) return { matched: false };
      const real = canonicalize(candidatePath, ctx.cwd);
      if (!real) return { matched: false };
      const testPaths = [real.replace(/\\/g, "/"), path.relative(ctx.cwd, real).replace(/\\/g, "/"), path.basename(real)];
      for (let i = 0; i < regexes.length; i++) {
        const rx = regexes[i];
        for (const tp of testPaths) {
          if (rx.test(tp)) return { matched: true, pattern: patterns[i] };
        }
      }
      return { matched: false };
    }

    if (["read", "ls", "find", "grep"].includes(tool)) {
      const inp: any = (event as any).input ?? {};
      const pathCandidates: string[] = [];
      if (typeof inp.path === "string") pathCandidates.push(inp.path);
      if (typeof inp.file_path === "string") pathCandidates.push(inp.file_path);
      if (tool === "find" && typeof inp.pattern === "string") {
        if (inp.pattern.includes("/") || inp.pattern.startsWith(".")) pathCandidates.push(inp.pattern);
      }
      for (const c of pathCandidates) {
        const res = testCandidate(c);
        if (res.matched) return { block: true, reason: `Blocked by blacklist pattern: ${res.pattern}` };
      }
      return;
    }

    if (tool === "read" || tool === "write" || tool === "edit") {
      const inp: any = (event as any).input ?? {};
      const c = (typeof inp.path === "string" && inp.path) || (typeof inp.file_path === "string" && inp.file_path);
      const res = testCandidate(c);
      if (res.matched) return { block: true, reason: `Blocked by blacklist pattern: ${res.pattern}` };
      return;
    }

    if (tool === "bash") {
      const check = !!pi.getFlag("blacklist-check-bash-tokens");
      if (!check) return;
      const cmd = (event as any).input?.command ?? "";
      const tokens = tokensFromCommand(cmd);
      for (const t of tokens) {
        if (!t) continue;
        if (t.includes("/") || t.startsWith("~") || t.startsWith(".")) {
          if (t.startsWith("-")) continue;
          const res = testCandidate(t);
          if (res.matched) return { block: true, reason: `Bash command references blacklisted file: ${res.pattern}` };
        }
      }
      return;
    }

    return;
  });
}
