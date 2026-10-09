/**
 * Interactive installer: `cpanel-mail-mcp setup`
 *
 * Goal is a one-command install for non-technical teammates. It:
 *   1. asks for the mailbox username and password (password never echoed),
 *   2. asks for the cPanel mail host and ports, pre-filled with the defaults,
 *   3. proves the credentials work with a real IMAP login BEFORE saving,
 *      and checks SMTP with the same login,
 *   4. copies the server to a permanent directory (npx's cache is temporary,
 *      and the MCP registration must keep working after it is cleared),
 *   5. registers it with both Claude Code and the Claude desktop app.
 *
 * The password is written only to ~/.cpanel-mail-mcp/.env with mode 600. It is
 * never passed on a command line (it would land in shell history and `ps`).
 */

import { spawnSync } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { Writable } from "node:stream";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_DIR = join(homedir(), ".cpanel-mail-mcp");
const ENV_PATH = join(INSTALL_DIR, ".env");
const SERVER_PATH = join(INSTALL_DIR, "build", "index.js");

// ---------- prompts ----------

// readline echoes keystrokes to its output stream. Rather than fight it for the
// password prompt, we hand it an output stream we can mute: while muted the
// typed characters are dropped instead of reaching the terminal.
class MutableOutput extends Writable {
  muted = false;
  override _write(chunk: any, enc: BufferEncoding, cb: (e?: Error | null) => void) {
    if (!this.muted) process.stdout.write(chunk, enc);
    cb();
  }
}

const output = new MutableOutput();
const rl = readline.createInterface({ input: process.stdin, output, terminal: true });

function ask(q: string, def?: string): Promise<string> {
  const suffix = def ? ` [${def}]` : "";
  return new Promise((res) =>
    rl.question(`${q}${suffix}: `, (a) => res(a.trim() || def || ""))
  );
}

function askHidden(q: string): Promise<string> {
  return new Promise((res) => {
    process.stdout.write(`${q}: `);
    output.muted = true;
    rl.question("", (a) => {
      output.muted = false;
      process.stdout.write("\n");
      res(a);
    });
  });
}

async function askYesNo(q: string, def = true): Promise<boolean> {
  const a = (await ask(`${q} (e/h)`, def ? "e" : "h")).toLowerCase();
  return a.startsWith("e") || a.startsWith("y");
}

// ---------- checks ----------

function tlsReachable(host: string, port: number, timeout = 7000): Promise<boolean> {
  return new Promise((res) => {
    const sock = tlsConnect(
      { host, port, servername: host, rejectUnauthorized: false },
      () => {
        sock.end();
        res(true);
      }
    );
    sock.setTimeout(timeout, () => {
      sock.destroy();
      res(false);
    });
    sock.on("error", () => res(false));
  });
}

async function imapLoginWorks(
  host: string,
  port: number,
  user: string,
  pass: string
): Promise<string | null> {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  try {
    await client.connect();
    await client.logout().catch(() => {});
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function smtpLoginWorks(
  host: string,
  port: number,
  user: string,
  pass: string
): Promise<string | null> {
  const t = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 10000,
  });
  try {
    await t.verify();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    t.close();
  }
}

// ---------- Claude registration ----------

function desktopConfigPath(): string | null {
  const home = homedir();
  if (platform() === "darwin")
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32")
    return process.env.APPDATA
      ? join(process.env.APPDATA, "Claude", "claude_desktop_config.json")
      : null;
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

// The desktop app launches servers without the user's shell, so a bare "node"
// (or an nvm shim, which is only a shell function) will not resolve. Prefer a
// node that exists at a fixed path and outlives an nvm version switch.
function stableNodePath(): string {
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter((p) => existsSync(p));
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    const major = Number((r.stdout ?? "").trim().replace(/^v/, "").split(".")[0]);
    if (major >= 20) return c;
  }
  return process.execPath;
}

function registerDesktop(nodePath: string): string {
  const p = desktopConfigPath();
  if (!p) return "Masaüstü uygulaması yapılandırması bulunamadı, atlandı.";
  try {
    let cfg: any = {};
    if (existsSync(p)) {
      writeFileSync(`${p}.bak`, readFileSync(p));
      try {
        cfg = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        return `${p} okunamadı (geçersiz JSON). Masaüstü kaydı atlandı.`;
      }
    } else {
      mkdirSync(dirname(p), { recursive: true });
    }
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers.mail = { command: nodePath, args: [SERVER_PATH] };
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    return "Claude masaüstü uygulamasına eklendi.";
  } catch (e) {
    return `Masaüstü kaydı yapılamadı: ${e instanceof Error ? e.message : e}`;
  }
}

function registerClaudeCode(nodePath: string): string {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error) return "Claude Code CLI bulunamadı, atlandı.";
  spawnSync("claude", ["mcp", "remove", "mail", "-s", "user"], { encoding: "utf8" });
  const r = spawnSync(
    "claude",
    ["mcp", "add", "mail", "--scope", "user", "--", nodePath, SERVER_PATH],
    { encoding: "utf8" }
  );
  return r.status === 0
    ? "Claude Code'a eklendi."
    : `Claude Code'a eklenemedi: ${(r.stderr || r.stdout || "").trim()}`;
}

// Plain ASCII only: Windows consoles and older terminals mangle box-drawing
// characters.
const BANNER = String.raw`
   +-----------------------------------------------------+
   |                                                     |
   |    __  __    _    ___ _       __  __  ____ ____     |
   |   |  \/  |  / \  |_ _| |     |  \/  |/ ___|  _ \    |
   |   | |\/| | / _ \  | || |     | |\/| | |   | |_) |   |
   |   | |  | |/ ___ \ | || |___  | |  | | |___|  __/    |
   |   |_|  |_/_/   \_\___|_____| |_|  |_|\____|_|       |
   |                                                     |
   |        IMAP  .  SMTP  .  Takvim  ->  Claude         |
   |                                                     |
   +-----------------------------------------------------+
`;

