// path-whitelist.ts
// Extension to enforce a filesystem whitelist for tools (read/write/edit/find/grep/ls) and bash.
// Default whitelist file: <agentDir>/whitelist.txt (e.g., ~/.pi/agent/whitelist.txt)

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("whitelist-paths", {
    type: "string",
    description: "Comma-separated allowed base paths (absolute or relative to cwd)",
    default: "",
  });
  pi.registerFlag("whitelist-file", {
    type: "string",
    description: "Path to whitelist file (default: <agentDir>/whitelist.txt)",
    default: "",
  });
  pi.registerFlag("whitelist-check-tokens", {
    type: "boolean",
    description: "Inspect tokens in bash commands for path-like tokens",
    default: true,
  });

  const defaultWhitelistPath = path.join(getAgentDir(), "whitelist.txt");

  function loadBases(ctxCwd: string): string[] {
    const flagList = (pi.getFlag("whitelist-paths") as string | undefined) || "";
    const fileFlag = (pi.getFlag("whitelist-file") as string | undefined) || "";
    const raw: string[] = [];

    if (flagList) for (const p of flagList.split(",")) { const t = p.trim(); if (t) raw.push(t); }

    const fileToRead = fileFlag ? (path.isAbsolute(fileFlag) ? fileFlag : path.resolve(ctxCwd, fileFlag)) : defaultWhitelistPath;
    try {
      const content = fs.readFileSync(fileToRead, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("#")) continue; // comments
        raw.push(t);
      }
    } catch {
      // missing file is allowed; empty raw means no whitelist configured
    }

    const out: string[] = [];
    for (const b of raw) {
      try {
        const abs = path.isAbsolute(b) ? b : path.resolve(ctxCwd, b);
        const real = fs.realpathSync(abs).replace(/[\/\\]+$/, "");
        out.push(real);
      } catch {
        // ignore invalid base
      }
    }
    return out;
  }

  function canonical(p: string, cwd: string): string | undefined {
    try {
      const expanded = p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p;
      const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
      return fs.realpathSync(abs).replace(/[\/\\]+$/, "");
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

  function extractTokens(command: string): string[] {
    const tokens: string[] = [];
    const re = /'([^']*)'|"([^"]*)"|([^ \t\n\r]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
      tokens.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
    }
    return tokens;
  }

  pi.on("tool_call", (event, ctx) => {
    const tool = event.toolName;
    const bases = loadBases(ctx.cwd);

    // If no whitelist configured, block writes/edits by default; allow read/find/grep/ls
    if (bases.length === 0) {
      if (tool === "write" || tool === "edit") {
        return { block: true, reason: "No whitelist configured: write/edit are disabled" };
      }
    }

    if (["read", "write", "edit", "ls", "find", "grep"].includes(tool)) {
      const inp: any = (event as any).input ?? {};
      const candidates: string[] = [];

      if (typeof inp.path === "string") candidates.push(inp.path);
      if (typeof inp.file_path === "string") candidates.push(inp.file_path);
      if (tool === "find" && typeof inp.pattern === "string" && (inp.pattern.includes(path.sep) || inp.pattern.startsWith("."))) {
        candidates.push(inp.pattern);
      }

      if (candidates.length === 0) return;

      for (const c of candidates) {
        const real = canonical(c, ctx.cwd);
        if (!real || !isUnderAnyBase(real, bases)) {
          return { block: true, reason: `Path not in whitelist: ${c}` };
        }
      }
      return;
    }

    if (tool === "bash") {
      const cwdReal = (() => { try { return fs.realpathSync(ctx.cwd).replace(/[\/\\]+$/, ""); } catch { return undefined; } })();
      if (!cwdReal || !isUnderAnyBase(cwdReal, bases)) {
        return { block: true, reason: `Working directory not in whitelist: ${ctx.cwd}` };
      }

      const checkTokens = !!pi.getFlag("whitelist-check-tokens");
      if (checkTokens) {
        const cmd: string = (event as any).input?.command ?? "";
        const tokens = extractTokens(cmd);
        for (const t of tokens) {
          if (!t) continue;
          if (t.includes(path.sep) || t.startsWith("~") || t.startsWith(".")) {
            if (t.startsWith("-")) continue;
            const maybe = canonical(t, ctx.cwd);
            if (maybe && !isUnderAnyBase(maybe, bases)) {
              return { block: true, reason: `Command references path outside whitelist: ${t}` };
            }
          }
        }
      }
      return;
    }

    return;
  });
}
