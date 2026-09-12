#!/usr/bin/env node
/**
 * cpanel-mail-mcp
 *
 * A stdio MCP server that exposes a SINGLE cPanel mailbox (IMAP + SMTP + CalDAV)
 * to an MCP client such as Claude Code.
 *
 * Design:
 *   - One mailbox per process. Each user runs their own instance with THEIR OWN
 *     credentials. There is no central multi-user credential store by design —
 *     that keeps 100 people's passwords out of one file.
 *   - Credentials come from a .env file beside this install, or from real env
 *     vars which take precedence. They are never logged.
 *   - stdio transport: no OAuth shim, no reverse proxy, no always-on server.
 *
 * Required env:
 *   IMAP_HOST, IMAP_PORT (default 993), IMAP_TLS (default true)
 *   SMTP_HOST, SMTP_PORT (default 465), SMTP_TLS (default true)
 *   MAIL_USER      full email address, e.g. burak@dantatsu.com
 *   MAIL_PASS      mailbox password (or app password)
 * Optional env:
 *   MAIL_FROM      From: header (defaults to MAIL_USER)
 *   CALDAV_URL     e.g. https://mail.dantatsu.com:2080/calendars/burak@dantatsu.com/calendar
 *   CALDAV_USER    defaults to MAIL_USER
 *   CALDAV_PASS    defaults to MAIL_PASS
 *   CALDAV_INSECURE_TLS = "true" to skip cert verification (cPanel :2080 self-signed). Use with care.
 *   ALLOW_DELETE   = "true" to expose the destructive delete_message tool (off by default)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import {
  fetchCalendars,
  fetchCalendarObjects,
  createCalendarObject,
  getBasicAuthHeaders,
} from "tsdav";
import ICAL from "ical.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- .env loading ----------

// Resolved next to the installed server rather than the client's cwd: MCP
// clients launch this process from an arbitrary directory. Real environment
// values win over the file, so --env flags still override it.
function loadDotEnv() {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      val.length > 1 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

// Must run before the config block below: during setup there is no .env yet,
// and reqEnv() would exit before the installer could ask anything.
if (process.argv[2] === "setup") {
  const { runSetup } = await import("./setup.js");
  await runSetup();
  process.exit(0);
}

// ---------- config ----------

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[cpanel-mail-mcp] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}
function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v.toLowerCase() === "true" || v === "1";
}

const CFG = {
  imap: {
    host: reqEnv("IMAP_HOST"),
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: boolEnv("IMAP_TLS", true),
    user: reqEnv("MAIL_USER"),
    pass: reqEnv("MAIL_PASS"),
  },
  smtp: {
    host: reqEnv("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: boolEnv("SMTP_TLS", true),
  },
  from: process.env.MAIL_FROM ?? process.env.MAIL_USER!,
  caldav: process.env.CALDAV_URL
    ? {
        url: process.env.CALDAV_URL,
        user: process.env.CALDAV_USER ?? process.env.MAIL_USER!,
        pass: process.env.CALDAV_PASS ?? process.env.MAIL_PASS!,
        insecure: boolEnv("CALDAV_INSECURE_TLS", false),
      }
    : null,
  allowDelete: boolEnv("ALLOW_DELETE", false),
};

// tsdav / node fetch honours this for self-signed cPanel :2080 certs.
if (CFG.caldav?.insecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// ---------- helpers ----------

async function withImap<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: CFG.imap.host,
    port: CFG.imap.port,
    secure: CFG.imap.secure,
    auth: { user: CFG.imap.user, pass: CFG.imap.pass },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

// Prefer the server's own SPECIAL-USE \Drafts flag; fall back to the usual
// spellings, including cPanel's INBOX-prefixed ones.
async function findDraftsFolder(c: ImapFlow): Promise<string> {
  const boxes = await c.list();
  const special = boxes.find((b: any) => b.specialUse === "\\Drafts");
  if (special) return special.path;
  const candidates = ["INBOX.Drafts", "Drafts", "INBOX/Drafts", "Taslaklar"];
  const hit = boxes.find((b) => candidates.includes(b.path));
  if (hit) return hit.path;
  throw new Error(
    "Taslak klasörü bulunamadı. draftsFolder parametresiyle klasör adını verin " +
      "(list_folders ile görebilirsiniz)."
  );
}

const smtp = nodemailer.createTransport({
  host: CFG.smtp.host,
  port: CFG.smtp.port,
  secure: CFG.smtp.secure,
  auth: { user: CFG.imap.user, pass: CFG.imap.pass },
});

// cPanel's cpdavd echoes "/" as the <D:href> of every multistatus response
// instead of the path that was requested. tsdav's built-in discovery matches
// responses by href, so it never finds the calendar home and fails with
// "cannot find homeUrl". We therefore run the two discovery PROPFINDs here and
// read the first href under the property we asked for, which cpdavd does return
// correctly.
type Caldav = { account: any; headers: Record<string, string> };
let caldavPromise: Promise<Caldav> | null = null;

async function propfindHref(
  target: string,
  headers: Record<string, string>,
  rootUrl: string,
  prop: string,
  ns: string
): Promise<string | null> {
  const body =
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="${ns}">` +
    `<d:prop><${prop}/></d:prop></d:propfind>`;
  const res = await fetch(target, {
    method: "PROPFIND",
    headers: { ...headers, Depth: "0", "Content-Type": "application/xml" },
    body,
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`CalDAV ${prop} failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  const tag = prop.split(":").pop()!;
  const block = new RegExp(`<[^>]*${tag}[^>]*>([\\s\\S]*?)</[^>]*${tag}>`, "i").exec(text);
  if (!block) return null;
  const href = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i.exec(block[1]);
  return href ? new URL(href[1].trim(), rootUrl).href : null;
}

function getDav(): Promise<Caldav> {
  if (!CFG.caldav) throw new Error("CalDAV is not configured (set CALDAV_URL).");
  if (!caldavPromise) {
    caldavPromise = (async () => {
      const cfg = CFG.caldav!;
      const u = new URL(cfg.url);
      const rootUrl = `${u.protocol}//${u.host}/`;
      const headers = getBasicAuthHeaders({ username: cfg.user, password: cfg.pass });

      const principalUrl = await propfindHref(
        rootUrl,
        headers,
        rootUrl,
        "d:current-user-principal",
        "DAV:"
      );
      if (!principalUrl) throw new Error("CalDAV: could not discover the principal URL.");

      const homeUrl = await propfindHref(
        principalUrl,
        headers,
        rootUrl,
        "c:calendar-home-set",
        "urn:ietf:params:xml:ns:caldav"
      );
      if (!homeUrl) throw new Error("CalDAV: could not discover the calendar home URL.");

      return {
        account: { accountType: "caldav", serverUrl: rootUrl, rootUrl, principalUrl, homeUrl },
        headers,
      };
    })().catch((e) => {
      caldavPromise = null; // let the next call retry instead of caching the failure
      throw e;
    });
  }
  return caldavPromise;
}

async function getCalendars() {
  const { account, headers } = await getDav();
  return fetchCalendars({ account, headers });
}

// Prefer the calendar the user pointed CALDAV_URL at; fall back to the first.
function pickCalendar(cals: any[], explicitUrl?: string) {
  const want = explicitUrl ?? CFG.caldav?.url;
  if (want) {
    const norm = (s: string) => s.replace(/\/+$/, "");
    const hit = cals.find((c: any) => norm(c.url) === norm(want));
    if (hit) return hit;
    if (explicitUrl) return undefined;
  }
  return cals[0];
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// ---------- tool definitions ----------

const tools: any[] = [
  {
    name: "list_folders",
    description: "List IMAP mailboxes/folders (INBOX, Sent, Drafts, …).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_messages",
    description: "List the newest messages in a folder (envelope only, no body).",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder name. Default INBOX." },
        limit: { type: "number", description: "How many recent messages. Default 20, max 100." },
      },
    },
  },
  {
    name: "search_messages",
    description:
      "Server-side IMAP search in a folder. Provide any of from/to/subject/text/since/before.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Default INBOX." },
        from: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        text: { type: "string", description: "Match in body." },
        since: { type: "string", description: "ISO date; messages on/after." },
        before: { type: "string", description: "ISO date; messages before." },
        unseenOnly: { type: "boolean" },
        limit: { type: "number", description: "Default 20, max 100." },
      },
    },
  },
  {
    name: "get_message",
    description: "Fetch full headers and text body of one message by UID.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "Message UID." },
        folder: { type: "string", description: "Default INBOX." },
      },
      required: ["uid"],
    },
  },
  {
    name: "send_message",
    description:
      "Send an email via SMTP. This is an irreversible outbound action; confirm recipients and content before calling.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Comma-separated recipients." },
        subject: { type: "string" },
        text: { type: "string", description: "Plain-text body." },
        html: { type: "string", description: "Optional HTML body." },
        cc: { type: "string" },
        bcc: { type: "string" },
      },
      required: ["to", "subject", "text"],
    },
  },
  {
    name: "create_draft",
    description: "Save a message to the Drafts folder without sending it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        text: { type: "string" },
        draftsFolder: { type: "string", description: "Default 'Drafts'." },
      },
      required: ["to", "subject", "text"],
    },
  },
];

if (CFG.caldav) {
  tools.push(
    {
      name: "list_calendars",
      description: "Discover CalDAV calendars available on the account.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_events",
      description: "List calendar events between two ISO timestamps.",
      inputSchema: {
        type: "object",
        properties: {
          start: { type: "string", description: "ISO datetime, inclusive." },
          end: { type: "string", description: "ISO datetime, exclusive." },
          calendarUrl: { type: "string", description: "Optional specific calendar URL." },
        },
        required: ["start", "end"],
      },
    },
    {
      name: "create_event",
      description: "Create a calendar event (writes to CalDAV).",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title." },
          start: { type: "string", description: "ISO datetime." },
          end: { type: "string", description: "ISO datetime." },
          description: { type: "string" },
          location: { type: "string" },
          calendarUrl: { type: "string", description: "Optional target calendar URL." },
        },
        required: ["summary", "start", "end"],
      },
    }
  );
}

if (CFG.allowDelete) {
  tools.push({
    name: "delete_message",
    description:
      "Permanently delete a message by UID. Irreversible — prefer moving to Trash. Only enabled when ALLOW_DELETE=true.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        folder: { type: "string", description: "Default INBOX." },
      },
      required: ["uid"],
    },
  });
}

// ---------- tool handlers ----------

async function handle(name: string, args: any) {
  switch (name) {
    case "list_folders":
      return withImap(async (c) => {
        const list = await c.list();
        return ok(list.map((f) => f.path).join("\n"));
      });

    case "list_messages":
      return withImap(async (c) => {
        const folder = args.folder ?? "INBOX";
        const limit = Math.min(args.limit ?? 20, 100);
        const lock = await c.getMailboxLock(folder);
        try {
          const status = await c.status(folder, { messages: true });
          const total = status.messages ?? 0;
          if (total === 0) return ok("(folder is empty)");
          const start = Math.max(1, total - limit + 1);
          const out: string[] = [];
          for await (const m of c.fetch(`${start}:*`, { uid: true, envelope: true, flags: true })) {
            const e = m.envelope;
            const seen = m.flags?.has("\\Seen") ? "" : "• ";
            out.push(
              `${seen}[uid ${m.uid}] ${e?.date?.toISOString?.().slice(0, 16) ?? ""}  ${
                e?.from?.[0]?.address ?? "?"
              }  —  ${e?.subject ?? "(no subject)"}`
            );
          }
          return ok(out.reverse().join("\n"));
        } finally {
          lock.release();
        }
      });

    case "search_messages":
      return withImap(async (c) => {
        const folder = args.folder ?? "INBOX";
        const limit = Math.min(args.limit ?? 20, 100);
        const lock = await c.getMailboxLock(folder);
        try {
          const q: any = {};
          if (args.from) q.from = args.from;
          if (args.to) q.to = args.to;
          if (args.subject) q.subject = args.subject;
          if (args.text) q.body = args.text;
          if (args.since) q.since = new Date(args.since);
          if (args.before) q.before = new Date(args.before);
          if (args.unseenOnly) q.seen = false;
          const uids = await c.search(q, { uid: true });
          if (!uids || uids.length === 0) return ok("(no matches)");
          const pick = uids.slice(-limit);
          const out: string[] = [];
          for await (const m of c.fetch(pick, { uid: true, envelope: true }, { uid: true })) {
            const e = m.envelope;
            out.push(
              `[uid ${m.uid}] ${e?.date?.toISOString?.().slice(0, 16) ?? ""}  ${
                e?.from?.[0]?.address ?? "?"
              }  —  ${e?.subject ?? "(no subject)"}`
            );
          }
          return ok(out.reverse().join("\n"));
        } finally {
          lock.release();
        }
      });

    case "get_message":
      return withImap(async (c) => {
        const folder = args.folder ?? "INBOX";
        const lock = await c.getMailboxLock(folder);
        try {
          const msg = await c.fetchOne(String(args.uid), { source: true, envelope: true }, { uid: true });
          if (!msg || !msg.source) return ok("(message not found)");
          const e = msg.envelope;
          const header =
            `From: ${e?.from?.map((a) => a.address).join(", ") ?? "?"}\n` +
            `To: ${e?.to?.map((a) => a.address).join(", ") ?? "?"}\n` +
            `Date: ${e?.date?.toISOString?.() ?? "?"}\n` +
            `Subject: ${e?.subject ?? "(no subject)"}\n\n`;
          // crude body extraction: strip headers block from raw source
          const raw = msg.source.toString("utf8");
          const bodyStart = raw.indexOf("\r\n\r\n");
          const body = bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw;
          return ok(header + body.slice(0, 8000));
        } finally {
          lock.release();
        }
      });

    case "send_message": {
      const info = await smtp.sendMail({
        from: CFG.from,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
      });
      return ok(`Sent. messageId=${info.messageId}`);
    }

    case "create_draft":
      return withImap(async (c) => {
        // cPanel namespaces folders under INBOX ("INBOX.Drafts"), so a literal
        // "Drafts" does not exist. Ask the server which mailbox is the drafts
        // one instead of guessing.
        const drafts = args.draftsFolder ?? (await findDraftsFolder(c));
        const raw =
          `From: ${CFG.from}\r\n` +
          `To: ${args.to}\r\n` +
          `Subject: ${args.subject}\r\n` +
          `Date: ${new Date().toUTCString()}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
          `${args.text}\r\n`;
        await c.append(drafts, Buffer.from(raw, "utf8"), ["\\Draft"]);
        return ok(`Draft saved to ${drafts}.`);
      });

    case "delete_message":
      return withImap(async (c) => {
        const folder = args.folder ?? "INBOX";
        const lock = await c.getMailboxLock(folder);
        try {
          await c.messageDelete(String(args.uid), { uid: true });
          return ok(`Deleted uid ${args.uid} from ${folder}.`);
        } finally {
          lock.release();
        }
      });

    case "list_calendars": {
      const cals = await getCalendars();
      return ok(
        cals
          .map((c: any) => `${c.displayName ?? "(unnamed)"}  —  ${c.url}`)
          .join("\n") || "(no calendars)"
      );
    }

    case "list_events": {
      const { headers } = await getDav();
      const cals = await getCalendars();
      const target = pickCalendar(cals, args.calendarUrl);
      if (!target) return ok("(calendar not found)");
      const objs = await fetchCalendarObjects({
        calendar: target,
        timeRange: { start: args.start, end: args.end },
        headers,
      });
      const out: string[] = [];
      for (const o of objs) {
        if (!o.data) continue;
        try {
          const jcal = ICAL.parse(o.data);
          const comp = new ICAL.Component(jcal);
          for (const ev of comp.getAllSubcomponents("vevent")) {
            const v = new ICAL.Event(ev);
            out.push(
              `${v.startDate?.toString() ?? "?"} → ${v.endDate?.toString() ?? "?"}  ${
                v.summary ?? "(no title)"
              }`
            );
          }
        } catch {
          /* skip unparseable */
        }
      }
      return ok(out.sort().join("\n") || "(no events in range)");
    }

    case "create_event": {
      const { headers } = await getDav();
      const cals = await getCalendars();
      const target = pickCalendar(cals, args.calendarUrl);
      if (!target) return ok("(target calendar not found)");
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@cpanel-mail-mcp`;
      const dt = (s: string) => new Date(s).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const ics =
        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//cpanel-mail-mcp//EN\r\n` +
        `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${dt(new Date().toISOString())}\r\n` +
        `DTSTART:${dt(args.start)}\r\nDTEND:${dt(args.end)}\r\n` +
        `SUMMARY:${args.summary}\r\n` +
        (args.location ? `LOCATION:${args.location}\r\n` : "") +
        (args.description ? `DESCRIPTION:${args.description}\r\n` : "") +
        `END:VEVENT\r\nEND:VCALENDAR\r\n`;
      await createCalendarObject({
        calendar: target,
        filename: `${uid}.ics`,
        iCalString: ics,
        headers,
      });
      return ok(`Event created: ${args.summary} (${args.start} → ${args.end}).`);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- wire up server ----------

const server = new Server(
  { name: "cpanel-mail-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await handle(req.params.name, req.params.arguments ?? {});
  } catch (e) {
    return fail(e);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[cpanel-mail-mcp] ready on stdio");
