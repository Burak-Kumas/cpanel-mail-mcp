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
 *   SMTP_HOST, SMTP_PORT (default 465), SMTP_TLS (default: true on 465, else STARTTLS)
 *   MAIL_USER      full email address, e.g. ad@firma.com
 *   MAIL_PASS      mailbox password (or app password)
 * Optional env:
 *   MAIL_FROM      From: header (defaults to MAIL_USER)
 *   CALDAV_URL     e.g. https://mail.firma.com:2080/calendars/ad@firma.com/calendar
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
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import {
  fetchCalendars,
  fetchCalendarObjects,
  createCalendarObject,
  updateCalendarObject,
  deleteCalendarObject,
  getBasicAuthHeaders,
} from "tsdav";
import ICAL from "ical.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
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
    // 465 is implicit TLS; 587/25 start plain and upgrade with STARTTLS.
    secure: boolEnv("SMTP_TLS", Number(process.env.SMTP_PORT ?? 465) === 465),
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

// Prefer the server's own SPECIAL-USE flag; fall back to the usual spellings,
// including cPanel's INBOX-prefixed ones ("INBOX.Drafts", not "Drafts").
async function findSpecialFolder(
  c: ImapFlow,
  flag: string,
  candidates: string[],
  label: string
): Promise<string> {
  const boxes = await c.list();
  const special = boxes.find((b: any) => b.specialUse === flag);
  if (special) return special.path;
  const lower = candidates.map((x) => x.toLowerCase());
  const hit = boxes.find((b) => lower.includes(b.path.toLowerCase()));
  if (hit) return hit.path;
  throw new Error(
    `${label} folder not found. Pass the folder name with the folder parameter ` +
      `(see list_folders).`
  );
}

const findDraftsFolder = (c: ImapFlow) =>
  findSpecialFolder(c, "\\Drafts", ["INBOX.Drafts", "Drafts", "Taslaklar"], "Drafts");
const findSentFolder = (c: ImapFlow) =>
  findSpecialFolder(
    c,
    "\\Sent",
    ["INBOX.Sent", "Sent", "Sent Items", "Gönderilmiş Öğeler", "Giden"],
    "Sent"
  );
const findTrashFolder = (c: ImapFlow) =>
  findSpecialFolder(
    c,
    "\\Trash",
    ["INBOX.Trash", "Trash", "Deleted Items", "Çöp Kutusu", "Silinmiş"],
    "Trash"
  );
const findJunkFolder = (c: ImapFlow) =>
  findSpecialFolder(c, "\\Junk", ["INBOX.spam", "INBOX.Junk", "Junk", "Spam"], "Spam");
const findArchiveFolder = (c: ImapFlow) =>
  findSpecialFolder(c, "\\Archive", ["INBOX.Archive", "Archive", "Arşiv"], "Archive");

// Raw source -> decoded headers, text, html and attachment metadata. The old
// "slice off everything before the first blank line" approach handed back
// base64 blobs for anything that was not a plain-text single-part message.
async function fetchParsed(uid: number, folder: string) {
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      return await simpleParser(msg.source);
    } finally {
      lock.release();
    }
  });
}

// Resolve the destination before taking the source lock: resolving it needs a
// LIST, and holding a mailbox lock while issuing one is asking for trouble.
async function moveMessage(
  folder: string,
  uid: number,
  target: string | ((c: ImapFlow) => Promise<string>)
) {
  return withImap(async (c) => {
    const dest = typeof target === "string" ? target : await target(c);
    const lock = await c.getMailboxLock(folder);
    try {
      await c.messageMove(String(uid), dest, { uid: true });
      return ok(`uid ${uid} moved: ${folder} → ${dest}`);
    } finally {
      lock.release();
    }
  });
}