// ---------- main ----------

export async function runSetup() {
  console.log(BANNER);
  console.log("   cPanel posta hesabı kurulumu: kullanıcı adı, şifre, sunucu ve port.\n");

  if (existsSync(ENV_PATH)) {
    const overwrite = await askYesNo(
      "Mevcut bir kurulum var. Ayarları yeniden girmek istiyor musun?",
      false
    );
    if (!overwrite) {
      console.log("\nAyarlar korundu. Kayıtlar yenileniyor...\n");
      const nodePath = stableNodePath();
      console.log("  " + registerClaudeCode(nodePath));
      console.log("  " + registerDesktop(nodePath));
      rl.close();
      return;
    }
  }

  // Every value is asked for, but host and ports come pre-filled with the
  // cPanel defaults (mail.<domain>, 993 SSL, 465 SSL), so Enter accepts them.
  // Values shown in cPanel > Email Accounts > Connect Devices.
  console.log(
    "  Bilgiler cPanel > Email Accounts > Connect Devices ekranındaki\n" +
      "  'Secure SSL/TLS Settings' bölümünde yazar. Köşeli parantezdeki\n" +
      "  değer doğruysa Enter'a basman yeterli.\n"
  );
  let email = "";
  let pass = "";
  let host = "";
  let imapPort = 993;
  let smtpPort = 465;
  for (let attempt = 1; ; attempt++) {
    email = await ask("Kullanıcı adı (tam e-posta adresi, örn. ad@firma.com)", email || undefined);
    if (!email.includes("@")) {
      console.log("  Kullanıcı adı tam e-posta adresi olmalı.\n");
      continue;
    }
    pass = await askHidden("Şifre (ekranda görünmez)");
    host = await ask("Sunucu (host)", host || `mail.${email.split("@")[1]}`);
    imapPort = Number(await ask("IMAP portu", String(imapPort))) || 993;
    smtpPort = Number(await ask("SMTP portu", String(smtpPort))) || 465;

    process.stdout.write("\n  IMAP girişi deneniyor... ");
    let err = await imapLoginWorks(host, imapPort, email, pass);
    if (!err) {
      console.log("başarılı.");
      process.stdout.write("  SMTP girişi deneniyor... ");
      err = await smtpLoginWorks(host, smtpPort, email, pass);
      if (!err) {
        console.log("başarılı.\n");
        break;
      }
    }
    console.log("başarısız.");
    console.log(`  Sunucu yanıtı: ${err}`);
    console.log(
      "  Not: Şifre, cPanel giriş şifren değil, o posta hesabının şifresidir.\n"
    );
    if (attempt >= 3) {
      console.log("Üç deneme başarısız oldu. Kurulum durduruldu.");
      rl.close();
      process.exit(1);
    }
    console.log("  Bilgileri tekrar gir:\n");
  }

  // Calendar is a bonus, not a decision to put in front of the user: enable it
  // when cPanel's CalDAV port answers, stay silent when it does not.
  process.stdout.write("  Takvim aranıyor... ");
  const calOk = await tlsReachable(host, 2080);
  console.log(calOk ? "bulundu, takvim araçları açılıyor." : "yok, sadece mail kurulacak.");
  const caldavUrl = calOk ? `https://${host}:2080/calendars/${email}/calendar` : "";

  // Install to a fixed path: npx runs from a cache that gets cleared, which
  // would break the registration we are about to write.
  mkdirSync(INSTALL_DIR, { recursive: true });
  cpSync(join(PKG_DIR, "build"), join(INSTALL_DIR, "build"), { recursive: true });
  cpSync(join(PKG_DIR, "package.json"), join(INSTALL_DIR, "package.json"));
  if (existsSync(join(PKG_DIR, "node_modules"))) {
    cpSync(join(PKG_DIR, "node_modules"), join(INSTALL_DIR, "node_modules"), {
      recursive: true,
    });
  } else {
    console.log("  Bağımlılıklar kuruluyor...");
    spawnSync("npm", ["install", "--omit=dev", "--silent"], {
      cwd: INSTALL_DIR,
      stdio: "inherit",
    });
  }

  const env =
    `# ${email} — otomatik oluşturuldu. Gizli dosya: paylaşma, git'e ekleme.\n` +
    `IMAP_HOST=${host}\nIMAP_PORT=${imapPort}\nIMAP_TLS=true\n` +
    `SMTP_HOST=${host}\nSMTP_PORT=${smtpPort}\nSMTP_TLS=${smtpPort === 465}\n` +
    `MAIL_USER=${email}\nMAIL_PASS=${pass}\nMAIL_FROM=${email}\n` +
    (caldavUrl ? `CALDAV_URL=${caldavUrl}\n` : "") +
    `\n# Silme aracı kapalı. Açmak için: ALLOW_DELETE=true (geri alınamaz)\n`;
  writeFileSync(ENV_PATH, env, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);

  const nodePath = stableNodePath();
  console.log("\n  " + registerClaudeCode(nodePath));
  console.log("  " + registerDesktop(nodePath));

  console.log(
    `\n  Kurulum tamam.\n\n` +
      `  Ayarlar: ${ENV_PATH}\n` +
      `  Açık olan Claude Code / Claude uygulamasını kapatıp yeniden aç.\n` +
      `  Sonra dene: "Gelen kutumdaki son 10 maili listele"\n`
  );
  rl.close();
}