function addrList(v: any): string {
  if (!v) return "";
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((a: any) => a?.value ?? [])
    .map((a: any) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(", ");
}

function quoteBody(parsed: any): string {
  const when = parsed.date ? parsed.date.toISOString().slice(0, 16).replace("T", " ") : "";
  const who = addrList(parsed.from) || "the sender";
  const body = (parsed.text ?? "").split("\n").map((l: string) => `> ${l}`).join("\n");
  return `\n\nOn ${when}, ${who} wrote:\n${body}`;
}

// Keep the thread intact: without In-Reply-To/References, mail clients show the
// reply as a brand-new conversation.
function threadHeaders(parsed: any) {
  const id = parsed.messageId;
  if (!id) return {};
  const refs = [parsed.references ?? [], id].flat().filter(Boolean).join(" ");
  return { inReplyTo: id, references: refs };
}

// Copy to the Sent folder ourselves: SMTP delivery does not put anything there,
// so without this the user's own Sent folder never shows what Claude sent.
async function appendToSent(raw: Buffer | string) {
  try {
    await withImap(async (c) => {
      const sent = await findSentFolder(c);
      await c.append(sent, Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"), ["\\Seen"]);
    });
    return " Saved to Sent.";
  } catch {
    return " (Could not save to Sent.)";
  }
}

// Compose once, then send that exact byte stream and file the same bytes in
// Sent, so the copy the user keeps matches what the recipient got (same
// Message-ID included).
async function sendAndFile(mail: any) {
  const compiled = new MailComposer({ ...mail, from: CFG.from }).compile();
  // With `raw`, nodemailer does not read recipients out of the headers, so the
  // envelope has to be derived explicitly (this is also what carries Bcc,
  // which is deliberately absent from the built message).
  // getEnvelope() reports `from: false` when there is none; the send options
  // type wants it absent instead.
  const env = compiled.getEnvelope();
  const envelope = { from: env.from || undefined, to: env.to ?? [] };
  const raw: Buffer = await compiled.build();
  const info = await smtp.sendMail({ envelope, raw } as Parameters<typeof smtp.sendMail>[0]);
  const filed = await appendToSent(raw);
  return `Sent. messageId=${info.messageId}${filed}`;
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
        attachments: {
          type: "array",
          description: "Local file paths to attach.",
          items: { type: "string" },
        },
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
        draftsFolder: { type: "string", description: "Defaults to the server's Drafts folder." },
      },
      required: ["to", "subject", "text"],
    },
  },
  {
    name: "reply_message",
    description:
      "Reply to a message, keeping it in the same conversation thread. Sends immediately; confirm content first. Use replyAll to include everyone.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "UID of the message being replied to." },
        text: { type: "string", description: "Your reply, in plain text." },
        folder: { type: "string", description: "Folder the original is in. Default INBOX." },
        replyAll: { type: "boolean", description: "Also reply to Cc and other To recipients." },
        quote: { type: "boolean", description: "Quote the original below your reply. Default true." },
      },
      required: ["uid", "text"],
    },
  },
  {
    name: "forward_message",
    description: "Forward a message to other recipients, keeping its attachments.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        to: { type: "string", description: "Comma-separated recipients." },
        text: { type: "string", description: "Optional note to add above the forwarded message." },
        folder: { type: "string", description: "Default INBOX." },
        cc: { type: "string" },
      },
      required: ["uid", "to"],
    },
  },
  {
    name: "move_message",
    description: "Move a message to another folder.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        target: { type: "string", description: "Destination folder (see list_folders)." },
        folder: { type: "string", description: "Source folder. Default INBOX." },
      },
      required: ["uid", "target"],
    },
  },
  {
    name: "trash_message",
    description:
      "Move a message to the Trash folder. This is the safe, reversible way to delete — prefer it over delete_message.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        folder: { type: "string", description: "Default INBOX." },
      },
      required: ["uid"],
    },
  },
  {
    name: "archive_message",
    description: "Move a message to the Archive folder.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        folder: { type: "string", description: "Default INBOX." },
      },
      required: ["uid"],
    },
  },
  {
    name: "mark_spam",
    description: "Move a message to the Junk/Spam folder.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        folder: { type: "string", description: "Default INBOX." },
      },
      required: ["uid"],
    },
  },
  {
    name: "set_flags",
    description:
      "Mark a message read/unread, flagged/unflagged, or answered. Only the fields you pass are changed.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        folder: { type: "string", description: "Default INBOX." },
        read: { type: "boolean", description: "true = mark read, false = mark unread." },
        flagged: { type: "boolean", description: "true = star/flag it, false = remove." },
        answered: { type: "boolean" },
      },
      required: ["uid"],
    },
  },
  {
    name: "list_attachments",
    description: "List the attachments on a message (filename, type, size).",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        folder: { type: "string", description: "Default INBOX." },
      },
      required: ["uid"],
    },
  },
  {
    name: "save_attachment",
    description: "Save one attachment from a message to a local directory.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number" },
        filename: { type: "string", description: "Attachment filename, from list_attachments." },
        directory: { type: "string", description: "Where to save. Default ~/Downloads." },
        folder: { type: "string", description: "Default INBOX." },
      },
      required: ["uid", "filename"],
    },
  },
  {
    name: "create_folder",
    description: "Create a new mail folder.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder name, e.g. 'INBOX.Projeler'." },
      },
      required: ["name"],
    },
  },
  {
    name: "rename_folder",
    description: "Rename a mail folder.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current folder name." },
        to: { type: "string", description: "New folder name." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "delete_folder",
    description:
      "Delete a mail folder and everything in it. Irreversible — move any messages you want to keep first.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Folder to delete." },
      },
      required: ["name"],
    },
  },
  {
    name: "empty_trash",
    description: "Permanently delete everything in the Trash folder. Irreversible.",
    inputSchema: { type: "object", properties: {} },
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
    },
    {
      name: "update_event",
      description:
        "Change an existing event. Only the fields you pass are modified; the rest stay as they are.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Event UID, from list_events." },
          summary: { type: "string" },
          start: { type: "string", description: "ISO datetime." },
          end: { type: "string", description: "ISO datetime." },
          description: { type: "string" },
          location: { type: "string" },
          calendarUrl: { type: "string" },
        },
        required: ["uid"],
      },
    },
    {
      name: "delete_event",
      description: "Delete a calendar event. This cannot be undone.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Event UID, from list_events." },
          calendarUrl: { type: "string" },
        },
        required: ["uid"],
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

    case "get_message": {
      const parsed = await fetchParsed(args.uid, args.folder ?? "INBOX");
      if (!parsed) return ok("(message not found)");
      const atts = parsed.attachments ?? [];
      const header =
        `From: ${addrList(parsed.from) || "?"}\n` +
        `To: ${addrList(parsed.to) || "?"}\n` +
        (addrList(parsed.cc) ? `Cc: ${addrList(parsed.cc)}\n` : "") +
        `Date: ${parsed.date?.toISOString?.() ?? "?"}\n` +
        `Subject: ${parsed.subject ?? "(no subject)"}\n` +
        (atts.length
          ? `Attachments: ${atts.map((a: any) => a.filename ?? "(unnamed)").join(", ")}\n`
          : "") +
        `\n`;
      // text is the decoded plain-text part; fall back to stripping the HTML
      // part when a sender ships HTML only.
      const body =
        parsed.text ??
        (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : "");
      return ok(header + body.slice(0, 8000));
    }

    case "send_message":
      return ok(
        await sendAndFile({
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
          attachments: (args.attachments ?? []).map((p: string) => ({ path: p })),
        })
      );

    case "reply_message": {
      const folder = args.folder ?? "INBOX";
      const parsed = await fetchParsed(args.uid, folder);
      if (!parsed) return ok("(message not found)");

      const me = CFG.imap.user.toLowerCase();
      const from = addrList(parsed.from);
      let to = from;
      let cc = "";
      if (args.replyAll) {
        // Everyone on the original minus ourselves, so we do not self-reply.
        const others = [addrList(parsed.to), addrList(parsed.cc)]
          .filter(Boolean)
          .join(", ")
          .split(",")
          .map((s: string) => s.trim())
          .filter((s: string) => s && !s.toLowerCase().includes(me));
        cc = [...new Set(others)].join(", ");
      }

      const subject = /^re:/i.test(parsed.subject ?? "")
        ? parsed.subject
        : `Re: ${parsed.subject ?? ""}`;
      const body = args.quote === false ? args.text : args.text + quoteBody(parsed);

      const res = await sendAndFile({
        to,
        cc: cc || undefined,
        subject,
        text: body,
        ...threadHeaders(parsed),
      });
      // \Answered is what mail clients use to draw the reply arrow.
      await withImap(async (c) => {
        const lock = await c.getMailboxLock(folder);
        try {
          await c.messageFlagsAdd(String(args.uid), ["\\Answered"], { uid: true });
        } finally {
          lock.release();
        }
      }).catch(() => {});
      return ok(`${res} To: ${to}${cc ? ` | Cc: ${cc}` : ""}`);
    }

    case "forward_message": {
      const folder = args.folder ?? "INBOX";
      const parsed = await fetchParsed(args.uid, folder);
      if (!parsed) return ok("(message not found)");

      const subject = /^(fwd|fw):/i.test(parsed.subject ?? "")
        ? parsed.subject
        : `Fwd: ${parsed.subject ?? ""}`;
      const header =
        `\n\n---------- Forwarded message ----------\n` +
        `From: ${addrList(parsed.from)}\n` +
        `Date: ${parsed.date?.toISOString?.() ?? ""}\n` +
        `Subject: ${parsed.subject ?? ""}\n` +
        `To: ${addrList(parsed.to)}\n\n`;

      return ok(
        await sendAndFile({
          to: args.to,
          cc: args.cc,
          subject,
          text: (args.text ?? "") + header + (parsed.text ?? ""),
          attachments: (parsed.attachments ?? []).map((a: any) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          })),
        })
      );
    }

    case "move_message":
      return moveMessage(args.folder ?? "INBOX", args.uid, args.target);

    case "trash_message":
      return moveMessage(args.folder ?? "INBOX", args.uid, findTrashFolder);

    case "archive_message":
      return moveMessage(args.folder ?? "INBOX", args.uid, findArchiveFolder);

    case "mark_spam":
      return moveMessage(args.folder ?? "INBOX", args.uid, findJunkFolder);

    case "set_flags":
      return withImap(async (c) => {
        const folder = args.folder ?? "INBOX";
        const lock = await c.getMailboxLock(folder);
        try {
          const add: string[] = [];
          const del: string[] = [];
          if (args.read === true) add.push("\\Seen");
          if (args.read === false) del.push("\\Seen");
          if (args.flagged === true) add.push("\\Flagged");
          if (args.flagged === false) del.push("\\Flagged");
          if (args.answered === true) add.push("\\Answered");
          if (args.answered === false) del.push("\\Answered");
          if (!add.length && !del.length) return ok("(nothing to change was specified)");
          const uid = String(args.uid);
          if (add.length) await c.messageFlagsAdd(uid, add, { uid: true });
          if (del.length) await c.messageFlagsRemove(uid, del, { uid: true });
          return ok(`uid ${args.uid} updated. Added: ${add.join(" ") || "-"}, removed: ${del.join(" ") || "-"}`);
        } finally {
          lock.release();
        }
      });

    case "list_attachments": {
      const parsed = await fetchParsed(args.uid, args.folder ?? "INBOX");
      if (!parsed) return ok("(message not found)");
      const atts = parsed.attachments ?? [];
      if (!atts.length) return ok("(no attachments)");
      return ok(
        atts
          .map((a: any) => `${a.filename ?? "(isimsiz)"}  —  ${a.contentType}  —  ${a.size} bayt`)
          .join("\n")
      );
    }

    case "save_attachment": {
      const parsed = await fetchParsed(args.uid, args.folder ?? "INBOX");
      if (!parsed) return ok("(message not found)");
      const att = (parsed.attachments ?? []).find((a: any) => a.filename === args.filename);
      if (!att) return ok(`(attachment not found: ${args.filename})`);
      const dir = args.directory ?? join(homedir(), "Downloads");
      mkdirSync(dir, { recursive: true });
      // basename() so a crafted filename cannot escape the chosen directory.
      const dest = join(dir, basename(String(args.filename)));
      writeFileSync(dest, att.content);
      return ok(`Saved: ${dest}`);
    }

    case "create_folder":
      return withImap(async (c) => {
        await c.mailboxCreate(args.name);
        return ok(`Folder created: ${args.name}`);
      });

    case "rename_folder":
      return withImap(async (c) => {
        await c.mailboxRename(args.from, args.to);
        return ok(`Folder renamed: ${args.from} → ${args.to}`);
      });

    case "delete_folder":
      return withImap(async (c) => {
        // Refuse the folders the mailbox cannot function without.
        const protectedBoxes = ["inbox"];
        if (protectedBoxes.includes(String(args.name).toLowerCase())) {
          return ok(`${args.name} cannot be deleted.`);
        }
        await c.mailboxDelete(args.name);
        return ok(`Folder deleted: ${args.name}`);
      });

    case "empty_trash":
      return withImap(async (c) => {
        const trash = await findTrashFolder(c);
        const lock = await c.getMailboxLock(trash);
        try {
          const status = await c.status(trash, { messages: true });
          if (!status.messages) return ok(`${trash} is already empty.`);
          await c.messageDelete({ all: true });
          return ok(`${trash} emptied (${status.messages} messages permanently deleted).`);
        } finally {
          lock.release();
        }
      });

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
            // The UID is what update_event/delete_event need as their handle.
            out.push(
              `${v.startDate?.toString() ?? "?"} → ${v.endDate?.toString() ?? "?"}  ${
                v.summary ?? "(untitled)"
              }${v.location ? `  @ ${v.location}` : ""}  [uid ${v.uid}]`
            );
          }
        } catch {
          /* skip unparseable */
        }
      }
      return ok(out.sort().join("\n") || "(no events in this range)");
    }

    case "update_event":
    case "delete_event": {
      const { headers } = await getDav();
      const cals = await getCalendars();
      const target = pickCalendar(cals, args.calendarUrl);
      if (!target) return ok("(calendar not found)");

      const objs = await fetchCalendarObjects({ calendar: target, headers });
      const hit = objs.find((o: any) => o.data && o.data.includes(`UID:${args.uid}`));
      if (!hit) return ok(`(event not found: ${args.uid})`);

      if (name === "delete_event") {
        await deleteCalendarObject({ calendarObject: hit, headers });
        return ok(`Event deleted: ${args.uid}`);
      }

      // Edit the existing VEVENT in place so fields we were not given keep
      // their current values.
      const comp = new ICAL.Component(ICAL.parse(hit.data!));
      const vevent = comp.getAllSubcomponents("vevent")[0];
      if (!vevent) return ok("(could not read event)");
      const setProp = (k: string, val?: string) => {
        if (val === undefined) return;
        vevent.updatePropertyWithValue(k, val);
      };
      setProp("summary", args.summary);
      setProp("description", args.description);
      setProp("location", args.location);
      if (args.start) vevent.updatePropertyWithValue("dtstart", ICAL.Time.fromJSDate(new Date(args.start), true));
      if (args.end) vevent.updatePropertyWithValue("dtend", ICAL.Time.fromJSDate(new Date(args.end), true));
      vevent.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));

      await updateCalendarObject({
        calendarObject: { ...hit, data: comp.toString() },
        headers,
      });
      return ok(`Event updated: ${args.uid}`);
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
